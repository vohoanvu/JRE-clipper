// JREClipper.Core/Models/VectorizedSegment.cs
using System;
using System.Collections.Generic;

namespace JREClipper.Core.Models
{
    public class VectorizedSegment
    {
        public string SegmentId { get; set; } // Unique ID for the segment
        public string VideoId { get; set; } = string.Empty;
        public string ChannelName { get; set; } = string.Empty; // Added
        public string Text { get; set; } = string.Empty;
        public double StartTime { get; set; }
        public double EndTime { get; set; }
        public List<float> Embedding { get; set; } = new List<float>(); // Dense vector embedding
        public DateTime Timestamp { get; set; } // Indexing timestamp
        public string? GuestName { get; set; }
        public string? Tags { get; set; }
        public int? EpisodeNumber { get; set; }

        public VectorizedSegment()
        {
            SegmentId = Guid.NewGuid().ToString();
            Timestamp = DateTime.UtcNow;
        }
    }
}
