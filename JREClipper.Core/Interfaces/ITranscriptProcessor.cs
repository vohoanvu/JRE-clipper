// JREClipper.Core/Interfaces/ITranscriptProcessor.cs
using JREClipper.Core.Models;
using System.Collections.Generic;

namespace JREClipper.Core.Interfaces
{
    public interface ITranscriptProcessor
    {
        IEnumerable<string> ChunkTranscript(RawTranscriptData transcriptData, int chunkSize, int overlap);
        // Consider adding a method that returns chunked segments with timestamps if needed later
        // IEnumerable<TranscriptSegmentChunk> ChunkTranscriptWithTimestamps(RawTranscriptData transcriptData, int chunkSize, int overlap);
    }

    // public class TranscriptSegmentChunk // Example for chunk with timestamps
    // {
    //     public string Text { get; set; }
    //     public double StartTime { get; set; }
    //     public double EndTime { get; set; }
    // }
}
