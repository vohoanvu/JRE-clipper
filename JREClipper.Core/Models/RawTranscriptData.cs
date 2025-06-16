// JREClipper.Core/Models/RawTranscriptData.cs
using System.Text.Json.Serialization;

namespace JREClipper.Core.Models
{
    public class RawTranscriptData
    {
        [JsonPropertyName("videoId")]
        public string VideoId { get; set; } = string.Empty;

        [JsonPropertyName("channelName")]
        public string ChannelName { get; set; } = string.Empty;

        [JsonPropertyName("channelSubscription")]
        public string ChannelSubscription { get; set; } = string.Empty;

        [JsonPropertyName("videoTitle")]
        public string VideoTitle { get; set; } = string.Empty;

        [JsonPropertyName("url")]
        public string Url { get; set; } = string.Empty;

        [JsonPropertyName("views")]
        public string Views { get; set; } = string.Empty;

        [JsonPropertyName("videoPostDate")]
        public string VideoPostDate { get; set; } = string.Empty;

        [JsonPropertyName("transcript")]
        public string Transcript { get; set; } = string.Empty; // Full episode text if available

        [JsonPropertyName("transcriptWithTimestamps")]
        public List<TimestampedText> TranscriptWithTimestamps { get; set; } = [];
    }

    public class TimestampedText
    {
        // Example timestamp formats: "0:01.234", "0:59:15", "1:02:03.000"
        [JsonPropertyName("timestamp")]
        public string Timestamp { get; set; } = string.Empty; 
                                               
        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;
    }
}
