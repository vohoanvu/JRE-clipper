using CloudNative.CloudEvents;
using Google.Cloud.Functions.Framework;
using Google.Events.Protobuf.Cloud.PubSub.V1;
using Microsoft.Extensions.Logging;
using System.Threading;
using System.Threading.Tasks;
using Google.Cloud.Storage.V1;
using Google.Cloud.Firestore;
using Google.Cloud.Firestore.V1;
using Google.Api.Gax;
using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Net.Http;
using System.Text.Json.Serialization;
using System.Diagnostics;
using System.Globalization;
using FFMpegCore;
using FFMpegCore.Enums;
using FFMpegCore.Pipes;

namespace JreVideoProcessor;

public class Function : ICloudEventFunction<MessagePublishedData>
{
    private readonly ILogger<Function> _logger;
    private readonly StorageClient _storageClient;
    private readonly FirestoreDb _firestoreDb;
    private const string BUCKET_NAME = "jre-processed-clips-bucker";
    private const string FIRESTORE_DB = "jre-clipper-db";
    private const string MOUNT_PATH = "/jre-videos";
    private static readonly string _projectId = GetProjectId();

    private static string GetProjectId()
    {
        // Get project ID from environment variable, or auto-detect
        var projectId = Environment.GetEnvironmentVariable("GOOGLE_CLOUD_PROJECT");
        if (string.IsNullOrEmpty(projectId))
        {
            try
            {
                projectId = Platform.Instance().ProjectId;
            }
            catch (Exception)
            {
                // Fallback to hardcoded project ID if detection fails
                projectId = "gen-lang-client-demo";
            }
        }
        return projectId;
    }

    public Function(ILogger<Function> logger)
    {
        _logger = logger;
        // Verify that ffmpeg is available before doing anything else.
        CheckFfmpegInstallation();

        _storageClient = StorageClient.Create();

        // Create FirestoreDb with custom database name using FirestoreDbBuilder
        var firestoreDbBuilder = new FirestoreDbBuilder
        {
            ProjectId = _projectId,
            DatabaseId = FIRESTORE_DB
        };
        _firestoreDb = firestoreDbBuilder.Build();
    }

    public async Task HandleAsync(CloudEvent cloudEvent, MessagePublishedData data, CancellationToken cancellationToken)
    {
        try
        {
            var messageData = data.Message?.Data?.ToStringUtf8();
            if (string.IsNullOrEmpty(messageData))
            {
                _logger.LogError("No message data received");
                return;
            }

            _logger.LogInformation($"Received Pub/Sub message: {messageData}");

            JobData jobData;
            try
            {
                var options = new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                };
                jobData = JsonSerializer.Deserialize<JobData>(messageData, options);
                _logger.LogInformation($"Successfully deserialized JobData. JobId: {jobData?.JobId}, VideoIds count: {jobData?.VideoIds?.Count}, Segments count: {jobData?.Segments?.Count}");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to deserialize JobData from message");
                return;
            }

            if (jobData?.JobId == null)
            {
                _logger.LogError("Invalid job data - missing jobId. JobData is null: {JobDataIsNull}", jobData == null);
                return;
            }

            _logger.LogInformation($"Processing job {jobData.JobId} with {jobData.VideoIds?.Count ?? 0} videos and {jobData.Segments?.Count ?? 0} segments");

            // Process the video segments
            try
            {
                await ProcessSegmentsForJob(jobData.JobId, jobData, cancellationToken);
                _logger.LogInformation($"Successfully completed processing for job {jobData.JobId}");
            }
            catch (Exception processingEx)
            {
                _logger.LogError(processingEx, $"Failed to process segments for job {jobData.JobId}");
                throw;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing Pub/Sub message");
            throw;
        }
    }

