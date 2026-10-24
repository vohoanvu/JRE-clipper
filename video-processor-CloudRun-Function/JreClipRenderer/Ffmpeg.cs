using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace JreClipRenderer;

public sealed class FfmpegException(string message, string stderrTail) : Exception($"{message}\n{stderrTail}")
{
    public string StderrTail { get; } = stderrTail;
}

/// <summary>Thin, allocation-conscious wrapper around the ffmpeg/ffprobe executables.</summary>
public static class Ffmpeg
{
    private const int StderrTailLines = 40;

    /// <summary>
    /// Runs ffmpeg with "-progress pipe:1" so encode position is streamed on stdout.
    /// <paramref name="onProgressSeconds"/> receives the output timestamp in seconds.
    /// </summary>
    public static async Task RunAsync(
        IReadOnlyList<string> args, Action<double>? onProgressSeconds, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("ffmpeg")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in new[] { "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-progress", "pipe:1" })
            psi.ArgumentList.Add(a);
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var process = new Process { StartInfo = psi };
        var stderrTail = new Queue<string>(StderrTailLines);
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            lock (stderrTail)
            {
                if (stderrTail.Count == StderrTailLines) stderrTail.Dequeue();
                stderrTail.Enqueue(e.Data);
            }
        };

        process.Start();
        process.BeginErrorReadLine();

        using var killOnCancel = ct.Register(() =>
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        });

        // Progress lines look like "out_time_us=12345678"; everything else is ignored.
        string? line;
        while ((line = await process.StandardOutput.ReadLineAsync(ct).ConfigureAwait(false)) is not null)
        {
            if (onProgressSeconds is not null &&
                line.StartsWith("out_time_us=", StringComparison.Ordinal) &&
                long.TryParse(line.AsSpan(12), NumberStyles.Integer, CultureInfo.InvariantCulture, out var us) &&
                us > 0)
            {
                onProgressSeconds(us / 1_000_000d);
            }
        }

        await process.WaitForExitAsync(ct).ConfigureAwait(false);
        if (process.ExitCode != 0)
        {
            string tail;
            lock (stderrTail) tail = string.Join('\n', stderrTail);
            throw new FfmpegException($"ffmpeg exited with code {process.ExitCode}", tail);
        }
    }

    public static async Task<SourceInfo> ProbeAsync(string path, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("ffprobe")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in new[]
                 {
                     "-v", "error", "-print_format", "json",
                     "-show_entries", "format=duration:stream=codec_type,width,height", path,
                 })
            psi.ArgumentList.Add(a);

        using var process = Process.Start(psi)!;
        using var killOnCancel = ct.Register(() =>
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        });
        var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = process.StandardError.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct).ConfigureAwait(false);
        var stdout = await stdoutTask.ConfigureAwait(false);
        var stderr = await stderrTask.ConfigureAwait(false);
        if (process.ExitCode != 0)
            throw new FfmpegException($"ffprobe failed for {path}", stderr);

        using var doc = JsonDocument.Parse(stdout);
        var root = doc.RootElement;
        var duration = double.Parse(
            root.GetProperty("format").GetProperty("duration").GetString()!, CultureInfo.InvariantCulture);

        bool hasAudio = false;
        int width = 0, height = 0;
        foreach (var s in root.GetProperty("streams").EnumerateArray())
        {
            var type = s.GetProperty("codec_type").GetString();
            if (type == "audio") hasAudio = true;
            else if (type == "video" && width == 0)
            {
                width = s.TryGetProperty("width", out var w) ? w.GetInt32() : 0;
                height = s.TryGetProperty("height", out var h) ? h.GetInt32() : 0;
            }
        }
        if (width == 0) throw new FfmpegException($"No video stream in {path}", stderr);
        return new SourceInfo(path, duration, hasAudio, width, height);
    }

    public static string Seconds(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);
}
