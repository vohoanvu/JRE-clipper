// JREClipper.Infrastructure/Embeddings/GoogleVertexAiEmbeddingService.cs
using Google.Cloud.AIPlatform.V1;
using GProtobuf = Google.Protobuf.WellKnownTypes;
using JREClipper.Core.Interfaces;

namespace JREClipper.Infrastructure.Embeddings
{
    public class GoogleVertexAiEmbeddingService : IEmbeddingService
    {
        private readonly PredictionServiceClient _predictionServiceClient;
        private readonly string _endpointName;
        private readonly bool _isPublisherModel; // Added for Gemini
        private readonly string? _modelName; // Added for Gemini

        // Constructor accepting PredictionServiceClient and endpoint name
        public GoogleVertexAiEmbeddingService(PredictionServiceClient predictionServiceClient, string endpointName, bool isPublisherModel = false, string? modelName = null)
        {
            _predictionServiceClient = predictionServiceClient ?? throw new ArgumentNullException(nameof(predictionServiceClient));
            _endpointName = endpointName ?? throw new ArgumentNullException(nameof(endpointName));
            _isPublisherModel = isPublisherModel;
            _modelName = modelName; // Store model name if it's a publisher model
        }

        // Factory method
        public static GoogleVertexAiEmbeddingService Create(string projectId, string location, string id, bool isPublisherModel = false)
        {
            var client = new PredictionServiceClientBuilder().Build();
            string endpointNameString;
            if (isPublisherModel)
            {
                // For publisher models like Gemini, 'id' is the modelId (e.g., "gemini-embedding-001")
                // Correct format: projects/{PROJECT_ID}/locations/{LOCATION}/publishers/google/models/{MODEL_ID}
                endpointNameString = $"projects/{projectId}/locations/{location}/publishers/google/models/{id}";
            }
            else
            {
                // For custom endpoints, 'id' is the endpointId
                endpointNameString = EndpointName.FromProjectLocationEndpoint(projectId, location, id).ToString();
            }
            return new GoogleVertexAiEmbeddingService(client, endpointNameString, isPublisherModel, isPublisherModel ? id : null);
        }

