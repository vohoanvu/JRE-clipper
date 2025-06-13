// JREClipper.Core/Interfaces/IGoogleCloudStorageService.cs
using JREClipper.Core.Models;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace JREClipper.Core.Interfaces
{
    public interface IGoogleCloudStorageService
    {
        Task<List<string>> ListVideoFilesAsync(string bucketName, string prefix);
        Task<RawTranscriptData> GetTranscriptDataAsync(string bucketName, string objectName);
        Task UploadVectorizedSegmentsAsync(string bucketName, string objectName, IEnumerable<VectorizedSegment> segments);
        // Potentially add methods for VideoMetadata if it's also stored/retrieved from GCS
        // Task<VideoMetadata> GetVideoMetadataAsync(string bucketName, string videoId);
    }
}
