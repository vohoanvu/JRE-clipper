// JREClipper.Infrastructure/GoogleCloudStorage/GoogleCloudStorageService.cs
using Google.Cloud.Storage.V1;
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using Newtonsoft.Json;
using System.Text;
using CsvHelper;
using System.Globalization;

namespace JREClipper.Infrastructure.GoogleCloudStorage
{
    public class GoogleCloudStorageService : IGoogleCloudStorageService
    {
        private readonly StorageClient _storageClient;

        public GoogleCloudStorageService(StorageClient storageClient)
        {
            _storageClient = storageClient;
        }

        public async Task<List<string>> ListAllTranscriptFiles(string bucketName, string prefix)
        {
            var videoFiles = new List<string>();
            var objects = _storageClient.ListObjectsAsync(bucketName, prefix);
            await foreach (var obj in objects)
            {
                if (!obj.Name.EndsWith('/')) // Exclude folders
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

        public async Task UpdateJrePlaylistMetadataAsync(
            string bucketName,
            string videoId,
            Dictionary<string, object> updatedFields,
            string objectName)
        {
            if (updatedFields == null || updatedFields.Count == 0)
                return;

            // Download and parse CSV
            List<JrePlaylistRow> records;
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
                records = [.. csvReader.GetRecords<JrePlaylistRow>()];
            }

            if (records.Count == 0)
                throw new InvalidDataException($"CSV '{objectName}' is empty or contains no records.");

            // Update the target record
            var record = records.FirstOrDefault(r => r.videoId == videoId)
                ?? throw new KeyNotFoundException($"Video ID '{videoId}' not found in playlist '{objectName}'.");
            foreach (var kvp in updatedFields)
            {
                var prop = typeof(JrePlaylistRow).GetProperty(kvp.Key);
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
    }

    public class JrePlaylistRow
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
