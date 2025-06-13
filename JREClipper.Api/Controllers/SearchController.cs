// JREClipper.Api/Controllers/SearchController.cs
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace JREClipper.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class SearchController : ControllerBase
    {
        private readonly IEmbeddingService _embeddingService;
        private readonly IVectorDatabaseService _vectorDbService;
        private readonly AppSettings _appSettings;

        public SearchController(
            Func<string, IEmbeddingService> embeddingServiceFactory,
            IVectorDatabaseService vectorDbService,
            IOptions<AppSettings> appSettings)
        {
            _appSettings = appSettings.Value;
            _embeddingService = embeddingServiceFactory(_appSettings.DefaultEmbeddingService ?? "Mock");
            _vectorDbService = vectorDbService;
        }

        /// <summary>
        /// Searches for video segments based on a query text.
        /// </summary>
        /// <param name="query">The text to search for.</param>
        /// <param name="topK">The number of results to return.</param>
        /// <param name="videoIdFilter">Optional: Filter results to a specific video ID.</param>
        /// <returns>A list of relevant video segments.</returns>
        [HttpGet("segments")]
        [ProducesResponseType(typeof(IEnumerable<VectorSearchResult>), StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status500InternalServerError)]
        public async Task<IActionResult> SearchSegments([FromQuery] string query, [FromQuery] int topK = 5, [FromQuery] string? videoIdFilter = null)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return BadRequest("Query text cannot be empty.");
            }
            if (topK <= 0)
            {
                topK = 5;
            }

            try
            {
                var queryVector = await _embeddingService.GenerateEmbeddingsAsync(query);
                if (queryVector == null || !queryVector.Any())
                {
                    return StatusCode(StatusCodes.Status500InternalServerError, "Failed to generate embedding for the query.");
                }

                var searchResults = await _vectorDbService.SearchSimilarVectorsAsync(queryVector, topK, videoIdFilter);
                
                return Ok(searchResults);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error during search: {ex.Message}");
                return StatusCode(StatusCodes.Status500InternalServerError, $"An error occurred during search: {ex.Message}");
            }
        }

        /// <summary>
        /// Checks the health of the vector database.
        /// </summary>
        /// <returns>Health status.</returns>
        [HttpGet("health")]
        [ProducesResponseType(typeof(object), StatusCodes.Status200OK)]
        [ProducesResponseType(typeof(object), StatusCodes.Status500InternalServerError)]
        public async Task<IActionResult> GetVectorDbHealth()
        {
            try
            {
                var isHealthy = await _vectorDbService.CheckHealthAsync();
                if (isHealthy)
                {
                    return Ok(new { Status = "Healthy" });
                }
                else
                {
                    return StatusCode(StatusCodes.Status500InternalServerError, new { Status = "Unhealthy" });
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error checking vector DB health: {ex.Message}");
                return StatusCode(StatusCodes.Status500InternalServerError, new { Status = "Error", Message = ex.Message });
            }
        }
    }
}