        public async Task<List<float>> GenerateEmbeddingsAsync(string text)
        {
            GProtobuf.Value instance;
            if (_isPublisherModel && _modelName != null && _modelName.StartsWith("gemini"))
            {
                // Construct specific payload for Gemini models
                instance = GProtobuf.Value.ForStruct(new GProtobuf.Struct
                {
                    Fields =
                    {
                        { "task_type", GProtobuf.Value.ForString("RETRIEVAL_DOCUMENT") },
                        { "content", GProtobuf.Value.ForString(text) }
                        // Optionally add "title" if available/needed
                        // { "title", GProtobuf.Value.ForString("Your Document Title") }
                    }
                });
            }
            else
            {
                instance = GProtobuf.Value.ForString(text);
            }

            var instances = new List<GProtobuf.Value> { instance };
            var parameters = GProtobuf.Value.ForNull(); // Or specify parameters if your model needs them

            var response = await _predictionServiceClient.PredictAsync(_endpointName, instances, parameters);
            
            // Assuming the response structure contains a list of floats for the embedding.
            // This will vary based on the specific model deployed to the Vertex AI endpoint.
            // You'll need to inspect the actual response structure and adjust parsing accordingly.
            var predictionResult = response.Predictions.FirstOrDefault();
            if (predictionResult != null && predictionResult.KindCase == GProtobuf.Value.KindOneofCase.StructValue)
            {
                var structVal = predictionResult.StructValue;
                // For Gemini, the embeddings are nested under "embeddings" -> "values"
                if (structVal.Fields.TryGetValue("embeddings", out var embeddingsStructVal) && 
                    embeddingsStructVal.KindCase == GProtobuf.Value.KindOneofCase.StructValue &&
                    embeddingsStructVal.StructValue.Fields.TryGetValue("values", out var valuesListVal) &&
                    valuesListVal.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
                {
                    return valuesListVal.ListValue.Values.Select(v => (float)v.NumberValue).ToList();
                }
                // Fallback for older models or different structures (original logic)
                else if (structVal.Fields.TryGetValue("embeddings", out var embeddingsValue) && embeddingsValue.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
                {
                    var listVal = embeddingsValue.ListValue;
                    if (listVal.Values.FirstOrDefault()?.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
                    {
                        var embeddingList = listVal.Values.First().ListValue;
                        return embeddingList.Values.Select(v => (float)v.NumberValue).ToList();
                    }
                }
            }
            return new List<float>(); // Return empty or throw if parsing fails
        }

        public async Task<List<List<float>>> GenerateEmbeddingsBatchAsync(IEnumerable<string> texts)
        {
            var allEmbeddings = new List<List<float>>();

            // Gemini models (gemini-embedding-001) currently support a batch size of 1 for the Predict API.
            // Therefore, we iterate and call the single embedding generation method.
            if (_isPublisherModel && _modelName != null && _modelName.StartsWith("gemini"))
            {
                foreach (var text in texts)
                {
                    // This will use the existing GenerateEmbeddingsAsync logic which handles
                    // the specific request/response format for Gemini.
                    var singleEmbedding = await GenerateEmbeddingsAsync(text);
                    allEmbeddings.Add(singleEmbedding);
                }
                return allEmbeddings;
            }

            // Original batch logic for other models that might support actual batching.
            // This part might need adjustment if other non-Gemini publisher models also have batch limits,
            // or if custom deployed models have different batching capabilities.
            // For now, it retains the previous batch structure for non-Gemini models.
            List<GProtobuf.Value> instances;
            // This 'else' block for non-Gemini models is retained from previous logic.
            // It assumes non-Gemini models might handle a list of strings directly as instances.
            // This might need refinement based on the specific non-Gemini models used.
            instances = texts.Select(text => GProtobuf.Value.ForString(text)).ToList();
            
            var parameters = GProtobuf.Value.ForNull(); 

            var response = await _predictionServiceClient.PredictAsync(_endpointName, instances, parameters);

            foreach (var predictionResult in response.Predictions)
            {
                if (predictionResult != null && predictionResult.KindCase == GProtobuf.Value.KindOneofCase.StructValue)
                {
                    var structVal = predictionResult.StructValue;
                    // For Gemini, the embeddings are nested under "embeddings" -> "values"
                    // This parsing logic is duplicated from GenerateEmbeddingsAsync for consistency,
                    // though for Gemini, this path won't be hit due to the loop above.
                    // It's kept for the hypothetical non-Gemini batch case.
                    if (structVal.Fields.TryGetValue("embeddings", out var embeddingsStructVal) && 
                        embeddingsStructVal.KindCase == GProtobuf.Value.KindOneofCase.StructValue &&
                        embeddingsStructVal.StructValue.Fields.TryGetValue("values", out var valuesListVal) &&
                        valuesListVal.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
                    {
                        allEmbeddings.Add(valuesListVal.ListValue.Values.Select(v => (float)v.NumberValue).ToList());
                    }
                    // Fallback for older models or different structures (original logic)
                    else if (structVal.Fields.TryGetValue("embeddings", out var embeddingsValue) && embeddingsValue.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
                    {
                        var listVal = embeddingsValue.ListValue;
                        if (listVal.Values.FirstOrDefault()?.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
                        {
                            var embeddingList = listVal.Values.First().ListValue;
                            allEmbeddings.Add(embeddingList.Values.Select(v => (float)v.NumberValue).ToList());
                        }
                        else
                        {
                            allEmbeddings.Add([]); 
                        }
                    }
                    else
                    {
                        allEmbeddings.Add([]); 
                    }
                }
                else
                {
                    allEmbeddings.Add([]); 
                }
            }
            return allEmbeddings;
        }
    }
}
