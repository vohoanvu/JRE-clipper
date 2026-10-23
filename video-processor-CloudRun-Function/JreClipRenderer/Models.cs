namespace JreClipRenderer;

public sealed record ClipSegment(string VideoId, double StartSeconds, double EndSeconds, string? VideoTitle)
{
    public double Duration => EndSeconds - StartSeconds;
}

public sealed record ClipJob(
    string JobId,
    IReadOnlyList<ClipSegment> Segments,
    IReadOnlyDictionary<string, string> SourceObjects);

public sealed record SourceInfo(string Path, double DurationSeconds, bool HasAudio, int Width, int Height);

public sealed record RenderedClip(string Path, double DurationSeconds, long SizeBytes, IReadOnlyList<string> SkippedSegments);

public sealed record PublishedClip(string Url, string StoragePath, DateTimeOffset? ExpiresAt);

/// <summary>Job states shared with the frontend and createVideoJob function.</summary>
public static class JobStatus
{
    public const string Queued = "Queued";
    public const string Processing = "Processing";
    public const string Uploading = "Uploading";
    public const string Complete = "Complete";
    public const string Failed = "Failed";
}

/// <summary>A failure that retrying will not fix (bad input, missing sources).</summary>
public sealed class PermanentJobException(string message) : Exception(message);
