### Implementation Plan

#### **Project Structure:**


* `JREClipper.Api`
* `JREClipper.Core`
    * `JREClipper.Core.Models`
    * `JREClipper.Core.Interfaces`
    * `JREClipper.Core.Services`
* `JREClipper.Infrastructure`
    * `JREClipper.Infrastructure.GoogleCloudStorage`
    * `JREClipper.Infrastructure.Embeddings`
    * `JREClipper.Infrastructure.VectorDatabases.Qdrant` (and similar for other DBs)

---

#### **Phase 1: Solution and Project Setup**

1.  **Create Solution and Projects:** (already done)
    ```bash
    dotnet new sln -n JREClipper
    dotnet new webapi -n JREClipper.Api
    dotnet new classlib -n JREClipper.Core
    dotnet new classlib -n JREClipper.Infrastructure

    dotnet sln JREClipper.sln add JREClipper.Api
    dotnet sln JREClipper.sln add JREClipper.Core
    dotnet sln JREClipper.sln add JREClipper.Infrastructure
    ```

2.  **Add Project References:** (already done)
    ```bash
    # Api depends on Core and Infrastructure
    dotnet add JREClipper.Api reference JREClipper.Core
    dotnet add JREClipper.Api reference JREClipper.Infrastructure

    # Infrastructure depends on Core
    dotnet add JREClipper.Infrastructure reference JREClipper.Core
    ```

3.  **Install Core NuGet Packages (`JREClipper.Api`):** (already done)
    ```bash
    # For CSV parsing
    dotnet add JREClipper.Api package CsvHelper
    # For Google Drive API client
    dotnet add JREClipper.Api package Google.Apis.Drive.v3
    dotnet add JREClipper.Api package Google.Apis.Auth.OAuth2
    ```

#### **Phase 2: Data Models (`JREClipper.Core/Models`)**

Create a `Models` folder within `JREClipper.Core` and define the following:

1.  **`VideoMetadata.cs`**: **(Updated to match provided CSV)**
    ```csharp
    // JREClipper.Core/Models/VideoMetadata.cs
    using CsvHelper.Configuration.Attributes;
    using System; // For DateTime

    namespace JREClipper.Core.Models
    {
        public class VideoMetadata
        {
            [Name("videoId")]
            public string VideoId { get; set; } = string.Empty;

            [Name("title")]
            public string Title { get; set; } = string.Empty;

            [Name("description")]
            public string Description { get; set; } = string.Empty;

            [Name("date")] // CSV provides date in "2025-06-10T02:57:34Z" format
            public DateTime Date { get; set; }

            [Name("Url")] // Matches casing in CSV
            public string Url { get; set; } = string.Empty;

            [Name("isTranscripted")]
            public bool IsTranscripted { get; set; }
        }
    }
    ```

2.  **`RawTranscriptData.cs`**: **(New model to perfectly match the input JSON structure)**
    ```csharp
    // JREClipper.Core/Models/RawTranscriptData.cs
    using System.Text.Json.Serialization;
    using System.Collections.Generic; // For List

    namespace JREClipper.Core.Models
    {
        public class RawTranscriptData
        {
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
            public string VideoPostDate { get; set; } = string.Empty; // Keep as string as per JSON example

            [JsonPropertyName("transcript")]
            public string Transcript { get; set; } = string.Empty; // Full episode text

            [JsonPropertyName("transcriptWithTimestamps")]
            public List<TimestampedText> TranscriptWithTimestamps { get; set; } = new List<TimestampedText>();
        }

        public class TimestampedText
        {
            [JsonPropertyName("timestamp")]
            public string Timestamp { get; set; } = string.Empty; // "0:01", "0:07", etc.
            [JsonPropertyName("text")]
            public string Text { get; set; } = string.Empty;
        }

        // For internal processing, we might simplify or re-map.
        // This is the model that TranscriptProcessor will work with.
        public class VideoTranscript
        {
            public string VideoId { get; set; } = string.Empty; // To link back to VideoMetadata
            public List<TimestampedText> Entries { get; set; } = new List<TimestampedText>();
            public string ChannelName { get; set; } = string.Empty; // Pass through from raw data
        }
    }
    ```

3.  **`VectorizedSegment.cs`**: **(Updated to include `ChannelName`)**
    ```csharp
    // JREClipper.Core/Models/VectorizedSegment.cs
    using System; // For Guid

    namespace JREClipper.Core.Models
    {
        public class VectorizedSegment
        {
            public string Id { get; set; } = Guid.NewGuid().ToString(); // Unique ID for this segment
            public string VideoId { get; set; } = string.Empty;       // Original YouTube video ID
            public string OriginalText { get; set; } = string.Empty;  // The actual text content of the segment
            public string StartTimestamp { get; set; } = string.Empty; // Start timestamp of this segment in the video
            public float[] Vector { get; set; } = Array.Empty<float>(); // The embedding vector

            // Enriched metadata for RAG
            public string VideoTitle { get; set; } = string.Empty;
            public string ChannelName { get; set; } = string.Empty;
        }
    }
    ```

4.  **Search Models (`VectorSearchModels.cs`)**: **(Minor update to `VectorSearchResult` to match `VectorizedSegment`)**
    ```csharp
    // JREClipper.Core/Models/VectorSearchModels.cs
    using System.Collections.Generic; // For IEnumerable

    namespace JREClipper.Core.Models
    {
        public class VectorSearchQuery
        {
            public string QueryText { get; set; } = string.Empty;
            public int K { get; set; } = 5; // Number of nearest neighbors to retrieve
            public string? VideoIdFilter { get; set; } // Optional: filter search to a specific video
        }

        public class VectorSearchResult
        {
            public string VideoId { get; set; } = string.Empty;
            public string SegmentId { get; set; } = string.Empty;
            public string OriginalText { get; set; } = string.Empty;
            public string StartTimestamp { get; set; } = string.Empty;
            public double Score { get; set; } // Similarity score from vector DB
            public string VideoTitle { get; set; } = string.Empty; // Enriched metadata for display
            public string ChannelName { get; set; } = string.Empty; // Enriched metadata for display
        }
    }
    ```

