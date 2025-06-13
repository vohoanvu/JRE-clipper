// JREClipper.Core/Interfaces/ITranscriptProcessor.cs
using JREClipper.Core.Models;

namespace JREClipper.Core.Interfaces
{
    public interface ITranscriptProcessor
    {
        // Processes raw transcript data with timestamps into structured, timed segments.
        IEnumerable<ProcessedTranscriptSegment> ChunkTranscriptWithTimestamps(RawTranscriptData transcriptData, int segmentDurationSeconds = 30);

        // Chunks a single block of text without timestamp awareness.
        // This might be deprecated if all transcripts are timestamped.
        IEnumerable<string> ChunkTranscript(RawTranscriptData transcriptData, int chunkSize, int overlap);
    }
}
