// JREClipper.Infrastructure/GoogleCloudStorage/GoogleCloudStorageService.cs
using Google.Cloud.Storage.V1;
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using Newtonsoft.Json;
using System.Text;

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
            return JsonConvert.DeserializeObject<RawTranscriptData>(jsonContent) ?? new RawTranscriptData();
        }

        public async Task UpdateJrePlaylistMetadataAsync(
            string bucketName,
            string videoId,
            Dictionary<string, object> updatedFields,
            string objectName = "jre-playlist.csv")
        {
            if (updatedFields == null || updatedFields.Count == 0)
            {
                // Nothing to update
                return;
            }

            var memoryStream = new MemoryStream();
            try
            {
                await _storageClient.DownloadObjectAsync(bucketName, objectName, memoryStream);
            }
            catch (Google.GoogleApiException ex) when (ex.Error?.Code == 404)
            {
                // If the goal is to modify, the file must exist.
                throw new FileNotFoundException($"Playlist file '{objectName}' not found in bucket '{bucketName}'.", ex);
            }

            memoryStream.Position = 0;

            var lines = new List<string>();
            bool entryFound = false;
            string[]? csvHeaders = null;

            using (var reader = new StreamReader(memoryStream, Encoding.UTF8))
            {
                string? headerLine = await reader.ReadLineAsync() ?? throw new InvalidOperationException($"Playlist file '{objectName}' is empty or does not contain a header.");
                lines.Add(headerLine);
                csvHeaders = headerLine.Split(','); // Assumes simple CSV, no commas in header names

                string? currentLine;
                while ((currentLine = await reader.ReadLineAsync()) != null)
                {
                    // WARNING: This Split(',') is not robust for CSV fields containing commas.
                    // Consider using a proper CSV parsing library.
                    var values = currentLine.Split(',');

                    if (values.Length > 0 && values[0] == videoId) // Assuming videoId is always the first column
                    {
                        entryFound = true;
                        for (int i = 0; i < csvHeaders.Length; i++)
                        {
                            string columnName = csvHeaders[i].Trim();
                            if (updatedFields.TryGetValue(columnName, out object? newValueObj))
                            {
                                // Convert the object value to string.
                                // bool.ToString() produces "True" or "False", which matches your example.
                                values[i] = newValueObj?.ToString() ?? string.Empty;
                            }
                        }
                        lines.Add(string.Join(",", values));
                    }
                    else
                    {
                        lines.Add(currentLine);
                    }
                }
            }

            if (!entryFound)
            {
                throw new KeyNotFoundException($"Video ID '{videoId}' not found in playlist '{objectName}'.");
            }

            // Upload the updated CSV
            var updatedContent = string.Join(Environment.NewLine, lines);
            using var uploadStream = new MemoryStream(Encoding.UTF8.GetBytes(updatedContent));
            try
            {
                await _storageClient.UploadObjectAsync(bucketName, objectName, "text/csv", uploadStream);
            }
            catch (Exception ex)
            {
                // Log error or wrap in a custom exception
                throw new Exception($"Failed to upload updated playlist metadata to '{objectName}': {ex.Message}", ex);
            }
        }

        public async Task UploadVectorizedSegmentsAsync(string bucketName, string objectName, IEnumerable<VectorizedSegment> segments)
        {
            var jsonContent = JsonConvert.SerializeObject(segments, Formatting.Indented);
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(jsonContent));
            await _storageClient.UploadObjectAsync(bucketName, objectName, "application/json", stream);
        }
    }
}
