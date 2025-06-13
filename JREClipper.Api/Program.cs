using JREClipper.Core.Interfaces;
using JREClipper.Core.Services;
using JREClipper.Infrastructure.GoogleCloudStorage;
using JREClipper.Infrastructure.Embeddings;
using JREClipper.Infrastructure.VectorDatabases.VertexAI;
using JREClipper.Core.Models;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// Learn more about configuring Swagger/OpenAPI at https://aka.ms/aspnetcore/swashbuckle
builder.Services.AddControllers(); // For API Controllers
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Configure Options pattern
builder.Services.Configure<GoogleCloudStorageOptions>(builder.Configuration.GetSection("GoogleCloudStorage"));
builder.Services.Configure<AppSettings>(builder.Configuration.GetSection("AppSettings"));
builder.Services.Configure<VectorDatabaseOptions>(builder.Configuration.GetSection("VectorDatabase"));
builder.Services.Configure<EmbeddingServiceOptions>(builder.Configuration.GetSection("EmbeddingService"));
builder.Services.Configure<VertexAIOptions>(builder.Configuration.GetSection("GoogleVertexAI"));
builder.Services.Configure<XaiGrokOptions>(builder.Configuration.GetSection("XaiGrok"));
builder.Services.Configure<VideoProcessingOptions>(builder.Configuration.GetSection("VideoProcessing"));
builder.Services.Configure<AgentSettings>(builder.Configuration.GetSection("AgentSettings"));

// Register Google Cloud Storage Service
builder.Services.AddSingleton<IGoogleCloudStorageService, GoogleCloudStorageService>();

// Register Transcript Processor
builder.Services.AddScoped<ITranscriptProcessor, BasicTranscriptProcessor>();

// Register Embedding Services Factory
builder.Services.AddScoped<GoogleVertexAiEmbeddingService>();
builder.Services.AddScoped<XaiGrokEmbeddingService>();
builder.Services.AddScoped<MockEmbeddingService>();

builder.Services.AddScoped<Func<string, IEmbeddingService>>(serviceProvider => key =>
{
    switch (key.ToLower())
    {
        case "googlevertexai":
            return serviceProvider.GetRequiredService<GoogleVertexAiEmbeddingService>();
        case "xaigrok":
            return serviceProvider.GetRequiredService<XaiGrokEmbeddingService>();
        case "mock":
        default:
            return serviceProvider.GetRequiredService<MockEmbeddingService>();
    }
});

// Register Vector Database Service (Vertex AI)
builder.Services.AddScoped<IVectorDatabaseService, VertexAiVectorSearchService>();

// Placeholder for Orchestration Service (Phase 5)
// builder.Services.AddScoped<IOrchestratorService, OrchestratorService>();

// Placeholder for Background Worker (Phase 6)
// builder.Services.AddHostedService<YouTubeIngestionWorker>();

// Add HttpClient for services that need it (e.g., XaiGrokEmbeddingService if it calls an external API)
builder.Services.AddHttpClient();

var app = builder.Build();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
    app.UseDeveloperExceptionPage(); // More detailed errors in dev
}

app.UseHttpsRedirection();

app.UseRouting(); // Add UseRouting before UseAuthorization and UseEndpoints

app.UseAuthorization(); // If you add authentication/authorization

app.MapControllers(); // Maps attribute-routed controllers

// Minimal API endpoint from template - can be removed or kept for testing
var summaries = new[]
{
    "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
};

app.MapGet("/weatherforecast", () =>
{
    var forecast = Enumerable.Range(1, 5).Select(index =>
        new WeatherForecast
        (
            DateOnly.FromDateTime(DateTime.Now.AddDays(index)),
            Random.Shared.Next(-20, 55),
            summaries[Random.Shared.Next(summaries.Length)]
        ))
        .ToArray();
    return forecast;
})
.WithName("GetWeatherForecast")
.WithOpenApi();

app.Run();

// Record can be kept or moved to a separate file if preferred
record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}
