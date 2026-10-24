namespace JreClipRenderer;

/// <summary>
/// Runtime configuration, read once from environment variables.
/// Cloud mode needs only JOB_ID; everything else has production defaults.
/// Local mode (no Firestore/GCS) is enabled by setting JOB_FILE + OUTPUT_DIR.
/// </summary>
public sealed record Settings
{
    public required string JobId { get; init; }
    public string ProjectId { get; init; } = "gen-lang-client-demo";
    public string FirestoreDatabase { get; init; } = "jre-clipper-db";
    public string JobsCollection { get; init; } = "videoJobs";
    public string SourceRoot { get; init; } = "/jre-videos";
    public string OutputBucket { get; init; } = "jre-processed-clips-bucker";
    public string OutputPrefix { get; init; } = "edited-clips";
    public string WorkRoot { get; init; } = Path.GetTempPath();
    public int OutputWidth { get; init; } = 854;
    public int OutputHeight { get; init; } = 480;
    public int Crf { get; init; } = 23;
    public string X264Preset { get; init; } = "veryfast";
    public int Parallelism { get; init; }
    public int ThreadsPerEncode { get; init; }
    public TimeSpan SignedUrlLifetime { get; init; } = TimeSpan.FromDays(7);
    public string? SignerEmail { get; init; }
    public string? AccessToken { get; init; }
    public string Execution { get; init; } = $"local-{Guid.NewGuid():N}";
    public int TaskAttempt { get; init; }
    public int MaxRetries { get; init; }

    // Local mode
    public string? JobFile { get; init; }
    public string? OutputDir { get; init; }
    public bool IsLocal => JobFile is not null;

    public static Settings FromEnvironment()
    {
        static string? Env(string name) =>
            Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : null;
        static int EnvInt(string name, int fallback) =>
            int.TryParse(Env(name), out var v) ? v : fallback;

        var jobFile = Env("JOB_FILE");
        var jobId = Env("JOB_ID") ?? (jobFile is null ? null : Path.GetFileNameWithoutExtension(jobFile))
            ?? throw new InvalidOperationException("JOB_ID environment variable is required.");

        // Split the CPUs between concurrent encodes: x264 scales well up to a few threads per
        // 480p stream, so two encodes x half the cores keeps every core busy while one encode
        // is blocked on source reads from the GCS mount.
        var cpus = Environment.ProcessorCount;
        var parallelism = Math.Clamp(EnvInt("RENDER_PARALLELISM", cpus >= 4 ? 2 : 1), 1, 8);
        var threads = Math.Max(1, EnvInt("THREADS_PER_ENCODE", cpus / parallelism));

        var defaults = new Settings { JobId = jobId };
        return defaults with
        {
            ProjectId = Env("GOOGLE_CLOUD_PROJECT") ?? defaults.ProjectId,
            FirestoreDatabase = Env("FIRESTORE_DATABASE") ?? defaults.FirestoreDatabase,
            SourceRoot = Env("SOURCE_ROOT") ?? defaults.SourceRoot,
            OutputBucket = Env("OUTPUT_BUCKET") ?? defaults.OutputBucket,
            WorkRoot = Env("WORK_ROOT") ?? defaults.WorkRoot,
            OutputWidth = EnvInt("OUTPUT_WIDTH", defaults.OutputWidth),
            OutputHeight = EnvInt("OUTPUT_HEIGHT", defaults.OutputHeight),
            Crf = EnvInt("CRF", defaults.Crf),
            X264Preset = Env("X264_PRESET") ?? defaults.X264Preset,
            Parallelism = parallelism,
            ThreadsPerEncode = threads,
            SignerEmail = Env("SIGNER_EMAIL"),
            AccessToken = Env("GOOGLE_OAUTH_ACCESS_TOKEN"),
            Execution = Env("CLOUD_RUN_EXECUTION") ?? defaults.Execution,
            TaskAttempt = EnvInt("CLOUD_RUN_TASK_ATTEMPT", 0),
            MaxRetries = EnvInt("MAX_RETRIES", 0),
            JobFile = jobFile,
            OutputDir = Env("OUTPUT_DIR"),
        };
    }
}
