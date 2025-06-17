// JREClipper.Infrastructure/Embeddings/GoogleVertexAiEmbeddingService.cs
using Google.Cloud.AIPlatform.V1;
using Google.Protobuf.WellKnownTypes;
using Grpc.Core;
using JREClipper.Core.Interfaces;
using Google.Api.Gax.ResourceNames;
using ProtobufValue = Google.Protobuf.WellKnownTypes.Value;

namespace JREClipper.Infrastructure.Embeddings
{
    public class GoogleVertexAiEmbeddingService : IEmbeddingService
    {
        private readonly PredictionServiceClient _predictionServiceClient;
        private readonly JobServiceClient _jobServiceClient; // Added for Batch Prediction
        private readonly string _endpointName; // This is the Model ID for publisher models or full endpoint for deployed indexes
        private readonly bool _isPublisherModel;
        private readonly string? _modelId; // Store the model ID itself for publisher models
        private readonly string _projectId;
        private readonly string _location;

        public GoogleVertexAiEmbeddingService(
            PredictionServiceClient predictionServiceClient,
            JobServiceClient jobServiceClient, 
            string projectId,
            string location,
            string endpointOrModelId, 
            bool isPublisherModel = false)
        {
            _predictionServiceClient = predictionServiceClient ?? throw new ArgumentNullException(nameof(predictionServiceClient));
            _jobServiceClient = jobServiceClient ?? throw new ArgumentNullException(nameof(jobServiceClient));
            _projectId = projectId ?? throw new ArgumentNullException(nameof(projectId));
            _location = location ?? throw new ArgumentNullException(nameof(location));
            _isPublisherModel = isPublisherModel;

            if (isPublisherModel)
            {
                _modelId = endpointOrModelId ?? throw new ArgumentNullException(nameof(endpointOrModelId), "Model ID is required for publisher models.");
                // _endpointName will be constructed dynamically for batch jobs or not used for Predict if model supports direct calls
                // For online Predict with publisher models, the endpointName is specific.
                // Let's assume for online Predict, it's still needed as before.
                _endpointName = $"projects/{_projectId}/locations/{_location}/publishers/google/models/{_modelId}";
            }
            else
            {
                _endpointName = endpointOrModelId ?? throw new ArgumentNullException(nameof(endpointOrModelId), "Endpoint name is required for non-publisher models.");
                _modelId = null; // Not a publisher model, so no separate modelId needed here for batch job model field
            }
        }

        // Simplified Create method, assuming DI will provide clients and config values.
        // If direct creation is still needed, it should be updated to inject JobServiceClient and StorageClient as well.
        public static GoogleVertexAiEmbeddingService Create(
            string projectId, 
            string location, 
            string endpointOrModelId, 
            bool isPublisherModel = false)
        {
            var predictionClient = PredictionServiceClient.Create();
            var jobClient = JobServiceClient.Create();
            
            return new GoogleVertexAiEmbeddingService(
                predictionClient, 
                jobClient, 
                projectId, 
                location, 
                endpointOrModelId, 
                isPublisherModel);
        }

        public async Task<List<float>> GenerateEmbeddingsAsync(string text)
        {
            ProtobufValue instance;
            // For Gemini models, the instance structure is different.
            if (_isPublisherModel && _modelId != null && _modelId.StartsWith("text-embedding-")) // Updated to reflect typical model naming
            {
                instance = ProtobufValue.ForStruct(new Struct
                {
                    Fields =
                    {
                        { "task_type", ProtobufValue.ForString("RETRIEVAL_DOCUMENT") }, // Example task type
                        { "content", ProtobufValue.ForString(text) }
                        // Add title if applicable for your model and task type
                    }
                });
            }
            else
            {
                // For older models or deployed indexes, it might just be the text or a simple struct
                instance = ProtobufValue.ForStruct(new Struct
                {
                    Fields = { { "content", ProtobufValue.ForString(text) } }
                });
            }

            var instances = new List<ProtobufValue> { instance };
            var parameters = ProtobufValue.ForNull(); 

            var response = await ExecuteWithRetryAsync(() => _predictionServiceClient.PredictAsync(_endpointName, instances, parameters));

            var predictionResult = response.Predictions.FirstOrDefault();
            if (predictionResult != null && predictionResult.StructValue != null && 
                predictionResult.StructValue.Fields.TryGetValue("embeddings", out var embeddingsValue) && 
                embeddingsValue.StructValue != null &&
                embeddingsValue.StructValue.Fields.TryGetValue("values", out var valuesListVal) &&
                valuesListVal.ListValue != null)
            {
                return valuesListVal.ListValue.Values.Select(v => (float)v.NumberValue).ToList();
            }
            throw new InvalidOperationException("Unexpected response format from Vertex AI online embedding prediction.");
        }

