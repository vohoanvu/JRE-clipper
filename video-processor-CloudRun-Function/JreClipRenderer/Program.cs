using System.Diagnostics;
using System.Runtime.InteropServices;
using Google.Apis.Auth.OAuth2;
using Google.Cloud.Firestore;
using Google.Cloud.Storage.V1;
using JreClipRenderer;

// Cloud Run Job entry point: renders exactly one videoJobs/{JOB_ID} document, then exits.
// Exit code 0 = done (succeeded, failed permanently, or nothing to do); 1 = retryable failure.

var settings = Settings.FromEnvironment();
Log.JobId = settings.JobId;

using var shutdown = new CancellationTokenSource();
// Cloud Run sends SIGTERM when the task times out: cancel so ffmpeg is killed and the job is marked.
using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; shutdown.Cancel(); });
using var sigint = PosixSignalRegistration.Create(PosixSignal.SIGINT, ctx => { ctx.Cancel = true; shutdown.Cancel(); });

using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
var (store, publisher) = await CreateBackendsAsync(settings, http, shutdown.Token);
await using var _ = store;

var stopwatch = Stopwatch.StartNew();
var finalAttempt = settings.TaskAttempt >= settings.MaxRetries;
var workDir = Path.Combine(settings.WorkRoot, $"clip-{settings.JobId}-{settings.TaskAttempt}");

try
{
    var job = await store.TryClaimAsync(shutdown.Token);
    if (job is null) return 0;

    Log.Info("Rendering job", new
    {
        segments = job.Segments.Count,
        settings.Parallelism,
        settings.ThreadsPerEncode,
        settings.Execution,
        settings.TaskAttempt,
    });

    var rendered = await new ClipRenderer(settings).RenderAsync(job, workDir, store.Progress, shutdown.Token);
    var published = await publisher.PublishAsync(rendered, store.Progress, shutdown.Token);
    await store.CompleteAsync(rendered, published, CancellationToken.None);

    Log.Info("Job complete", new { elapsedSeconds = Math.Round(stopwatch.Elapsed.TotalSeconds, 1), published.StoragePath });
    return 0;
}
catch (PermanentJobException ex)
{
    Log.Warn("Job failed permanently", new { error = ex.Message });
    await store.FailAsync(ex.Message, final: true, CancellationToken.None);
    return 0;
}
catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
{
    Log.Error("Job cancelled (task timeout or shutdown)");
    await store.FailAsync("Rendering took too long and was stopped. Try fewer or shorter segments.",
        final: finalAttempt, CancellationToken.None);
    return 1;
}
catch (Exception ex)
{
    Log.Error("Job failed", ex, new { finalAttempt });
    await store.FailAsync("Video rendering failed. Please try again.", final: finalAttempt, CancellationToken.None);
    return 1;
}
finally
{
    try { if (Directory.Exists(workDir)) Directory.Delete(workDir, recursive: true); }
    catch (IOException ex) { Log.Warn("Work directory cleanup failed", new { error = ex.Message }); }
}

static async Task<(IJobStore, IPublisher)> CreateBackendsAsync(Settings settings, HttpClient http, CancellationToken ct)
{
    if (settings.IsLocal)
        return (new LocalJobStore(settings), new LocalPublisher(settings));

    // GOOGLE_OAUTH_ACCESS_TOKEN lets the container run locally against real Firestore/GCS
    // (e.g. `gcloud auth print-access-token`); on Cloud Run the metadata-server identity is used.
    var credential = settings.AccessToken is not null
        ? GoogleCredential.FromAccessToken(settings.AccessToken)
        : (await GoogleCredential.GetApplicationDefaultAsync(ct)).CreateScoped("https://www.googleapis.com/auth/cloud-platform");

    var db = await new FirestoreDbBuilder
    {
        ProjectId = settings.ProjectId,
        DatabaseId = settings.FirestoreDatabase,
        GoogleCredential = credential,
    }.BuildAsync(ct);
    var storage = await new StorageClientBuilder { GoogleCredential = credential }.BuildAsync(ct);

    var signerEmail = settings.SignerEmail ?? await IamBlobSigner.GetDefaultServiceAccountEmailAsync(http, ct);
    var signer = UrlSigner.FromBlobSigner(new IamBlobSigner(http, credential, signerEmail));

    return (new FirestoreJobStore(db, settings), new GcsPublisher(storage, signer, settings));
}
