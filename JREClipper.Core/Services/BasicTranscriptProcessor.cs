// JREClipper.Core/Services/BasicTranscriptProcessor.cs
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using System.Text;

namespace JREClipper.Core.Services
{
    //var chunks = ChunkTranscriptWithTimestamps(transcriptData, 30, 15); // 30s windows, 15s overlap
    //var chunks = ChunkTranscriptWithTimestamps(transcriptData, 30, 30); // 30s windows, no overlap
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
                    VideoId = transcriptData.VideoId,
                    Text = !string.IsNullOrWhiteSpace(segmentText)
                        ? (segmentText.Length > 20
                            ? string.Concat(segmentText.AsSpan(0, 10), "...", segmentText.AsSpan(segmentText.Length - 10, 10))
                            : segmentText)
                        : string.Empty,
                    StartTime = windowStart,
                    EndTime = windowEnd,
                    ChannelName = transcriptData.ChannelName,
                    VideoTitle = transcriptData.VideoTitle
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

        // This signature matches the one in ITranscriptProcessor for non-timestamped text.
        public IEnumerable<string> ChunkTranscript(RawTranscriptData transcriptData, int chunkSize, int overlap)
        {
            if (string.IsNullOrEmpty(transcriptData?.Transcript)) // Changed FullTranscriptText to Transcript
            {
                return Enumerable.Empty<string>();
            }

            var chunks = new List<string>();
            var currentChunk = new StringBuilder();
            // Changed FullTranscriptText to Transcript
            var words = transcriptData.Transcript.Split([' ', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries);

            for (int i = 0; i < words.Length; i++)
            {
                currentChunk.Append(words[i]).Append(' ');

                // If we've hit the chunk size, or we're at the last word, finalize this chunk
                if (currentChunk.Length >= chunkSize || i == words.Length - 1)
                {
                    chunks.Add(currentChunk.ToString().Trim());
                    currentChunk.Clear();

                    // If there's an overlap, re-add the last 'overlap' words to the new chunk
                    if (overlap > 0 && i < words.Length - 1)
                    {
                        int overlapStart = Math.Max(0, i - overlap + 1);
                        for (int j = overlapStart; j <= i; j++)
                        {
                            currentChunk.Append(words[j]).Append(' ');
                        }
                    }
                }
            }

            return chunks;
        }
    }
}
