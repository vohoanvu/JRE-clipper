// JREClipper.Core/Services/BasicTranscriptProcessor.cs
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;

namespace JREClipper.Core.Services
{
    public class BasicTranscriptProcessor : ITranscriptProcessor
    {
        public IEnumerable<ProcessedTranscriptSegment> ChunkTranscriptWithTimestamps(RawTranscriptData transcriptData,
            int? segmentDurationSeconds, int? slideSeconds
        )
        {
            if (transcriptData?.TranscriptWithTimestamps == null || transcriptData.TranscriptWithTimestamps.Count == 0)
            {
                return [];
            }

            var processedSegments = new List<ProcessedTranscriptSegment>();

            // Parse and order entries by timestamp
            var orderedEntries = transcriptData.TranscriptWithTimestamps
                .Select(e => new
                {
                    Entry = e,
                    TimestampValue = ParseTimestamp(e.Timestamp)
                })
                .Where(e => e.TimestampValue != TimeSpan.Zero)
                .OrderBy(e => e.TimestampValue)
                .ToList();

            if (orderedEntries.Count == 0)
                return processedSegments;

            // Find the last timestamp -- use segment end to cover the last transcript
            var lastTime = orderedEntries.Last().TimestampValue;

            TimeSpan windowStart = TimeSpan.Zero;
            TimeSpan windowEnd = windowStart.Add(TimeSpan.FromSeconds(segmentDurationSeconds ?? 30));

            while (windowStart <= lastTime)
            {
                // Collect all transcript entries that overlap this window
                var entriesInWindow = orderedEntries
                    .Where(e => e.TimestampValue >= windowStart && e.TimestampValue < windowEnd)
                    .Select(e => e.Entry)
                    .ToList();

                // Concatenate all texts for this window (empty if none)
                string segmentText = string.Join(" ", entriesInWindow.Select(e => e.Text?.Trim()).Where(t => !string.IsNullOrWhiteSpace(t)));

                processedSegments.Add(new ProcessedTranscriptSegment
                {
                    SegmentId = $"{transcriptData.VideoId}_{windowStart.TotalSeconds}_{windowEnd.TotalSeconds}",
                    VideoId = transcriptData.VideoId,
                    Text = segmentText,
                    StartTime = windowStart,
                    EndTime = windowEnd,
                });

                // Slide the window forward (overlap if slideSeconds < segmentDurationSeconds)
                windowStart = windowStart.Add(TimeSpan.FromSeconds(slideSeconds ?? 15));
                windowEnd = windowStart.Add(TimeSpan.FromSeconds(segmentDurationSeconds ?? 30));
            }

            return processedSegments;
        }

        private static TimeSpan ParseTimestamp(string timestamp)
        {
            if (string.IsNullOrEmpty(timestamp))
            {
                Console.WriteLine($"Warning: Null or empty timestamp provided. Defaulting to TimeSpan.Zero.");
                return TimeSpan.Zero;
            }

            string trimmedTimestamp = timestamp.Trim();

            // Split by ':'
            var parts = trimmedTimestamp.Split(':');
            try
            {
                if (parts.Length == 3)
                {
                    // h:mm:ss or hh:mm:ss
                    int hours = int.Parse(parts[0]);
                    int minutes = int.Parse(parts[1]);
                    int seconds = int.Parse(parts[2]);
                    return new TimeSpan(hours, minutes, seconds);
                }
                else if (parts.Length == 2)
                {
                    // mm:ss or m:ss
                    int minutes = int.Parse(parts[0]);
                    int seconds = int.Parse(parts[1]);
                    return new TimeSpan(0, minutes, seconds);
                }
                else if (parts.Length == 1)
                {
                    // Just seconds
                    int seconds = int.Parse(parts[0]);
                    return new TimeSpan(0, 0, seconds);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Warning: Exception parsing timestamp '{timestamp}': {ex.Message}. Defaulting to TimeSpan.Zero.");
                return TimeSpan.Zero;
            }

            Console.WriteLine($"Warning: Could not parse timestamp. Original: '{timestamp}', Trimmed: '{trimmedTimestamp}'. Defaulting to TimeSpan.Zero.");
            return TimeSpan.Zero;
        }

        public Task<IEnumerable<ProcessedTranscriptSegment>> ChunkTranscriptAsync(RawTranscriptData transcriptData, VideoMetadata videoMetadata)
        {
            throw new NotImplementedException("Async chunking not implemented in BasicTranscriptProcessor. Use IntelligentTranscriptProcessor for async operations.");
        }
    }
}