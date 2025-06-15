// JREClipper.Core/Services/BasicTranscriptProcessor.cs
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using System.Globalization;
using System.Text;

namespace JREClipper.Core.Services
{
    public class BasicTranscriptProcessor : ITranscriptProcessor
    {
        public IEnumerable<ProcessedTranscriptSegment> ChunkTranscriptWithTimestamps(
            RawTranscriptData transcriptData,
            int segmentDurationSeconds = 0) 
        {
            if (transcriptData?.TranscriptWithTimestamps == null || !transcriptData.TranscriptWithTimestamps.Any())
            {
                return Enumerable.Empty<ProcessedTranscriptSegment>();
            }

            var processedSegments = new List<ProcessedTranscriptSegment>();
            var orderedEntries = transcriptData.TranscriptWithTimestamps
                                    // Keep original timestamp string, parse for ordering only
                                    .Select(e => new { 
                                        Entry = e, 
                                        TimestampValue = e.Timestamp, 
                                        OriginalTimestampString = e.Timestamp // Store original string
                                    })
                                    .OrderBy(e => e.TimestampValue)
                                    .ToList();

            for (int i = 0; i < orderedEntries.Count; i++)
            {
                var currentItem = orderedEntries[i];
                var entry = currentItem.Entry;
                // var entryTime = currentItem.TimestampValue; // TimeSpan value, used for logic if needed
                string currentTimestampString = currentItem.OriginalTimestampString; // Use original string for StartTime

                if (string.IsNullOrWhiteSpace(entry.Text))
                {
                    Console.WriteLine($"Skipping entry with timestamp {entry.Timestamp} due to empty text.");
                    continue;
                }

                string endTimeString = currentTimestampString; // Default EndTime to StartTime string
                if (i + 1 < orderedEntries.Count)
                {
                    endTimeString = orderedEntries[i + 1].OriginalTimestampString; // Use original string of next entry for EndTime
                }
                // else if (i == orderedEntries.Count - 1) { // Handle last segment if specific EndTime logic is needed
                //    TimeSpan tempEndTime = currentItem.TimestampValue.Add(TimeSpan.FromSeconds(1)); // Example: add 1 sec
                //    endTimeString = tempEndTime.ToString(@"hh\:mm\:ss"); // Format as needed
                // }

                processedSegments.Add(new ProcessedTranscriptSegment
                {
                    VideoId = transcriptData.VideoId,
                    Text = entry.Text.Trim().Length > 20 ? string.Concat(entry.Text.Trim().AsSpan(0,10), "...", entry.Text.Trim().AsSpan(entry.Text.Trim().Length-10,10)) : entry.Text.Trim(), // Example: Truncate text
                    StartTime = currentTimestampString, 
                    EndTime = endTimeString, 
                    ChannelName = transcriptData.ChannelName,
                    VideoTitle = transcriptData.VideoTitle,
                    OriginalEntries = [entry] 
                });
            }

            return processedSegments;
        }

        // Helper to parse flexible timestamp formats like "HH:MM:SS.fff", "MM:SS.fff", "SS.fff"
        // or "HH:MM:SS", "MM:SS", "SS", "H:MM:SS", "M:SS"
        private static TimeSpan ParseTimestamp(string timestamp)
        {
            if (string.IsNullOrEmpty(timestamp))
            {
                Console.WriteLine($"Warning: Null or empty timestamp provided. Defaulting to TimeSpan.Zero.");
                return TimeSpan.Zero;
            }

            string trimmedTimestamp = timestamp.Trim();

            // Expanded and reordered formats for robustness, prioritizing 24-hour formats.
            // H/HH for 24-hour (0-23), h/hh for 12/24-hour (0-23 if no AM/PM).
            string[] formats = new[]
            {
                // Most specific with milliseconds first
                "HH:mm:ss.fff", // 24-hour, 00-23
                "H:mm:ss.fff",  // 24-hour, 0-23
                "hh:mm:ss.fff", // 12-hour (00-23 if no tt), or 24-hour
                "h:mm:ss.fff",  // 12-hour (0-23 if no tt), or 24-hour

                // Without milliseconds
                "HH:mm:ss",     // 24-hour, 00-23
                "H:mm:ss",      // 24-hour, 0-23  <- Should robustly match "3:07:17"
                "hh:mm:ss",     // 12-hour (00-23 if no tt), or 24-hour
                "h:mm:ss",      // 12-hour (0-23 if no tt), or 24-hour

                // Minutes and seconds with milliseconds
                "mm:ss.fff",
                "m:ss.fff",

                // Minutes and seconds without milliseconds
                "mm:ss",
                "m:ss",

                // Seconds with milliseconds
                "ss.fff",
                "s.fff",

                // Seconds without milliseconds
                "ss",
                "s"
            };

            if (TimeSpan.TryParseExact(trimmedTimestamp, formats, CultureInfo.InvariantCulture, TimeSpanStyles.None, out TimeSpan result))
            {
                return result;
            }

            // Fallback for simple numbers which might represent total seconds
            if (double.TryParse(trimmedTimestamp, NumberStyles.Any, CultureInfo.InvariantCulture, out double seconds))
            {
                return TimeSpan.FromSeconds(seconds);
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
            var words = transcriptData.Transcript.Split(new[] { ' ', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries);

            for (int i = 0; i < words.Length; i++)
            {
                currentChunk.Append(words[i]).Append(" ");

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
                            currentChunk.Append(words[j]).Append(" ");
                        }
                    }
                }
            }

            return chunks;
        }
    }
}
