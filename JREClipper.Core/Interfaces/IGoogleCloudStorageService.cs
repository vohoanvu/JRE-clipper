// JREClipper.Core/Interfaces/IGoogleCloudStorageService.cs
using JREClipper.Core.Models;

namespace JREClipper.Core.Interfaces
{
    public interface IGoogleCloudStorageService
    {
        Task<List<string>> ListAllTranscriptFiles(string bucketName, string prefix);
        Task<RawTranscriptData> GetSingleTranscript(string bucketName, string objectName);

        /// <summary>
        /// Updates specific fields for a given videoId in the JRE playlist CSV.
        /// Throws an exception if the playlist file or videoId is not found.
        /// Note: This implementation uses basic string splitting for CSV parsing, which may not be robust
        /// for fields containing commas. Consider using a library like CsvHelper for production use.
        /// </summary>
        /// <param name="bucketName">The GCS bucket name.</param>
        /// <param name="videoId">The ID of the video entry to update.</param>
        /// <param name="updatedFields">A dictionary where keys are column names and values are the new field values.</param>
        /// <param name="objectName">The name of the CSV file in GCS.</param>
        Task UpdateJrePlaylistMetadataAsync(string bucketName, string videoId, Dictionary<string, object> updatedFields, string objectName = "jre-playlist.csv");

        Task UploadVectorizedSegmentsAsync(string bucketName, string objectName, IEnumerable<VectorizedSegment> segments);
        // Potentially add methods for VideoMetadata if it's also stored/retrieved from GCS
        // Task<VideoMetadata> GetVideoMetadataAsync(string bucketName, string videoId);
    }
}
