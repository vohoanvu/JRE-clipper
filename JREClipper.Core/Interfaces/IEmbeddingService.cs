// JREClipper.Core/Interfaces/IEmbeddingService.cs

namespace JREClipper.Core.Interfaces
{
    public interface IEmbeddingService
    {
        Task<List<float>> GenerateEmbeddingsAsync(string text);
        Task<List<List<float>>> GenerateEmbeddingsBatchAsync(IEnumerable<string> texts);
    }
}