#### **Phase 3: Google Cloud Storage Data Ingestion (`JREClipper.Infrastructure/GoogleCloudStorage`)**

Create a `GoogleCloudStorage` folder within `JREClipper.Infrastructure`.

1.  **`IGoogleCloudStorageService.cs` (`JREClipper.Core/Interfaces`)**:
    ```csharp
    // JREClipper.Core/Interfaces/IGoogleCloudStorageService.cs
    using System.IO;
    using System.Collections.Generic;
    using System.Threading.Tasks;

    namespace JREClipper.Core.Interfaces
    {
        public interface IGoogleCloudStorageService
        {
            /// <summary>
            /// Downloads an object from a GCS bucket as a MemoryStream.
            /// </summary>
            /// <param name="bucketName">The name of the GCS bucket.</param>
            /// <param name="objectName">The full path (name) of the object within the bucket.</param>
            /// <returns>A MemoryStream containing the object's content.</returns>
            Task<MemoryStream> DownloadObjectAsync(string bucketName, string objectName);

            /// <summary>
            /// Lists objects within a specific GCS bucket, optionally filtered by a prefix.
            /// </summary>
            /// <param name="bucketName">The name of the GCS bucket.</param>
            /// <param name="prefix">The prefix to filter by (simulates a folder).</param>
            /// <returns>A list of object names.</returns>
            Task<List<string>> ListObjectsAsync(string bucketName, string? prefix = null);
        }
    }
    ```

2.  **`GoogleCloudStorageService.cs` (`JREClipper.Infrastructure/GoogleCloudStorage`)**:
    *   **Required Dependencies (for `JREClipper.Infrastructure` project):**
    *   `Google.Cloud.Storage.V1`
    ```csharp
    // JREClipper.Infrastructure/GoogleCloudStorage/GoogleCloudStorageService.cs
    using Google.Cloud.Storage.V1;
    using Microsoft.Extensions.Logging;
    using JREClipper.Core.Interfaces;

    namespace JREClipper.Infrastructure.GoogleCloudStorage
    {
        public class GoogleCloudStorageService : IGoogleCloudStorageService
        {
            private readonly StorageClient _storageClient;
            private readonly ILogger<GoogleCloudStorageService> _logger;

            public GoogleCloudStorageService(ILogger<GoogleCloudStorageService> logger)
            {
                // StorageClient will use Application Default Credentials (ADC) automatically.
                // This is the recommended authentication method on GCP.
                _storageClient = StorageClient.Create();
                _logger = logger;
            }

            public async Task<MemoryStream> DownloadObjectAsync(string bucketName, string objectName)
            {
                throw new NotImplementedException("DownloadObjectAsync for GoogleCloudStorageService is not implemented.");
            }

            public async Task<List<string>> ListObjectsAsync(string bucketName, string? prefix = null)
            {
                throw new NotImplementedException("ListObjectsAsync for GoogleCloudStorageService is not implemented.");
            }
        }
    }
    ```

#### **Phase 4: Transcription Processing and Chunking (`JREClipper.Core/Services`)**

Create a `Services` folder within `JREClipper.Core`.

1.  **`ITranscriptProcessor.cs` (`JREClipper.Core/Interfaces`)**:
    ```csharp
    // JREClipper.Core/Interfaces/ITranscriptProcessor.cs
    using System.Collections.Generic; // For List
    using JREClipper.Core.Models;

    namespace JREClipper.Core.Interfaces
    {
        public interface ITranscriptProcessor
        {
            /// <summary>
            /// Processes raw timestamped transcript data and chunks it into smaller, vectorized segments.
            /// </summary>
            /// <param name="videoTranscript">The structured transcript entries for a video.</param>
            /// <param name="videoMetadata">The metadata of the video, used for enriching segments.</param>
            /// <returns>A list of VectorizedSegment objects.</returns>
            List<VectorizedSegment> ProcessAndChunk(VideoTranscript videoTranscript, VideoMetadata videoMetadata);
        }
    }
    ```

2.  **`BasicTranscriptProcessor.cs` (`JREClipper.Core/Services`)**:
    ```csharp
    // JREClipper.Core/Services/BasicTranscriptProcessor.cs
    using Microsoft.Extensions.Logging;
    using System.Collections.Generic; // For List
    using JREClipper.Core.Interfaces;
    using JREClipper.Core.Models;

    namespace JREClipper.Core.Services
    {
        public class BasicTranscriptProcessor : ITranscriptProcessor
        {
            private readonly ILogger<BasicTranscriptProcessor> _logger;
            // Configurable parameters for chunking strategy (e.g., via IOptions<T>)
            private readonly int _maxChunkDurationSeconds;
            private readonly int _minChunkDurationSeconds;
            private readonly int _overlapDurationSeconds;

            public BasicTranscriptProcessor(ILogger<BasicTranscriptProcessor> logger)
            {
                _logger = logger;
                // Default values, would typically be from configuration
                _maxChunkDurationSeconds = 20;
                _minChunkDurationSeconds = 5;
                _overlapDurationSeconds = 3;
                throw new NotImplementedException("Constructor for BasicTranscriptProcessor is not implemented.");
            }

            public List<VectorizedSegment> ProcessAndChunk(VideoTranscript videoTranscript, VideoMetadata videoMetadata)
            {
                throw new NotImplementedException("ProcessAndChunk for BasicTranscriptProcessor is not implemented.");
            }
        }
    }
    ```
    * **Required Dependencies (for `JREClipper.Core` project - though only `Microsoft.Extensions.Logging` directly):**
        * `Microsoft.Extensions.Logging`

