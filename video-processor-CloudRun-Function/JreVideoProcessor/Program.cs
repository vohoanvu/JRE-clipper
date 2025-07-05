using CloudNative.CloudEvents;
using Google.Cloud.Functions.Framework;
using Google.Events.Protobuf.Cloud.PubSub.V1;
using JreVideoProcessor;

var builder = WebApplication.CreateBuilder(args);

// Add your Function class to the dependency injection container
builder.Services.AddSingleton<Function>();
// Also add a CloudEvent formatter
builder.Services.AddSingleton<JsonEventFormatter>();

var app = builder.Build();

// This is the endpoint that Cloud Run will send Pub/Sub events to
app.MapPost("/", async (HttpContext context, Function function, JsonEventFormatter formatter, ILogger<Program> logger) =>
{
    try
    {
        var cloudEvent = await context.Request.ReadCloudEventAsync(formatter);
        if (cloudEvent?.Data is MessagePublishedData messageData)
        {
            await function.HandleAsync(cloudEvent, messageData, context.RequestAborted);
            return Results.Ok();
        }
        else
        {
            logger.LogWarning("Could not deserialize Pub/Sub message from CloudEvent.");
            return Results.BadRequest("Invalid CloudEvent payload.");
        }
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "An error occurred processing the request.");
        return Results.Problem("An unexpected error occurred.");
    }
});

app.Run();