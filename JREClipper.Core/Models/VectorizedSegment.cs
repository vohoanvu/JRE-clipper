// JREClipper.Core/Models/VectorizedSegment.cs
using System.Collections.Generic;
using System.Text.Json.Serialization; // Added for List

namespace JREClipper.Core.Models
{
    public class VectorizedSegment
    {
        public required string SegmentId { get; set; } // Unique ID for the segment
        public string VideoId { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty; // Added
        public double StartTime { get; set; }
        public double EndTime { get; set; }
        public List<float> Embedding { get; set; } = []; // Dense vector embedding
        public string ChannelName { get; set; } = string.Empty; // Added
        public string VideoTitle { get; set; } = string.Empty; // Added
    }

    public class EmbeddingPredictionResult
    {
        [JsonPropertyName("instance")]
        public InstanceData Instance { get; set; }

        [JsonPropertyName("predictions")]
        public List<Prediction> Predictions { get; set; }
    }

    // Represents the "instance" object, containing your original input
    public class InstanceData
    {
        [JsonPropertyName("content")]
        public string Content { get; set; }

        [JsonPropertyName("id")]
        public string Id { get; set; }
    }

    public class Prediction
    {
        [JsonPropertyName("embeddings")]
        public EmbeddingsData Embeddings { get; set; }
    }

    // Represents the "embeddings" object, containing the actual vector
    public class EmbeddingsData
    {
        [JsonPropertyName("values")]
        public float[] Values { get; set; }
    }
}
