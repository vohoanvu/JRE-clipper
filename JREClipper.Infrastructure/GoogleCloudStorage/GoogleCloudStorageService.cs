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

        public async Task<List<string>> ListVideoFilesAsync(string bucketName, string prefix)
        {
            var videoFiles = new List<string>();
            var objects = _storageClient.ListObjectsAsync(bucketName, prefix);
            await foreach (var obj in objects)
            {
                if (!obj.Name.EndsWith("/")) // Exclude folders
                {
                    videoFiles.Add(obj.Name);
                }
            }
            return videoFiles;
        }

        public async Task<RawTranscriptData> GetTranscriptDataAsync(string bucketName, string objectName)
        {
            using var memoryStream = new MemoryStream();
            await _storageClient.DownloadObjectAsync(bucketName, objectName, memoryStream);
            memoryStream.Position = 0; // Reset stream position to the beginning
            using var reader = new StreamReader(memoryStream, Encoding.UTF8);
            var jsonContent = await reader.ReadToEndAsync();
            return JsonConvert.DeserializeObject<RawTranscriptData>(jsonContent) ?? new RawTranscriptData();
        }

        public async Task UploadVectorizedSegmentsAsync(string bucketName, string objectName, IEnumerable<VectorizedSegment> segments)
        {
            var jsonContent = JsonConvert.SerializeObject(segments, Formatting.Indented);
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(jsonContent));
            await _storageClient.UploadObjectAsync(bucketName, objectName, "application/json", stream);
        }
    }
}
