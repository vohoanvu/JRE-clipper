// JREClipper.Infrastructure/GoogleCloudStorage/GoogleCloudStorageService.cs
using Google.Cloud.Storage.V1;
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using Newtonsoft.Json;
using System.Text;
using CsvHelper;
using System.Globalization;
using JREClipper.Core.Services;
using Microsoft.Extensions.Logging;

namespace JREClipper.Infrastructure.GoogleCloudStorage
{
    public class GoogleCloudStorageService : IGoogleCloudStorageService
    {
        private readonly StorageClient _storageClient;
        private readonly ILogger<GoogleCloudStorageService> _logger;

        public GoogleCloudStorageService(StorageClient storageClient,
            ILogger<GoogleCloudStorageService> logger)
        {
            _storageClient = storageClient;
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        public async Task<VideoMetadata?> GetVideoMetadataAsync(string bucketName, string playlistCsvObject, string videoId)
        {
            try
            {
                using var memoryStream = new MemoryStream();
                await _storageClient.DownloadObjectAsync(bucketName, playlistCsvObject, memoryStream);
                memoryStream.Position = 0; // Reset for reading

                using var reader = new StreamReader(memoryStream, Encoding.UTF8);
                using var csv = new CsvReader(reader, CultureInfo.InvariantCulture);

                await csv.ReadAsync();
                csv.ReadHeader();

                while (await csv.ReadAsync())
                {
                    var record = csv.GetRecord<JrePlaylistCsvRow>();
                    if (record != null && record.videoId == videoId)
                    {
                        return new VideoMetadata
                        {
                            VideoId = record.videoId,
                            Title = record.title ?? string.Empty,
                            ChannelName = "The Joe Rogan Experience"
                        };
                    }
                }

                // If the loop completes, the videoId was not found.
                return null;
            }
            catch (Google.GoogleApiException ex) when (ex.Error?.Code == 404)
            {
                // It's good practice to know if the file itself is missing.
                throw new FileNotFoundException($"Playlist CSV file '{playlistCsvObject}' not found in bucket '{bucketName}'.", ex);
            }
        }

        public async Task<List<string>> ListAllTranscriptFiles(string bucketName, string prefix)
        {
            var videoFiles = new List<string>();
            var objects = _storageClient.ListObjectsAsync(bucketName, prefix);
            await foreach (var obj in objects)
            {
                if (!obj.Name.EndsWith('/') && obj.Name.StartsWith("transcriptions/transcript-") && obj.Name.EndsWith(".json")) // Exclude folders
                {
                    videoFiles.Add(obj.Name);
                }
            }
            return videoFiles;
        }

        public async Task<RawTranscriptData> GetSingleTranscript(string bucketName, string objectName)
        {
            using var memoryStream = new MemoryStream();
            await _storageClient.DownloadObjectAsync(bucketName, objectName, memoryStream);
            memoryStream.Position = 0; // Reset stream position to the beginning
            using var reader = new StreamReader(memoryStream, Encoding.UTF8);
            var jsonContent = await reader.ReadToEndAsync();
            var parseJsonArray = JsonConvert.DeserializeObject<List<RawTranscriptData>>(jsonContent) ?? [];

            return parseJsonArray.FirstOrDefault() ?? new RawTranscriptData
            {
                VideoId = string.Empty,
                Transcript = string.Empty,
                ChannelName = string.Empty,
                VideoTitle = string.Empty
            };
        }

        public async Task UpdateJrePlaylistMetadataAsync(string bucketName, string videoId, Dictionary<string, object> updatedFields, string objectName)
        {
            if (updatedFields == null || updatedFields.Count == 0)
                return;

            // Download and parse CSV
            List<JrePlaylistCsvRow> records;
            using (var downloadStream = new MemoryStream())
            {
                try
                {
                    await _storageClient.DownloadObjectAsync(bucketName, objectName, downloadStream);
                }
                catch (Google.GoogleApiException ex) when (ex.Error?.Code == 404)
                {
                    throw new FileNotFoundException($"Playlist file '{objectName}' not found in bucket '{bucketName}'.", ex);
                }
                downloadStream.Position = 0;

                using var reader = new StreamReader(downloadStream, Encoding.UTF8);
                using var csvReader = new CsvReader(reader, CultureInfo.InvariantCulture);
                if (!csvReader.Read() || !csvReader.ReadHeader())
                    throw new InvalidDataException($"CSV '{objectName}' has no header row.");
                records = [.. csvReader.GetRecords<JrePlaylistCsvRow>()];
            }

            if (records.Count == 0)
                throw new InvalidDataException($"CSV '{objectName}' is empty or contains no records.");

            // Update the target record
            var record = records.FirstOrDefault(r => r.videoId == videoId)
                ?? throw new KeyNotFoundException($"Video ID '{videoId}' not found in playlist '{objectName}'.");
            foreach (var kvp in updatedFields)
            {
                var prop = typeof(JrePlaylistCsvRow).GetProperty(kvp.Key);
                if (prop != null && kvp.Value != null)
                    prop.SetValue(record, kvp.Value.ToString());
            }

            // Write updated CSV back to stream
            using var uploadStream = new MemoryStream();
            using var writer = new StreamWriter(uploadStream, Encoding.UTF8, leaveOpen: true);
            using var csvWriter = new CsvWriter(writer, CultureInfo.InvariantCulture);
            csvWriter.WriteRecords(records);
            await writer.FlushAsync();
            uploadStream.Position = 0;
            await _storageClient.UploadObjectAsync(bucketName, objectName, "text/csv", uploadStream);
        }

        public async Task UploadVectorizedSegmentsAsync(string bucketName, string objectName, IEnumerable<VectorizedSegment> segments)
        {
            using var memoryStream = new MemoryStream();
            using (var writer = new StreamWriter(memoryStream, Encoding.UTF8, bufferSize: 1024, leaveOpen: true))
            {
                foreach (var segment in segments)
                {
                    // Create an object that matches the Vertex AI required structure for each line.
                    var record = new
                    {
                        id = segment.SegmentId, // "id" (string, required)
                        embedding = segment.Embedding, // "embedding" (array of numbers, required)
                        videoId = segment.VideoId,
                        text = segment.Text,
                        startTime = segment.StartTime,
                        endTime = segment.EndTime,
                        channelName = segment.ChannelName,
                        videoTitle = segment.VideoTitle
                    };

                    var jsonLine = JsonConvert.SerializeObject(record);

                    await writer.WriteLineAsync(jsonLine);
                }
                await writer.FlushAsync();
            }

            memoryStream.Position = 0;
            await _storageClient.UploadObjectAsync(bucketName, objectName, "application/x-ndjson", memoryStream);
        }

        public async Task<string> UploadSegmentedTranscriptNDJSONAsync(string bucketName, string objectName, List<ProcessedTranscriptSegment> segmentedTranscripts)
        {
            if (string.IsNullOrEmpty(bucketName))
            {
                throw new ArgumentNullException(nameof(bucketName));
            }
            if (string.IsNullOrEmpty(objectName))
            {
                throw new ArgumentNullException(nameof(objectName));
            }

            using var memoryStream = new MemoryStream();
            using (var writer = new StreamWriter(memoryStream, new UTF8Encoding(false), bufferSize: 1024, leaveOpen: true))
            {
                foreach (var transcriptSegment in segmentedTranscripts)
                {
                    // Create a nested object for structData to match the Vertex AI Search schema.
                    var record = new
                    {
                        id = transcriptSegment.SegmentId,
                        content = transcriptSegment.Text,
                        structData = new
                        {
                            videoId = transcriptSegment.VideoId,
                            startTime = transcriptSegment.StartTime.TotalSeconds,
                            endTime = transcriptSegment.EndTime.TotalSeconds,
                            videoTitle = transcriptSegment.VideoTitle,
                            channelName = transcriptSegment.ChannelName
                        }
                    };

                    var jsonLine = JsonConvert.SerializeObject(record);
                    await writer.WriteLineAsync(jsonLine);
                }
                await writer.FlushAsync();
            }

            memoryStream.Position = 0;
            await _storageClient.UploadObjectAsync(bucketName, objectName, "application/x-ndjson", memoryStream);

            return $"gs://{bucketName}/{objectName}";
        }

        public async Task<string> UploadAllUtterancesToGcsAsync(string outputUtteranceFileUri, List<UtteranceForEmbedding> allUtterancesForEmbedding)
        {
            if (!outputUtteranceFileUri.StartsWith("gs://"))
                throw new ArgumentException("Output URI must start with gs://", nameof(outputUtteranceFileUri));

            var uriParts = outputUtteranceFileUri.Substring(5).Split('/', 2);
            if (uriParts.Length != 2)
                throw new ArgumentException("Invalid GCS URI format.", nameof(outputUtteranceFileUri));

            var bucketName = uriParts[0];
            var objectName = uriParts[1];

            using var memoryStream = new MemoryStream();
            // Using a StreamWriter is efficient for writing line by line.
            using (var writer = new StreamWriter(memoryStream, new UTF8Encoding(false), bufferSize: 1024, leaveOpen: true))
            {
                foreach (var utterance in allUtterancesForEmbedding)
                {
                    var utteranceRecord = new
                    {
                        id = utterance.Id,
                        content = utterance.Text,
                    };
                    var jsonLine = JsonConvert.SerializeObject(utteranceRecord);
                    await writer.WriteLineAsync(jsonLine);
                }
                await writer.FlushAsync();
            }

            memoryStream.Position = 0;

            await _storageClient.UploadObjectAsync(bucketName, objectName, "application/x-ndjson", memoryStream);

            return $"gs://{bucketName}/{objectName}";
        }

        public async Task<IReadOnlyDictionary<string, float[]>> DownloadLocalEmbeddingResultsAsync(
            string localDirectoryPath = "../utterence-embedding-results/")
        {
            if (string.IsNullOrEmpty(localDirectoryPath)) throw new ArgumentNullException(nameof(localDirectoryPath));

            var result = new Dictionary<string, float[]>();
            var fullPath = Path.GetFullPath(localDirectoryPath);

            if (!Directory.Exists(fullPath))
            {
                _logger.LogError("The specified local directory does not exist: {DirectoryPath}", fullPath);
                throw new DirectoryNotFoundException($"The specified local directory does not exist: {fullPath}");
            }

            // Get all .ndjson files from the directory
            var embeddingFiles = Directory.GetFiles(fullPath, "*.jsonl");

            if (embeddingFiles.Length == 0)
            {
                _logger.LogWarning("No '.jsonl' files found in directory: {DirectoryPath}", fullPath);
                return result; // Return empty dictionary
            }

            foreach (var filePath in embeddingFiles)
            {
                _logger.LogInformation("Processing embedding result file: {FileName}", Path.GetFileName(filePath));

                // Use File.OpenRead for efficient reading
                using var stream = File.OpenRead(filePath);
                using var reader = new StreamReader(stream, Encoding.UTF8);
                string? line;
                while ((line = await reader.ReadLineAsync()) != null)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;

                    try
                    {
                        var embeddingResult = JsonConvert.DeserializeObject<EmbeddingPredictionResult>(line);

                        if (embeddingResult?.Instance?.Id != null && embeddingResult.Predictions?.FirstOrDefault()?.Embeddings?.Values != null)
                        {
                            string id = embeddingResult.Instance.Id;
                            float[] embedding = embeddingResult.Predictions[0].Embeddings.Values;
                            result[id] = embedding;
                        }
                        else
                        {
                            _logger.LogError("Skipping invalid or incomplete line in embedding result file: {Line}", line);
                        }
                    }
                    catch (JsonException ex)
                    {
                        _logger.LogError(ex, "Failed to deserialize line in {FilePath}: {Line}", filePath, line);
                    }
                }
            }

            _logger.LogInformation("Successfully loaded {EmbeddingCount} embeddings from {FileCount} files.", result.Count, embeddingFiles.Length);
            return result;
        }

