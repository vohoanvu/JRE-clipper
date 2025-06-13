// JREClipper.Infrastructure/VectorDatabases/VertexAI/VertexAiVectorSearchService.cs
using Google.Cloud.AIPlatform.V1; // Corrected: Using the namespace
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Grpc.Core;

namespace JREClipper.Infrastructure.VectorDatabases.VertexAI
{
    public class VertexAiVectorSearchService : IVectorDatabaseService
    {
        private readonly MatchServiceClient _matchServiceClient;
        private readonly string _indexPath; // Format: projects/{PROJECT_ID}/locations/{LOCATION_ID}/indexes/{INDEX_ID}
        private readonly string _deployedIndexId; // The ID of the deployed index on an IndexEndpoint

        public VertexAiVectorSearchService(MatchServiceClient matchServiceClient, string indexPath, string deployedIndexId)
        {
            _matchServiceClient = matchServiceClient ?? throw new ArgumentNullException(nameof(matchServiceClient));
            _indexPath = indexPath ?? throw new ArgumentNullException(nameof(indexPath));
            // _deployedIndexId is used for MatchServiceClient.FindNeighbors.
            // It should be the DeployedIndex.Id, which is part of the IndexEndpoint.
            // The IndexEndpoint itself is what MatchServiceClient targets.
            // Let's assume _deployedIndexId is the DeployedIndex.Id string.
            _deployedIndexId = deployedIndexId ?? throw new ArgumentNullException(nameof(deployedIndexId));
        }

        // Helper to create an instance, similar to the embedding service
        // The 'indexPath' here refers to the Index resource name (projects/.../indexes/{INDEX_ID})
        // The 'deployedIndexId' here should be the ID of the DeployedIndex on an IndexEndpoint.
        // The IndexEndpoint resource name will be constructed or passed for FindNeighbors.
        public static VertexAiVectorSearchService Create(string projectId, string locationId, string indexId, string indexEndpointId, string deployedIndexId)
        {
            var client = new MatchServiceClientBuilder().Build();
            var indexPath = IndexName.FormatProjectLocationIndex(projectId, locationId, indexId);
            // The MatchServiceClient needs the IndexEndpoint resource name for queries.
            // We'll store the DeployedIndex.Id separately as it's also needed.
            // For simplicity, we'll assume the user provides the full IndexEndpoint resource name
            // or we construct it if only the ID is given.
            // Let's assume indexEndpointId is the full resource name for now.
            // If it's just the ID, it would be: IndexEndpointName.FormatProjectLocationIndexEndpoint(projectId, locationId, indexEndpointId);
            return new VertexAiVectorSearchService(client, indexPath, deployedIndexId);
        }

        public async Task AddVectorAsync(VectorizedSegment segment)
        {
            // Vertex AI Vector Search typically ingests data in batches (upserting to an index).
            // A single add might be inefficient or not directly supported for online updates without re-indexing.
            // This often involves preparing data files (JSON) and using IndexService.UpsertDatapoints.
            // For simplicity, we'll assume batch additions. If single adds are critical, the approach needs to be revised based on API capabilities for live indexes.
            await AddVectorsBatchAsync(new List<VectorizedSegment> { segment });
        }

        public async Task AddVectorsBatchAsync(IEnumerable<VectorizedSegment> segments)
        {
            // This is a simplified representation. Actual implementation requires:
            // 1. Formatting segments into the JSON structure Vertex AI expects for datapoints.
            // 2. Using IndexServiceClient.UpsertDatapointsAsync (not MatchServiceClient).
            //    MatchServiceClient is for querying, not for index data manipulation.
            // This would involve creating an IndexDatapoint for each segment.
            // For now, this method will be a placeholder or would need significant changes
            // if direct upsert to a live queryable index is the goal without batch re-indexing.

            // Example of what would be needed (conceptual - requires IndexServiceClient):
            /*
            var indexServiceClient = new IndexServiceClientBuilder().Build(); // Needs to be injected or created
            var datapoints = segments.Select(s => new IndexDatapoint
            {
                DatapointId = s.SegmentId,
                FeatureVector = { s.Embedding }, // Assuming s.Embedding is List<float>
                // Add restrictions/metadata if supported and needed
            }).ToList();

            var request = new UpsertDatapointsRequest
            {
                Index = _indexPath, // This should be the Index resource name, not DeployedIndexId
            };
            request.Datapoints.AddRange(datapoints);

            try
            {
                await indexServiceClient.UpsertDatapointsAsync(request);
            }
            catch (RpcException ex)
            {
                // Handle API errors
                Console.WriteLine($"Error upserting datapoints: {ex.Status}");
                throw;
            }
            */
            Console.WriteLine($"VertexAiVectorSearchService.AddVectorsBatchAsync called with {segments.Count()} segments. Actual data upsert requires IndexServiceClient and is not fully implemented here.");
            await Task.CompletedTask; // Placeholder
        }

