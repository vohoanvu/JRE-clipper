// JREClipper.Core/Models/ProcessedTranscriptSegment.cs
namespace JREClipper.Core.Models
{
    public class ProcessedTranscriptSegment
    {
        public string SegmentId { get; set; } = string.Empty;
        public string VideoId { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty;
        public TimeSpan StartTime { get; set; }
        public TimeSpan EndTime { get; set; }
    }
}
