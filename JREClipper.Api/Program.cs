using JREClipper.Core.Interfaces;
using JREClipper.Core.Services;
using JREClipper.Infrastructure.GoogleCloudStorage;
using JREClipper.Infrastructure.Embeddings;
using JREClipper.Infrastructure.VectorDatabases.VertexAI;
using JREClipper.Core.Models;
using Microsoft.Extensions.Options;
using Google.Cloud.AIPlatform.V1;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// Learn more about configuring Swagger/OpenAPI at https://aka.ms/aspnetcore/swashbuckle
builder.Services.AddControllers(); // For API Controllers
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Configure Options pattern
builder.Services.Configure<AppSettings>(builder.Configuration.GetSection("AppSettings")); // Added AppSettings
builder.Services.Configure<GoogleCloudStorageOptions>(builder.Configuration.GetSection("GoogleCloudStorage"));
builder.Services.Configure<VectorDatabaseOptions>(builder.Configuration.GetSection("VectorDatabase"));
builder.Services.Configure<EmbeddingServiceOptions>(builder.Configuration.GetSection("Embedding"));
builder.Services.Configure<GoogleVertexAIEmbeddingOptions>(builder.Configuration.GetSection("GoogleVertexAI")); 
builder.Services.Configure<VertexAIVectorSearchDbOptions>(builder.Configuration.GetSection("VectorDatabase:VertexAI")); // Corrected path
builder.Services.Configure<XaiGrokOptions>(builder.Configuration.GetSection("XaiGrok"));
builder.Services.Configure<VideoProcessingOptions>(builder.Configuration.GetSection("VideoProcessing"));
builder.Services.Configure<GcpOptions>(builder.Configuration.GetSection("Gcp")); // Added GcpOptions
builder.Services.Configure<PubSubOptions>(builder.Configuration.GetSection("PubSub")); // Added PubSubOptions

// Register Google Cloud Storage Service
builder.Services.AddSingleton(provider => 
{
    return Google.Cloud.Storage.V1.StorageClient.Create();
});
builder.Services.AddSingleton<IGoogleCloudStorageService, GoogleCloudStorageService>();

// Register Transcript Processor
builder.Services.AddScoped<ITranscriptProcessor, BasicTranscriptProcessor>();

// Register Embedding Services
builder.Services.AddSingleton(provider =>
{
    var options = provider.GetRequiredService<IOptions<GoogleVertexAIEmbeddingOptions>>().Value;
    // Validate necessary options for publisher model
    if (string.IsNullOrEmpty(options.ProjectId) ||
        string.IsNullOrEmpty(options.Location) ||
        string.IsNullOrEmpty(options.ModelName))
    {
        throw new InvalidOperationException("GoogleVertexAI Embedding options (ProjectId, Location, or ModelName) are not configured properly for a publisher model.");
    }
    return GoogleVertexAiEmbeddingService.Create(options.ProjectId, options.Location, options.ModelName, true); // Added isPublisherModel flag
});
builder.Services.AddScoped<MockEmbeddingService>();

// Embedding Service Factory Delegate
// This factory delegate allows resolving a specific IEmbeddingService based on configuration or a key.
builder.Services.AddScoped<Func<string, IEmbeddingService>>(serviceProvider => key =>
{
    // Correctly use AppSettings to get the configured embedding provider
    var appSettings = serviceProvider.GetRequiredService<IOptions<AppSettings>>().Value;
    var activeServiceKey = !string.IsNullOrEmpty(key) ? key : appSettings.EmbeddingProvider;

    switch (activeServiceKey?.ToLower())
    {
        case "googlevertexai":
            // Resolve the singleton GoogleVertexAiEmbeddingService.
            return serviceProvider.GetRequiredService<GoogleVertexAiEmbeddingService>();
        case "mock":
        default:
            // Fallback to MockEmbeddingService if the configuration is missing or invalid.
            return serviceProvider.GetRequiredService<MockEmbeddingService>();
    }
});

// Register Vector Database Service (Vertex AI)

// Register VertexAiVectorSearchService as a singleton, created by its static factory method.
builder.Services.AddSingleton(provider =>
{
    var dbOptions = provider.GetRequiredService<IOptions<VertexAIVectorSearchDbOptions>>().Value;
    var commonGoogleOptions = provider.GetRequiredService<IOptions<GoogleVertexAIEmbeddingOptions>>().Value; 

    var projectId = !string.IsNullOrEmpty(dbOptions.ProjectId) ? dbOptions.ProjectId : commonGoogleOptions.ProjectId;
    var location = !string.IsNullOrEmpty(dbOptions.Location) ? dbOptions.Location : commonGoogleOptions.Location;

    if (string.IsNullOrEmpty(projectId) || 
        string.IsNullOrEmpty(location) || 
        string.IsNullOrEmpty(dbOptions.IndexId) || 
        string.IsNullOrEmpty(dbOptions.IndexEndpointId) || 
        string.IsNullOrEmpty(dbOptions.DeployedIndexId))
    {
        // If critical configuration for VertexAiVectorSearchService is missing, throw an exception.
        // This service cannot be constructed without these details.
        throw new InvalidOperationException("VertexAI Vector Database (ProjectId, Location, IndexId, IndexEndpointId, or DeployedIndexId) is not configured properly. This service cannot be created.");
    }
    return VertexAiVectorSearchService.Create(projectId, location, dbOptions.IndexId, dbOptions.IndexEndpointId, dbOptions.DeployedIndexId);
});

// Register IVectorDatabaseService to resolve the active vector database service based on configuration.
builder.Services.AddScoped<IVectorDatabaseService>(provider => 
{
    // var appSettings = provider.GetRequiredService<IOptions<AppSettings>>().Value; // Old way, VectorDatabaseProvider removed from AppSettings
    var vectorDbSettings = provider.GetRequiredService<IOptions<VectorDatabaseOptions>>().Value;
    
    switch (vectorDbSettings.Provider?.ToLower())
    {
        case "vertexai":
            // Attempt to get the registered VertexAiVectorSearchService.
            // If it failed to create in its AddSingleton registration (due to config issues),
            // GetRequiredService will throw, which is the desired behavior.
            return provider.GetRequiredService<VertexAiVectorSearchService>();
        // case "qdrant":
        //     // Ensure QdrantOptions is configured if you add this provider
        //     // builder.Services.Configure<QdrantOptions>(builder.Configuration.GetSection("VectorDatabase:Qdrant"));
        //     // builder.Services.AddScoped<QdrantVectorDbService>(); // Assuming QdrantVectorDbService exists
        //     return provider.GetRequiredService<QdrantVectorDbService>(); 
        default:
            // Fallback or throw if no provider matches or is configured, or if the provider is unknown.
            throw new InvalidOperationException($"Unsupported or unconfigured vector database provider: {vectorDbSettings.Provider}");
    }
});

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
