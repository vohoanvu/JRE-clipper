// JREClipper.Core/Interfaces/IVectorDatabaseService.cs
using JREClipper.Core.Models;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace JREClipper.Core.Interfaces
{
    public interface IVectorDatabaseService
    {
        Task AddVectorAsync(VectorizedSegment segment);
        Task AddVectorsBatchAsync(IEnumerable<VectorizedSegment> segments);
        Task<IEnumerable<VectorSearchResult>> SearchSimilarVectorsAsync(List<float> queryVector, int topK, string? channelFilter = null);
        Task<bool> CheckHealthAsync();
        // Consider adding methods for updating or deleting vectors if needed
        // Task UpdateVectorAsync(VectorizedSegment segment);
        // Task DeleteVectorAsync(string segmentId);
    }
}