    private async Task ProcessSegmentsForJob(string jobId, JobData jobData, CancellationToken cancellationToken)
    {
        string tempDir = null;
        var downloadedVideos = new Dictionary<string, string>();

        try
        {
            _logger.LogInformation($"Starting segment processing pipeline for job {jobId}");

            // Create temporary directory
            tempDir = Path.Combine(Path.GetTempPath(), $"job_{jobId}_{Guid.NewGuid()}");
            Directory.CreateDirectory(tempDir);
            _logger.LogInformation($"Created temp directory: {tempDir}");

            if (jobData.VideoIds == null || jobData.Segments == null ||
                !jobData.VideoIds.Any() || !jobData.Segments.Any())
            {
                throw new ArgumentException("Job missing video IDs or segments data");
            }

            _logger.LogInformation($"Processing {jobData.Segments.Count} segments across {jobData.VideoIds.Count} videos");

            // Update initial progress
            await UpdateJobStatus(jobId, "Processing", 55,
                $"Analyzing {jobData.Segments.Count} segments across {jobData.VideoIds.Count} videos...");

            // Group segments by video ID
            var segmentsByVideo = jobData.Segments
                .Where(s => !string.IsNullOrEmpty(s.VideoId))
                .GroupBy(s => s.VideoId)
                .ToDictionary(g => g.Key, g => g.ToList());

            _logger.LogInformation($"Segments grouped by video: {string.Join(", ", segmentsByVideo.Select(kvp => $"{kvp.Key}:{kvp.Value.Count}"))}");

            // Process videos with segments
            var allProcessedSegments = new List<string>();
            var totalVideosToProcess = segmentsByVideo.Count;
            var processedVideos = 0;
            var failedVideos = new List<string>();

            foreach (var kvp in segmentsByVideo)
            {
                var videoId = kvp.Key;
                var videoSegments = kvp.Value;
                var videoStartTime = DateTime.UtcNow;

                try
                {
                    processedVideos++;
                    var progressPercent = (int)(55 + (processedVideos / (double)totalVideosToProcess) * 25);

                    _logger.LogInformation($"Processing video {processedVideos}/{totalVideosToProcess}: {videoId} ({videoSegments.Count} segments)");
                    await UpdateJobStatus(jobId, "Processing", progressPercent,
                        $"Processing video {processedVideos}/{totalVideosToProcess}: {videoId} ({videoSegments.Count} segments)");

                    // Download video only if not already cached
                    if (!downloadedVideos.ContainsKey(videoId))
                    {
                        _logger.LogInformation($"Finding video file for {videoId}...");
                        try
                        {
                            var videoPath = FindVideoFileFuse(videoId);
                            downloadedVideos[videoId] = videoPath;
                            _logger.LogInformation($"Video {videoId} found and cached: {videoPath}");
                        }
                        catch (Exception findEx)
                        {
                            _logger.LogError(findEx, $"Failed to find video file for {videoId}");
                            failedVideos.Add($"{videoId} (file not found)");
                            continue;
                        }
                    }

                    // Process segments for this video
                    _logger.LogInformation($"Processing {videoSegments.Count} segments for video {videoId}");
                    try
                    {
                        var processedPath = await ProcessVideoSegments(downloadedVideos[videoId], videoSegments, tempDir, jobId, cancellationToken);

                        if (!string.IsNullOrEmpty(processedPath) && File.Exists(processedPath))
                        {
                            allProcessedSegments.Add(processedPath);
                            var processingTime = DateTime.UtcNow - videoStartTime;
                            _logger.LogInformation($"Successfully processed segments for video {videoId} in {processingTime.TotalSeconds:F1}s");
                        }
                        else
                        {
                            _logger.LogError($"Failed to process segments for video {videoId} - no output file");
                            failedVideos.Add($"{videoId} (no output)");
                        }
                    }
                    catch (Exception processEx)
                    {
                        _logger.LogError(processEx, $"Failed to process segments for video {videoId}");
                        failedVideos.Add($"{videoId} (processing error: {processEx.Message.Substring(0, Math.Min(50, processEx.Message.Length))})");
                    }
                }
                catch (Exception videoError)
                {
                    _logger.LogError(videoError, $"Failed to process video {videoId}");
                    failedVideos.Add($"{videoId} ({videoError.Message.Substring(0, Math.Min(50, videoError.Message.Length))})");
                    continue;
                }
            }

            // Check if we have any successful results
            var successCount = allProcessedSegments.Count;
            var totalCount = segmentsByVideo.Count;

            if (!allProcessedSegments.Any())
            {
                var errorMsg = $"No video segments were successfully processed. Failed videos: {string.Join(", ", failedVideos)}";
                _logger.LogError(errorMsg);
                throw new Exception(errorMsg);
            }
            else if (failedVideos.Any())
            {
                _logger.LogWarning($"Partial success: {successCount}/{totalCount} videos processed. Failed: {string.Join(", ", failedVideos)}");
                await UpdateJobStatus(jobId, "Processing", 80,
                    $"Processed {successCount}/{totalCount} videos successfully. Combining results...");
            }
            else
            {
                _logger.LogInformation($"Successfully processed all {successCount} video segments");
                await UpdateJobStatus(jobId, "Processing", 80,
                    $"Successfully processed all {successCount} videos. Combining results...");
            }

            // Combine multiple videos if needed
            string finalVideoPath;
            if (allProcessedSegments.Count > 1)
            {
                _logger.LogInformation($"Combining {allProcessedSegments.Count} processed video files");
                finalVideoPath = await CombineMultipleVideos(allProcessedSegments, tempDir, jobId);
            }
            else
            {
                finalVideoPath = allProcessedSegments[0];
                _logger.LogInformation("Single video processed, skipping combination step");
            }

            // Upload final result to GCS
            _logger.LogInformation("Uploading final video to GCS...");
            var publicUrl = await UploadToGcs(finalVideoPath, jobId);

            // Include summary of any failures in the completion message
            var completionMessage = "Video processing complete!";
            if (failedVideos.Any())
            {
                completionMessage += $" Note: {failedVideos.Count} videos failed but {successCount} were processed successfully.";
            }

            // Update final status
            await UpdateJobStatus(jobId, "Complete", 100, completionMessage, videoUrl: publicUrl);

            _logger.LogInformation($"Successfully completed segment processing for job {jobId}: {publicUrl}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Segment processing pipeline failed for job {jobId}");
            await UpdateJobStatus(jobId, "Failed", error: ex.Message,
                suggestions: new[] { "Video processing failed", "Please try generating the video again" });
            throw;
        }
        finally
        {
            // Clean up temporary directory
            if (!string.IsNullOrEmpty(tempDir) && Directory.Exists(tempDir))
            {
                try
                {
                    Directory.Delete(tempDir, recursive: true);
                    _logger.LogInformation($"Cleaned up temp directory: {tempDir}");
                }
                catch (Exception cleanupError)
                {
                    _logger.LogWarning(cleanupError, $"Failed to clean up temp directory {tempDir}");
                }
            }
        }
    }

