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

        // Constructor accepting PredictionServiceClient and endpoint name
        public GoogleVertexAiEmbeddingService(PredictionServiceClient predictionServiceClient, string endpointName)
        {
            _predictionServiceClient = predictionServiceClient ?? throw new ArgumentNullException(nameof(predictionServiceClient));
            _endpointName = endpointName ?? throw new ArgumentNullException(nameof(endpointName));
        }

        // Example: "projects/{PROJECT_ID}/locations/{LOCATION}/endpoints/{ENDPOINT_ID}"
        public static GoogleVertexAiEmbeddingService Create(string projectId, string location, string endpointId)
        {
            var client = new PredictionServiceClientBuilder().Build();
            var endpointName = EndpointName.FromProjectLocationEndpoint(projectId, location, endpointId).ToString();
            return new GoogleVertexAiEmbeddingService(client, endpointName);
        }

        public async Task<List<float>> GenerateEmbeddingsAsync(string text)
        {
            var instances = new List<GProtobuf.Value> { GProtobuf.Value.ForString(text) };
            var parameters = GProtobuf.Value.ForNull(); // Or specify parameters if your model needs them

            var response = await _predictionServiceClient.PredictAsync(_endpointName, instances, parameters);
            
            // Assuming the response structure contains a list of floats for the embedding.
            // This will vary based on the specific model deployed to the Vertex AI endpoint.
            // You'll need to inspect the actual response structure and adjust parsing accordingly.
            var predictionResult = response.Predictions.FirstOrDefault();
            if (predictionResult != null && predictionResult.KindCase == GProtobuf.Value.KindOneofCase.StructValue)
            {
                var structVal = predictionResult.StructValue;
                if (structVal.Fields.TryGetValue("embeddings", out var embeddingsValue) && embeddingsValue.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
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
            var instances = texts.Select(text => GProtobuf.Value.ForString(text)).ToList();
            var parameters = GProtobuf.Value.ForNull(); // Or specify parameters if your model needs them

            var response = await _predictionServiceClient.PredictAsync(_endpointName, instances, parameters);
            var allEmbeddings = new List<List<float>>();

            foreach (var predictionResult in response.Predictions)
            {
                if (predictionResult != null && predictionResult.KindCase == GProtobuf.Value.KindOneofCase.StructValue)
                {
                    var structVal = predictionResult.StructValue;
                    if (structVal.Fields.TryGetValue("embeddings", out var embeddingsValue) && embeddingsValue.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
                    {
                        var listVal = embeddingsValue.ListValue;
                        if (listVal.Values.FirstOrDefault()?.KindCase == GProtobuf.Value.KindOneofCase.ListValue)
                        {
                            var embeddingList = listVal.Values.First().ListValue;
                            allEmbeddings.Add(embeddingList.Values.Select(v => (float)v.NumberValue).ToList());
                        }
                        else
                        {
                            allEmbeddings.Add([]); // Add empty list for this text if no embedding found
                        }
                    }
                    else
                    {
                        allEmbeddings.Add([]); // Add empty list if embedding structure is not as expected
                    }
                }
                else
                {
                    allEmbeddings.Add([]); // Add empty list if prediction is malformed
                }
            }
            return allEmbeddings;
        }
    }
}
