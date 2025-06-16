// JREClipper.Core/Models/ProcessedTranscriptSegment.cs
namespace JREClipper.Core.Models
{
    public class ProcessedTranscriptSegment
    {
        public string VideoId { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty;
        public TimeSpan StartTime { get; set; }
        public TimeSpan EndTime { get; set; } //Used the TimeStamp entry of the next segment, minus 1 second, as the EndTime
        public string ChannelName { get; set; } = string.Empty;
        public string VideoTitle { get; set; } = string.Empty;

        // Optional: for debugging or detailed reference
        public List<TimestampedText> OriginalEntries { get; set; } = [];
    }
}