#### **Phase 5: Embedding Service (`JREClipper.Infrastructure/Embeddings`)**

Create an `Embeddings` folder within `JREClipper.Infrastructure`.

1.  **`IEmbeddingService.cs` (`JREClipper.Core/Interfaces`)**:
    ```csharp
    // JREClipper.Core/Interfaces/IEmbeddingService.cs
    using System.Threading.Tasks;

    namespace JREClipper.Core.Interfaces
    {
        public interface IEmbeddingService
        {
            /// <summary>
            /// Generates a vector embedding for the given text.
            /// </summary>
            /// <param name="text">The text to embed.</param>
            /// <returns>A float array representing the vector embedding.</returns>
            Task<float[]> GenerateEmbeddingAsync(string text);
        }
    }
    ```

2.  **`GoogleVertexAiEmbeddingService.cs` (`JREClipper.Infrastructure/Embeddings`)**:
    ```csharp
    // JREClipper.Infrastructure/Embeddings/GoogleVertexAiEmbeddingService.cs
    using Microsoft.Extensions.Configuration;
    using Microsoft.Extensions.Logging;
    using JREClipper.Core.Interfaces;
    using System.Threading.Tasks;
    // Add Google.Cloud.AIPlatform.V1 or appropriate NuGet package for Vertex AI

    namespace JREClipper.Infrastructure.Embeddings
    {
        public class GoogleVertexAiEmbeddingService : IEmbeddingService
        {
            private readonly IConfiguration _configuration;
            private readonly ILogger<GoogleVertexAiEmbeddingService> _logger;

            public GoogleVertexAiEmbeddingService(IConfiguration configuration, ILogger<GoogleVertexAiEmbeddingService> logger)
            {
                _configuration = configuration;
                _logger = logger;
                throw new NotImplementedException("Constructor for GoogleVertexAiEmbeddingService is not implemented.");
            }

            public async Task<float[]> GenerateEmbeddingAsync(string text)
            {
                throw new NotImplementedException("GenerateEmbeddingAsync for GoogleVertexAiEmbeddingService is not implemented.");
            }
        }
    }
    ```
    * **Required Dependencies (for `JREClipper.Infrastructure` project):**
        * `Google.Cloud.AIPlatform.V1` (or the specific NuGet package for Vertex AI embeddings)
        * `Microsoft.Extensions.Configuration`
        * `Microsoft.Extensions.Logging`

3.  **`XaiGrokEmbeddingService.cs` (`JREClipper.Infrastructure/Embeddings`)**:
    ```csharp
    // JREClipper.Infrastructure/Embeddings/XaiGrokEmbeddingService.cs
    using Microsoft.Extensions.Configuration;
    using Microsoft.Extensions.Logging;
    using JREClipper.Core.Interfaces;
    using System.Threading.Tasks;

    namespace JREClipper.Infrastructure.Embeddings
    {
        public class XaiGrokEmbeddingService : IEmbeddingService
        {
            private readonly IConfiguration _configuration;
            private readonly ILogger<XaiGrokEmbeddingService> _logger;

            public XaiGrokEmbeddingService(IConfiguration configuration, ILogger<XaiGrokEmbeddingService> logger)
            {
                _configuration = configuration;
                _logger = logger;
                throw new NotImplementedException("Constructor for XaiGrokEmbeddingService is not implemented.");
            }

            public async Task<float[]> GenerateEmbeddingAsync(string text)
            {
                 throw new NotImplementedException("GenerateEmbeddingAsync for XaiGrokEmbeddingService is not implemented.");
            }
        }
    }
    ```

4.  **`MockEmbeddingService.cs` (`JREClipper.Infrastructure/Embeddings`)**:
    ```csharp
    // JREClipper.Infrastructure/Embeddings/MockEmbeddingService.cs
    using Microsoft.Extensions.Logging;
    using JREClipper.Core.Interfaces;
    using System; // For Random, Array
    using System.Threading.Tasks;

    namespace JREClipper.Infrastructure.Embeddings
    {
        public class MockEmbeddingService : IEmbeddingService
        {
            private readonly ILogger<MockEmbeddingService> _logger;
            private const int EmbeddingDimension = 768; // Matching a common dimension like Vertex AI's gecko@001
            private readonly Random _random = new Random();

            public MockEmbeddingService(ILogger<MockEmbeddingService> logger)
            {
                _logger = logger;
                throw new NotImplementedException("Constructor for MockEmbeddingService is not implemented.");
            }

            public Task<float[]> GenerateEmbeddingAsync(string text)
            {
                throw new NotImplementedException("GenerateEmbeddingAsync for MockEmbeddingService is not implemented.");
            }
        }
    }
    ```

#### **Phase 6: Pluggable Vector Database Service**

We abstract the service to allow for multiple providers.

1.  **`IVectorDatabaseService.cs` (`JREClipper.Core/Interfaces`)**:
    ```csharp
    // JREClipper.Core/Interfaces/IVectorDatabaseService.cs
    using System.Collections.Generic; // For IEnumerable
    using System.Threading.Tasks;
    using JREClipper.Core.Models;

    namespace JREClipper.Core.Interfaces
    {
        public interface IVectorDatabaseService
        {
            /// <summary>
            /// Initializes the vector database (e.g., creates collections/indexes if they don't exist).
            /// </summary>
            Task InitializeAsync();

            /// <summary>
            /// Upserts (inserts or updates) a vectorized segment into the database.
            /// </summary>
            /// <param name="segment">The segment to upsert.</param>
            Task UpsertSegmentAsync(VectorizedSegment segment);

            /// <summary>
            /// Searches for similar segments based on a query vector.
            /// </summary>
            /// <param name="queryVector">The embedding vector of the search query.</param>
            /// <param name="limit">The maximum number of similar segments to retrieve.</param>
            /// <param name="videoIdFilter">Optional: Filters the search results to a specific video ID.</param>
            /// <returns>A list of similar segments.</returns>
            Task<IEnumerable<VectorSearchResult>> SearchSimilarSegmentsAsync(float[] queryVector, int limit, string? videoIdFilter = null);
        }
    }
    ```

