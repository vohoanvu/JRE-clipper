// In a new file: UtteranceExtractorService.cs
using System.Text;
using System.Text.Json.Serialization;
using JREClipper.Core.Models;
using Microsoft.Extensions.Logging;

namespace JREClipper.Core.Services
{
    // A simple model for the JSONL output
    public class UtteranceForEmbedding
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("content")]
        public string Text { get; set; } = string.Empty;
    }

    public class UtteranceExtractorService
    {
        // Note: No IEmbeddingService dependency!
        private readonly ILogger<UtteranceExtractorService> _logger;
        private const int MaxUtteranceLengthChars = 2000; // Safeguard for run-on sentences
        private const int MinUtteranceLengthChars = 10;   // Avoid tiny utterances like "Ok."

        public UtteranceExtractorService(ILogger<UtteranceExtractorService> logger)
        {
            _logger = logger;
        }

        /// <summary>
        /// Extracts all utterances from a transcript and prepares them for a batch embedding job.
        /// </summary>
        public List<UtteranceForEmbedding> ExtractUtterances(RawTranscriptData transcriptData)
        {
            var timedUtterances = GroupIntoUtterances(transcriptData.TranscriptWithTimestamps);
            var utterancesForEmbedding = new List<UtteranceForEmbedding>();

            for (int i = 0; i < timedUtterances.Count; i++)
            {
                utterancesForEmbedding.Add(new UtteranceForEmbedding
                {
                    Id = $"{transcriptData.VideoId}_{i}",
                    Text = timedUtterances[i].Text
                });
            }
            return utterancesForEmbedding;
        }

        private List<TimedUtterance> GroupIntoUtterances(List<TimestampedText> entries)
        {
            var utterances = new List<TimedUtterance>();
            if (entries == null || !entries.Any()) return utterances;

            var orderedEntries = entries
                .Select(e => new { Entry = e, Timestamp = ParseTimestamp(e.Timestamp) })
                .Where(e => e.Timestamp != TimeSpan.Zero) // Filter out invalid entries
                .OrderBy(e => e.Timestamp)
                .ToList();

            if (!orderedEntries.Any()) return utterances;

            var currentUtteranceBuilder = new StringBuilder();
            var utteranceStartTime = orderedEntries.First().Timestamp;

            for (int i = 0; i < orderedEntries.Count; i++)
            {
                var currentEntry = orderedEntries[i];
                currentUtteranceBuilder.Append(currentEntry.Entry.Text).Append(' ');

                string trimmedText = currentEntry.Entry.Text.Trim();
                char lastChar = trimmedText.LastOrDefault();

                bool isPunctuation = lastChar == '.' || lastChar == '?' || lastChar == '!';
                bool isEndOfTranscript = i == orderedEntries.Count - 1;
                bool isOverLength = currentUtteranceBuilder.Length > MaxUtteranceLengthChars;

                // Condition to split: It's a punctuation mark AND the utterance is a reasonable length.
                // OR we've hit the max length safeguard, OR it's the very end of the transcript.
                if ((isPunctuation && currentUtteranceBuilder.Length >= MinUtteranceLengthChars) || isOverLength || isEndOfTranscript)
                {
                    // Check for abbreviations (like "U.S.A.") to avoid splitting them.
                    // If the char before the period is a capital letter, it's likely an acronym.
                    if (lastChar == '.' && trimmedText.Length > 1 && char.IsUpper(trimmedText[^2]))
                    {
                        // This is likely an acronym, so we don't split here. Continue the loop.
                        continue;
                    }

                    utterances.Add(new TimedUtterance
                    {
                        Text = currentUtteranceBuilder.ToString().Trim(),
                        StartTime = utteranceStartTime,
                        EndTime = currentEntry.Timestamp
                    });

                    currentUtteranceBuilder.Clear();

                    // **RECOMMENDATION 2 FIX:** Set the start time for the *next* utterance
                    if (!isEndOfTranscript)
                    {
                        utteranceStartTime = orderedEntries[i + 1].Timestamp;
                    }
                }
            }

            return utterances;
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
    }
}