    private async Task<string> ProcessVideoSegments(string videoPath, List<VideoSegment> segments, string tempDir, string jobId, CancellationToken cancellationToken)
    {
        var videoId = segments.FirstOrDefault()?.VideoId ?? "unknown";
        var outputPath = Path.Combine(tempDir, $"processed_{videoId}_{jobId}.mp4");

        // --- FIX: Track segment files created by this specific method call ---
        var createdSegmentFiles = new List<string>();

        try
        {
            _logger.LogInformation($"Job {jobId}: Starting segment processing for video {videoId}");

            var validSegments = new List<VideoSegment>();
            // (Validation logic remains the same...)
            for (int i = 0; i < segments.Count; i++)
            {
                var segment = segments[i];
                if (segment.StartTimeSeconds.HasValue && segment.EndTimeSeconds.HasValue &&
                    segment.StartTimeSeconds >= 0 && segment.EndTimeSeconds > segment.StartTimeSeconds)
                {
                    validSegments.Add(segment);
                }
                else
                {
                    _logger.LogWarning($"Job {jobId}: Invalid segment {i + 1} for video {videoId} skipped.");
                }
            }

            if (!validSegments.Any())
            {
                throw new ArgumentException($"No valid segments to process for video {videoId}");
            }

            _logger.LogInformation($"Job {jobId}: Processing {validSegments.Count} valid segments from video: {Path.GetFileName(videoPath)}");

            if (!File.Exists(videoPath))
            {
                throw new FileNotFoundException($"Input video file not found: {videoPath}");
            }

            await UpdateJobStatus(jobId, "Processing", 60, $"Processing {validSegments.Count} video segments...");

            // Process and extract segments
            for (int i = 0; i < validSegments.Count; i++)
            {
                var segment = validSegments[i];
                var tempSegmentPath = Path.Combine(tempDir, $"segment_{videoId}_{i}_{jobId}.mp4");

                // --- FIX: Add created file to our tracked list ---
                createdSegmentFiles.Add(tempSegmentPath);

                var success = await ExtractSegmentWithFFmpeg(videoPath, tempSegmentPath, segment.StartTimeSeconds.Value, segment.EndTimeSeconds.Value, jobId);
                if (!success)
                {
                    _logger.LogError($"Job {jobId}: Failed to extract segment {i + 1} for video {videoId}.");
                    // Optional: decide if you want to continue or fail the whole video
                }
            }

            // Filter out any files that failed to be created
            var existingSegmentFiles = createdSegmentFiles.Where(File.Exists).ToList();
            if (!existingSegmentFiles.Any())
            {
                throw new Exception($"No video segments could be created for video {videoId}");
            }

            _logger.LogInformation($"Job {jobId}: Created {existingSegmentFiles.Count} segment files for video {videoId}.");
            await UpdateJobStatus(jobId, "Processing", 75, "Combining segments...");

            // Concatenate the segments for this video
            var concatenationSuccess = await ConcatenateSegments(existingSegmentFiles, outputPath, jobId);
            if (!concatenationSuccess || !File.Exists(outputPath))
            {
                throw new Exception($"Failed to concatenate segments for video {videoId}");
            }

            _logger.LogInformation($"Job {jobId}: Video processing for {videoId} completed successfully.");
            return outputPath;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Job {jobId}: Video processing failed for {videoId}");
            throw;
        }
        finally
        {
            // --- FIX: Clean up only the files created by this method ---
            _logger.LogInformation($"Job {jobId}: Cleaning up {createdSegmentFiles.Count} temporary segment files for video {videoId}.");
            foreach (var file in createdSegmentFiles)
            {
                if (File.Exists(file))
                {
                    try
                    {
                        File.Delete(file);
                    }
                    catch (Exception deleteEx)
                    {
                        _logger.LogWarning(deleteEx, $"Failed to delete temporary file: {file}");
                    }
                }
            }
        }
    }