2.  **`VertexAiVectorSearchService.cs` (`JREClipper.Infrastructure/VectorDatabases/VertexAI`)**:
    *   **Required Dependencies (for `JREClipper.Infrastructure` project):**
    *   `Google.Cloud.AIPlatform.V1`
    ```csharp
    // JREClipper.Infrastructure/VectorDatabases/Qdrant/QdrantVectorDatabaseService.cs
    // JREClipper.Infrastructure/VectorDatabases/VertexAI/VertexAiVectorSearchService.cs
    using Google.Cloud.AIPlatform.V1;
    using Microsoft.Extensions.Configuration;
    using Microsoft.Extensions.Logging;
    using JREClipper.Core.Interfaces;
    using JREClipper.Core.Models;
    using Qdrant.Client;
    // For Qdrant.Client.Grpc types
    using Qdrant.Client.Grpc;

    namespace JREClipper.Infrastructure.VectorDatabases.VertexAI
    {
        public class VertexAiVectorSearchService : IVectorDatabaseService
        {
            private readonly ILogger<VertexAiVectorSearchService> _logger;
            private readonly MatchServiceClient _matchServiceClient;
            private readonly IndexEndpointName _indexEndpointName;
            private readonly string _deployedIndexId;

            public VertexAiVectorSearchService(IConfiguration configuration, ILogger<VertexAiVectorSearchService> logger)
            {
                _logger = logger;
                // Config values from appsettings.json
                var projectId = configuration["VectorDatabase:VertexAI:ProjectId"];
                var location = configuration["VectorDatabase:VertexAI:Location"];
                var indexEndpointId = configuration["VectorDatabase:VertexAI:IndexEndpointId"];
                _deployedIndexId = configuration["VectorDatabase:VertexAI:DeployedIndexId"];

                // ADC will be used for auth
                _matchServiceClient = MatchServiceClient.Create();
                _indexEndpointName = IndexEndpointName.FromProjectLocationIndexEndpoint(projectId, location, indexEndpointId);
                throw new NotImplementedException("Constructor for VertexAiVectorSearchService is not implemented.");
            }

            public Task InitializeAsync()
            {
                 // For Vertex AI, initialization might involve checking if the endpoint and index are available.
                 // Often, this can be a no-op if infrastructure is managed via Terraform/CLI.
                 _logger.LogInformation("Vertex AI Vector Search Service initialized.");
                 return Task.CompletedTask;
            }

            public async Task UpsertSegmentAsync(VectorizedSegment segment)
            {
                // Vertex AI uses an IndexServiceClient for upserting, which is a different client.
                // This is a more complex operation involving batching and file uploads to GCS.
                // This highlights a key difference between providers.
                throw new NotImplementedException("UpsertSegmentAsync for Vertex AI is complex and not implemented. It typically involves batch updates via IndexServiceClient.");
            }

            public async Task<IEnumerable<VectorSearchResult>> SearchSimilarSegmentsAsync(float[] queryVector, int limit, string? videoIdFilter = null)
            {
                throw new NotImplementedException("SearchSimilarSegmentsAsync for VertexAiVectorSearchService is not implemented.");
            }
        }
    }
    ```

#### **Phase 7: Orchestration Service (`JREClipper.Core/Services`)**

Create a `Services` folder within `JREClipper.Core`.

1.  **`IVectorizationOrchestratorService.cs` (`JREClipper.Core/Interfaces`)**:
    ```csharp
    // JREClipper.Core/Interfaces/IVectorizationOrchestratorService.cs

    namespace JREClipper.Core.Interfaces
    {
        public interface IVectorizationOrchestratorService
        {
            /// <summary>
            /// Initiates the ingestion and vectorization of YouTube video transcripts from a GCS bucket.
            /// </summary>
            /// <param name="bucketName">The GCS bucket containing the data.</param>
            /// <param name="prefix">The prefix (folder) within the bucket to process.</param>
            Task IngestChannelTranscriptsAsync(string bucketName, string? prefix);

            /// <summary>
            /// Searches for video segments similar to the given query text.
            /// </summary>
            /// <param name="query">The search query details.</param>
            /// <returns>A list of video segments matching the query.</returns>
            Task<IEnumerable<VectorSearchResult>> SearchVideoSegmentsAsync(VectorSearchQuery query);
        }
    }
    ```

