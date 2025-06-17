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
            _embeddingService = embeddingServiceFactory(_appSettings.EmbeddingProvider!); // Get service from factory
            _vectorDbService = vectorDbService;
            _gcsOptions = gcsOptions.Value;
            _embeddingOptions = embeddingOptions.Value;
        }

        private static (string BucketName, string ObjectName) ParseGcsUri(string gcsUri)
        {
            if (string.IsNullOrWhiteSpace(gcsUri) || !gcsUri.StartsWith("gs://"))
            {
                throw new ArgumentException("Invalid GCS URI format. Must start with 'gs://'.", nameof(gcsUri));
            }

            var uri = new Uri(gcsUri);
            var bucketName = uri.Host;
            var objectName = uri.AbsolutePath.TrimStart('/');

            if (string.IsNullOrEmpty(bucketName))
            {
                throw new ArgumentException("Bucket name cannot be extracted from GCS URI.", nameof(gcsUri));
            }
            // ObjectName can be empty if URI points to bucket root, or a prefix if it ends with /
            return (bucketName, objectName);
        }

        /// <summary>
        /// Processes a single transcript file from Google Cloud Storage using URIs from configuration.
        /// </summary>
        /// <returns>Status of the ingestion process.</returns>
        [HttpPost("vectorize-single-transcript")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        [ProducesResponseType(StatusCodes.Status500InternalServerError)]
        public async Task<IActionResult> ProcessSingleTranscript() // Removed [FromBody] RequestDto requestDto
        {
            // Use URIs from _gcsOptions
            if (string.IsNullOrEmpty(_gcsOptions.InputDataUri) || string.IsNullOrEmpty(_gcsOptions.OutputDataUri) || string.IsNullOrEmpty(_gcsOptions.SegmentedTranscriptDataUri))
            {
                return BadRequest("InputDataUri and OutputDataUri must be configured in appsettings.");
            }

            try
            {
                (string inputBucketName, string inputObjectName) = ParseGcsUri(_gcsOptions.InputDataUri);
                (string configuredOutputBucketName, string configuredOutputObjectName) = ParseGcsUri(_gcsOptions.OutputDataUri);
                (string segmentedTranscriptBucketName, string configuredSegmentedTranscriptObjectName) = ParseGcsUri(_gcsOptions.SegmentedTranscriptDataUri);

                if (string.IsNullOrEmpty(inputObjectName))
                {
                    return BadRequest("Configured InputDataUri must specify a valid GCS object name for the transcript.");
                }

                string finalOutputObjectName = configuredOutputObjectName;
                // If OutputDataUri from config is a folder for single transcript, derive a filename.
                if (configuredOutputObjectName.EndsWith("/") || string.IsNullOrEmpty(Path.GetExtension(configuredOutputObjectName)))
                {
                    finalOutputObjectName = $"{configuredOutputObjectName.TrimEnd('/')}/{Path.GetFileName(inputObjectName)}";
                }

                var rawTranscript = await _gcsService.GetSingleTranscript(inputBucketName, inputObjectName);
                if (rawTranscript == null || rawTranscript.TranscriptWithTimestamps == null || rawTranscript.TranscriptWithTimestamps.Count == 0)
                {
                    return NotFound($"Transcript data not found or empty in GCS object: {inputObjectName} in bucket {inputBucketName}");
                }
                // Ensure VideoId is populated if not directly in the JSON root
                if (string.IsNullOrEmpty(rawTranscript.VideoId))
                {
                    var fileName = Path.GetFileNameWithoutExtension(inputObjectName);
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

                string finalSegmentedTranscriptObjectName = configuredSegmentedTranscriptObjectName;
                if (configuredSegmentedTranscriptObjectName.EndsWith('/') || string.IsNullOrEmpty(Path.GetExtension(configuredSegmentedTranscriptObjectName)))
                {
                    finalSegmentedTranscriptObjectName = $"{configuredSegmentedTranscriptObjectName.TrimEnd('/')}/{rawTranscript.VideoId}.ndjson"; // Ensure .ndjson extension
                }

                string uploadedNdjsonUri = await _gcsService.UploadSegmentedTranscriptNDJSONAsync(
                    segmentedTranscriptBucketName, 
                    finalSegmentedTranscriptObjectName, 
                    processedSegments);
                Console.WriteLine($"Segmented transcript NDJSON uploaded to: {uploadedNdjsonUri}");

                var textsToEmbed = processedSegments.Select(s => s.Text).ToList();
                //Specify Input URI and Output URI for batch embeddings
                var outputUri = await _embeddingService.GenerateEmbeddingsBatchAsync(uploadedNdjsonUri, _gcsOptions.OutputDataUri);

                // Update playlist metadata
                if (!string.IsNullOrEmpty(rawTranscript.VideoId) && !string.IsNullOrEmpty(_gcsOptions.JrePlaylistCsvUri))
                {
                    (string playlistBucketName, string playlistObjectName) = ParseGcsUri(_gcsOptions.JrePlaylistCsvUri);
                    if (string.IsNullOrEmpty(playlistObjectName))
                    {
                         Console.WriteLine($"Warning: JrePlaylistCsvUri '{_gcsOptions.JrePlaylistCsvUri}' does not specify an object name. Skipping playlist update.");
                    }
                    else
                    {
                        var updatedFields = new Dictionary<string, object> { { "isVectorized", true } };
                        await _gcsService.UpdateJrePlaylistMetadataAsync(
                            playlistBucketName,
                            rawTranscript.VideoId,
                            updatedFields,
                            playlistObjectName);
                    }
                }

                return Ok(new { Message = $"Successfully processed, vectorized, and saved {processedSegments.Count} segments from {_gcsOptions.InputDataUri} to {outputUri}. Playlist metadata updated.", SegmentsCount = processedSegments.Count });
            }
            catch (ArgumentException ex) // Catch specific URI parsing errors
            {
                return BadRequest($"Invalid GCS URI format in configuration: {ex.Message}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error processing transcript from {_gcsOptions.InputDataUri}: {ex.Message}");
                return StatusCode(StatusCodes.Status500InternalServerError, $"An error occurred: {ex.Message}");
            }
        }

        /// <summary>
        /// Triggers batch processing of all transcripts using URIs from configuration.
        /// Output embeddings will be placed in a corresponding structure under the OutputDataUri (config).
        /// </summary>
        /// <returns>Status of the batch initiation.</returns>
        [HttpPost("process-batch-transcripts")]
        [ProducesResponseType(StatusCodes.Status202Accepted)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status500InternalServerError)]
        public async Task<IActionResult> UploadBatchTranscripts()
        {
            if (string.IsNullOrEmpty(_gcsOptions.InputDataUri) || string.IsNullOrEmpty(_gcsOptions.SegmentedTranscriptDataUri))
            {
                return BadRequest("InputDataUri and SegmentedTranscriptDataUri must be configured in appsettings.");
            }

            try
            {
                (string inputBucket, string inputPrefix) = ParseGcsUri(_gcsOptions.InputDataUri);
                (string segmentedBucket, string segmentedPrefix) = ParseGcsUri(_gcsOptions.SegmentedTranscriptDataUri);

                string ensuredInputPrefix = string.IsNullOrEmpty(inputPrefix) ? "" : (inputPrefix.EndsWith("/") ? inputPrefix : inputPrefix + "/");
                string ensuredSegmentedPrefix = string.IsNullOrEmpty(segmentedPrefix) ? "" : (segmentedPrefix.EndsWith("/") ? segmentedPrefix : segmentedPrefix + "/");

                var transcriptFiles = await _gcsService.ListAllTranscriptFiles(inputBucket, ensuredInputPrefix);
                if (transcriptFiles.Count == 0)
                {
                    return NotFound($"No transcript files found at {_gcsOptions.InputDataUri}.");
                }

                var allSegments = new List<ProcessedTranscriptSegment>();
                int chunkSize = _appSettings.ChunkSettings?.MaxChunkDurationSeconds ?? 300;
                int overlap = _appSettings.ChunkSettings?.OverlapDurationSeconds ?? 30;

                foreach (var objectName in transcriptFiles)
                {
                    var raw = await _gcsService.GetSingleTranscript(inputBucket, objectName);
                    if (raw == null || string.IsNullOrWhiteSpace(raw.Transcript) || raw.TranscriptWithTimestamps.Count == 0)
                    {
                        Console.WriteLine($"Skipping empty or missing transcript: {objectName}");
                        continue;
                    }
                    if (string.IsNullOrEmpty(raw.VideoId))
                    {
                        var fileName = Path.GetFileNameWithoutExtension(objectName);
                        raw.VideoId = fileName.StartsWith("transcript-") ? fileName.Substring("transcript-".Length) : fileName;
                    }
                    var segments = _transcriptProcessor.ChunkTranscriptWithTimestamps(raw, chunkSize, overlap).ToList();
                    allSegments.AddRange(segments);
                    Console.WriteLine($"Processed {segments.Count} segments from {objectName}");
                }

                if (allSegments.Count == 0)
                {
                    return Ok("No segments generated from any transcripts.");
                }

                // Split allSegments into batches of 30,000
                const int maxBatchSize = 30000;
                int totalBatches = (int)Math.Ceiling(allSegments.Count / (double)maxBatchSize);
                var uploadedBatchUris = new List<string>();

                for (int i = 0; i < totalBatches; i++)
                {
                    var batch = allSegments.Skip(i * maxBatchSize).Take(maxBatchSize).ToList();
                    string batchObjectName = $"{ensuredSegmentedPrefix}jre-segments-batch-{i + 1}.ndjson";
                    string batchUri = await _gcsService.UploadSegmentedTranscriptNDJSONAsync(segmentedBucket, batchObjectName, batch);
                    uploadedBatchUris.Add(batchUri);
                    Console.WriteLine($"Uploaded batch {i + 1}/{totalBatches} to: {batchUri} ({batch.Count} segments)");
                }

                return Accepted(new { Message = $"Uploaded {uploadedBatchUris.Count} NDJSON batch files (max 30,000 segments each) to {_gcsOptions.SegmentedTranscriptDataUri}.", BatchFiles = uploadedBatchUris });
            }
            catch (ArgumentException ex)
            {
                return BadRequest($"Invalid GCS URI format in configuration: {ex.Message}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error during batch transcript processing: {ex.Message}");
                return StatusCode(StatusCodes.Status500InternalServerError, $"An error occurred during batch processing: {ex.Message}");
            }
        }
    }
}
