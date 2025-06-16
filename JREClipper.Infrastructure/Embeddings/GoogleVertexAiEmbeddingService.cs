// JREClipper.Infrastructure/Embeddings/GoogleVertexAiEmbeddingService.cs
using Google.Cloud.AIPlatform.V1;
using Google.Protobuf.WellKnownTypes;
using Grpc.Core;
using JREClipper.Core.Interfaces;
using ProtobufValue = Google.Protobuf.WellKnownTypes.Value; // Alias to resolve ambiguity

namespace JREClipper.Infrastructure.Embeddings
{
    public class GoogleVertexAiEmbeddingService : IEmbeddingService
    {
        private readonly PredictionServiceClient _predictionServiceClient;
        private readonly string _endpointName;
        private readonly bool _isPublisherModel;
        private readonly string? _modelName;

        // Constructor and Create method unchanged
        public GoogleVertexAiEmbeddingService(PredictionServiceClient predictionServiceClient, string endpointName, bool isPublisherModel = false, string? modelName = null)
        {
            _predictionServiceClient = predictionServiceClient ?? throw new ArgumentNullException(nameof(predictionServiceClient));
            _endpointName = endpointName ?? throw new ArgumentNullException(nameof(endpointName));
            _isPublisherModel = isPublisherModel;
            _modelName = modelName;
        }

        public static GoogleVertexAiEmbeddingService Create(string projectId, string location, string id, bool isPublisherModel = false)
        {
            var client = new PredictionServiceClientBuilder().Build();
            string endpointNameString;
            if (isPublisherModel)
            {
                endpointNameString = $"projects/{projectId}/locations/{location}/publishers/google/models/{id}";
            }
            else
            {
                endpointNameString = EndpointName.FromProjectLocationEndpoint(projectId, location, id).ToString();
            }
            return new GoogleVertexAiEmbeddingService(client, endpointNameString, isPublisherModel, isPublisherModel ? id : null);
        }

        public async Task<List<float>> GenerateEmbeddingsAsync(string text)
        {
            ProtobufValue instance;
            if (_isPublisherModel && _modelName != null && _modelName.StartsWith("gemini"))
            {
                instance = ProtobufValue.ForStruct(new Struct
                {
                    Fields =
                {
                    { "task_type", ProtobufValue.ForString("RETRIEVAL_DOCUMENT") },
                    { "content", ProtobufValue.ForString(text) }
                }
                });
            }
            else
            {
                instance = ProtobufValue.ForString(text);
            }

            var instances = new List<ProtobufValue> { instance };
            var parameters = ProtobufValue.ForNull();

            var response = await ExecuteWithRetryAsync(() => _predictionServiceClient.PredictAsync(_endpointName, instances, parameters));

            var predictionResult = response.Predictions.FirstOrDefault();
            if (predictionResult != null && predictionResult.KindCase == ProtobufValue.KindOneofCase.StructValue)
            {
                var structVal = predictionResult.StructValue;
                if (structVal.Fields.TryGetValue("embeddings", out var embeddingsStructVal) &&
                    embeddingsStructVal.KindCase == ProtobufValue.KindOneofCase.StructValue &&
                    embeddingsStructVal.StructValue.Fields.TryGetValue("values", out var valuesListVal) &&
                    valuesListVal.KindCase == ProtobufValue.KindOneofCase.ListValue)
                {
                    return valuesListVal.ListValue.Values.Select(v => (float)v.NumberValue).ToList();
                }
                else if (structVal.Fields.TryGetValue("embeddings", out var embeddingsValue) && embeddingsValue.KindCase == ProtobufValue.KindOneofCase.ListValue)
                {
                    var listVal = embeddingsValue.ListValue;
                    if (listVal.Values.FirstOrDefault()?.KindCase == ProtobufValue.KindOneofCase.ListValue)
                    {
                        var embeddingList = listVal.Values.First().ListValue;
                        return embeddingList.Values.Select(v => (float)v.NumberValue).ToList();
                    }
                }
            }
            throw new InvalidOperationException("Unexpected response format from Vertex AI embedding service.");
        }

        public async Task<List<List<float>>> GenerateEmbeddingsBatchAsync(IEnumerable<string> texts)
        {
            var allEmbeddings = new List<List<float>>();

            if (_isPublisherModel && _modelName != null && _modelName.StartsWith("gemini"))
            {
                var tasks = texts.Select(text => GenerateEmbeddingsAsync(text)).ToList();
                var results = await Task.WhenAll(tasks);
                allEmbeddings.AddRange(results);
                return allEmbeddings;
            }

            var instances = texts.Select(text => ProtobufValue.ForString(text)).ToList();
            var parameters = ProtobufValue.ForNull();

            var response = await ExecuteWithRetryAsync(() => _predictionServiceClient.PredictAsync(_endpointName, instances, parameters));

            foreach (var predictionResult in response.Predictions)
            {
                if (predictionResult != null && predictionResult.KindCase == ProtobufValue.KindOneofCase.StructValue)
                {
                    var structVal = predictionResult.StructValue;
                    if (structVal.Fields.TryGetValue("embeddings", out var embeddingsStructVal) &&
                        embeddingsStructVal.KindCase == ProtobufValue.KindOneofCase.StructValue &&
                        embeddingsStructVal.StructValue.Fields.TryGetValue("values", out var valuesListVal) &&
                        valuesListVal.KindCase == ProtobufValue.KindOneofCase.ListValue)
                    {
                        allEmbeddings.Add(valuesListVal.ListValue.Values.Select(v => (float)v.NumberValue).ToList());
                    }
                    else if (structVal.Fields.TryGetValue("embeddings", out var embeddingsValue) && embeddingsValue.KindCase == ProtobufValue.KindOneofCase.ListValue)
                    {
                        var listVal = embeddingsValue.ListValue;
                        if (listVal.Values.FirstOrDefault()?.KindCase == ProtobufValue.KindOneofCase.ListValue)
                        {
                            var embeddingList = listVal.Values.First().ListValue;
                            allEmbeddings.Add(embeddingList.Values.Select(v => (float)v.NumberValue).ToList());
                        }
                        else
                        {
                            allEmbeddings.Add(new List<float>());
                        }
                    }
                    else
                    {
                        allEmbeddings.Add(new List<float>());
                    }
                }
                else
                {
                    allEmbeddings.Add(new List<float>());
                }
            }
            return allEmbeddings;
        }

        private static async Task<PredictResponse> ExecuteWithRetryAsync(Func<Task<PredictResponse>> apiCall)
        {
            while (true)
            {
                try
                {
                    return await apiCall();
                }
                catch (RpcException ex) when (ex.StatusCode == StatusCode.ResourceExhausted)
                {
                    var retryAfter = ex.Trailers.GetValue("retry-after");
                    if (int.TryParse(retryAfter, out int waitSeconds))
                    {
                        await Task.Delay(waitSeconds * 1000);
                    }
                    else
                    {
                        await Task.Delay(60000); // 1 minute
                    }
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException($"Error executing Vertex AI API call: {ex.Message}", ex);
                }
            }
        }
    }
}