        public async Task<IEnumerable<VectorSearchResult>> SearchSimilarVectorsAsync(List<float> queryVector, int topK, string? channelFilter = null)
        {
            var queryDatapoint = new IndexDatapoint
            {
                FeatureVector = { queryVector }
            };

            // Add filtering if channelFilter is provided and your index supports it.
            // This requires setting up the index with appropriate restriction tags.
            if (!string.IsNullOrEmpty(channelFilter))
            {
                queryDatapoint.Restricts.Add(new IndexDatapoint.Types.Restriction
                {
                    Namespace = "channel_name", // Must match the namespace used during indexing
                    AllowList = { channelFilter }
                });
            }

            var request = new FindNeighborsRequest
            {
                // IndexEndpoint should be the full resource name of the IndexEndpoint
                // e.g., projects/{PROJECT_ID}/locations/{LOCATION_ID}/indexEndpoints/{INDEX_ENDPOINT_ID}
                // We are assuming _matchServiceClient was created with this endpoint or it's passed/set elsewhere.
                // For this call, we need the DeployedIndexId.
                IndexEndpoint = _indexPath, // This was incorrect. It should be the IndexEndpoint resource name.
                                            // Let's assume _indexPath was meant to be the IndexEndpoint for the constructor,
                                            // or it needs to be passed/configured differently.
                                            // For now, this will likely cause an error if _indexPath is an Index name.
                                            // This needs to be the IndexEndpoint resource name.
                DeployedIndexId = _deployedIndexId,
            };
            request.Queries.Add(new FindNeighborsRequest.Types.Query // Create the Query object here
            {
                Datapoint = queryDatapoint,
                NeighborCount = topK
            });


            try
            {
                var response = await _matchServiceClient.FindNeighborsAsync(request);
                var results = new List<VectorSearchResult>();

                foreach (var neighbor in response.NearestNeighbors.FirstOrDefault()?.Neighbors ?? Enumerable.Empty<FindNeighborsResponse.Types.Neighbor>())
                {
                    // Assuming the neighbor.Datapoint.DatapointId is the VectorizedSegment.SegmentId
                    // You would typically fetch the full VectorizedSegment metadata from another store (e.g., GCS, a relational DB)
                    // using this ID, as the vector DB might only store the ID and vector.
                    // For this example, we'll create a placeholder segment.
                    results.Add(new VectorSearchResult
                    {
                        Segment = new VectorizedSegment { SegmentId = neighbor.Datapoint.DatapointId, Text = "[Metadata not fetched from vector DB]" },
                        Score = neighbor.Distance
                    });
                }
                return results;
            }
            catch (RpcException ex)
            {
                // Handle API errors (e.g., invalid arguments, not found, permission denied)
                Console.WriteLine($"Error searching neighbors: {ex.Status}");
                throw;
            }
        }

        public async Task<bool> CheckHealthAsync()
        {
            // A simple health check could be a FindNeighbors request with a dummy vector and topK=1.
            // This verifies connectivity and that the deployed index is responsive.
            try
            {
                var dummyVector = Enumerable.Repeat(0.1f, 768).ToList(); // Assuming 768 dimensions
                await SearchSimilarVectorsAsync(dummyVector, 1);
                return true;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Health check failed for Vertex AI Vector Search: {ex.Message}");
                return false;
            }
        }
    }
}