        /// <summary>
        /// Loads and parses a local playlist CSV file into a dictionary for fast lookups.
        /// </summary>
        /// <param name="localCsvPath">The local file path for the playlist CSV.</param>
        /// <returns>A dictionary mapping video IDs to their metadata.</returns>
        public async Task<IReadOnlyDictionary<string, VideoMetadata>> LoadAllVideoMetadataAsync(string localCsvPath = "../jre-playlist_cleaned.csv")
        {
            // OPTIMIZATION: Loads metadata only ONCE
            var metadataDict = new Dictionary<string, VideoMetadata>();
            var fullPath = Path.GetFullPath(localCsvPath);

            if (!File.Exists(fullPath))
            {
                _logger.LogError("Playlist CSV file not found at the specified path: {FilePath}", fullPath);
                throw new FileNotFoundException($"Playlist CSV file not found at the specified path: {fullPath}");
            }

            try
            {
                using var stream = File.OpenRead(fullPath);
                using var reader = new StreamReader(stream, Encoding.UTF8);
                using var csv = new CsvReader(reader, CultureInfo.InvariantCulture);

                await csv.ReadAsync();
                csv.ReadHeader();

                while (await csv.ReadAsync())
                {
                    var record = csv.GetRecord<JrePlaylistCsvRow>();
                    if (record != null && !string.IsNullOrEmpty(record.videoId))
                    {
                        metadataDict[record.videoId] = new VideoMetadata
                        {
                            VideoId = record.videoId,
                            Title = record.title ?? string.Empty,
                            ChannelName = "The Joe Rogan Experience" // Default value
                        };
                    }
                }
                return metadataDict;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to read or parse the local playlist CSV file: {FilePath}", fullPath);
                // Re-throw the exception to let the caller know something went wrong.
                throw;
            }
        }