2.  **`VectorizationOrchestratorService.cs` (`JREClipper.Core/Services`)**:
    ```csharp
    // JREClipper.Core/Services/VectorizationOrchestratorService.cs
    using CsvHelper;
    using CsvHelper.Configuration;
    using Microsoft.Extensions.Logging;
    using JREClipper.Core.Interfaces;
    using JREClipper.Core.Models;

    namespace JREClipper.Core.Services
    {
        public class VectorizationOrchestratorService : IVectorizationOrchestratorService
        {
            private readonly IGoogleCloudStorageService _gcsService; 
            private readonly ITranscriptProcessor _transcriptProcessor;
            private readonly IEmbeddingService _embeddingService; // The specific embedding service will be resolved by the factory
            private readonly IVectorDatabaseService _vectorDatabaseService;
            private readonly ILogger<VectorizationOrchestratorService> _logger;
            private readonly Func<EmbeddingProvider, IEmbeddingService> _embeddingServiceFactory; // Factory for embedding services

            public VectorizationOrchestratorService(
                IGoogleCloudStorageService gcsService,
                ITranscriptProcessor transcriptProcessor,
                IVectorDatabaseService vectorDatabaseService,
                Func<EmbeddingProvider, IEmbeddingService> embeddingServiceFactory, // Inject the factory
                ILogger<VectorizationOrchestratorService> logger)
            {
                _gcsService = gcsService;
                _transcriptProcessor = transcriptProcessor;
                _vectorDatabaseService = vectorDatabaseService;
                _embeddingServiceFactory = embeddingServiceFactory;
                _logger = logger;
                throw new NotImplementedException("Constructor for VectorizationOrchestratorService is not implemented.");
            }

            public async Task IngestChannelTranscriptsAsync(string bucketName, string? prefix) // <-- CHANGED
            {
                _logger.LogInformation("Starting ingestion from GCS bucket '{BucketName}' with prefix '{Prefix}'", bucketName, prefix);
                // 1. Use _gcsService.ListObjectsAsync to find metadata.csv and all .json files.
                // 2. Use _gcsService.DownloadObjectAsync for each file.
                // 3. The rest of the logic (parsing, chunking, embedding, upserting) remains the same.
                throw new NotImplementedException("IngestChannelTranscriptsAsync for VectorizationOrchestratorService is not implemented.");
            }

            public async Task<IEnumerable<VectorSearchResult>> SearchVideoSegmentsAsync(VectorSearchQuery query)
            {
                throw new NotImplementedException("SearchVideoSegmentsAsync for VectorizationOrchestratorService is not implemented.");
            }
        }
    }
    ```

#### **Phase 8: Web API (`JREClipper.Api`)**
This is where we implement the pluggable architecture for the Vector DB and the new asynchronous ingestion flow.

1.  **`IngestionController.cs` (API Controller)**: **(Refactored for Asynchronous Processing)**
    *   **Required Dependencies:** Add `Google.Cloud.PubSub.V1` NuGet package.
    ```csharp
    // JREClipper.Api/Controllers/IngestionController.cs
    using Google.Cloud.PubSub.V1;
    using Microsoft.AspNetCore.Mvc;
    using System.Threading.Tasks;

    public class IngestionRequest
    {
        public string BucketName { get; set; }
        public string? Prefix { get; set; }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class IngestionController : ControllerBase
    {
        private readonly ILogger<IngestionController> _logger;
        private readonly PublisherClient _publisherClient;

        public IngestionController(IConfiguration configuration, ILogger<IngestionController> logger)
        {
            _logger = logger;
            var topicId = configuration["PubSub:IngestionTopicId"];
            var projectId = configuration["Gcp:ProjectId"];
            var topicName = new TopicName(projectId, topicId);
            _publisherClient = PublisherClient.Create(topicName);
        }

        /// <summary>
        /// Initiates the ingestion process for transcripts in a GCS bucket.
        /// This endpoint returns immediately and processing occurs in the background.
        /// </summary>
        /// <param name="request">The details of the GCS location to ingest.</param>
        [HttpPost("start")]
        [ProducesResponseType(StatusCodes.Status202Accepted)]
        public async Task<IActionResult> StartIngestion([FromBody] IngestionRequest request)
        {
            // Publish a message to Pub/Sub to trigger the background worker.
            // The message can be a simple JSON string.
            var messageJson = System.Text.Json.JsonSerializer.Serialize(request);
            await _publisherClient.PublishAsync(messageJson);

            _logger.LogInformation("Ingestion request for bucket '{BucketName}' accepted and queued.", request.BucketName);
            return Accepted();
        }
    }
    ```
    ***Note:** The `IVectorizationOrchestratorService` is no longer injected here. It will be used by the background worker.*

    * **`SearchController.cs` (`JREClipper.Api/Controllers`)**:
        ```csharp
        // JREClipper.Api/Controllers/SearchController.cs
        using Microsoft.AspNetCore.Mvc;
        using Microsoft.Extensions.Logging;
        using System.Collections.Generic; // For IEnumerable
        using System.Threading.Tasks;
        using JREClipper.Core.Interfaces;
        using JREClipper.Core.Models;

        namespace JREClipper.Api.Controllers
        {
            [ApiController]
            [Route("api/[controller]")]
            public class SearchController : ControllerBase
            {
                private readonly IVectorizationOrchestratorService _orchestratorService;
                private readonly ILogger<SearchController> _logger;

                public SearchController(IVectorizationOrchestratorService orchestratorService, ILogger<SearchController> logger)
                {
                    _orchestratorService = orchestratorService;
                    _logger = logger;
                    throw new NotImplementedException("Constructor for SearchController is not implemented.");
                }

                /// <summary>
                /// Searches for YouTube video segments based on a natural language query.
                /// </summary>
                /// <param name="query">The search query details.</param>
                /// <returns>A list of relevant video segments.</returns>
                [HttpGet("videos")]
                [ProducesResponseType(StatusCodes.Status200OK)]
                [ProducesResponseType(StatusCodes.Status400BadRequest)]
                [ProducesResponseType(StatusCodes.Status500InternalServerError)]
                public async Task<ActionResult<IEnumerable<VectorSearchResult>>> SearchVideos([FromQuery] VectorSearchQuery query)
                {
                    throw new NotImplementedException("SearchVideos for SearchController is not implemented.");
                }
            }
        }
        ```

