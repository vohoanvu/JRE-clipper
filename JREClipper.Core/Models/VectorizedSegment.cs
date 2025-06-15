// JREClipper.Core/Models/VectorizedSegment.cs
using System.Collections.Generic; // Added for List

namespace JREClipper.Core.Models
{
    public class VectorizedSegment
    {
        public required string SegmentId { get; set; } // Unique ID for the segment
        public string VideoId { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty; // Added
        public string StartTime { get; set; } = string.Empty; // Changed from double to string
        public string EndTime { get; set; } = string.Empty;   // Changed from double to string
        public List<float> Embedding { get; set; } = new List<float>(); // Dense vector embedding
        public string ChannelName { get; set; } = string.Empty; // Added
        public string VideoTitle { get; set; } = string.Empty; // Added
    }
}
