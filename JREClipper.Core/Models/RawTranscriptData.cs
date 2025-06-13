// JREClipper.Core/Models/RawTranscriptData.cs
using System.Collections.Generic;

namespace JREClipper.Core.Models
{
    public class RawTranscriptData
    {
        public List<TranscriptSegment> Segments { get; set; } = new List<TranscriptSegment>();
    }

    public class TranscriptSegment
    {
        public string Text { get; set; } = string.Empty;
        public double StartTime { get; set; }
        public double EndTime { get; set; }
        public string? Speaker { get; set; } // Assuming speaker info might be available
    }
}
