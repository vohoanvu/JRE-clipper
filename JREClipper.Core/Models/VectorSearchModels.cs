// JREClipper.Core/Models/VectorSearchModels.cs
using System.Collections.Generic;

namespace JREClipper.Core.Models
{
    public class VectorSearchRequest
    {
        public List<float> QueryVector { get; set; } = new List<float>();
        public int TopK { get; set; } = 10; // Default to top 10 results
        // Add any other filtering criteria if needed, e.g., date range, specific channel
    }

    public class VectorSearchResult
    {
        public required VectorizedSegment Segment { get; set; } // Added required keyword
        public double Score { get; set; } // Similarity score
    }
}