2.  **`Program.cs` (`JREClipper.Api`)**:
    ```csharp
    // JREClipper.Api/Program.cs
    using JREClipper.Infrastructure.GoogleCloudStorage;
    using JREClipper.Infrastructure.VectorDatabases.VertexAI;

    // Define enums for providers
    public enum EmbeddingProvider { GoogleVertexAI, XaiGrok, Mock }
    public enum VectorDatabaseProvider { Qdrant, VertexAI }

    var builder = WebApplication.CreateBuilder(args);

    // Add services to the container.
    builder.Services.AddControllers();
    builder.Services.AddEndpointsApiExplorer();
    builder.Services.AddSwaggerGen();

    // --- Core Services ---
    builder.Services.AddScoped<ITranscriptProcessor, BasicTranscriptProcessor>();
    builder.Services.AddScoped<IVectorizationOrchestratorService, VectorizationOrchestratorService>();

    // --- Infrastructure Services ---

    // Google Cloud Storage Service
    builder.Services.AddSingleton<IGoogleCloudStorageService, GoogleCloudStorageService>();

    // Embedding Service Factory - allows dynamic selection of embedding provider
    builder.Services.AddSingleton<Func<EmbeddingProvider, IEmbeddingService>>(serviceProvider => (embeddingProvider) =>
    {
        var loggerFactory = serviceProvider.GetRequiredService<ILoggerFactory>();
        var configuration = serviceProvider.GetRequiredService<IConfiguration>();

        return embeddingProvider switch
        {
            EmbeddingProvider.GoogleVertexAI => new GoogleVertexAiEmbeddingService(configuration, loggerFactory.CreateLogger<GoogleVertexAiEmbeddingService>()),
            EmbeddingProvider.XaiGrok => new XaiGrokEmbeddingService(configuration, loggerFactory.CreateLogger<XaiGrokEmbeddingService>()),
            EmbeddingProvider.Mock => new MockEmbeddingService(loggerFactory.CreateLogger<MockEmbeddingService>()),
            _ => throw new ArgumentOutOfRangeException(nameof(embeddingProvider), embeddingProvider, "Unsupported embedding provider specified in configuration."),
        };
    });

    // DYNAMIC VECTOR DATABASE FACTORY
    builder.Services.AddSingleton<IVectorDatabaseService>(sp =>
    {
        var config = sp.GetRequiredService<IConfiguration>();
        var loggerFactory = sp.GetRequiredService<ILoggerFactory>();

        // Read the provider from config
        var provider = config.GetValue<VectorDatabaseProvider>("VectorDatabase:Provider");

        return provider switch
        {
            VectorDatabaseProvider.Qdrant => new QdrantVectorDatabaseService(
                config,
                loggerFactory.CreateLogger<QdrantVectorDatabaseService>()),

            VectorDatabaseProvider.VertexAI => new VertexAiVectorSearchService(
                config,
                loggerFactory.CreateLogger<VertexAiVectorSearchService>()),

            _ => throw new ArgumentOutOfRangeException(nameof(provider), "Unsupported vector database provider specified in configuration.")
        };
    });


    var app = builder.Build();

    // Configure the HTTP request pipeline.
    if (app.Environment.IsDevelopment())
    {
        app.UseSwagger();
        app.UseSwaggerUI();
    }

    app.UseHttpsRedirection();
    app.UseAuthorization();
    app.MapControllers();

    // Initialize services that require async setup on application startup
    using (var scope = app.Services.CreateScope())
    {
        var vectorDbService = scope.ServiceProvider.GetRequiredService<IVectorDatabaseService>();
        await vectorDbService.InitializeAsync();
    }

    app.Run();
    ```

#### **Phase 9: Configuration**

Create `appsettings.json` and `appsettings.Development.json` in `JREClipper.Api`.

1.  **`appsettings.json`**:
    ```json
    {
        "Logging": {
            "LogLevel": {
            "Default": "Information",
            "Microsoft.AspNetCore": "Warning",
            "JREClipper": "Information" // Set higher for more detail in your services
            }
        },
        "AllowedHosts": "*",
        "Gcp": {
            "ProjectId": "your-gcp-project-id"
        },
        "PubSub": {
            "IngestionTopicId": "jre-transcripts-ingestion-topic"
        },
        "GoogleCloudStorage": {
            "BucketName": "your-jre-transcripts-bucket"
        },
        "AppSettings": {
            "EmbeddingProvider": "GoogleVertexAI" // Options: "GoogleVertexAI", "XaiGrok", "Mock"
        },
        "VectorDatabase": {
            // CHOOSE YOUR PROVIDER HERE
            "Provider": "VertexAI", // Options: "Qdrant", "VertexAI"

            // Configuration for Qdrant
            "Qdrant": {
                "Url": "http://localhost:6334",
                "ApiKey": "",
                "CollectionName": "youtube_video_segments"
            },
            // Configuration for Google Cloud Vertex AI Vector Search
            "VertexAI": {
                "ProjectId": "your-gcp-project-id",
                "Location": "us-central1",
                "IndexEndpointId": "your-vector-search-endpoint-id",
                "DeployedIndexId": "your-deployed-index-id"
            }
        },
        "Embedding": {
            "Dimension": 768 // Must match your chosen embedding model
        },
        "GoogleVertexAI": {
            "ProjectId": "your-gcp-project-id",
            "Location": "us-central1", // Or your desired region
            "Endpoint": "us-central1-aiplatform.googleapis.com", // Region-specific endpoint
            "ModelName": "textembedding-gecko@001" // Example model name. Check Vertex AI docs for latest.
            // For authentication, Google.Cloud.AIPlatform generally uses Application Default Credentials,
            // so ensure your Cloud Run service account has 'Vertex AI User' role.
        },
        "XaiGrok": {
            "ApiKey": "YOUR_XAI_GROK_API_KEY",
            "Endpoint": "https://api.grok.x.ai/v1" // Consult xAI Grok API documentation for the correct endpoint
            // Add other Grok-specific configurations as needed
        }
    }
    ```

