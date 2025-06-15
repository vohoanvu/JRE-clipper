// JREClipper.Api/Controllers/IngestionController.cs
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace JREClipper.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class IngestionController : ControllerBase
    {
        private readonly IGoogleCloudStorageService _gcsService;
        private readonly ITranscriptProcessor _transcriptProcessor;
        private readonly IEmbeddingService _embeddingService;
        private readonly IVectorDatabaseService _vectorDbService;
        private readonly GoogleCloudStorageOptions _gcsOptions;
        private readonly AppSettings _appSettings;
        private readonly EmbeddingServiceOptions _embeddingOptions;

        public IngestionController(
            IGoogleCloudStorageService gcsService,
            ITranscriptProcessor transcriptProcessor,
            Func<string, IEmbeddingService> embeddingServiceFactory, // Use factory
            IVectorDatabaseService vectorDbService,
            IOptions<GoogleCloudStorageOptions> gcsOptions,
            IOptions<AppSettings> appSettings,
            IOptions<EmbeddingServiceOptions> embeddingOptions)
        {
            _gcsService = gcsService;
            _transcriptProcessor = transcriptProcessor;
            _appSettings = appSettings.Value;
            _embeddingService = embeddingServiceFactory(_appSettings.EmbeddingProvider ?? "Mock"); // Get service from factory
            _vectorDbService = vectorDbService;
            _gcsOptions = gcsOptions.Value;
            _embeddingOptions = embeddingOptions.Value;
        }

        /// <summary>
        /// Processes a single transcript file from Google Cloud Storage.
        /// </summary>
        /// <param name="bucketName">The GCS bucket name.</param>
        /// <param name="objectName">The full path to the transcript JSON file in the bucket.</param>
        /// <returns>Status of the ingestion process.</returns>
        [HttpPost("vectorize-single-transcript")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        [ProducesResponseType(StatusCodes.Status500InternalServerError)]
        public async Task<IActionResult> ProcessSingleTranscript(string bucketName, string objectName)
        {
            if (string.IsNullOrEmpty(bucketName) || string.IsNullOrEmpty(objectName))
            {
                return BadRequest("Bucket name and object name are required.");
            }

            try
            {
                var rawTranscript = await _gcsService.GetSingleTranscript(bucketName, objectName);
                if (rawTranscript == null || rawTranscript.TranscriptWithTimestamps == null || !rawTranscript.TranscriptWithTimestamps.Any())
                {
                    return NotFound($"Transcript data not found or empty in GCS object: {objectName}");
                }

                // Ensure VideoId is populated if not directly in the JSON root
                if (string.IsNullOrEmpty(rawTranscript.VideoId))
                {
                    // Attempt to derive VideoId from objectName if it follows a pattern like "transcript_VIDEOID.json"
                    var fileName = Path.GetFileNameWithoutExtension(objectName);
                    if (fileName.StartsWith("transcript-"))
                    {
                        rawTranscript.VideoId = fileName.Substring("transcript-".Length);
                    }
                    else
                    {
                        rawTranscript.VideoId = fileName; // Fallback to filename without extension
                    }
                }

                var processedSegments = _transcriptProcessor.ChunkTranscriptWithTimestamps(rawTranscript);
                if (!processedSegments.Any())
                {
                    return Ok("Transcript processed, but no segments were generated (possibly empty or too short).");
                }

                var vectorizedSegments = new List<VectorizedSegment>();
                var textsToEmbed = processedSegments.Select(s => s.Text).ToList();

                // Batch embedding generation
                var embeddings = await _embeddingService.GenerateEmbeddingsBatchAsync(textsToEmbed);

                if (embeddings.Count != processedSegments.Count())
                {
                    return StatusCode(StatusCodes.Status500InternalServerError, "Mismatch between number of segments and generated embeddings.");
                }

                for (int i = 0; i < processedSegments.Count(); i++)
                {
                    var segment = processedSegments.ElementAt(i);
                    vectorizedSegments.Add(new VectorizedSegment
                    {
                        SegmentId = Guid.NewGuid().ToString(),
                        VideoId = segment.VideoId,
                        Text = segment.Text,
                        StartTime = TimeSpan.Parse(segment.StartTime.ToString(@"hh\:mm\:ss\.fff")).TotalSeconds,
                        Embedding = embeddings[i], // Use the List<float> directly
                        ChannelName = segment.ChannelName
                        // Optional properties have been removed as they don't exist in ProcessedTranscriptSegment
                    });
                }

                await _vectorDbService.AddVectorsBatchAsync(vectorizedSegments);

                return Ok(new { Message = $"Successfully processed and vectorized {vectorizedSegments.Count} segments from {objectName}.", SegmentsCount = vectorizedSegments.Count });
            }
            catch (Exception ex)
            {
                // Log the exception (using ILogger if available)
                Console.WriteLine($"Error processing transcript {objectName}: {ex.Message}");
                return StatusCode(StatusCodes.Status500InternalServerError, $"An error occurred: {ex.Message}");
            }
        }

        /// <summary>
        /// Triggers batch processing of all transcripts in a specified GCS folder.
        /// (This is a placeholder and would typically be handled by a background worker/queue system for long-running tasks)
        /// </summary>
        /// <param name="bucketName">The GCS bucket name.</param>
        /// <param name="prefix">The folder/prefix in the bucket containing transcript files.</param>
        /// <returns>Status of the batch initiation.</returns>
        [HttpPost("vectorize-batch-transcripts")]
        [ProducesResponseType(StatusCodes.Status202Accepted)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        public async Task<IActionResult> ProcessBatchTranscripts(string bucketName, string prefix)
        {
            if (string.IsNullOrEmpty(bucketName))
            {
                return BadRequest("Bucket name is required.");
            }

            // In a real system, this would publish messages to a queue (e.g., Pub/Sub)
            // for a background worker to process each file.
            // For now, it just lists them as a demonstration.
            try
            {
                var transcriptFiles = await _gcsService.ListAllTranscriptFiles(bucketName, prefix ?? string.Empty);
                if (transcriptFiles.Count == 0)
                {
                    return NotFound($"No transcript files found in gs://{bucketName}/{prefix}");
                }

                // TODO: Implement actual queuing mechanism here.
                // For now, just returning the list of files that *would* be queued.
                return Accepted(new { Message = "Batch processing initiated (simulation).", FilesToProcess = transcriptFiles, Count = transcriptFiles.Count });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error initiating batch processing: {ex.Message}");
                return StatusCode(StatusCodes.Status500InternalServerError, $"An error occurred: {ex.Message}");
            }
        }

        /// <summary>
        /// Trigger an Update of JRE Playlist CSV metadata stored in GCS to change the isVectorized field of rows that were just vectorized.
        /// </summary>
        /// <param name="bucketName">The GCS bucket name.</param>
        /// <param name="videoId">The ID of the video entry to update.</param>
        /// <param name="updatedFields">A dictionary where keys are column names and values are the new field values.</param>
        /// <param name="objectName">The name of the CSV file in GCS.</param>
        [HttpPost("update-jre-playlist-metadata")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        [ProducesResponseType(StatusCodes.Status500InternalServerError)]
        public async Task<IActionResult> UpdateJrePlaylistMetadata(string bucketName, string videoId, [FromBody] Dictionary<string, object> updatedFields, string objectName)
        {
            if (string.IsNullOrEmpty(bucketName) || string.IsNullOrEmpty(videoId) || string.IsNullOrEmpty(objectName))
            {
                return BadRequest("Bucket name, video ID, and object name are required.");
            }

            if (updatedFields == null || !updatedFields.Any())
            {
                return BadRequest("No fields to update provided.");
            }

            try
            {
                await _gcsService.UpdateJrePlaylistMetadataAsync(bucketName, videoId, updatedFields, objectName);
                return Ok(new { Message = $"Successfully updated metadata for video ID {videoId} in {objectName}." });
            }
            catch (KeyNotFoundException knfEx)
            {
                return NotFound(knfEx.Message);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error updating JRE playlist metadata: {ex.Message}");
                return StatusCode(StatusCodes.Status500InternalServerError, $"An error occurred: {ex.Message}");
            }
        }
    }
}
