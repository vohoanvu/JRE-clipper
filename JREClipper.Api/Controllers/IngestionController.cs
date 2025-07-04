// JREClipper.Api/Controllers/IngestionController.cs
using System;
using System.Text;
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using JREClipper.Core.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Newtonsoft.Json;

namespace JREClipper.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class IngestionController : ControllerBase
    {
        private readonly IGoogleCloudStorageService _gcsService;
        private readonly ITranscriptProcessor _transcriptProcessor;
        private readonly IEmbeddingService _embeddingService;
        private readonly GoogleCloudStorageOptions _gcsOptions;
        private readonly AppSettings _appSettings;
        private readonly ILogger<IngestionController> _logger;
        private readonly UtteranceExtractorService _utteranceExtractorService;

        public IngestionController(
            IGoogleCloudStorageService gcsService,
            ITranscriptProcessor transcriptProcessor,
            Func<string, IEmbeddingService> embeddingServiceFactory, // Use factory
            IOptions<GoogleCloudStorageOptions> gcsOptions,
            IOptions<AppSettings> appSettings,
            ILogger<IngestionController> logger,
            UtteranceExtractorService utteranceExtractorService)
        {
            _gcsService = gcsService;
            _transcriptProcessor = transcriptProcessor;
            _appSettings = appSettings.Value;
            _embeddingService = embeddingServiceFactory(_appSettings.EmbeddingProvider!); // Get service from factory
            _gcsOptions = gcsOptions.Value;
            _logger = logger ?? throw new ArgumentNullException(nameof(logger), "Logger cannot be null. Ensure it is properly configured in DI.");
            _utteranceExtractorService = utteranceExtractorService;
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

        [HttpGet("get-utterances-from-transcript")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        [ProducesResponseType(StatusCodes.Status500InternalServerError)]
        /// <summary>
        /// Extracts utterances from all local transcript files, batches them, and uploads them as separate NDJSON files to GCS.
        /// </summary>
        /// <param name="localPath">The local directory path containing the transcript files (e.g., 'transcripts').</param>
        /// <param name="batchSize">The number of transcript files to process in each batch.</param>
        public async Task<IActionResult> GetUtterancesFromTranscript(
            [FromQuery] string localPath = "../transcriptions",
            [FromQuery] int maxInstancesPerBatch = 990000) // Changed parameter name for clarity
        {
            if (string.IsNullOrEmpty(localPath))
            {
                return BadRequest("Local path must be provided.");
            }
            if (maxInstancesPerBatch <= 0)
            {
                return BadRequest("Max instances per batch must be a positive integer.");
            }

            try
            {
                var fullPath = Path.GetFullPath(localPath);
                if (!Directory.Exists(fullPath))
                {
                    return NotFound($"The specified local directory does not exist: {fullPath}");
                }

                var transcriptFiles = Directory.GetFiles(fullPath, "transcript-*.json").ToList();
                if (transcriptFiles.Count == 0)
                {
                    return NotFound($"No transcript files matching 'transcript-*.json' found in {fullPath}.");
                }

                // --- PASS 1: EXTRACT ALL UTTERANCES INTO A SINGLE LIST ---
                _logger.LogInformation("Starting Pass 1: Extracting all utterances from {FileCount} transcript files...", transcriptFiles.Count);
                var allUtterances = new List<UtteranceForEmbedding>();

                foreach (var filePath in transcriptFiles)
                {
                    try
                    {
                        var jsonContent = await System.IO.File.ReadAllTextAsync(filePath);
                        var rawTranscript = JsonConvert.DeserializeObject<List<RawTranscriptData>>(jsonContent)?.FirstOrDefault();

                        if (rawTranscript == null || rawTranscript.TranscriptWithTimestamps.Count == 0)
                        {
                            _logger.LogWarning("Skipping empty or invalid transcript: {FilePath}", filePath);
                            continue;
                        }

                        // Populate VideoId if missing
                        if (string.IsNullOrEmpty(rawTranscript.VideoId))
                        {
                            var fileName = Path.GetFileNameWithoutExtension(filePath);
                            rawTranscript.VideoId = fileName.StartsWith("transcript-") ? fileName.Substring("transcript-".Length) : fileName;
                        }

                        var utterances = _utteranceExtractorService.ExtractUtterances(rawTranscript);
                        allUtterances.AddRange(utterances);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Error processing transcript file {FilePath}. It will be skipped.", filePath);
                    }
                }

                if (allUtterances.Count == 0)
                {
                    return NotFound("No utterances were extracted from any of the provided transcripts.");
                }
                _logger.LogInformation("Pass 1 Complete: Extracted a total of {TotalUtteranceCount} utterances.", allUtterances.Count);


                // --- PASS 2: SHARD AND UPLOAD THE AGGREGATED LIST ---
                int totalBatches = (int)Math.Ceiling((double)allUtterances.Count / maxInstancesPerBatch);
                var uploadedBatchUris = new List<string>();
                _logger.LogInformation("Starting Pass 2: Sharding {TotalUtteranceCount} utterances into {BatchCount} batches of up to {BatchSize} each.", allUtterances.Count, totalBatches, maxInstancesPerBatch);

                for (int i = 0; i < totalBatches; i++)
                {
                    var batchNumber = i + 1;
                    var batchUtterances = allUtterances
                        .Skip(i * maxInstancesPerBatch)
                        .Take(maxInstancesPerBatch)
                        .ToList();

                    if (!batchUtterances.Any())
                    {
                        _logger.LogWarning("Batch {BatchNum} is empty, skipping upload.", batchNumber);
                        continue;
                    }

                    // Define a unique GCS path for each batch's input file
                    var outputFileName = $"utterances_batch_{batchNumber}.jsonl";
                    var batchOutputUri = $"gs://jre-processed-clips-bucker/utterances-for-embedding/{outputFileName}";

                    _logger.LogInformation("Uploading {UtteranceCount} utterances for batch {BatchNum} to {Uri}", batchUtterances.Count, batchNumber, batchOutputUri);

                    var uploadedUri = await _gcsService.UploadAllUtterancesToGcsAsync(batchOutputUri, batchUtterances);
                    uploadedBatchUris.Add(uploadedUri);
                }

                return Ok(new
                {
                    Message = $"Successfully sharded {allUtterances.Count} utterances into {uploadedBatchUris.Count} batch files.",
                    TotalTranscriptsProcessed = transcriptFiles.Count,
                    TotalUtterancesExtracted = allUtterances.Count,
                    TotalBatchesCreated = uploadedBatchUris.Count,
                    OutputFileUris = uploadedBatchUris
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "An unexpected error occurred during the utterance preparation process.");
                return StatusCode(StatusCodes.Status500InternalServerError, $"An error occurred: {ex.Message}");
            }
        }


        [HttpPost("create-indexed-embeddings")]
        public async Task<IActionResult> CreateIndexedEmbeddings()
        {
            try
            {
                var embeddingSourceDirectories = new List<string>
                {
                    "../utterence-embedding-results-1/",
                    "../utterence-embedding-results-2/",
                    "../utterence-embedding-results-3/",
                    "../utterence-embedding-results-4/"
                };
                var outputIndexDirectory = Path.GetFullPath("../indexed-embeddings/");
                Directory.CreateDirectory(outputIndexDirectory);

                _logger.LogInformation("Starting one-time embedding indexing process...");

                // --- FIX: This dictionary will now track which files have been created, not open streams ---
                var createdVideoFiles = new HashSet<string>();

                foreach (var directoryPath in embeddingSourceDirectories)
                {
                    _logger.LogInformation("Processing source directory: {DirectoryPath}", Path.GetFullPath(directoryPath));
                    var embeddingFiles = Directory.GetFiles(Path.GetFullPath(directoryPath), "*.jsonl");
                    foreach (var filePath in embeddingFiles)
                    {
                        _logger.LogInformation("Processing source file: {FileName}", Path.GetFileName(filePath));

                        // Read all lines from the source file at once for simplicity
                        var lines = await System.IO.File.ReadAllLinesAsync(filePath);

                        foreach (var line in lines)
                        {
                            if (string.IsNullOrWhiteSpace(line)) continue;

                            var idMatch = System.Text.RegularExpressions.Regex.Match(line, @"""id""\s*:\s*""([^""]+)""");
                            if (!idMatch.Success) continue;

                            var fullId = idMatch.Groups[1].Value;
                            var videoId = fullId.Split('_').FirstOrDefault();

                            if (string.IsNullOrEmpty(videoId)) continue;

                            var outputFilePath = Path.Combine(outputIndexDirectory, $"{videoId}.jsonl");

                            // --- FIX: Open, Append, and Close the file in one atomic operation ---
                            // Use a StreamWriter with `append: true` to add to the file if it exists,
                            // or create it if it doesn't. The `using` statement guarantees it's closed immediately.
                            using (var writer = new StreamWriter(outputFilePath, append: true))
                            {
                                await writer.WriteLineAsync(line);
                            }

                            // Keep track of how many unique files we've touched.
                            createdVideoFiles.Add(outputFilePath);
                        }
                        
                        _logger.LogInformation("Processed {LineCount} lines from {FileName}", lines.Length, Path.GetFileName(filePath));
                    }
                }

                _logger.LogInformation("Indexing complete.");
                return Ok($"Successfully created or appended to {createdVideoFiles.Count} indexed embedding files in {outputIndexDirectory}");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to create indexed embeddings.");
                return StatusCode(500, ex.Message);
            }
        }


        [HttpPost("run-semantic-chunking")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        [ProducesResponseType(StatusCodes.Status500InternalServerError)]
        /// <summary>
        /// Runs semantic chunking on all trancript utterances with embeddings in Google Cloud Storage.
        /// </summary>
        /// <returns>Status of the semantic chunking process.</returns>
        public async Task<IActionResult> RunSematicChunking()
        {
            try
            {
                // --- Setup Phase ---
                var transcriptDirectory = Path.GetFullPath("../transcriptions/");
                var indexedEmbeddingDirectory = "../indexed-embeddings/"; // Point to the new indexed directory
                var transcriptFiles = Directory.GetFiles(transcriptDirectory, "*.json");

                // --- Streaming Upload Setup ---
                string batchObjectName = "final-semantic-chunks/jre-segments-all.ndjson";
                string gcsUri = $"gs://jre-processed-clips-bucker/{batchObjectName}";
                _logger.LogInformation("Starting FAST streaming chunking process using indexed embeddings...");
                long totalSegmentsGenerated = 0;

                using (var uploadStream = new MemoryStream())
                using (var writer = new StreamWriter(uploadStream, new UTF8Encoding(false), leaveOpen: true))
                {
                    // --- Main Processing Loop ---
                    for (int i = 0; i < transcriptFiles.Length; i++)
                    {
                        var transcriptFile = transcriptFiles[i];
                        _logger.LogInformation("Processing transcript {Current}/{Total}: {FileName}", i + 1, transcriptFiles.Length, Path.GetFileName(transcriptFile));

                        var jsonContent = await System.IO.File.ReadAllTextAsync(transcriptFile);
                        var raw = JsonConvert.DeserializeObject<List<RawTranscriptData>>(jsonContent)?.FirstOrDefault();

                        if (raw == null || raw.TranscriptWithTimestamps.Count == 0 || string.IsNullOrEmpty(raw.Transcript)) continue;

                        if (string.IsNullOrEmpty(raw.VideoId))
                        {
                            var fileName = Path.GetFileNameWithoutExtension(transcriptFile);
                            raw.VideoId = fileName.StartsWith("transcript-") ? fileName.Substring("transcript-".Length) : fileName;
                        }

                        var embeddingsForThisVideo = await _gcsService.GetEmbeddingsForSingleVideoAsync(indexedEmbeddingDirectory, raw.VideoId);
                        _logger.LogInformation("Loaded {EmbeddingCount} embeddings for Video ID {VideoId}", embeddingsForThisVideo.Count, raw.VideoId);
                        var segments = _transcriptProcessor.ChunkTranscriptFromPrecomputedEmbeddings(raw, embeddingsForThisVideo);

                        foreach (var segment in segments)
                        {
                            var record = new
                            {
                                id = segment.SegmentId,
                                content = segment.Text,
                                structData = new
                                {
                                    videoId = segment.VideoId,
                                    startTime = segment.StartTime.TotalSeconds,
                                    endTime = segment.EndTime.TotalSeconds,
                                    videoTitle = segment.VideoTitle,
                                    channelName = segment.ChannelName
                                }
                            };
                            var jsonLine = JsonConvert.SerializeObject(record);
                            await writer.WriteLineAsync(jsonLine);
                            totalSegmentsGenerated++;
                        }
                    }

                    // --- Final Upload (No changes here) ---
                    await writer.FlushAsync();
                    uploadStream.Position = 0;
                    _logger.LogInformation("All transcripts processed. Uploading {SegmentCount} total segments to GCS...", totalSegmentsGenerated);
                    await _gcsService.UploadStreamToGcsAsync("jre-processed-clips-bucker", batchObjectName, uploadStream);
                }

                return Accepted(new
                {
                    Message = $"Successfully chunked {transcriptFiles.Length} transcripts into {totalSegmentsGenerated} segments.",
                    OutputFileUri = gcsUri
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "A critical error occurred during the semantic chunking process.");
                return StatusCode(StatusCodes.Status500InternalServerError, $"An error occurred: {ex.Message}");
            }
        }
    }
}