    private async Task<bool> ExtractSegmentWithFFmpeg(string inputPath, string outputPath, double startTime, double endTime, string jobId)
    {
        var duration = endTime - startTime;

        // Use InvariantCulture to ensure '.' is the decimal separator, regardless of the system's locale.
        // Quote file paths to handle spaces and other special characters robustly.
        var arguments = $"-ss {startTime.ToString(CultureInfo.InvariantCulture)} -i \"{inputPath}\" -t {duration.ToString(CultureInfo.InvariantCulture)} -c copy -y \"{outputPath}\"";

        _logger.LogInformation($"Job {jobId}: Preparing to execute direct ffmpeg command.");
        _logger.LogInformation($"Job {jobId}: > ffmpeg {arguments}");

        var processStartInfo = new ProcessStartInfo
        {
            FileName = "ffmpeg", // Assumes 'ffmpeg' is in the system's PATH, which it is in your container.
            Arguments = arguments,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        try
        {
            using (var process = new Process { StartInfo = processStartInfo })
            {
                var stdOut = new StringBuilder();
                var stdErr = new StringBuilder();

                // Use TaskCompletionSource to await the process exit event.
                var tcs = new TaskCompletionSource<bool>();
                process.EnableRaisingEvents = true;
                process.Exited += (sender, args) => tcs.TrySetResult(true);

                // Asynchronously capture the output and error streams.
                process.OutputDataReceived += (sender, args) => { if (args.Data != null) stdOut.AppendLine(args.Data); };
                process.ErrorDataReceived += (sender, args) => { if (args.Data != null) stdErr.AppendLine(args.Data); };

                process.Start();

                process.BeginOutputReadLine();
                process.BeginErrorReadLine();

                // Wait for the process to exit.
                await tcs.Task;

                // Check the exit code. 0 means success.
                if (process.ExitCode == 0)
                {
                    // Final check to ensure the file was created and is not empty.
                    if (File.Exists(outputPath) && new FileInfo(outputPath).Length > 0)
                    {
                        _logger.LogInformation($"Job {jobId}: ffmpeg command executed successfully.");
                        // Log the standard error stream, as ffmpeg writes progress and summary here.
                        _logger.LogInformation($"Job {jobId}: ffmpeg output:\n{stdErr.ToString()}");
                        return true;
                    }
                    else
                    {
                        _logger.LogError($"Job {jobId}: ffmpeg process exited with code 0, but the output file is missing or empty. Path: {outputPath}.\nffmpeg output:\n{stdErr.ToString()}");
                        return false;
                    }
                }
                else
                {
                    _logger.LogError($"Job {jobId}: ffmpeg process failed with exit code {process.ExitCode}.\nffmpeg output:\n{stdErr.ToString()}");
                    return false;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Job {jobId}: An unhandled exception occurred while trying to execute the ffmpeg process. Command: ffmpeg {arguments}");
            return false;
        }
    }

    private async Task<bool> ConcatenateSegments(List<string> segmentFiles, string outputPath, string jobId)
    {
        if (segmentFiles.Count == 1)
        {
            File.Copy(segmentFiles[0], outputPath, true);
            return true;
        }

        _logger.LogInformation($"Job {jobId}: Normalizing and concatenating {segmentFiles.Count} segments into '{outputPath}'.");

        // --- START: ROBUST NORMALIZATION AND CONCATENATION LOGIC ---
        var inputs = string.Join(" ", segmentFiles.Select(f => $"-i \"{f}\""));
        var filterComplex = new StringBuilder();

        // Step 1: Create a filter chain for each input to normalize it to a standard format.
        for (int i = 0; i < segmentFiles.Count; i++)
        {
            // This chain standardizes resolution, aspect ratio, pixel format, and frame rate for the video.
            filterComplex.Append($"[{i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=30[v{i}];");

            // This chain standardizes the audio sample rate.
            filterComplex.Append($"[{i}:a]aresample=44100[a{i}];");
        }

        // Step 2: Chain the now-normalized streams into the final concat filter.
        for (int i = 0; i < segmentFiles.Count; i++)
        {
            filterComplex.Append($"[v{i}][a{i}]");
        }
        filterComplex.Append($"concat=n={segmentFiles.Count}:v=1:a=1[outv][outa]");

        // Use standard, highly compatible codecs for the output file.
        var ffmpegArguments = $"{inputs} -filter_complex \"{filterComplex.ToString()}\" -map \"[outv]\" -map \"[outa]\" -c:v libx264 -preset veryfast -crf 23 -c:a aac -y \"{outputPath}\"";
        // --- END: ROBUST NORMALIZATION AND CONCATENATION LOGIC ---

        _logger.LogInformation($"Job {jobId}: > ffmpeg {ffmpegArguments}");

        var processStartInfo = new ProcessStartInfo("ffmpeg", ffmpegArguments)
        {
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        try
        {
            using (var process = new Process { StartInfo = processStartInfo })
            {
                var stdErr = new StringBuilder();
                var tcs = new TaskCompletionSource<bool>();
                process.EnableRaisingEvents = true;
                process.Exited += (sender, args) => tcs.TrySetResult(true);
                process.ErrorDataReceived += (sender, args) => { if (args.Data != null) stdErr.AppendLine(args.Data); };

                process.Start();
                process.BeginErrorReadLine();
                await tcs.Task;

                if (process.ExitCode == 0 && File.Exists(outputPath) && new FileInfo(outputPath).Length > 0)
                {
                    _logger.LogInformation($"Job {jobId}: Concatenation successful. ffmpeg output:\n{stdErr.ToString()}");
                    return true;
                }
                else
                {
                    _logger.LogError($"Job {jobId}: Concatenation failed. ffmpeg exit code: {process.ExitCode}. Output:\n{stdErr.ToString()}");
                    return false;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Job {jobId}: An unhandled exception occurred during concatenation.");
            return false;
        }
    }

    private async Task<string> CombineMultipleVideos(List<string> videoPaths, string tempDir, string jobId)
    {
        var outputPath = Path.Combine(tempDir, "combined_final_video.mp4");

        if (videoPaths.Count == 1)
        {
            File.Copy(videoPaths[0], outputPath, true);
            return outputPath;
        }

        _logger.LogInformation($"Job {jobId}: Normalizing and combining {videoPaths.Count} video files into '{outputPath}'.");
        await UpdateJobStatus(jobId, "Processing", 80, "Normalizing and combining video segments...");

        // --- START: CORRECT ROBUST CONCATENATION LOGIC ---
        var inputs = string.Join(" ", videoPaths.Select(f => $"-i \"{f}\""));
        var filterComplex = new StringBuilder();

        // Step 1: Create a filter chain for each input to normalize it to a standard format.
        for (int i = 0; i < videoPaths.Count; i++)
        {
            // [i:v] = video stream from input i
            // [i:a] = audio stream from input i
            // This chain standardizes resolution, aspect ratio, pixel format, and frame rate.
            filterComplex.Append($"[{i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=30[v{i}];");

            // This chain standardizes the audio sample rate.
            filterComplex.Append($"[{i}:a]aresample=44100[a{i}];");
        }

        // Step 2: Chain the normalized streams into the concat filter.
        for (int i = 0; i < videoPaths.Count; i++)
        {
            filterComplex.Append($"[v{i}][a{i}]");
        }
        filterComplex.Append($"concat=n={videoPaths.Count}:v=1:a=1[outv][outa]");

        // Use standard, highly compatible codecs for the output.
        var ffmpegArguments = $"{inputs} -filter_complex \"{filterComplex.ToString()}\" -map \"[outv]\" -map \"[outa]\" -c:v libx264 -preset veryfast -crf 23 -c:a aac -y \"{outputPath}\"";
        // --- END: CORRECT ROBUST CONCATENATION LOGIC ---

        _logger.LogInformation($"Job {jobId}: > ffmpeg {ffmpegArguments}");

        var processStartInfo = new ProcessStartInfo("ffmpeg", ffmpegArguments)
        {
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        try
        {
            using (var process = new Process { StartInfo = processStartInfo })
            {
                var stdErr = new StringBuilder();
                var tcs = new TaskCompletionSource<bool>();
                process.EnableRaisingEvents = true;
                process.Exited += (sender, args) => tcs.TrySetResult(true);
                process.ErrorDataReceived += (sender, args) => { if (args.Data != null) stdErr.AppendLine(args.Data); };

                process.Start();
                process.BeginErrorReadLine();
                await tcs.Task;

                if (process.ExitCode == 0 && File.Exists(outputPath) && new FileInfo(outputPath).Length > 0)
                {
                    var fileSize = new FileInfo(outputPath).Length;
                    _logger.LogInformation($"Job {jobId}: Video combination completed: {outputPath} ({fileSize / 1024.0 / 1024.0:F2} MB)");
                    return outputPath;
                }
                else
                {
                    var errorMessage = $"Job {jobId}: ffmpeg process for combining videos failed with exit code {process.ExitCode}. Output:\n{stdErr.ToString()}";
                    _logger.LogError(errorMessage);
                    throw new Exception(errorMessage);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Job {jobId}: An unhandled exception occurred while combining videos.");
            throw;
        }
    }

    private async Task<string> UploadToGcs(string localPath, string jobId)
    {
        try
        {
            _logger.LogInformation($"Starting upload to GCS for job {jobId}");
            await UpdateJobStatus(jobId, "Uploading", 85, "Uploading final video to cloud storage...");

            var blobName = $"edited-clips/{jobId}/final_video.mp4";
            var bucket = await _storageClient.GetBucketAsync(BUCKET_NAME);

            using var fileStream = File.OpenRead(localPath);
            var obj = await _storageClient.UploadObjectAsync(BUCKET_NAME, blobName, "video/mp4", fileStream);

            _logger.LogInformation($"Upload successful to gs://{BUCKET_NAME}/{blobName}");

            // Generate signed URL
            var urlSigner = UrlSigner.FromCredential(_storageClient.Service.HttpClientInitializer as Google.Apis.Auth.OAuth2.GoogleCredential);
            var signedUrl = await urlSigner.SignAsync(BUCKET_NAME, blobName, TimeSpan.FromDays(7), HttpMethod.Get);

            _logger.LogInformation("Signed URL generated successfully");

            await UpdateJobStatus(jobId, "Complete", 100, "Video ready for download!", videoUrl: signedUrl);

            return signedUrl;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"GCS upload failed for job {jobId}");
            var errorMsg = $"Failed to upload video: {ex.Message}";
            await UpdateJobStatus(jobId, "Failed", error: errorMsg,
                suggestions: new[] { "Upload to cloud storage failed", "Please try generating the video again" });
            throw new Exception(errorMsg);
        }
    }

    private string FindVideoFileFuse(string videoId)
    {
        _logger.LogInformation($"Searching for video file with ID '{videoId}' in mount path '{MOUNT_PATH}'");

        var patternsToTry = new[]
        {
            Path.Combine(MOUNT_PATH, $"{videoId}.mp4"),
            Path.Combine(MOUNT_PATH, $"{videoId}_*.mp4"),
            Path.Combine(MOUNT_PATH, $"{videoId}*.mp4")
        };

        foreach (var pattern in patternsToTry)
        {
            _logger.LogInformation($"Trying pattern: {pattern}");

            if (pattern.Contains("*"))
            {
                var directory = Path.GetDirectoryName(pattern);
                var searchPattern = Path.GetFileName(pattern);

                if (Directory.Exists(directory))
                {
                    var matchingFiles = Directory.GetFiles(directory, searchPattern, SearchOption.AllDirectories);
                    if (matchingFiles.Any())
                    {
                        var videoPath = matchingFiles[0];
                        _logger.LogInformation($"Found video file via FUSE mount: {videoPath}");

                        // Verify file exists and has valid size
                        if (File.Exists(videoPath) && new FileInfo(videoPath).Length > 0)
                        {
                            return videoPath;
                        }
                        else
                        {
                            _logger.LogWarning($"Found file but it's empty or doesn't exist: {videoPath}");
                        }
                    }
                }
            }
            else
            {
                if (File.Exists(pattern))
                {
                    // Verify file has valid size
                    if (new FileInfo(pattern).Length > 0)
                    {
                        _logger.LogInformation($"Found video file via FUSE mount: {pattern}");
                        return pattern;
                    }
                    else
                    {
                        _logger.LogWarning($"Found file but it's empty: {pattern}");
                    }
                }
            }
        }

        // Log directory contents for debugging
        try
        {
            if (Directory.Exists(MOUNT_PATH))
            {
                _logger.LogInformation($"Directory contents of {MOUNT_PATH}:");
                var videoFiles = Directory.GetFiles(MOUNT_PATH, "*.mp4", SearchOption.AllDirectories).Take(10);
                foreach (var file in videoFiles)
                {
                    var fileInfo = new FileInfo(file);
                    _logger.LogInformation($"  {file} (Size: {fileInfo.Length / 1024.0 / 1024.0:F2} MB)");
                }
            }
            else
            {
                _logger.LogError($"Mount path {MOUNT_PATH} does not exist");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to list directory contents");
        }

        throw new FileNotFoundException($"Video file with ID '{videoId}' not found in mounted bucket. Tried patterns: {string.Join(", ", patternsToTry)}");
    }

    private async Task UpdateJobStatus(string jobId, string status, int? progress = null, string message = null,
        string error = null, string videoUrl = null, string[] suggestions = null)
    {
        const int maxRetries = 3;
        int attempt = 0;

        while (attempt < maxRetries)
        {
            try
            {
                _logger.LogInformation($"Updating job status for {jobId}: {status} (attempt {attempt + 1}/{maxRetries})");

                var docRef = _firestoreDb.Collection("videoJobs").Document(jobId);
                var updates = new Dictionary<string, object>
                {
                    ["status"] = status,
                    ["updatedAt"] = DateTime.UtcNow
                };

                if (progress.HasValue)
                    updates["progress"] = progress.Value;

                if (!string.IsNullOrEmpty(message))
                    updates["progressMessage"] = message;

                if (!string.IsNullOrEmpty(error))
                    updates["error"] = error;

                if (!string.IsNullOrEmpty(videoUrl))
                    updates["finalVideoUrl"] = videoUrl;

                if (suggestions != null)
                    updates["suggestions"] = suggestions;

                await docRef.UpdateAsync(updates);
                _logger.LogInformation($"Successfully updated job {jobId} status: {status}");
                return; // Success, exit the retry loop
            }
            catch (Exception ex)
            {
                attempt++;
                _logger.LogError(ex, $"Failed to update job status for {jobId} (attempt {attempt}/{maxRetries})");

                if (attempt >= maxRetries)
                {
                    _logger.LogError($"All {maxRetries} attempts failed to update job status for {jobId}");
                    // Don't throw here to avoid cascading failures
                    return;
                }

                // Wait before retrying
                await Task.Delay(1000 * attempt);
            }
        }
    }

    private void CheckFfmpegInstallation()
    {
        try
        {
            _logger.LogInformation("Verifying ffmpeg installation by running 'ffmpeg -version'...");
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "ffmpeg",
                    Arguments = "-version",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                }
            };

            process.Start();
            string output = process.StandardOutput.ReadToEnd();
            string err = process.StandardError.ReadToEnd();
            process.WaitForExit();

            if (process.ExitCode == 0)
            {
                // Log the first line of the output which usually contains the version.
                var versionLine = output.Split('\n').FirstOrDefault()?.Trim() ?? "Unknown version";
                _logger.LogInformation($"ffmpeg verification successful. Version info: {versionLine}");
            }
            else
            {
                // This will be triggered if ffmpeg returns an error.
                _logger.LogCritical($"ffmpeg verification failed. Exit Code: {process.ExitCode}. Stderr: {err}");
                throw new Exception($"ffmpeg executable returned an error. Stderr: {err}");
            }
        }
        catch (Exception ex)
        {
            // This catch block is crucial. On Linux, if 'ffmpeg' is not found, an exception is thrown.
            _logger.LogCritical(ex, "FATAL: ffmpeg executable not found or failed to run. " +
                                    "Please ensure ffmpeg is installed in the container and accessible via the PATH environment variable.");
            throw;
        }
    }
}

// Data models
public class JobData
{
    [JsonPropertyName("apifyRunId")]
    public string? JobId { get; set; }

    [JsonPropertyName("videoIds")]
    public List<string>? VideoIds { get; set; }

    [JsonPropertyName("segments")]
    public List<VideoSegment>? Segments { get; set; }

    [JsonPropertyName("createdAt")]
    public string? CreatedAt { get; set; }

    [JsonPropertyName("skipDownload")]
    public bool? SkipDownload { get; set; }

    [JsonPropertyName("progress")]
    public int? Progress { get; set; }

    [JsonPropertyName("totalVideos")]
    public int? TotalVideos { get; set; }

    [JsonPropertyName("videosAlreadyAvailable")]
    public List<string>? VideosAlreadyAvailable { get; set; }

    [JsonPropertyName("finalVideoUrl")]
    public string? FinalVideoUrl { get; set; }

    [JsonPropertyName("userSessionId")]
    public string? UserSessionId { get; set; }

    [JsonPropertyName("updatedAt")]
    public string? UpdatedAt { get; set; }

    [JsonPropertyName("videosNeedingDownload")]
    public List<string>? VideosNeedingDownload { get; set; }

    [JsonPropertyName("segmentCount")]
    public int? SegmentCount { get; set; }

    [JsonPropertyName("download_progress")]
    public double? DownloadProgress { get; set; }

    [JsonPropertyName("suggestions")]
    public List<string>? Suggestions { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("progressMessage")]
    public string? ProgressMessage { get; set; }
}

public class VideoSegment
{
    [JsonPropertyName("videoId")]
    public string? VideoId { get; set; }

    [JsonPropertyName("startTimeSeconds")]
    public double? StartTimeSeconds { get; set; }

    [JsonPropertyName("endTimeSeconds")]
    public double? EndTimeSeconds { get; set; }

    [JsonPropertyName("videoTitle")]
    public string? VideoTitle { get; set; }
}

public class VideoInfo
{
    public double Duration { get; set; }
    public double Fps { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}