        /// <summary>
        /// Generates embeddings for a batch of texts using Vertex AI Batch Prediction.
        /// The input is a GCS URI pointing to an NDJSON file where each line is {"content":"text_segment", "id":"optional_id"}.
        /// The output is a GCS URI pointing to a directory containing NDJSON files with embeddings.
        /// </summary>
        public async Task<string> GenerateEmbeddingsBatchAsync(string inputGcsUri, string outputGcsUri)
        {
            if (string.IsNullOrEmpty(inputGcsUri) || !inputGcsUri.StartsWith("gs://"))
            {
                throw new ArgumentException("Invalid GCS URI format. Must start with 'gs://'.", nameof(inputGcsUri));
            }

            string actualModelResourceName;
            if (_isPublisherModel)
            {
                // _endpointName is already correctly formatted as the model resource name for publisher models
                // e.g., projects/PROJECT_ID/locations/LOCATION_ID/publishers/google/models/MODEL_ID
                actualModelResourceName = _endpointName;
            }
            else
            {
                // For non-publisher models, _endpointName must be a Model resource name for batch prediction.
                // This part might need more robust logic if _endpointName could be an Endpoint resource name.
                if (string.IsNullOrEmpty(_endpointName) || !_endpointName.Contains("/models/")) {
                     throw new InvalidOperationException($"For non-publisher models, the configured 'endpointOrModelId' ('{_endpointName}') must be a Model resource name for batch prediction, not an Endpoint resource name.");
                }
                actualModelResourceName = _endpointName;
            }

            var batchJobDisplayName = $"batch-embedding-job-{Guid.NewGuid()}";

            var batchPredictionJob = new BatchPredictionJob
            {
                DisplayName = batchJobDisplayName,
                Model = actualModelResourceName,
                InputConfig = new BatchPredictionJob.Types.InputConfig
                {
                    InstancesFormat = "jsonl",
                    GcsSource = new GcsSource { Uris = { inputGcsUri } }
                },
                OutputConfig = new BatchPredictionJob.Types.OutputConfig
                {
                    PredictionsFormat = "jsonl",
                    GcsDestination = new GcsDestination { OutputUriPrefix = outputGcsUri }
                },

                ModelParameters = ProtobufValue.ForStruct(new Struct
                {
                    Fields =
                    {
                        { "task_type", ProtobufValue.ForString("RETRIEVAL_DOCUMENT") } 
                        // Add other parameters as needed
                    }
                })
            };

            var parentLocation = LocationName.FromProjectLocation(_projectId, _location).ToString();
            
            BatchPredictionJob createdJob;
            try
            {
                // Use CreateBatchPredictionJobAsync
                createdJob = await ExecuteWithRetryAsync(() => _jobServiceClient.CreateBatchPredictionJobAsync(parentLocation, batchPredictionJob));
            }
            catch (RpcException ex)
            {
                Console.Error.WriteLine($"Error creating batch prediction job: {ex.Status} - {ex.Message}");
                throw;
            }
            
            Console.WriteLine($"Batch prediction job created: {createdJob.Name}");

            // Poll for job completion
            int pollingIntervalSeconds = 60;
            int maxRetries = 30; // Max 30 minutes for typical embedding jobs
            int attempt = 0;

            BatchPredictionJob currentJobState = createdJob;
            while (attempt < maxRetries)
            {
                await Task.Delay(TimeSpan.FromSeconds(pollingIntervalSeconds));
                // Use GetBatchPredictionJobAsync
                currentJobState = await ExecuteWithRetryAsync<BatchPredictionJob>(() => _jobServiceClient.GetBatchPredictionJobAsync(currentJobState.Name));

                Console.WriteLine($"Batch job {currentJobState.Name} state: {currentJobState.State}");

                switch (currentJobState.State)
                {
                    case JobState.Succeeded:
                        Console.WriteLine($"Batch prediction job {currentJobState.Name} succeeded.");
                        // The output is in NDJSON format in the GCS directory specified by currentJobState.OutputInfo.GcsOutputDirectory
                        // The caller will handle reading from this GCS path.
                        return currentJobState.OutputInfo.GcsOutputDirectory; 

                    case JobState.Failed:
                    case JobState.Cancelled:
                    case JobState.Expired:
                        var errorMessage = $"Batch prediction job {currentJobState.Name} ended with state: {currentJobState.State}.";
                        if (currentJobState.Error != null)
                        {
                            errorMessage += $" Error: {currentJobState.Error.Message} (Code: {currentJobState.Error.Code})";
                        }
                        Console.Error.WriteLine(errorMessage);
                        throw new InvalidOperationException(errorMessage);

                    case JobState.Pending:
                    case JobState.Running:
                    case JobState.Cancelling:
                    case JobState.Unspecified:
                    case JobState.Queued:
                    case JobState.Paused:
                    case JobState.Updating:
                         // Continue polling, these are intermediate states
                        break;
                    default:
                        throw new InvalidOperationException($"Unexpected job state: {currentJobState.State}");
                }
                attempt++;
            }

            throw new TimeoutException($"Batch prediction job {createdJob.Name} did not complete within the expected time.");
        }

        private async Task<T> ExecuteWithRetryAsync<T>(Func<Task<T>> action, int maxRetries = 3, int delaySeconds = 5)
        {
            int attempt = 0;
            while (true)
            {
                try
                {
                    return await action();
                }
                catch (RpcException ex) when (ex.StatusCode == StatusCode.Unavailable || ex.StatusCode == StatusCode.DeadlineExceeded)
                {
                    attempt++;
                    if (attempt >= maxRetries)
                    {
                        Console.Error.WriteLine($"Max retries reached for RpcException: {ex.Status} - {ex.Message}");
                        throw;
                    }
                    Console.WriteLine($"RpcException ({ex.StatusCode}), retrying in {delaySeconds}s... (Attempt {attempt}/{maxRetries})");
                    await Task.Delay(TimeSpan.FromSeconds(delaySeconds));
                    delaySeconds *= 2; // Exponential backoff
                }
                catch (Exception ex)
                {
                    // Catch other exceptions that might not be retryable or need specific handling
                    Console.Error.WriteLine($"Unhandled exception during execution: {ex.Message}");
                    throw;
                }
            }
        }
    }
}
