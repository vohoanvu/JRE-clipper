// JREClipper.Infrastructure/VectorDatabases/VertexAI/VertexAiVectorSearchService.cs
using Google.Cloud.AIPlatform.V1;
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Grpc.Core; // For RpcException
using System.Globalization; // For CultureInfo`

namespace JREClipper.Infrastructure.VectorDatabases.VertexAI
{
    public class VertexAiVectorSearchService : IVectorDatabaseService
    {
        private readonly IndexServiceClient _indexServiceClient; // Changed from MatchServiceClient for upserts
        private readonly MatchServiceClient _matchServiceClient; // Keep for search
        private readonly string _indexNameString;
        private readonly string _indexEndpointNameString;
        private readonly string _deployedIndexId;

        public VertexAiVectorSearchService(
            IndexServiceClient indexServiceClient,
            MatchServiceClient matchServiceClient,
            string indexNameString,
            string indexEndpointNameString,
            string deployedIndexId)
        {
            _indexServiceClient = indexServiceClient ?? throw new ArgumentNullException(nameof(indexServiceClient));
            _matchServiceClient = matchServiceClient ?? throw new ArgumentNullException(nameof(matchServiceClient));
            _indexNameString = indexNameString ?? throw new ArgumentNullException(nameof(indexNameString));
            _indexEndpointNameString = indexEndpointNameString ?? throw new ArgumentNullException(nameof(indexEndpointNameString));
            _deployedIndexId = deployedIndexId ?? throw new ArgumentNullException(nameof(deployedIndexId));
        }

        // Helper to create an instance, similar to the embedding service
        // The 'indexPath' here refers to the Index resource name (projects/.../indexes/{INDEX_ID})
        // The 'deployedIndexId' here should be the ID of the DeployedIndex on an IndexEndpoint.
        // The IndexEndpoint resource name will be constructed or passed for FindNeighbors.
        public static VertexAiVectorSearchService Create(string projectId, string locationId, string indexId, string indexEndpointId, string deployedIndexId)
        {
            var indexServiceBuilder = new IndexServiceClientBuilder { Endpoint = $"{locationId}-aiplatform.googleapis.com" };
            var indexServiceClient = indexServiceBuilder.Build();

            var matchServiceBuilder = new MatchServiceClientBuilder { Endpoint = $"{locationId}-aiplatform.googleapis.com" };
            var matchServiceClient = matchServiceBuilder.Build();

            var indexName = IndexName.FormatProjectLocationIndex(projectId, locationId, indexId);
            var indexEndpointName = IndexEndpointName.FormatProjectLocationIndexEndpoint(projectId, locationId, indexEndpointId);
            
            return new VertexAiVectorSearchService(indexServiceClient, matchServiceClient, indexName, indexEndpointName, deployedIndexId);
        }

        public async Task AddVectorAsync(VectorizedSegment segment)
        {
            await AddVectorsBatchAsync([segment]);
        }

        public async Task AddVectorsBatchAsync(IEnumerable<VectorizedSegment> segments)
        {
            if (segments == null || !segments.Any())
            {
                Console.WriteLine("No segments provided to AddVectorsBatchAsync.");
                return;
            }

            var datapoints = new List<IndexDatapoint>();
            foreach (var segment in segments)
            {
                if (segment.Embedding == null || !segment.Embedding.Any())
                {
                    Console.WriteLine($"Segment {segment.SegmentId ?? "Unknown"} has no embedding. Skipping.");
                    continue;
                }

                var datapoint = new IndexDatapoint
                {
                    DatapointId = segment.SegmentId ?? $"{segment.VideoId}_{Guid.NewGuid()}", // Ensure unique ID
                    FeatureVector = { segment.Embedding }
                };

                // Add restrictions for metadata filtering
                // Ensure the namespace strings match exactly what's configured in your Vertex AI Index metadata schema
                if (!string.IsNullOrEmpty(segment.VideoId))
                {
                    datapoint.Restricts.Add(new IndexDatapoint.Types.Restriction { Namespace = "videoId", AllowList = { segment.VideoId } });
                }
                if (!string.IsNullOrEmpty(segment.ChannelName))
                {
                    datapoint.Restricts.Add(new IndexDatapoint.Types.Restriction { Namespace = "channelName", AllowList = { segment.ChannelName } });
                }
                // Storing numeric values like StartTime and EndTime as strings in allow lists.
                // For numeric range filtering, Vertex AI expects numeric_restricts.
                // For simplicity with current structure, using string restrictions.
                // If numeric range search is needed, this needs adjustment.
                if (segment.StartTime != TimeSpan.Zero)
                {
                    string startTimeString = segment.StartTime.ToString("g", CultureInfo.InvariantCulture);
                    datapoint.Restricts.Add(new IndexDatapoint.Types.Restriction { Namespace = "startTime", AllowList = { startTimeString } });
                }
                if (segment.EndTime != TimeSpan.Zero)
                {
                    // datapoint.Restricts.Add(new IndexDatapoint.Types.Restriction { Namespace = "endTimeSeconds", AllowList = { segment.EndTime.ToString("F0", CultureInfo.InvariantCulture) } });
                    string endTimeString = segment.EndTime.ToString("g", CultureInfo.InvariantCulture);
                    datapoint.Restricts.Add(new IndexDatapoint.Types.Restriction { Namespace = "endTime", AllowList = { endTimeString } });
                }
                
                // You can add more string based metadata here if needed, e.g. VideoTitle
                // if (!string.IsNullOrEmpty(segment.VideoTitle))
                // {
                //    datapoint.Restricts.Add(new IndexDatapoint.Types.Restriction { Namespace = "videoTitle", AllowList = { segment.VideoTitle } });
                // }

                // Example for numeric restrictions if you configure the index to support them:
                // datapoint.NumericRestricts.Add(new IndexDatapoint.Types.NumericRestriction { Namespace = "startTimeMs", ValueInt = (int)segment.StartTime });
                // datapoint.NumericRestricts.Add(new IndexDatapoint.Types.NumericRestriction { Namespace = "endTimeMs", ValueInt = (int)segment.EndTime });
                
                datapoints.Add(datapoint);
            }

            if (!datapoints.Any())
            {
                Console.WriteLine("No valid datapoints to upsert after processing segments.");
                return;
            }

            try
            {
                Console.WriteLine($"Upserting {datapoints.Count} datapoints to Vertex AI Index: {_indexNameString}");
                UpsertDatapointsRequest request = new UpsertDatapointsRequest
                {
                    Index = _indexNameString,
                    Datapoints = { datapoints }
                };
                await _indexServiceClient.UpsertDatapointsAsync(request);
                Console.WriteLine("Successfully upserted datapoints to Vertex AI.");
            }
            catch (RpcException e)
            {
                Console.WriteLine($"Error upserting datapoints to Vertex AI: {e.Status} - {e.Message}");
                // Consider re-throwing or specific error handling
                throw;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"An unexpected error occurred during Vertex AI upsert: {ex.Message}");
                throw;
            }
        }

