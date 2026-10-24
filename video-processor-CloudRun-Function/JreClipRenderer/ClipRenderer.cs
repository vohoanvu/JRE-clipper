using System.Collections.Concurrent;
using System.Globalization;
using System.Text;

namespace JreClipRenderer;

public interface IProgressSink
{
    /// <summary>Records the latest progress. Must be cheap and non-blocking; sinks throttle writes.</summary>
    void Report(string status, int percent, string message);
}

/// <summary>
/// Renders a compilation in one encode pass:
///   1. probe each distinct source once (moov is at the front of every source, so this is a few small reads),
///   2. encode every segment independently and in parallel (frame-accurate input seek + normalize)
///      to final-format H.264 plus PCM audio trimmed to exactly the segment's video length,
///   3. join the segments with the concat demuxer, copying the video and encoding the audio to AAC once.
/// Video is never re-encoded, and only one source decoder per concurrent encode is alive.
/// Audio sync: joining separately encoded AAC segments drifts at every seam (each carries its own
/// encoder priming, and its audio and video lengths differ by up to a frame), which put the audio
/// ~270 ms ahead after 30 segments. Sample-exact PCM segments + one AAC encode keep every seam exact.
/// </summary>
public sealed class ClipRenderer(Settings settings)
{
    // Progress bands (percent) for each phase; uploading continues to 99 in the publisher.
    private const int ProbeDone = 3;
    private const int EncodeDone = 85;
    private const int ConcatDone = 90;
    private const double FadeSeconds = 0.03;
    private const int FrameRateNum = 30000, FrameRateDen = 1001, SampleRate = 48000;

    public async Task<RenderedClip> RenderAsync(ClipJob job, string workDir, IProgressSink progress, CancellationToken ct)
    {
        Directory.CreateDirectory(workDir);
        progress.Report(JobStatus.Processing, 1, $"Preparing {job.Segments.Count} segments...");

        var sources = await ProbeSourcesAsync(job, ct).ConfigureAwait(false);
        var plan = Plan(job, sources, out var skipped);
        if (plan.Count == 0)
            throw new PermanentJobException("None of the selected segments could be rendered: " + string.Join("; ", skipped));

        var totalSeconds = plan.Sum(p => p.Segment.Duration);
        progress.Report(JobStatus.Processing, ProbeDone,
            $"Rendering {plan.Count} segments ({FormatDuration(totalSeconds)} total)...");

        var segmentFiles = await EncodeSegmentsAsync(plan, workDir, totalSeconds, progress, ct).ConfigureAwait(false);
        var rendered = segmentFiles.Where(f => f.Path is not null).ToList();
        foreach (var failed in segmentFiles.Where(f => f.Path is null)) skipped.Add(failed.Reason!);
        if (rendered.Count == 0)
            throw new InvalidOperationException("Every segment failed to encode: " + string.Join("; ", skipped));

        progress.Report(JobStatus.Processing, EncodeDone, "Joining segments...");
        var finalPath = Path.Combine(workDir, "final_video.mp4");
        await ConcatAsync(rendered, workDir, finalPath, ct).ConfigureAwait(false);
        foreach (var r in rendered) TryDelete(r.Path!);

        var expected = rendered.Sum(r => r.Duration);
        var final = await Ffmpeg.ProbeAsync(finalPath, ct).ConfigureAwait(false);
        if (!final.HasAudio || Math.Abs(final.DurationSeconds - expected) > 0.5 + 0.1 * rendered.Count)
        {
            throw new InvalidOperationException(
                $"Output validation failed: duration {final.DurationSeconds:F2}s vs expected {expected:F2}s, audio={final.HasAudio}");
        }

        progress.Report(JobStatus.Processing, ConcatDone, "Video rendered, preparing upload...");
        Log.Info("Render complete", new
        {
            segments = rendered.Count,
            skipped = skipped.Count,
            durationSeconds = Math.Round(final.DurationSeconds, 2),
            sizeBytes = new FileInfo(finalPath).Length,
        });
        return new RenderedClip(finalPath, final.DurationSeconds, new FileInfo(finalPath).Length, skipped);
    }

    private sealed record PlannedSegment(int Index, ClipSegment Segment, SourceInfo Source);

    private sealed record EncodedSegment(int Index, string? Path, double Duration, string? Reason);

    private async Task<IReadOnlyDictionary<string, SourceInfo?>> ProbeSourcesAsync(ClipJob job, CancellationToken ct)
    {
        var videoIds = job.Segments.Select(s => s.VideoId).Distinct().ToList();
        var results = new ConcurrentDictionary<string, SourceInfo?>();
        await Parallel.ForEachAsync(videoIds, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
            async (videoId, token) =>
            {
                var path = ResolveSourcePath(job, videoId);
                if (path is null)
                {
                    Log.Warn("Source video not found", new { videoId });
                    results[videoId] = null;
                    return;
                }
                try
                {
                    results[videoId] = await Ffmpeg.ProbeAsync(path, token).ConfigureAwait(false);
                }
                catch (FfmpegException ex)
                {
                    Log.Warn("Source video could not be probed", new { videoId, path, error = ex.StderrTail });
                    results[videoId] = null;
                }
            }).ConfigureAwait(false);
        return results;
    }

