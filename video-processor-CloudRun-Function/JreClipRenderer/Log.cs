using System.Text.Json;

namespace JreClipRenderer;

/// <summary>
/// One JSON object per line on stdout: Cloud Logging parses "severity"/"message" and
/// indexes the remaining fields, so logs are filterable by jobId without a logging library.
/// </summary>
public static class Log
{
    private static readonly object Gate = new();
    public static string? JobId { get; set; }

    public static void Info(string message, object? fields = null) => Write("INFO", message, fields, null);
    public static void Warn(string message, object? fields = null) => Write("WARNING", message, fields, null);
    public static void Error(string message, Exception? ex = null, object? fields = null) => Write("ERROR", message, fields, ex);

    private static void Write(string severity, string message, object? fields, Exception? ex)
    {
        var entry = new Dictionary<string, object?>
        {
            ["severity"] = severity,
            ["message"] = ex is null ? message : $"{message}: {ex.Message}",
            ["jobId"] = JobId,
        };
        if (fields is not null)
        {
            foreach (var p in fields.GetType().GetProperties())
                entry[p.Name] = p.GetValue(fields);
        }
        if (ex is not null) entry["exception"] = ex.ToString();

        var line = JsonSerializer.Serialize(entry);
        lock (Gate) Console.Out.WriteLine(line);
    }
}
