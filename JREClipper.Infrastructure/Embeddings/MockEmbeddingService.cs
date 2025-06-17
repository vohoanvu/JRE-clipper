// JREClipper.Infrastructure/Embeddings/MockEmbeddingService.cs
using JREClipper.Core.Interfaces;

namespace JREClipper.Infrastructure.Embeddings
{
    public class MockEmbeddingService : IEmbeddingService
    {
        private readonly int _embeddingDimension;

        public MockEmbeddingService(int embeddingDimension = 768) // Common dimension size
        {
            _embeddingDimension = embeddingDimension;
        }

        public Task<List<float>> GenerateEmbeddingsAsync(string text)
        {
            // Simulate embedding generation by creating a list of random floats
            var random = new Random(text.GetHashCode()); // Seed with text hash for some consistency
            var embedding = Enumerable.Range(0, _embeddingDimension)
                                      .Select(_ => (float)random.NextDouble() * 2 - 1) // Values between -1 and 1
                                      .ToList();
            return Task.FromResult(embedding);
        }

        /// <summary>
        /// Mock implementation for generating embeddings for a batch of texts from a GCS URI.
        /// This mock implementation does not actually read from GCS or write to GCS.
        /// It simply returns the outputGcsUri, potentially with a mock file name appended if it's a directory.
        /// </summary>
        /// <param name="inputGcsUri">The GCS URI of the input NDJSON file (ignored by mock).</param>
        /// <param name="outputGcsUri">The GCS URI where the output embeddings would be stored.</param>
        /// <returns>A mock GCS URI for the output.</returns>
        public Task<string> GenerateEmbeddingsBatchAsync(string inputGcsUri, string outputGcsUri)
        {
            Console.WriteLine($"MockEmbeddingService: GenerateEmbeddingsBatchAsync called with input: {inputGcsUri}, output: {outputGcsUri}");
            // Simulate that the batch job has produced an output file in the specified outputGcsUri (if it's a directory)
            // or just returns the outputGcsUri if it's a file path.
            string mockResultUri = outputGcsUri;
            if (outputGcsUri.EndsWith("/"))
            {
                mockResultUri = $"{outputGcsUri.TrimEnd('/')}/mock_batch_embeddings_output.ndjson";
            }
            // In a real scenario, this would be the GCS path to the prediction results.
            return Task.FromResult(mockResultUri);
        }
    }
}
