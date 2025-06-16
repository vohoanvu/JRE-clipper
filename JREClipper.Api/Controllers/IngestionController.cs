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

        public class RequestDto
        {
            public string? BucketName { get; set; }
            public string? ObjectName { get; set; }

            public string? Prefix { get; set; }

            public string? VideoId { get; set; }

            public Dictionary<string, object>? UpdatedFields { get; set; }
        }

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
        public async Task<IActionResult> ProcessSingleTranscript([FromBody] RequestDto requestDto)
        {
            if (string.IsNullOrEmpty(requestDto.BucketName) || string.IsNullOrEmpty(requestDto.ObjectName))
            {
                requestDto.BucketName = "jre-content";
                requestDto.ObjectName = "transcriptions/transcript-_BTNmNpoAro.json"; //Test data
            }

            try
            {
                var rawTranscript = await _gcsService.GetSingleTranscript(requestDto.BucketName, requestDto.ObjectName);
                if (rawTranscript == null || rawTranscript.TranscriptWithTimestamps == null || rawTranscript.TranscriptWithTimestamps.Count == 0)
                {
                    return NotFound($"Transcript data not found or empty in GCS object: {requestDto.ObjectName}");
                }

                // Ensure VideoId is populated if not directly in the JSON root
                if (string.IsNullOrEmpty(rawTranscript.VideoId))
                {
                    // Attempt to derive VideoId from objectName if it follows a pattern like "transcript_VIDEOID.json"
                    var fileName = Path.GetFileNameWithoutExtension(requestDto.ObjectName);
                    if (fileName.StartsWith("transcript-"))
                    {
                        rawTranscript.VideoId = fileName.Substring("transcript-".Length);
                    }
                    else
                    {
                        rawTranscript.VideoId = fileName; // Fallback to filename without extension
                    }
                }

                var segmentChunkSize = _appSettings.ChunkSettings?.MaxChunkDurationSeconds;
                var segmentOverlap = _appSettings.ChunkSettings?.OverlapDurationSeconds;

                var processedSegments = _transcriptProcessor.ChunkTranscriptWithTimestamps(rawTranscript, segmentChunkSize, segmentOverlap).ToList();
                if (processedSegments.Count == 0)
                {
                    return Ok("Transcript processed, but no segments were generated (possibly empty or too short).");
                }

                var textsToEmbed = processedSegments.Select(s => s.Text).ToList();

                // Batch embedding generation
                var embeddings = await _embeddingService.GenerateEmbeddingsBatchAsync(textsToEmbed);

                if (embeddings == null || embeddings.Count != processedSegments.Count)
                {
                    return StatusCode(StatusCodes.Status500InternalServerError, new { Message = "Mismatch between number of segments and generated embeddings." });
                }

                var vectorizedSegments = processedSegments.Select((segment, i) => new VectorizedSegment
                {
                    SegmentId = Guid.NewGuid().ToString(),
                    VideoId = segment.VideoId,
                    Text = segment.Text,
                    StartTime = segment.StartTime.TotalSeconds,
                    EndTime = segment.EndTime.TotalSeconds,
                    Embedding = embeddings[i],
                    ChannelName = segment.ChannelName,
                    VideoTitle = segment.VideoTitle
                }).ToList();

                // await _vectorDbService.AddVectorsBatchAsync(vectorizedSegments);
                
                // Save vectorized segments to GCS for Vertex AI Index batch updates
                var vectorizedSegmentsObjectName = $"embeddings/{rawTranscript.VideoId}.json";
                await _gcsService.UploadVectorizedSegmentsAsync("jre-processed-clips-bucker", vectorizedSegmentsObjectName, vectorizedSegments);

                // Update playlist metadata
                if (!string.IsNullOrEmpty(rawTranscript.VideoId) && !string.IsNullOrEmpty(_gcsOptions.JrePlaylistCsvObjectName))
                {
                    var updatedFields = new Dictionary<string, object> { { "isVectorized", true } };
                    await _gcsService.UpdateJrePlaylistMetadataAsync(
                        requestDto.BucketName,
                        rawTranscript.VideoId,
                        updatedFields,
                        _gcsOptions.JrePlaylistCsvObjectName);
                }

                return Ok(new { Message = $"Successfully processed, vectorized, and saved {vectorizedSegments.Count} segments from {requestDto.ObjectName}. Playlist metadata updated.", SegmentsCount = vectorizedSegments.Count });
            }
            catch (Exception ex)
            {
                // Log the exception (using ILogger if available)
                Console.WriteLine($"Error processing transcript {requestDto.ObjectName}: {ex.Message}");
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
        public async Task<IActionResult> ProcessBatchTranscripts([FromBody] RequestDto requestDto)
        {
            if (string.IsNullOrEmpty(requestDto.BucketName))
            {
                return BadRequest("Bucket name is required.");
            }

            // In a real system, this would publish messages to a queue (e.g., Pub/Sub)
            // for a background worker to process each file.
            // For now, it just lists them as a demonstration.
            try
            {
                var transcriptFiles = await _gcsService.ListAllTranscriptFiles(requestDto.BucketName, requestDto.Prefix ?? string.Empty); // Corrected typo: Prefex -> Prefix
                if (transcriptFiles.Count == 0)
                {
                    return NotFound($"No transcript files found in gs://{requestDto.BucketName}/{requestDto.Prefix}"); // Corrected typo: Prefex -> Prefix
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
        public async Task<IActionResult> UpdateJrePlaylistMetadata([FromBody] RequestDto requestDto)
        {
            if (string.IsNullOrEmpty(requestDto.BucketName) || string.IsNullOrEmpty(requestDto.VideoId) || string.IsNullOrEmpty(requestDto.ObjectName))
            {
                return BadRequest("Bucket name, video ID, and object name are required.");
            }

            if (requestDto.UpdatedFields == null || !requestDto.UpdatedFields.Any())
            {
                return BadRequest("No fields to update provided.");
            }

            try
            {
                await _gcsService.UpdateJrePlaylistMetadataAsync(requestDto.BucketName, requestDto.VideoId, requestDto.UpdatedFields, requestDto.ObjectName);
                return Ok(new { Message = $"Successfully updated metadata for video ID {requestDto.VideoId} in {requestDto.ObjectName}." });
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
