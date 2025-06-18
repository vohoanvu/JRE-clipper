using System.Text;
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using Microsoft.Extensions.Logging;
using System.Numerics.Tensors;

namespace JREClipper.Core.Services
{
    public class IntelligentTranscriptProcessor : ITranscriptProcessor
    {
        private readonly IEmbeddingService _embeddingService;
        private readonly ILogger<IntelligentTranscriptProcessor> _logger;
        private readonly AppSettings _appSettings;

        public IntelligentTranscriptProcessor(
            IEmbeddingService embeddingService,
            ILogger<IntelligentTranscriptProcessor> logger,
            AppSettings appSettings)
        {
            _embeddingService = embeddingService;
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

        public async Task<IEnumerable<ProcessedTranscriptSegment>> ChunkTranscriptAsync(
            RawTranscriptData transcriptData, VideoMetadata videoMetadata)
        {
            if (transcriptData?.TranscriptWithTimestamps == null || !transcriptData.TranscriptWithTimestamps.Any())
            {
                return [];
            }

            // 1. Group raw entries into sentences/utterances
            var utterances = GroupIntoUtterances(transcriptData.TranscriptWithTimestamps);
            if (!utterances.Any()) return [];

            // 2. Generate embeddings for all utterances in parallel
            var embeddingTasks = utterances.Select(async u =>
            {
                var embeddings = await _embeddingService.GenerateEmbeddingsAsync(u.Text);
                u.Embedding = embeddings.ToArray();
                return u;
            }).ToList();
            await Task.WhenAll(embeddingTasks);

            // 3. Perform semantic chunking
            return CreateSemanticChunks(utterances, transcriptData.VideoId, videoMetadata);
        }

        private List<TimedUtterance> GroupIntoUtterances(List<TimestampedText> entries)
        {
            var utterances = new List<TimedUtterance>();
            if (!entries.Any()) return utterances;

            var orderedEntries = entries
                .Select(e => new { Entry = e, Timestamp = ParseTimestamp(e.Timestamp) })
                .OrderBy(e => e.Timestamp)
                .ToList();

            var currentUtteranceBuilder = new StringBuilder();
            var utteranceStartTime = orderedEntries.First().Timestamp;

            foreach (var entry in orderedEntries)
            {
                currentUtteranceBuilder.Append(entry.Entry.Text).Append(' ');
                char lastChar = entry.Entry.Text.Trim().LastOrDefault();

                // Split on sentence-ending punctuation
                if (lastChar == '.' || lastChar == '?' || lastChar == '!')
                {
                    utterances.Add(new TimedUtterance
                    {
                        Text = currentUtteranceBuilder.ToString().Trim(),
                        StartTime = utteranceStartTime,
                        EndTime = entry.Timestamp
                    });
                    currentUtteranceBuilder.Clear();
                    utteranceStartTime = entry.Timestamp;
                }
            }

            // Add any remaining text as the last utterance
            if (currentUtteranceBuilder.Length > 0)
            {
                utterances.Add(new TimedUtterance
                {
                    Text = currentUtteranceBuilder.ToString().Trim(),
                    StartTime = utteranceStartTime,
                    EndTime = orderedEntries.Last().Timestamp
                });
            }

            return utterances;
        }

        private List<ProcessedTranscriptSegment> CreateSemanticChunks(List<TimedUtterance> utterances, string videoId, VideoMetadata videoMetadata)
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
                    var segment = FinalizeSegment(currentChunkSentences, videoId, videoMetadata);
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

        private ProcessedTranscriptSegment FinalizeSegment(List<TimedUtterance> utterances, string videoId, VideoMetadata videoMetadata)
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
                // Add enriched metadata for better retrieval context
                VideoTitle = videoMetadata.Title,
                ChannelName = videoMetadata.ChannelName
            };
        }

        private double CalculateCosineSimilarity(float[]? vec1, float[]? vec2)
        {
            if (vec1 == null || vec2 == null || vec1.Length != vec2.Length) return 0;

            var tensor1 = new DenseTensor<float>(vec1, [vec1.Length]);
            var tensor2 = new DenseTensor<float>(vec2, [vec2.Length]);

            var dotProduct = TensorPrimitives.Dot(tensor1.Buffer.Span, tensor2.Buffer.Span);
            var norm1 = TensorPrimitives.Norm(tensor1.Buffer.Span);
            var norm2 = TensorPrimitives.Norm(tensor2.Buffer.Span);

            if (norm1 == 0 || norm2 == 0) return 0;

            return dotProduct / (norm1 * norm2);
        }

        // Using TryParseExact for more robust and cleaner timestamp parsing
        private static TimeSpan ParseTimestamp(string timestamp)
        {
            // Define expected formats from most to least specific
            string[] formats = ["h\\:mm\\:ss", "mm\\:ss", "m\\:ss", "ss"];
            if (TimeSpan.TryParseExact(timestamp.Trim(), formats, null, out var timeSpan))
            {
                return timeSpan;
            }
            return TimeSpan.Zero;
        }
    }
}
