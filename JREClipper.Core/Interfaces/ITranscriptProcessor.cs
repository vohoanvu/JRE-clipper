// JREClipper.Core/Interfaces/ITranscriptProcessor.cs
using JREClipper.Core.Models;

namespace JREClipper.Core.Interfaces
{
    public interface ITranscriptProcessor
    {
        // Processes raw transcript data with timestamps into structured, timed segments.
        IEnumerable<ProcessedTranscriptSegment> ChunkTranscriptWithTimestamps(RawTranscriptData transcriptData, int? segmentDurationSeconds, int? slideSeconds);
        Task<IEnumerable<ProcessedTranscriptSegment>> ChunkTranscriptAsync(RawTranscriptData transcriptData, VideoMetadata videoMetadata);

        IEnumerable<ProcessedTranscriptSegment> ChunkTranscriptFromPrecomputedEmbeddings(
            RawTranscriptData transcriptData,
            VideoMetadata videoMetadata,
            IReadOnlyDictionary<string, float[]> precomputedEmbeddings);
    }
}
