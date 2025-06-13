// JREClipper.Core/Services/BasicTranscriptProcessor.cs
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using System.Globalization;
using System.Text;

namespace JREClipper.Core.Services
{
    public class BasicTranscriptProcessor : ITranscriptProcessor
    {
        private const int DefaultSegmentDurationSeconds = 30;

        public IEnumerable<ProcessedTranscriptSegment> ChunkTranscriptWithTimestamps(
            RawTranscriptData transcriptData,
            int segmentDurationSeconds = DefaultSegmentDurationSeconds)
        {
            if (transcriptData?.TranscriptWithTimestamps == null || !transcriptData.TranscriptWithTimestamps.Any())
            {
                return Enumerable.Empty<ProcessedTranscriptSegment>();
            }

            var processedSegments = new List<ProcessedTranscriptSegment>();
            var currentSegmentEntries = new List<TimestampedText>();
            var currentSegmentText = new StringBuilder();
            TimeSpan currentSegmentStartTime = TimeSpan.Zero;
            TimeSpan segmentDuration = TimeSpan.FromSeconds(segmentDurationSeconds);

            foreach (var entry in transcriptData.TranscriptWithTimestamps.OrderBy(e => ParseTimestamp(e.Timestamp)))
            {
                var entryStartTime = ParseTimestamp(entry.Timestamp);

                if (!currentSegmentEntries.Any()) // First entry for a new segment
                {
                    currentSegmentStartTime = entryStartTime;
                }

                // If adding this entry exceeds the desired segment duration (and it's not the first entry of the segment)
                // or if there's a significant gap (e.g., more than segmentDuration/2, indicating a new scene/topic)
                // then finalize the current segment.
                bool isNewSegment = currentSegmentEntries.Any() &&
                                    (entryStartTime - currentSegmentStartTime >= segmentDuration ||
                                     entryStartTime - ParseTimestamp(currentSegmentEntries.Last().Timestamp) > segmentDuration / 2);


                if (isNewSegment)
                {
                    if (currentSegmentText.Length > 0)
                    {
                        processedSegments.Add(new ProcessedTranscriptSegment
                        {
                            VideoId = transcriptData.VideoId,
                            Text = currentSegmentText.ToString().Trim(),
                            StartTime = currentSegmentStartTime,
                            EndTime = ParseTimestamp(currentSegmentEntries.Last().Timestamp), // End time is the start of the last entry in this chunk
                            ChannelName = transcriptData.ChannelName,
                            VideoTitle = transcriptData.VideoTitle,
                            OriginalEntries = new List<TimestampedText>(currentSegmentEntries)
                        });
                    }
                    currentSegmentEntries.Clear();
                    currentSegmentText.Clear();
                    currentSegmentStartTime = entryStartTime; // Start new segment with current entry
                }

                currentSegmentEntries.Add(entry);
                currentSegmentText.Append(entry.Text).Append(" ");
            }

            // Add the last remaining segment
            if (currentSegmentText.Length > 0 && currentSegmentEntries.Any())
            {
                processedSegments.Add(new ProcessedTranscriptSegment
                {
                    VideoId = transcriptData.VideoId,
                    Text = currentSegmentText.ToString().Trim(),
                    StartTime = currentSegmentStartTime,
                    EndTime = ParseTimestamp(currentSegmentEntries.Last().Timestamp),
                    ChannelName = transcriptData.ChannelName,
                    VideoTitle = transcriptData.VideoTitle,
                    OriginalEntries = new List<TimestampedText>(currentSegmentEntries)
                });
            }

            return processedSegments;
        }

        // Helper to parse flexible timestamp formats like "HH:MM:SS.fff", "MM:SS.fff", "SS.fff"
        // or "HH:MM:SS", "MM:SS", "SS"
        private static TimeSpan ParseTimestamp(string timestamp)
        {
            // Normalize to handle missing milliseconds or hours
            string[] parts = timestamp.Split(':');
            string normalizedTimestamp;

            if (parts.Length == 1) // "SS.fff" or "SS"
            {
                normalizedTimestamp = $"00:00:{timestamp}";
            }
            else if (parts.Length == 2) // "MM:SS.fff" or "MM:SS"
            {
                normalizedTimestamp = $"00:{timestamp}";
            }
            else // "HH:MM:SS.fff" or "HH:MM:SS"
            {
                normalizedTimestamp = timestamp;
            }
            
            // Ensure milliseconds part exists for TimeSpan.ParseExact
            if (!normalizedTimestamp.Contains('.'))
            {
                normalizedTimestamp += ".000";
            }

            // Try parsing with milliseconds
            if (TimeSpan.TryParseExact(normalizedTimestamp, @"hh\:mm\:ss\.fff", CultureInfo.InvariantCulture, out var timeSpan) ||
                TimeSpan.TryParseExact(normalizedTimestamp, @"h\:mm\:ss\.fff", CultureInfo.InvariantCulture, out timeSpan))
            {
                return timeSpan;
            }
            // Try parsing without milliseconds (if previous added .000 and it failed, this is a fallback)
            if (TimeSpan.TryParseExact(normalizedTimestamp.Substring(0, normalizedTimestamp.LastIndexOf('.')), @"hh\:mm\:ss", CultureInfo.InvariantCulture, out timeSpan) ||
                TimeSpan.TryParseExact(normalizedTimestamp.Substring(0, normalizedTimestamp.LastIndexOf('.')), @"h\:mm\:ss", CultureInfo.InvariantCulture, out timeSpan))
            {
                 return timeSpan;
            }

            Console.WriteLine($"Warning: Could not parse timestamp '{timestamp}'. Defaulting to TimeSpan.Zero.");
            return TimeSpan.Zero; // Fallback for unparseable timestamps
        }

        // Original ChunkTranscript method - can be deprecated or adapted if still needed for non-timestamped full transcripts
        public IEnumerable<string> ChunkTranscript(RawTranscriptData transcriptData, int chunkSize, int overlap)
        {
            if (string.IsNullOrEmpty(transcriptData?.Transcript))
            {
                return Enumerable.Empty<string>();
            }

            var fullText = transcriptData.Transcript;
            var chunks = new List<string>();
            var currentIndex = 0;

            while (currentIndex < fullText.Length)
            {
                var remainingLength = fullText.Length - currentIndex;
                var currentChunkSize = System.Math.Min(chunkSize, remainingLength);
                var chunk = fullText.Substring(currentIndex, currentChunkSize);
                chunks.Add(chunk);

                if (currentIndex + currentChunkSize >= fullText.Length)
                {
                    break; // Reached the end
                }

                currentIndex += (chunkSize - overlap);
                if (currentIndex < 0) // Ensure currentIndex doesn't go negative with large overlap
                {
                    currentIndex = 0;
                }
            }
            return chunks;
        }
    }
}
