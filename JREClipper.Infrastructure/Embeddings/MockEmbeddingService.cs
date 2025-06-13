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

        public async Task<List<List<float>>> GenerateEmbeddingsBatchAsync(IEnumerable<string> texts)
        {
            var allEmbeddings = new List<List<float>>();
            foreach (var text in texts)
            {
                allEmbeddings.Add(await GenerateEmbeddingsAsync(text));
            }
            return allEmbeddings;
        }
    }
}
