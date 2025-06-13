// JREClipper.Core/Models/ConfigurationOptions.cs
namespace JREClipper.Core.Models
{
    public class AppSettings
    {
        public string? DefaultEmbeddingService { get; set; }
        public string? DefaultVectorDatabase { get; set; }
        public string? ApplicationName { get; set; }
    }

    public class GoogleCloudStorageOptions
    {
        public string? BucketName { get; set; }
        public string? CredentialsJsonPath { get; set; } // Path to service account JSON
        public string? ProjectId { get; set; }
    }

    public class VectorDatabaseOptions
    {
        public string? SelectedDatabase { get; set; } // e.g., "VertexAI", "Qdrant"
        public VertexAIOptions? VertexAI { get; set; }
        // public QdrantOptions Qdrant { get; set; } // Example for future Qdrant integration
    }

    public class VertexAIOptions // Consolidated VertexAI options
    {
        public string? ProjectId { get; set; }
        public string? LocationId { get; set; } // e.g., "us-central1"
        public string? IndexEndpointId { get; set; } // For Vector Search
        public string? DeployedIndexId { get; set; } // For Vector Search
        public string? Publisher { get; set; } = "google"; // For Embeddings
        public string? EmbeddingModel { get; set; } = "textembedding-gecko@003"; // For Embeddings
        public string? CredentialsJsonPath { get; set; } // Path to service account JSON
        public int Dimensions { get; set; } = 768; // Default, adjust as per embedding model
    }

    public class EmbeddingServiceOptions
    {
        public string? SelectedService { get; set; } // e.g., "GoogleVertexAI", "XaiGrok", "Mock"
        public VertexAIOptions? GoogleVertexAI { get; set; } // Use the consolidated VertexAIOptions
        public XaiGrokOptions? XaiGrok { get; set; }
        public MockEmbeddingOptions? Mock { get; set; }
    }

    public class XaiGrokOptions
    {
        public string? ApiKey { get; set; }
        public string? ModelEndpoint { get; set; }
        // Any other specific settings for Grok
    }
    
    public class MockEmbeddingOptions
    {
        public int EmbeddingDimension { get; set; } = 768; // Default dimension for mock embeddings
    }

    public class VideoProcessingOptions
    {
        public int SegmentDurationSeconds { get; set; } = 300; // e.g., 5 minutes
        public int SegmentOverlapSeconds { get; set; } = 30;  // e.g., 30 seconds
    }

    public class AgentSettings // For future agent-based architecture
    {
        public string? MasterCoordinatorEndpoint { get; set; }
        // Other agent-specific settings
    }

    public class PubSubOptions
    {
        public string? ProjectId { get; set; }
        public string? TopicId { get; set; }
        public string? SubscriptionId { get; set; }
        public string? CredentialsJsonPath { get; set; }
    }
}
