// JREClipper.Infrastructure/Embeddings/GoogleVertexAiEmbeddingService.cs
using Google.Cloud.AIPlatform.V1;
using Google.Protobuf.WellKnownTypes;
using Grpc.Core;
using JREClipper.Core.Interfaces;
using Google.Api.Gax.ResourceNames;
using ProtobufValue = Google.Protobuf.WellKnownTypes.Value;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Google.Apis.Auth.OAuth2;

namespace JREClipper.Infrastructure.Embeddings
{
    public class GoogleVertexAiEmbeddingService : IEmbeddingService
    {
        private readonly PredictionServiceClient _predictionServiceClient;
        private readonly JobServiceClient _jobServiceClient; // Kept for legacy, not used in batch anymore
        private readonly HttpClient _httpClient;
        private readonly string _endpointName;
        private readonly bool _isPublisherModel;
        private readonly string? _modelId;
        private readonly string _projectId;
        private readonly string _location;

        public GoogleVertexAiEmbeddingService(
            PredictionServiceClient predictionServiceClient,
            JobServiceClient jobServiceClient,
            HttpClient httpClient,
            string projectId,
            string location,
            string endpointOrModelId,
            bool isPublisherModel = false)
        {
            _predictionServiceClient = predictionServiceClient ?? throw new ArgumentNullException(nameof(predictionServiceClient));
            _jobServiceClient = jobServiceClient ?? throw new ArgumentNullException(nameof(jobServiceClient));
            _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
            _projectId = projectId ?? throw new ArgumentNullException(nameof(projectId));
            _location = location ?? throw new ArgumentNullException(nameof(location));
            _isPublisherModel = isPublisherModel;

            if (isPublisherModel)
            {
                _modelId = endpointOrModelId ?? throw new ArgumentNullException(nameof(endpointOrModelId), "Model ID is required for publisher models.");
                _endpointName = $"projects/{_projectId}/locations/{_location}/publishers/google/models/{_modelId}";
            }
            else
            {
                _endpointName = endpointOrModelId ?? throw new ArgumentNullException(nameof(endpointOrModelId), "Endpoint name is required for non-publisher models.");
                _modelId = null;
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
            var httpClient = new HttpClient(); // Directly create HttpClient here, or use DI to provide it
            
            return new GoogleVertexAiEmbeddingService(
                predictionClient, 
                jobClient, 
                httpClient,
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
        /// Generates embeddings for a batch of texts using Vertex AI Batch Prediction via direct HTTP API.
        /// The input is a GCS URI pointing to an NDJSON file where each line is {"content":"text_segment", "id":"optional_id"}.
        /// The output is a GCS URI pointing to a directory containing NDJSON files with embeddings.
        /// </summary>
        public async Task<string> GenerateEmbeddingsBatchAsync(string inputGcsUri, string outputGcsUri)
        {
            if (string.IsNullOrEmpty(inputGcsUri) || !inputGcsUri.StartsWith("gs://"))
                throw new ArgumentException("Invalid GCS URI format. Must start with 'gs://'.", nameof(inputGcsUri));

            // Prepare job name and model
            var batchJobDisplayName = $"batch-embedding-job-{Guid.NewGuid()}";
            string modelResource = _isPublisherModel
                ? $"projects/{_projectId}/locations/{_location}/publishers/google/models/{_modelId}"
                : _endpointName;

            // Prepare request body (correct GCS field names)
            var requestBody = new
            {
                name = batchJobDisplayName,
                displayName = batchJobDisplayName,
                model = modelResource,
                inputConfig = new
                {
                    instancesFormat = "jsonl",
                    gcsSource = new { uris = new[] { inputGcsUri } }
                },
                outputConfig = new
                {
                    predictionsFormat = "jsonl",
                    gcsDestination = new { outputUriPrefix = outputGcsUri }
                },
                modelParameters = new { task_type = "RETRIEVAL_DOCUMENT" }
            };

            string url = $"https://{_location}-aiplatform.googleapis.com/v1/projects/{_projectId}/locations/{_location}/batchPredictionJobs";
            string token = await GetGoogleAccessTokenAsync();

            var httpRequest = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(JsonSerializer.Serialize(requestBody), Encoding.UTF8, "application/json")
            };
            httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            var response = await _httpClient.SendAsync(httpRequest);
            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync();
                throw new InvalidOperationException($"Failed to create batch prediction job: {response.StatusCode} {error}");
            }
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            string? jobName = doc.RootElement.GetProperty("name").GetString();
            if (string.IsNullOrEmpty(jobName))
                throw new InvalidOperationException("Batch job creation response did not include a job name.");

            // Poll for job completion
            int pollingIntervalSeconds = 60;
            int maxRetries = 30;
            int attempt = 0;
            while (attempt < maxRetries)
            {
                await Task.Delay(TimeSpan.FromSeconds(pollingIntervalSeconds));
                var statusRequest = new HttpRequestMessage(HttpMethod.Get, $"https://{_location}-aiplatform.googleapis.com/v1/{jobName}");
                statusRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                var statusResponse = await _httpClient.SendAsync(statusRequest);
                if (!statusResponse.IsSuccessStatusCode)
                {
                    var error = await statusResponse.Content.ReadAsStringAsync();
                    throw new InvalidOperationException($"Failed to get batch job status: {statusResponse.StatusCode} {error}");
                }
                using var statusDoc = JsonDocument.Parse(await statusResponse.Content.ReadAsStringAsync());
                var state = statusDoc.RootElement.GetProperty("state").GetString();
                if (state == "JOB_STATE_SUCCEEDED")
                {
                    // Output URI is in outputConfig.gcsDestination.outputUri
                    var outputConfig = statusDoc.RootElement.GetProperty("outputConfig");
                    var gcsDest = outputConfig.GetProperty("gcsDestination");
                    var outputUri = gcsDest.GetProperty("outputUriPrefix").GetString();
                    if (string.IsNullOrEmpty(outputUri))
                        throw new InvalidOperationException($"Batch prediction job {jobName} succeeded but outputUri is missing in response.");
                    return outputUri;
                }
                if (state == "JOB_STATE_FAILED" || state == "JOB_STATE_CANCELLED" || state == "JOB_STATE_EXPIRED")
                {
                    throw new InvalidOperationException($"Batch prediction job {jobName} ended with state: {state}");
                }
                // else: pending, running, etc.
                attempt++;
            }
            throw new TimeoutException($"Batch prediction job {jobName} did not complete within the expected time.");
        }

        // Helper to get Google access token for Vertex AI
        private static async Task<string> GetGoogleAccessTokenAsync()
        {
            GoogleCredential credential = await GoogleCredential.GetApplicationDefaultAsync();
            if (credential.IsCreateScopedRequired)
            {
                credential = credential.CreateScoped(["https://www.googleapis.com/auth/cloud-platform"]);
            }
            var token = await credential.UnderlyingCredential.GetAccessTokenForRequestAsync();
            return token;
        }

        private static async Task<T> ExecuteWithRetryAsync<T>(Func<Task<T>> action, int maxRetries = 3, int delaySeconds = 5)
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
