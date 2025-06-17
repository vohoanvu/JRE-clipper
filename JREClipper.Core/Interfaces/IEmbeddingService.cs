// JREClipper.Core/Interfaces/IEmbeddingService.cs

namespace JREClipper.Core.Interfaces
{
    public interface IEmbeddingService
    {
        Task<List<float>> GenerateEmbeddingsAsync(string text);

        /// <summary>
        /// Generates embeddings for a batch of texts provided via a GCS URI pointing to an NDJSON file.
        /// Each line in the NDJSON file should be a JSON object, e.g., {"content": "text to embed", "id": "optional_id"}.
        /// </summary>
        /// <param name="inputGcsUri">The GCS URI of the input NDJSON file.</param>
        /// <param name="outputGcsUri">The GCS URI where the output embeddings will be stored in NDJSON format.</param>
        /// <returns>The GCS URI where the output embeddings will be storeds</returns>
        Task<string> GenerateEmbeddingsBatchAsync(string inputGcsUri, string outputGcsUri);
    }
}
