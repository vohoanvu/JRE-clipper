using System.Globalization;
using System.Text.Json;
using Google.Cloud.Firestore;

namespace JreClipRenderer;

public interface IJobStore : IAsyncDisposable
{
    /// <summary>Atomically takes ownership of the job. Returns null when there is nothing to do.</summary>
    Task<ClipJob?> TryClaimAsync(CancellationToken ct);
    IProgressSink Progress { get; }
    Task CompleteAsync(RenderedClip clip, PublishedClip published, CancellationToken ct);
    Task FailAsync(string error, bool final, CancellationToken ct);
}

/// <summary>
/// Coalesces progress reports and flushes at most once per interval from a single loop,
/// so parallel encoders never issue concurrent or redundant Firestore writes.
/// </summary>
public sealed class ThrottledProgress(Func<string, int, string, Task> write, TimeSpan interval) : IProgressSink, IAsyncDisposable
{
    private readonly object _gate = new();
    private readonly CancellationTokenSource _stop = new();
    private (string Status, int Percent, string Message)? _pending;
    private int _lastPercent = -1;
    private int _disposed;
    private Task? _loop;

    public void Start() => _loop = Task.Run(LoopAsync);

    public void Report(string status, int percent, string message)
    {
        lock (_gate)
        {
            // Progress only moves forward, even when parallel encoders report out of order.
            if (percent < _lastPercent) percent = _lastPercent;
            _lastPercent = percent;
            _pending = (status, percent, message);
        }
    }

    private async Task LoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            try { await Task.Delay(interval, _stop.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
            await FlushAsync().ConfigureAwait(false);
        }
    }

    private async Task FlushAsync()
    {
        (string Status, int Percent, string Message)? next;
        lock (_gate) { next = _pending; _pending = null; }
        if (next is not { } p) return;
        try { await write(p.Status, p.Percent, p.Message).ConfigureAwait(false); }
        catch (Exception ex) { Log.Warn("Progress update failed", new { error = ex.Message }); }
    }

    /// <summary>Stops the loop without flushing, so a stale update can never land after a final status.</summary>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        _stop.Cancel();
        if (_loop is not null) await _loop.ConfigureAwait(false);
        _stop.Dispose();
    }
}

public sealed class FirestoreJobStore : IJobStore
{
    private readonly DocumentReference _doc;
    private readonly Settings _settings;
    private readonly ThrottledProgress _progress;

    public FirestoreJobStore(FirestoreDb db, Settings settings)
    {
        _settings = settings;
        _doc = db.Collection(settings.JobsCollection).Document(settings.JobId);
        _progress = new ThrottledProgress((status, percent, message) => _doc.UpdateAsync(new Dictionary<string, object>
        {
            ["status"] = status,
            ["progress"] = percent,
            ["progressMessage"] = message,
            ["updatedAt"] = FieldValue.ServerTimestamp,
        }), TimeSpan.FromSeconds(2));
    }

    public IProgressSink Progress => _progress;

    public async Task<ClipJob?> TryClaimAsync(CancellationToken ct)
    {
        var job = await _doc.Database.RunTransactionAsync(async tx =>
        {
            var snap = await tx.GetSnapshotAsync(_doc, ct).ConfigureAwait(false);
            if (!snap.Exists)
            {
                Log.Warn("Job document not found");
                return null;
            }

            var status = snap.TryGetValue<string>("status", out var s) ? s : null;
            var owner = snap.TryGetValue<string>("renderExecution", out var o) ? o : null;
            // Queued -> ours. Otherwise only a retry of the same execution may resume;
            // a duplicate execution (or a finished job) exits without touching anything.
            var claimable = status == JobStatus.Queued ||
                            (owner == _settings.Execution && status != JobStatus.Complete);
            if (!claimable)
            {
                Log.Info("Job not claimable; exiting", new { status, owner });
                return null;
            }

            tx.Update(_doc, new Dictionary<string, object>
            {
                ["status"] = JobStatus.Processing,
                ["progress"] = 1,
                ["progressMessage"] = "Starting render...",
                ["renderExecution"] = _settings.Execution,
                ["renderAttempt"] = _settings.TaskAttempt,
                ["startedAt"] = FieldValue.ServerTimestamp,
                ["updatedAt"] = FieldValue.ServerTimestamp,
                ["error"] = FieldValue.Delete,
            });
            return ParseJob(_settings.JobId, snap.ToDictionary());
        }, cancellationToken: ct).ConfigureAwait(false);

        if (job is not null) _progress.Start();
        return job;
    }