        public async Task<IReadOnlyDictionary<string, float[]>> GetEmbeddingsForSingleVideoAsync(
        string indexedEmbeddingDirectory, string videoId)
        {
            var result = new Dictionary<string, float[]>();
            var filePath = Path.Combine(Path.GetFullPath(indexedEmbeddingDirectory), $"{videoId}.jsonl");

            if (!File.Exists(filePath))
            {
                _logger.LogWarning("Indexed embedding file not found for Video ID {VideoId} at path {FilePath}", videoId, filePath);
                return result;
            }

            using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream);
            string? line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    var embeddingResult = JsonConvert.DeserializeObject<EmbeddingPredictionResult>(line);
                    if (embeddingResult?.Instance?.Id != null && embeddingResult.Predictions?.FirstOrDefault()?.Embeddings?.Values != null)
                    {
                        result[embeddingResult.Instance.Id] = embeddingResult.Predictions[0].Embeddings.Values;
                    }
                }
                catch (JsonException ex)
                {
                    _logger.LogError(ex, "Failed to deserialize line in indexed file {FilePath}: {Line}", filePath, line);
                }
            }
            return result;
        }

        public async Task UploadStreamToGcsAsync(string buckerName, string trancriptSegmentResulsObject, MemoryStream dataStream)
        {
            if (dataStream == null || dataStream.Length == 0)
            {
                throw new ArgumentException("Data stream cannot be null or empty.", nameof(dataStream));
            }

            await _storageClient.UploadObjectAsync(buckerName, trancriptSegmentResulsObject, "application/x-ndjson", dataStream);
            _logger.LogInformation("Successfully uploaded stream to GCS bucket '{BucketName}' with object name '{ObjectName}'.", buckerName, trancriptSegmentResulsObject);
        }
    }

    public class JrePlaylistCsvRow
    {
        public string? videoId { get; set; }
        public string? title { get; set; }
        public string? description { get; set; }
        public string? date { get; set; }
        public string? Url { get; set; }
        public string? isTranscripted { get; set; }
        public string? isVectorized { get; set; }
        public string? isEmptyTranscript { get; set; }
    }
}