    private string? ResolveSourcePath(ClipJob job, string videoId)
    {
        // Object names come from createVideoJob; GetFileName strips any path components.
        if (job.SourceObjects.TryGetValue(videoId, out var objectName) && !string.IsNullOrWhiteSpace(objectName))
        {
            var mapped = Path.Combine(settings.SourceRoot, Path.GetFileName(objectName));
            if (File.Exists(mapped)) return mapped;
        }

        var exact = Path.Combine(settings.SourceRoot, $"{videoId}.mp4");
        if (File.Exists(exact)) return exact;

        // Legacy names: {videoId}_JRE1242_TimPool.mp4. Only reached for jobs without sourceObjects.
        return Directory.Exists(settings.SourceRoot)
            ? Directory.EnumerateFiles(settings.SourceRoot, $"{videoId}_*.mp4").FirstOrDefault()
            : null;
    }

    private static List<PlannedSegment> Plan(
        ClipJob job, IReadOnlyDictionary<string, SourceInfo?> sources, out List<string> skipped)
    {
        skipped = [];
        var plan = new List<PlannedSegment>(job.Segments.Count);
        for (var i = 0; i < job.Segments.Count; i++)
        {
            var seg = job.Segments[i];
            var label = $"segment {i + 1} ({seg.VideoId} {FormatDuration(seg.StartSeconds)}-{FormatDuration(seg.EndSeconds)})";
            if (!sources.TryGetValue(seg.VideoId, out var source) || source is null)
            {
                skipped.Add($"{label}: source video unavailable");
                continue;
            }

            // Search results can run a few seconds past the end of an episode; clamp instead of failing.
            var end = Math.Min(seg.EndSeconds, source.DurationSeconds);
            if (seg.StartSeconds < 0 || end - seg.StartSeconds < 0.5)
            {
                skipped.Add($"{label}: outside the video's {FormatDuration(source.DurationSeconds)} length");
                continue;
            }
            plan.Add(new PlannedSegment(i, seg with { EndSeconds = end }, source));
        }
        return plan;
    }

    private async Task<EncodedSegment[]> EncodeSegmentsAsync(
        List<PlannedSegment> plan, string workDir, double totalSeconds, IProgressSink progress, CancellationToken ct)
    {
        var results = new EncodedSegment[plan.Count];
        var doneMs = new long[plan.Count];
        var completed = 0;

        void ReportProgress()
        {
            long sumMs = 0;
            for (var i = 0; i < doneMs.Length; i++) sumMs += Volatile.Read(ref doneMs[i]);
            var fraction = Math.Clamp(sumMs / 1000d / totalSeconds, 0, 1);
            var percent = ProbeDone + (int)(fraction * (EncodeDone - ProbeDone));
            progress.Report(JobStatus.Processing, percent,
                $"Rendering segments: {Volatile.Read(ref completed)}/{plan.Count} done ({fraction:P0})");
        }

        await Parallel.ForEachAsync(Enumerable.Range(0, plan.Count),
            new ParallelOptions { MaxDegreeOfParallelism = settings.Parallelism, CancellationToken = ct },
            async (slot, token) =>
            {
                var item = plan[slot];
                var output = Path.Combine(workDir, $"seg_{item.Index:D3}.mov");
                var frames = FrameCount(item.Segment.Duration);
                var maxMs = (long)(item.Segment.Duration * 1000);
                Exception? lastError = null;

                // One retry absorbs transient read errors from the GCS mount.
                for (var attempt = 1; attempt <= 2; attempt++)
                {
                    try
                    {
                        await Ffmpeg.RunAsync(BuildSegmentArgs(item, frames, output), seconds =>
                        {
                            Volatile.Write(ref doneMs[slot], Math.Min(maxMs, (long)(seconds * 1000)));
                            ReportProgress();
                        }, token).ConfigureAwait(false);

                        Volatile.Write(ref doneMs[slot], maxMs);
                        Interlocked.Increment(ref completed);
                        ReportProgress();
                        results[slot] = new EncodedSegment(item.Index, output, FramesToSeconds(frames), null);
                        return;
                    }
                    catch (FfmpegException ex) when (!token.IsCancellationRequested)
                    {
                        lastError = ex;
                        Log.Warn("Segment encode failed", new { segment = item.Index, attempt, error = ex.StderrTail });
                        TryDelete(output);
                    }
                }

                results[slot] = new EncodedSegment(item.Index, null, 0,
                    $"segment {item.Index + 1} ({item.Segment.VideoId}) failed to encode: {lastError?.Message.Split('\n')[0]}");
            }).ConfigureAwait(false);

        return results;
    }

