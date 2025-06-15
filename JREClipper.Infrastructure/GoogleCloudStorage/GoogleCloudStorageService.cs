// JREClipper.Infrastructure/GoogleCloudStorage/GoogleCloudStorageService.cs
using Google.Cloud.Storage.V1;
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using Newtonsoft.Json;
using System.Text;
using CsvHelper;
using CsvHelper.Configuration;
using System.Dynamic;
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
            if (updatedFields == null || !updatedFields.Any())
                return;

            // Download existing CSV
            var downloadStream = new MemoryStream();
            try
            {
                await _storageClient.DownloadObjectAsync(bucketName, objectName, downloadStream);
            }
            catch (Google.GoogleApiException ex) when (ex.Error?.Code == 404)
            {
                throw new FileNotFoundException($"Playlist file '{objectName}' not found in bucket '{bucketName}'.", ex);
            }
            downloadStream.Position = 0;

            // Parse CSV using CsvHelper
            List<dynamic> records;
            using (var reader = new StreamReader(downloadStream, Encoding.UTF8))
            using (var csvReader = new CsvReader(reader, new CsvConfiguration(CultureInfo.InvariantCulture) { HasHeaderRecord = true }))
            {
                records = csvReader.GetRecords<dynamic>().ToList();
            }

            bool entryFound = false;
            // Update the matching record
            foreach (IDictionary<string, object> record in records.Cast<IDictionary<string, object>>())
            {
                if (record.TryGetValue("videoId", out var id) && id?.ToString() == videoId)
                {
                    entryFound = true;
                    foreach (var kvp in updatedFields)
                    {
                        if (record.ContainsKey(kvp.Key))
                            record[kvp.Key] = kvp.Value;
                    }
                    break;
                }
            }
            if (!entryFound)
                throw new KeyNotFoundException($"Video ID '{videoId}' not found in playlist '{objectName}'.");

            // Write updated CSV back to stream
            var uploadStream = new MemoryStream();
            using (var writer = new StreamWriter(uploadStream, Encoding.UTF8, leaveOpen: true))
            using (var csvWriter = new CsvWriter(writer, new CsvConfiguration(CultureInfo.InvariantCulture) { HasHeaderRecord = true }))
            {
                csvWriter.WriteRecords(records);
                await writer.FlushAsync();
            }
            uploadStream.Position = 0;
            // Upload overwrite
            await _storageClient.UploadObjectAsync(bucketName, objectName, "text/csv", uploadStream);
        }

        public async Task UploadVectorizedSegmentsAsync(string bucketName, string objectName, IEnumerable<VectorizedSegment> segments)
        {
            var jsonContent = JsonConvert.SerializeObject(segments, Formatting.Indented);
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(jsonContent));
            await _storageClient.UploadObjectAsync(bucketName, objectName, "application/json", stream);
        }
    }
}
