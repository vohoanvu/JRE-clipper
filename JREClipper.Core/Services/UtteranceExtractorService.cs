// In a new file: UtteranceExtractorService.cs
using System.Numerics.Tensors;
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

        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;
    }

    public class UtteranceExtractorService
    {
        // Note: No IEmbeddingService dependency!
        private readonly ILogger<UtteranceExtractorService> _logger;

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
                    Id = $"{transcriptData.VideoId}_{i}", // Create a unique ID
                    Text = timedUtterances[i].Text
                });
            }
            return utterancesForEmbedding;
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