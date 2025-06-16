// JREClipper.Core/Models/VectorizedSegment.cs
using System.Collections.Generic; // Added for List

namespace JREClipper.Core.Models
{
    public class VectorizedSegment
    {
        public required string SegmentId { get; set; } // Unique ID for the segment
        public string VideoId { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty; // Added
        public TimeSpan StartTime { get; set; }
        public TimeSpan EndTime { get; set; }
        public List<float> Embedding { get; set; } = []; // Dense vector embedding
        public string ChannelName { get; set; } = string.Empty; // Added
        public string VideoTitle { get; set; } = string.Empty; // Added
    }
}