#### **Phase 10: Docker Setup for Qdrant (Local Testing)**

Make sure Docker Desktop is running.

```bash
docker pull qdrant/qdrant
docker run -d --name qdrant-local -p 6333:6333 -p 6334:6334 qdrant/qdrant
```
- **REST API**: `http://localhost:6333`
- **gRPC API**: `http://localhost:6334` (used by .NET `Qdrant.Client`)
- **Web UI**: `http://localhost:6333/dashboard`

#### **Phase 11: Running and Testing**
1.  **Test Ingestion:**
    * Use the `POST /api/Ingestion/start` endpoint.
    * Provide your Google Drive `folderId` as a query parameter.
    * Execute. Monitor the API's console output for `_logger` messages.

2.  **Test Search:**
    * Use the `GET /api/Search/videos` endpoint.
    * Provide a `QueryText` (e.g., "AI and healthcare"), and `K` (e.g., 3). Optionally, add a `VideoIdFilter`.
    * Execute.

#### **Phase 12: Production Deployment Considerations (Google Cloud)**

1. **Cost-Optimized Compute: Cloud Run**

*   **API Service (`JREClipper.Api`):**
    *   **CPU Allocation:** Deploy with the `--cpu-boost` flag in gcloud CLI or set "CPU is only allocated during request processing" in the UI. This is a major cost saver for services with intermittent traffic.
    *   **Scaling:** Set `--min-instances=0` to allow the service to scale to zero when not in use. You pay nothing for compute when idle.
    *   **IAM:** The service account for this Cloud Run service needs the **`Pub/Sub Publisher`** role.

*   **Ingestion Worker:**
    *   **Architecture:** Create a *second* Cloud Run service. This service does not expose an HTTP endpoint. Instead, it is triggered directly by messages on the Pub/Sub topic.
    *   **Trigger:** Configure the service with a Pub/Sub push subscription as its trigger.
    *   **Processing:** This service will host the `VectorizationOrchestratorService` logic. When it receives a message, it will execute the `IngestChannelTranscriptsAsync` method.
    *   **Timeouts:** You can configure a longer timeout for this service since it's handling background jobs, not live user requests.
    *   **IAM:** The service account for this worker service needs more permissions:
        *   **`Storage Object Viewer`**: To read transcripts from GCS.
        *   **`Vertex AI User`**: To generate embeddings and interact with Vector Search.
        *   **`Logs Writer`**: (Implicitly granted).

2. **Vector Database Cost Considerations**

*   **Vertex AI Vector Search (Recommended for GCP):** This is a fully managed, serverless offering. You pay for the amount of data stored and the number of queries (QPS) you perform.
    *   **Cost Advantage:** It scales automatically and requires zero operational overhead. You don't pay for idle VMs. This perfectly matches the serverless ethos of Cloud Run.
    *   **Updates:** Use `BatchUpdate` for the initial large ingestion, which is more cost-effective than streaming individual updates.

*   **Self-Managed (Qdrant on GKE/Compute Engine):**
    *   **Cost Disadvantage:** You pay for the underlying VM/cluster **24/7**, regardless of traffic. This can be significantly more expensive for applications with low or spiky usage patterns.
    *   **Operational Overhead:** You are responsible for patching, scaling, and maintaining the database.

3. **Storage Cost Considerations**

*   **GCS Storage Classes:** Your JRE transcript data is likely write-once, read-many. Using the `Standard` storage class is appropriate for actively accessed data. If you find parts of the dataset become archival, you could implement lifecycle policies to move them to cheaper `Nearline` or `Coldline` storage, but for this app's purpose, `Standard` is likely the best choice.



### **Architectural Vision: A Fully Serverless, Event-Driven Workflow**

Here is the high-level data flow for our new, simplified architecture:

1.  **Frontend (Firebase Hosting):** A user interacts with a static HTML page containing the Vertex AI Search widget.
2.  **Search (Vertex AI):** The widget communicates directly and securely with the Vertex AI Search API endpoint you provided. The user gets search results instantly in the UI.
3.  **Job Initiation (Cloud Function):** When the user clicks a "Generate Video" button next to a search result, the frontend makes a direct call to a new, simple HTTP-triggered Cloud Function.
4.  **Queueing (Pub/Sub):** The Cloud Function takes the search result data, creates a job ID, and publishes a message to a Pub/Sub topic.
5.  **Processing (Cloud Run Job):** A **Cloud Run Job** (a service designed for long-running, non-HTTP tasks) is triggered by the Pub/Sub message. It performs the heavy lifting of downloading, clipping, and stitching the video.
6.  **Status & Output (Firestore & GCS):** The Cloud Run Job writes the final video/report to GCS and updates the job's status in a **Firestore** database, which is ideal for real-time status updates on the frontend.

This architecture minimizes custom code and eliminates the need to manage a constantly running backend server.

---

## The Step-by-Step Implementation Plan

### **Phase 1: Frontend Setup with Firebase and Vertex AI Search Widget**

**Goal:** Create a live, searchable web page with zero backend code.