    public async Task CompleteAsync(RenderedClip clip, PublishedClip published, CancellationToken ct)
    {
        await _progress.DisposeAsync().ConfigureAwait(false);
        var updates = new Dictionary<string, object>
        {
            ["status"] = JobStatus.Complete,
            ["progress"] = 100,
            ["progressMessage"] = clip.SkippedSegments.Count == 0
                ? "Your video is ready!"
                : $"Your video is ready ({clip.SkippedSegments.Count} segment(s) could not be included).",
            ["finalVideoUrl"] = published.Url,
            ["finalVideoPath"] = published.StoragePath,
            ["outputDurationSeconds"] = Math.Round(clip.DurationSeconds, 2),
            ["outputSizeBytes"] = clip.SizeBytes,
            ["skippedSegments"] = clip.SkippedSegments.ToList(),
            ["completedAt"] = FieldValue.ServerTimestamp,
            ["updatedAt"] = FieldValue.ServerTimestamp,
            ["error"] = FieldValue.Delete,
        };
        if (published.ExpiresAt is { } expires) updates["finalVideoExpiresAt"] = Timestamp.FromDateTimeOffset(expires);
        await _doc.UpdateAsync(updates, cancellationToken: ct).ConfigureAwait(false);
    }

    public async Task FailAsync(string error, bool final, CancellationToken ct)
    {
        await _progress.DisposeAsync().ConfigureAwait(false);
        var updates = final
            ? new Dictionary<string, object>
            {
                ["status"] = JobStatus.Failed,
                ["error"] = error,
                ["progressMessage"] = "Video generation failed.",
                ["failedAt"] = FieldValue.ServerTimestamp,
                ["updatedAt"] = FieldValue.ServerTimestamp,
            }
            : new Dictionary<string, object>
            {
                ["progressMessage"] = "Hit an error, retrying...",
                ["updatedAt"] = FieldValue.ServerTimestamp,
            };
        await _doc.UpdateAsync(updates, cancellationToken: ct).ConfigureAwait(false);
    }

    public ValueTask DisposeAsync() => _progress.DisposeAsync();

    internal static ClipJob ParseJob(string jobId, IDictionary<string, object> data)
    {
        var segments = new List<ClipSegment>();
        if (data.TryGetValue("segments", out var raw) && raw is IEnumerable<object> list)
        {
            foreach (var item in list.OfType<IDictionary<string, object>>())
            {
                var videoId = item.TryGetValue("videoId", out var v) ? v?.ToString() : null;
                var start = ToDouble(item.TryGetValue("startTimeSeconds", out var a) ? a : null);
                var end = ToDouble(item.TryGetValue("endTimeSeconds", out var b) ? b : null);
                var title = item.TryGetValue("videoTitle", out var t) ? t?.ToString() : null;
                if (string.IsNullOrWhiteSpace(videoId) || start is null || end is null || end <= start)
                    throw new PermanentJobException("Job contains an invalid segment.");
                segments.Add(new ClipSegment(videoId, start.Value, end.Value, title));
            }
        }
        if (segments.Count == 0) throw new PermanentJobException("Job has no segments.");

        var sources = new Dictionary<string, string>();
        if (data.TryGetValue("sourceObjects", out var map) && map is IDictionary<string, object> dict)
        {
            foreach (var (k, v) in dict)
                if (v?.ToString() is { Length: > 0 } name) sources[k] = name;
        }
        return new ClipJob(jobId, segments, sources);
    }

    private static double? ToDouble(object? value) => value switch
    {
        long l => l,
        int i => i,
        double d => d,
        string s when double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
        _ => null,
    };
}

/// <summary>Offline mode for local testing: the job comes from a JSON file, progress goes to the log.</summary>
public sealed class LocalJobStore(Settings settings) : IJobStore
{
    private readonly ThrottledProgress _progress = new((status, percent, message) =>
    {
        Log.Info(message, new { status, percent });
        return Task.CompletedTask;
    }, TimeSpan.FromSeconds(2));

    public IProgressSink Progress => _progress;

    public async Task<ClipJob?> TryClaimAsync(CancellationToken ct)
    {
        await using var stream = File.OpenRead(settings.JobFile!);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        var data = (IDictionary<string, object>)ToObject(doc.RootElement)!;
        _progress.Start();
        return FirestoreJobStore.ParseJob(settings.JobId, data);
    }

    public async Task CompleteAsync(RenderedClip clip, PublishedClip published, CancellationToken ct)
    {
        await _progress.DisposeAsync().ConfigureAwait(false);
        Log.Info("Job complete", new { published.Url, clip.DurationSeconds, clip.SizeBytes, skipped = clip.SkippedSegments });
    }

    public async Task FailAsync(string error, bool final, CancellationToken ct)
    {
        await _progress.DisposeAsync().ConfigureAwait(false);
        Log.Error("Job failed", fields: new { error, final });
    }

    public ValueTask DisposeAsync() => _progress.DisposeAsync();

    private static object? ToObject(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Object => e.EnumerateObject().ToDictionary(p => p.Name, p => ToObject(p.Value)!),
        JsonValueKind.Array => e.EnumerateArray().Select(ToObject).ToList(),
        JsonValueKind.Number => e.TryGetInt64(out var l) ? l : e.GetDouble(),
        JsonValueKind.String => e.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };
}
