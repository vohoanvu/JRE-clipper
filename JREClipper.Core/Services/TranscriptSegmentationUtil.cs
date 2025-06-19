// JREClipper.Core/Utils/TranscriptSegmentationUtil.cs
using System.Text;
using JREClipper.Core.Models;
using Microsoft.Extensions.Logging; // Or remove if not logging from here

public static class TranscriptSegmentationUtil
{
    // This is now the single source of truth for utterance grouping.
    public static List<TimedUtterance> GroupIntoUtterancesByPause(
        List<TimestampedText> entries,
        ILogger logger)
    {
        var utterances = new List<TimedUtterance>();
        if (entries == null || entries.Count < 2) return utterances;

        var pauseThreshold = TimeSpan.FromSeconds(0.7);
        const int maxCharsPerUtterance = 2000;

        var orderedEntries = entries
            .Select(e => new { Entry = e, Timestamp = ParseTimestamp(e.Timestamp, logger) })
            .OrderBy(e => e.Timestamp)
            .ToList();

        if (!orderedEntries.Any()) return utterances;

        var currentUtteranceBuilder = new StringBuilder();
        var utteranceStartTime = orderedEntries.First().Timestamp;

        for (int i = 0; i < orderedEntries.Count - 1; i++)
        {
            var currentEntry = orderedEntries[i];
            var nextEntry = orderedEntries[i + 1];

            currentUtteranceBuilder.Append(currentEntry.Entry.Text).Append(' ');

            var pauseDuration = nextEntry.Timestamp - currentEntry.Timestamp;
            bool isSignificantPause = pauseDuration > pauseThreshold;
            bool isOverLength = currentUtteranceBuilder.Length > maxCharsPerUtterance;

            if (isSignificantPause || isOverLength)
            {
                if (currentUtteranceBuilder.Length > 10) // Avoid tiny fragments
                {
                    utterances.Add(new TimedUtterance
                    {
                        Text = currentUtteranceBuilder.ToString().Trim(),
                        StartTime = utteranceStartTime,
                        EndTime = currentEntry.Timestamp
                    });
                }
                currentUtteranceBuilder.Clear();
                utteranceStartTime = nextEntry.Timestamp;
            }
        }

        var lastEntry = orderedEntries.Last();
        currentUtteranceBuilder.Append(lastEntry.Entry.Text);

        if (currentUtteranceBuilder.Length > 0)
        {
            utterances.Add(new TimedUtterance
            {
                Text = currentUtteranceBuilder.ToString().Trim(),
                StartTime = utteranceStartTime,
                EndTime = lastEntry.Timestamp
            });
        }
        return utterances;
    }

    private static TimeSpan ParseTimestamp(string timestamp, ILogger logger)
    {
        if (string.IsNullOrEmpty(timestamp))
        {
            logger.LogWarning($"Warning: Null or empty timestamp provided. Defaulting to TimeSpan.Zero.");
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
            logger.LogError($"Warning: Exception parsing timestamp '{timestamp}': {ex.Message}. Defaulting to TimeSpan.Zero.");
            return TimeSpan.Zero;
        }

        logger.LogWarning($"Warning: Could not parse timestamp. Original: '{timestamp}', Trimmed: '{trimmedTimestamp}'. Defaulting to TimeSpan.Zero.");
        return TimeSpan.Zero;
    }
}