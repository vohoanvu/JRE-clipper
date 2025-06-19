using System.Text;
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using Microsoft.Extensions.Logging;
using System.Numerics.Tensors;

namespace JREClipper.Core.Services
{
    public class IntelligentTranscriptProcessor : ITranscriptProcessor
    {
        private readonly ILogger<IntelligentTranscriptProcessor> _logger;
        private readonly AppSettings _appSettings;

        public IntelligentTranscriptProcessor(
            ILogger<IntelligentTranscriptProcessor> logger,
            AppSettings appSettings)
        {
            _logger = logger;
            _appSettings = appSettings ?? new AppSettings()
            {
                ChunkSettings = new ChunkSettings
                {
                    MinChunkDurationSeconds = 10,
                    MaxChunkDurationSeconds = 60,
                    OverlapSentences = 2,
                    SimilarityThreshold = 0.82
                }
            };
        }

        public IEnumerable<ProcessedTranscriptSegment> ChunkTranscriptWithTimestamps(RawTranscriptData transcriptData, int? segmentDurationSeconds, int? slideSeconds)
        {
            throw new NotImplementedException("This method is not implemented in the IntelligentTranscriptProcessor. Use ChunkTranscriptAsync instead.");
        }

        // This is the new primary method. It takes pre-computed embeddings as input.
        public IEnumerable<ProcessedTranscriptSegment> ChunkTranscriptFromPrecomputedEmbeddings(
            RawTranscriptData transcriptData, IReadOnlyDictionary<string, float[]> precomputedEmbeddings)
        {
            var timedUtterances = TranscriptSegmentationUtil.GroupIntoUtterancesByPause(
                transcriptData.TranscriptWithTimestamps, _logger);

            // Populate the utterances with their pre-computed embeddings
            for (int i = 0; i < timedUtterances.Count; i++)
            {
                var utteranceId = $"{transcriptData.VideoId}_{i}";
                if (precomputedEmbeddings.TryGetValue(utteranceId, out var embedding))
                {
                    timedUtterances[i].Embedding = embedding;
                }
                else
                {
                    _logger.LogWarning("Could not find pre-computed embedding for utterance ID: {UtteranceId}", utteranceId);
                }
            }

            // The rest of the logic is the same!
            return CreateSemanticChunks(timedUtterances, transcriptData.VideoId, transcriptData);
        }

        public async Task<IEnumerable<ProcessedTranscriptSegment>> ChunkTranscriptAsync(
            RawTranscriptData transcriptData, VideoMetadata? videoMetadata)
        {
            throw new NotSupportedException("This method is deprecated. Use ChunkTranscriptFromPrecomputedEmbeddings after running a batch embedding job.");
        }


        private List<ProcessedTranscriptSegment> CreateSemanticChunks(List<TimedUtterance> utterances, string videoId, RawTranscriptData rawTranscriptData)
        {
            var segments = new List<ProcessedTranscriptSegment>();
            if (utterances.Count == 0) return segments;

            var currentChunkSentences = new List<TimedUtterance>();

            for (int i = 0; i < utterances.Count; i++)
            {
                var utterance = utterances[i];
                currentChunkSentences.Add(utterance);

                // Calculate similarity with the next utterance to decide if we should split
                double similarityWithNext = 1.0; // Default to no split
                if (i < utterances.Count - 1)
                {
                    similarityWithNext = CalculateCosineSimilarity(utterance.Embedding, utterances[i + 1].Embedding);
                }

                var currentChunkDuration = currentChunkSentences.Last().EndTime - currentChunkSentences.First().StartTime;

                // Conditions to finalize the current chunk:
                // 1. A semantic break is detected (low similarity).
                // 2. The chunk has reached its maximum allowed size.
                // 3. It's the last utterance in the transcript.
                bool isSemanticBreak = similarityWithNext < _appSettings.ChunkSettings!.SimilarityThreshold;
                bool isMaxDuration = currentChunkDuration.TotalSeconds >= _appSettings.ChunkSettings!.MaxChunkDurationSeconds;
                bool isLastUtterance = i == utterances.Count - 1;

                if ((isSemanticBreak && currentChunkDuration.TotalSeconds >= _appSettings.ChunkSettings!.MinChunkDurationSeconds) || isMaxDuration || isLastUtterance)
                {
                    var segment = FinalizeSegment(currentChunkSentences, videoId, rawTranscriptData);
                    segments.Add(segment);

                    // Start the next chunk with an overlap of the last few sentences
                    var overlapIndex = Math.Max(0, currentChunkSentences.Count - _appSettings.ChunkSettings!.OverlapSentences);
                    currentChunkSentences = currentChunkSentences.GetRange(overlapIndex, currentChunkSentences.Count - overlapIndex);

                    // If we are not at a semantic break, clear completely to avoid re-adding sentences
                    if (!isSemanticBreak)
                    {
                        currentChunkSentences.Clear();
                    }
                }
            }

            return segments;
        }

        private ProcessedTranscriptSegment FinalizeSegment(List<TimedUtterance> utterances, string videoId, RawTranscriptData rawTranscriptData)
        {
            var segmentText = string.Join(" ", utterances.Select(u => u.Text));
            var startTime = utterances.First().StartTime;
            var endTime = utterances.Last().EndTime;

            return new ProcessedTranscriptSegment
            {
                SegmentId = $"{videoId}_{startTime.TotalSeconds:F0}_{endTime.TotalSeconds:F0}",
                VideoId = videoId,
                Text = segmentText,
                StartTime = startTime,
                EndTime = endTime,
                VideoTitle = rawTranscriptData.VideoTitle,
                ChannelName = rawTranscriptData.ChannelName,
            };
        }

        private double CalculateCosineSimilarity(float[]? vec1, float[]? vec2)
        {
            if (vec1 == null || vec2 == null || vec1.Length != vec2.Length)
            {
                _logger.LogWarning("Cannot calculate cosine similarity: one or both vectors are null or have different lengths.");
                return 0;
            }

            // Directly create ReadOnlySpan<float> from the float[] arrays
            ReadOnlySpan<float> span1 = vec1.AsSpan();
            ReadOnlySpan<float> span2 = vec2.AsSpan();

            // Use TensorPrimitives directly on the spans
            var dotProduct = TensorPrimitives.Dot(span1, span2);
            var norm1 = TensorPrimitives.Norm(span1);
            var norm2 = TensorPrimitives.Norm(span2);

            if (norm1 == 0 || norm2 == 0)
            {
                // If one of the vectors is a zero vector, similarity is undefined or zero.
                // Returning 0 is a common convention in this case.
                return 0;
            }

            return dotProduct / (norm1 * norm2);
        }
    }
}