    private static int FrameCount(double seconds) =>
        Math.Max(1, (int)Math.Round(seconds * FrameRateNum / FrameRateDen));

    private static double FramesToSeconds(int frames) => (double)frames * FrameRateDen / FrameRateNum;

    private List<string> BuildSegmentArgs(PlannedSegment item, int frames, string output)
    {
        var seg = item.Segment;
        var exactSeconds = FramesToSeconds(frames);
        // 29.97 fps at 48 kHz is 1601.6 samples per frame, so rounding is under one sample per segment.
        var samples = (long)Math.Round((double)frames * FrameRateDen * SampleRate / FrameRateNum);
        // Read a little past the cut so the trims below land on real content, not padding.
        var readSeconds = Ffmpeg.Seconds(exactSeconds + 0.25);
        var (w, h) = (settings.OutputWidth, settings.OutputHeight);

        var args = new List<string>(48)
        {
            // Input-side seek + duration: ffmpeg jumps to the nearest keyframe and decodes forward,
            // so the cut is frame-accurate while only reading the bytes it needs from the mount.
            "-ss", Ffmpeg.Seconds(seg.StartSeconds), "-t", readSeconds, "-i", item.Source.Path,
        };
        if (!item.Source.HasAudio)
        {
            args.AddRange(["-f", "lavfi", "-t", readSeconds, "-i", $"anullsrc=channel_layout=stereo:sample_rate={SampleRate}"]);
        }

        var fadeOutStart = Ffmpeg.Seconds(Math.Max(0, exactSeconds - FadeSeconds));
        args.AddRange(
        [
            "-map", "0:v:0", "-map", item.Source.HasAudio ? "0:a:0" : "1:a:0",
            // Scale/pad/fps are no-ops for the common 854x480 29.97 source; they only work on outliers.
            // fps start_time=0 pins the first frame to t=0 even when the first decoded frame lands a few ms
            // after the seek point; tpad covers a source that ends early (clamped segments). The cut is a trim
            // filter, not -frames:v, because hitting -frames:v closes the file and truncates buffered audio.
            "-vf", $"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={FrameRateNum}/{FrameRateDen}:start_time=0,format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=end_frame={frames}",
            // Audio is padded/trimmed to exactly the video's length. Micro fades remove the click a hard cut produces at each seam.
            "-af", $"aresample={SampleRate}:async=1:first_pts=0,apad,atrim=end_sample={samples},afade=t=in:d={Ffmpeg.Seconds(FadeSeconds)},afade=t=out:st={fadeOutStart}:d={Ffmpeg.Seconds(FadeSeconds)}",
            "-c:v", "libx264", "-preset", settings.X264Preset, "-crf", settings.Crf.ToString(),
            "-profile:v", "high", "-g", "60", "-threads", settings.ThreadsPerEncode.ToString(),
            // PCM has no encoder priming, so segments join sample-exact; AAC is encoded once in ConcatAsync.
            "-c:a", "pcm_s16le", "-ac", "2", "-ar", SampleRate.ToString(),
            // Identical timescale across segments keeps the concat stream copy's timestamps exact.
            "-video_track_timescale", FrameRateNum.ToString(),
            "-y", output,
        ]);
        return args;
    }

    private static async Task ConcatAsync(List<EncodedSegment> segments, string workDir, string finalPath, CancellationToken ct)
    {
        var listPath = Path.Combine(workDir, "concat.txt");
        var sb = new StringBuilder();
        foreach (var s in segments)
        {
            // concat demuxer syntax: single-quoted, with ' escaped as '\''. The explicit duration makes
            // each file's offset exactly its frame count rather than whichever stream ends last.
            sb.Append("file '").Append(s.Path!.Replace('\\', '/').Replace("'", @"'\''")).Append("'\n")
              .Append("duration ").Append(s.Duration.ToString("0.000000", CultureInfo.InvariantCulture)).Append('\n');
        }
        await File.WriteAllTextAsync(listPath, sb.ToString(), ct).ConfigureAwait(false);

        await Ffmpeg.RunAsync(
        [
            "-f", "concat", "-safe", "0", "-i", listPath,
            "-map", "0:v:0", "-map", "0:a:0",
            // This single audio encode is serial, so use the fast coder: ~3x faster than the default
            // twoloop (7 s vs 22 s for 15 min) and indistinguishable for speech at 128k.
            "-c:v", "copy", "-c:a", "aac", "-aac_coder", "fast", "-b:a", "128k", "-ac", "2", "-ar", SampleRate.ToString(),
            "-movflags", "+faststart", "-y", finalPath,
        ], null, ct).ConfigureAwait(false);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static string FormatDuration(double seconds)
    {
        var t = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss") : t.ToString(@"m\:ss");
    }
}