        public async Task<IEnumerable<VectorSearchResult>> SearchSimilarVectorsAsync(List<float> queryVector, int topK, string? channelFilter = null)
        {
            var queryDatapoint = new IndexDatapoint { FeatureVector = { queryVector } };

            if (!string.IsNullOrEmpty(channelFilter))
            {
                queryDatapoint.Restricts.Add(new IndexDatapoint.Types.Restriction 
                {
                    Namespace = "channelName", 
                    AllowList = { channelFilter }
                });
            }
            
            var query = new FindNeighborsRequest.Types.Query 
            { 
                Datapoint = queryDatapoint, 
                NeighborCount = topK 
            };

            var request = new FindNeighborsRequest
            {
                IndexEndpoint = _indexEndpointNameString,
                DeployedIndexId = _deployedIndexId,
            };
            request.Queries.Add(query);

            try
            {
                FindNeighborsResponse response = await _matchServiceClient.FindNeighborsAsync(request);
                var results = new List<VectorSearchResult>();

                foreach (var neighbor in response.NearestNeighbors[0].Neighbors)
                {
                    // Assuming DatapointId was stored in a way that VideoId and SegmentId can be retrieved
                    // or that other metadata is available directly if the index is configured to return it.
                    // For now, we only have neighbor.Datapoint.DatapointId and neighbor.Distance.
                    // The VectorSearchResult expects a full VectorizedSegment.
                    // We need to decide how to populate this. For now, creating a minimal one.
                    var matchedSegment = new VectorizedSegment
                    {
                        SegmentId = neighbor.Datapoint.DatapointId,
                        VideoId = neighbor.Datapoint.DatapointId.Split('_').FirstOrDefault() ?? neighbor.Datapoint.DatapointId, // Simplistic split
                        // Other fields like Text, StartTime, EndTime, ChannelName would ideally be retrieved
                        // either from the index if configured to return them, or by a separate lookup using the SegmentId/VideoId.
                        // For this example, they will remain default/empty.
                    };
                    results.Add(new VectorSearchResult
                    {
                        Segment = matchedSegment,
                        Score = (float)(1 - neighbor.Distance) // Convert distance to similarity score (0 to 1)
                    });
                }
                return results;
            }
            catch (RpcException e)
            {
                Console.WriteLine($"Error searching vectors in Vertex AI: {e.Status} - {e.Message}");
                throw;
            }
        }

        public async Task<bool> CheckHealthAsync()
        {
            // A simple health check could be trying to get index details or a dummy search.
            // For MatchServiceClient, a dummy FindNeighbors with 0 results or specific ID might work.
            // For IndexServiceClient, GetIndex could be used.
            try
            {
                await _indexServiceClient.GetIndexAsync(new GetIndexRequest { Name = _indexNameString });
                // Optionally, also check the match service endpoint if critical for health
                // var dummyQuery = new FindNeighborsRequest { IndexEndpoint = _indexEndpointNameString, DeployedIndexId = _deployedIndexId };
                // dummyQuery.Queries.Add(new FindNeighborsRequest.Types.QueryRequest { Datapoint = new IndexDatapoint { FeatureVector = { new float[1] } }, NeighborCount = 1 });
                // await _matchServiceClient.FindNeighborsAsync(dummyQuery);

                return true;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Health check failed for VertexAiVectorSearchService: {ex.Message}");
                return false;
            }
        }
    }
}
