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
        private const int MaxUtteranceLengthChars = 1500; // Safeguard for run-on sentences
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
            var timedUtterances = TranscriptSegmentationUtil.GroupIntoUtterancesByPause(
                transcriptData.TranscriptWithTimestamps, _logger);
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
    }
}