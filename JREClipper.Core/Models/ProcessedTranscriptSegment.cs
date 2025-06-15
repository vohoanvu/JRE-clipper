// JREClipper.Core/Models/ProcessedTranscriptSegment.cs
using System;
using System.Collections.Generic; // Added for List

namespace JREClipper.Core.Models
{
    public class ProcessedTranscriptSegment
    {
        public string VideoId { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty;
        public string StartTime { get; set; } = string.Empty; // Changed from TimeSpan to string
        public string EndTime { get; set; } = string.Empty;   // Changed from TimeSpan to string
        public string ChannelName { get; set; } = string.Empty;
        public string VideoTitle { get; set; } = string.Empty;

        // Optional: for debugging or detailed reference
        public List<TimestampedText> OriginalEntries { get; set; } = new List<TimestampedText>();
    }
}
