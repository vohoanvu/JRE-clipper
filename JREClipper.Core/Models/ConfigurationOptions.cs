// JREClipper.Core/Models/ConfigurationOptions.cs
namespace JREClipper.Core.Models
{
    public class AppSettings
    {
        public string? EmbeddingProvider { get; set; } // Renamed from DefaultEmbeddingService
        public string? ApplicationName { get; set; }

        // Moved ChunkSettings and ClipSettings here if they are general app settings
        public ChunkSettings? ChunkSettings { get; set; }
        public ClipSettings? ClipSettings { get; set; }
    }

    public class ChunkSettings
    {
        public int MaxChunkDurationSeconds { get; set; } = 180;
        public int MinChunkDurationSeconds { get; set; } = 45;
        public int OverlapDurationSeconds { get; set; } = 15;

        public double SimilarityThreshold { get; set; } = 0.82;
        public int OverlapSentences { get; set; }  = 2;
    }

    public class ClipSettings
    {
        public int MaxClipDuration { get; set; }
        public int MinClipDuration { get; set; }
        public int DefaultClipsPerSummary { get; set; }
    }

    //export GOOGLE_APPLICATION_CREDENTIALS="/Users/vohoanvu/secrets/gen-lang-client-demo-438f6a60e6e4.json"
    public class GoogleCloudStorageOptions
    {
        public string? InputDataUri { get; set; }
        public string? OutputDataUri { get; set; } // For embeddings output
        public string? SegmentedTranscriptDataUri { get; set; } // For segmented transcript NDJSON output
        public string? JrePlaylistCsvUri { get; set; }
    }

    public class VectorDatabaseOptions
    {
        public string? Provider { get; set; } // Renamed from SelectedDatabase
        public VertexAIVectorSearchDbOptions? VertexAI { get; set; }
        public QdrantOptions? Qdrant { get; set; }
        public string? IndexName { get; set; } // Added IndexName
        public string? IndexEndpointDomain { get; set; } // Added IndexEndpointDomain
    }

    public class VertexAIVectorSearchDbOptions // Specific for VectorDatabase:VertexAI section
    {
        public string? ProjectId { get; set; }
        public string? Location { get; set; } // Matched JSON
        public string? IndexEndpointId { get; set; }
        public string? DeployedIndexId { get; set; }
        public string? IndexId { get; set; }
        // CredentialsJsonPath removed
    }

    public class QdrantOptions
    {
        public string? Url { get; set; }
        public string? ApiKey { get; set; }
        public string? CollectionName { get; set; }
        public int VectorDimension { get; set; }
    }

    public class EmbeddingServiceOptions // Bound to "Embedding" section
    {
        // SelectedService removed, as AppSettings.EmbeddingProvider serves this role
        public int Dimension { get; set; } // From Embedding.Dimension
        public int BatchSize { get; set; } // From Embedding.BatchSize

        // Nested provider-specific options are not in the "Embedding" JSON section.
        // These will be configured separately and accessed via IOptions<GoogleVertexAIEmbeddingOptions>, etc.
        // public GoogleVertexAIEmbeddingOptions? GoogleVertexAI { get; set; }
        // public XaiGrokOptions? XaiGrok { get; set; }
        // public MockEmbeddingOptions? Mock { get; set; }
    }

    //export GOOGLE_APPLICATION_CREDENTIALS="/Users/vohoanvu/secrets/gen-lang-client-demo-438f6a60e6e4.json"
    public class GoogleVertexAIEmbeddingOptions // Specific for "GoogleVertexAI" top-level section
    {
        public string? ProjectId { get; set; }
        public string? Location { get; set; } // Matched JSON
        public string? Endpoint { get; set; } // General service endpoint
        public string? ModelName { get; set; } // Matched JSON (textembedding-gecko@001)
    }

    public class XaiGrokOptions // Specific for "XaiGrok" top-level section
    {
        public string? ApiKey { get; set; }
        public string? Endpoint { get; set; } // Renamed from ModelEndpoint to match JSON
    }
    
    public class MockEmbeddingOptions // Can be configured if needed, e.g., under "AppSettings" or its own section
    {
        public int EmbeddingDimension { get; set; } = 768;
    }

    public class VideoProcessingOptions
    {
        public string? FFmpegPath { get; set; }
        public string? TemporaryFolder { get; set; }
        public int MaxConcurrentJobs { get; set; }
        public string? DefaultVideoFormat { get; set; }
        public string? DefaultAudioFormat { get; set; }
    }

    public class GcpOptions // For the top-level "Gcp" section
    {
        public string? ProjectId { get; set; }
    }

    public class PubSubOptions // For the top-level "PubSub" section
    {
        public string? IngestionTopicId { get; set; }
        // ProjectId could be inherited from GcpOptions or set here if different
        // CredentialsJsonPath removed
    }
}
