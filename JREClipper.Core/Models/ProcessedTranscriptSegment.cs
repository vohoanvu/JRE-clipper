// JREClipper.Core/Models/ProcessedTranscriptSegment.cs
namespace JREClipper.Core.Models
{
    public class ProcessedTranscriptSegment
    {
        public string SegmentId { get; set; } = string.Empty;
        public string VideoId { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty;
        public TimeSpan StartTime { get; set; }
        public TimeSpan EndTime { get; set; } //For now using the EndTime of the next consecutive segment 

        public string? VideoTitle { get; set; }
        public string? ChannelName { get; set; } // Enriched metadata for better retrieval context
    }

    // Helper model for an utterance with timing
    public class TimedUtterance
    {
        public string Text { get; set; } = string.Empty;
        public TimeSpan StartTime { get; set; }
        public TimeSpan EndTime { get; set; }
        public float[]? Embedding { get; set; }
    }
}
