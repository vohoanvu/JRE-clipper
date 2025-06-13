// JREClipper.Core/Models/ProcessedTranscriptSegment.cs
using System;

namespace JREClipper.Core.Models
{
    public class ProcessedTranscriptSegment
    {
        public string VideoId { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty;
        public TimeSpan StartTime { get; set; }
        public TimeSpan EndTime { get; set; }
        public string ChannelName { get; set; } = string.Empty; // Added from RawTranscriptData
        public string VideoTitle { get; set; } = string.Empty;  // Added from RawTranscriptData

        // Optional: for debugging or detailed reference
        public List<TimestampedText> OriginalEntries { get; set; } = new List<TimestampedText>();
    }
}
