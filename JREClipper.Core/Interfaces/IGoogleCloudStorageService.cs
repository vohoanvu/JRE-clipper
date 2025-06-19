// JREClipper.Core/Interfaces/IGoogleCloudStorageService.cs
using JREClipper.Core.Models;
using JREClipper.Core.Services;

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
        Task UpdateJrePlaylistMetadataAsync(string bucketName, string videoId, Dictionary<string, object> updatedFields, string objectName);

        Task UploadVectorizedSegmentsAsync(string bucketName, string objectName, IEnumerable<VectorizedSegment> segments);

        /// <summary>
        /// Creates and uploads a new NDJSON file to Google Cloud Storage from a list of segmented transcripts.
        /// Each line in the NDJSON file will be in the format: {"content":"transcript_segment"}.
        /// </summary>
        /// <param name="bucketName">The GCS bucket name.</param>
        /// <param name="objectName">The desired object name for the new NDJSON file in GCS.</param>
        /// <param name="segmentedTranscripts">A list of strings, where each string is a transcript segment.</param>
        /// <returns>The GCS URI of the uploaded NDJSON file (e.g., gs://bucketName/objectName).</returns>
        Task<string> UploadSegmentedTranscriptNDJSONAsync(string bucketName, string objectName, List<ProcessedTranscriptSegment> segmentedTranscripts);

        Task<string> UploadAllUtterancesToGcsAsync(string outputUtteranceFileUri, List<UtteranceForEmbedding> allUtterancesForEmbedding);

        Task<VideoMetadata?> GetVideoMetadataAsync(string bucketName, string playlistCsvObject, string videoId);

        Task<IReadOnlyDictionary<string, float[]>> DownloadLocalEmbeddingResultsAsync(string localDirectoryPath);
        Task<IReadOnlyDictionary<string, VideoMetadata>> LoadAllVideoMetadataAsync(string localCsvPath);
    }
}