1.  **Create a Firebase Project:**
    *   Go to the [Firebase Console](https://console.firebase.google.com/).
    *   Click "Add project" and link it to your existing Google Cloud project (`gen-lang-client-demo`).

2.  **Set up Firebase Hosting:**
    *   On your local machine, install the Firebase CLI: `npm install -g firebase-tools`.
    *   Log in: `firebase login`.
    *   In a new local directory for your frontend, run `firebase init hosting`.
        *   Select your existing project.
        *   Use `public` as the public directory.
        *   Configure as a single-page app? **No**.

3.  **Create the `index.html` Page:**
    *   In the newly created `public` directory, edit `index.html`.
    *   This will be a simple, clean HTML page. You can use a minimalist CSS framework like Pico.css or just plain HTML/CSS.
    *   It should contain a title, a brief description, and a `<div>` where the Vertex AI widget will be rendered.

4.  **Integrate the Vertex AI Search Widget:**
    *   Go to your Vertex AI Search application in the Google Cloud Console.
    *   Navigate to the "Integration" section.
    *   Copy the provided `<script>` and `<discovery-search-widget>` HTML tags.
    *   Paste these tags directly into your `index.html`. The widget handles authentication and communication with the search API securely out-of-the-box.

5.  **Deploy the Frontend:**
    *   From your frontend directory, run: `firebase deploy --only hosting`.
    *   Firebase will give you a live URL (e.g., `your-project.web.app`). You now have a working search engine.

---

### **Phase 2: Create the Job Initiation Cloud Function**

**Goal:** Create a lightweight, serverless endpoint to kick off the video generation process. We will use the Firebase NodeJS for the Cloud Function.

1.  **Create the Cloud Function:**
    *   Go to the Google Cloud Console -> Cloud Functions.
    *   Click "Create Function".
    *   **Environment:** 2nd gen.
    *   **Function name:** `initiate-video-job`.
    *   **Region:** `us-central1`.
    *   **Trigger:** HTTP. Check "Allow unauthenticated invocations" for now (we can secure it later with App Check).
    *   **Runtime:** Firebase NodeJS 22.
    *   **Source Code:** Select "Inline editor".

2.  **Write the Cloud Function Code:**
    *   The Cloud Console provides a template. You will modify the main `functions/index.js` file. This is the **only code** you need for this part of the workflow.
    *   The function will receive the search result data (videoId, startTime, endTime, etc.) in the HTTP request body.
    *   **Logic:**
        a.  Generate a new `JobId` (`Guid.NewGuid().ToString()`).
        b.  Create a payload object containing the `JobId` and the received segment data.
        c.  Use the `Google.Cloud.PubSub.V1` library to publish this payload to a new Pub/Sub topic (`video-processing-jobs`).
        d.  Return the `JobId` in the HTTP response.

3.  **Update the Frontend:**
    *   Add JavaScript to your `index.html` page.
    *   This script will listen for the `searchResultClicked` event from the Vertex AI widget.
    *   When a result is clicked, a "Generate Video" button should appear.
    *   Clicking this button will use the `fetch` API to make a `POST` request to your new Cloud Function's trigger URL, sending the relevant segment data. It will then store the returned `JobId` in local storage and redirect the user to a status page (e.g., `status.html?jobId=...`).

---

### **Phase 3: Create the Video Processing Cloud Run Job**

**Goal:** Set up a containerized, long-running job that is triggered by Pub/Sub and does the heavy lifting.

1.  **Create a `Dockerfile`:**
    *   This is the most "custom" part. You need a Dockerfile that starts from a base image (like Debian) and installs `yt-dlp` and `FFmpeg`.
    *   It will also contain a simple Python or Bash script that acts as the entry point. This script will be responsible for the video processing logic (download, cut, stitch, upload). **No .NET code is needed here.**

2.  **Build and Push the Docker Image:**
    *   Use Google Cloud Build to automatically build your Dockerfile and push the resulting image to Google Artifact Registry. You can set up a trigger to do this automatically when you commit the Dockerfile to a Git repository.

3.  **Create the Cloud Run Job:**
    *   Go to the Google Cloud Console -> Cloud Run.
    *   Select the "Jobs" tab and click "Create Job".
    *   **Source:** Select the container image you just pushed to Artifact Registry.
    *   **Configuration:**
        *   Increase the **Task timeout** to at least 30-60 minutes to allow for video downloading and processing.
        *   Allocate sufficient CPU and Memory (e.g., 2 vCPU, 4 GiB Memory).
    *   **Trigger:** This is the key step.
        *   Select "Cloud Pub/Sub".
        *   Choose the `video-processing-jobs` topic you created earlier.
        *   This configures the job to automatically execute whenever a new message is published. The message payload will be passed to your container as an environment variable.

---

### **Phase 4: Implement State Management and Status Page**

**Goal:** Allow the user to see the status of their job in real-time.

1.  **Set up Firestore:**
    *   Go to the Firebase Console -> Firestore Database.
    *   Create a new database in Native mode.
    *   **Security Rules:** Set up rules so that clients can read from the `jobs` collection, but only your backend services can write to it.

2.  **Update the Cloud Run Job Script:**
    *   Modify the entry point script inside your Docker container.
    *   **On Start:** Use a library (like `google-cloud-firestore` for Python) to create a new document in a `jobs` collection in Firestore with the `JobId`. Set its status to `{"status": "Processing", "progress": 0}`.
    *   **During Processing:** Periodically update the document's `progress` field (e.g., after each clip is downloaded).
    *   **On Completion/Failure:** Update the document with the final status, including GCS URLs for the video and report, or an error message.

3.  **Create the `status.html` Page:**
    *   Add a new page to your Firebase Hosting project.
    *   **JavaScript Logic:**
        a.  On page load, get the `jobId` from the URL query parameter.
        b.  Use the Firebase Web SDK to listen for real-time updates on the corresponding document in the Firestore `jobs` collection (`onSnapshot`).
        c.  Update the UI dynamically as the status changes (e.g., show a progress bar, display "Complete", provide download links when they appear).

This plan maximizes the use of managed, serverless components, requires minimal custom code (only for the Cloud Function and the processing script), and results in a highly scalable, cost-effective, and modern cloud-native application.