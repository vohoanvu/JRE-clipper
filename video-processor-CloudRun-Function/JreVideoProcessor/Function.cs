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
using System.Text.Json;
using System.Net.Http;
using System.Text.Json.Serialization;
using FFMpegCore;

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

        try
        {
            _logger.LogInformation($"Job {jobId}: Starting segment processing");

            // Validate segments
            var validSegments = new List<VideoSegment>();
            for (int i = 0; i < segments.Count; i++)
            {
                var segment = segments[i];
                try
                {
                    if (segment.StartTimeSeconds.HasValue && segment.EndTimeSeconds.HasValue &&
                        segment.StartTimeSeconds >= 0 && segment.EndTimeSeconds > segment.StartTimeSeconds)
                    {
                        validSegments.Add(segment);
                        _logger.LogInformation($"Job {jobId}: Valid segment {i + 1}: {segment.VideoId} {segment.StartTimeSeconds}s-{segment.EndTimeSeconds}s (duration: {segment.EndTimeSeconds - segment.StartTimeSeconds:F2}s)");
                    }
                    else
                    {
                        _logger.LogWarning($"Job {jobId}: Invalid segment {i + 1} skipped: start={segment.StartTimeSeconds}, end={segment.EndTimeSeconds}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, $"Job {jobId}: Skipping segment {i + 1} due to format error");
                }
            }

            if (!validSegments.Any())
            {
                throw new ArgumentException("No valid segments to process");
            }

            var totalSegmentDuration = validSegments.Sum(s => s.EndTimeSeconds - s.StartTimeSeconds);
            _logger.LogInformation($"Job {jobId}: Processing {validSegments.Count} valid segments from video: {Path.GetFileName(videoPath)}");
            _logger.LogInformation($"Job {jobId}: Total segments duration: {totalSegmentDuration:F2}s");

            // Verify input video exists
            if (!File.Exists(videoPath))
            {
                throw new FileNotFoundException($"Input video file not found: {videoPath}");
            }

            // Remove the GetVideoInfo call - we'll let FFMpeg handle video validation
            _logger.LogInformation($"Job {jobId}: Processing video file: {Path.GetFileName(videoPath)}");

            // Update job status
            await UpdateJobStatus(jobId, "Processing", 60, $"Processing {validSegments.Count} video segments...");

            // Process segments
            var segmentFiles = new List<string>();
            for (int i = 0; i < validSegments.Count; i++)
            {
                var segment = validSegments[i];
                var startTime = segment.StartTimeSeconds.Value;
                var endTime = segment.EndTimeSeconds.Value;
                var duration = endTime - startTime;

                _logger.LogInformation($"Job {jobId}: Processing segment {i + 1}/{validSegments.Count}: {startTime}s-{endTime}s (duration: {duration:F2}s)");

                try
                {
                    var tempSegmentPath = Path.Combine(tempDir, $"segment_{i}_{jobId}.mp4");
                    _logger.LogInformation($"Job {jobId}: Extracting segment {i + 1}/{validSegments.Count} using FFMpeg to {tempSegmentPath}");

                    // Extract segment using FFMpeg.SubVideo - it will handle validation internally
                    var success = await ExtractSegmentWithFFmpeg(videoPath, tempSegmentPath, startTime, endTime, jobId);
                    if (success && File.Exists(tempSegmentPath) && new FileInfo(tempSegmentPath).Length > 0)
                    {
                        segmentFiles.Add(tempSegmentPath);
                        _logger.LogInformation($"Job {jobId}: Successfully extracted segment {i + 1}");
                    }
                    else
                    {
                        _logger.LogError($"Job {jobId}: Failed to extract segment {i + 1}");
                    }

                    // Update progress
                    var progress = (int)(60 + (i + 1) / (double)validSegments.Count * 15);
                    await UpdateJobStatus(jobId, "Processing", progress, $"Processed segment {i + 1}/{validSegments.Count}");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, $"Job {jobId}: Error processing segment {i + 1}");
                    continue;
                }
            }

            if (!segmentFiles.Any())
            {
                throw new Exception("No valid video segments could be created");
            }

            _logger.LogInformation($"Job {jobId}: Created {segmentFiles.Count} segment files successfully");

            // Update progress
            await UpdateJobStatus(jobId, "Processing", 75, "Combining segments and encoding final video...");

            // Concatenate segments
            var concatenationSuccess = await ConcatenateSegments(segmentFiles, outputPath, jobId);
            if (!concatenationSuccess || !File.Exists(outputPath))
            {
                throw new Exception("Failed to concatenate video segments");
            }

            _logger.LogInformation($"Job {jobId}: Video processing completed successfully");
            var fileSize = new FileInfo(outputPath).Length;
            _logger.LogInformation($"Job {jobId}: Output file: {outputPath} ({fileSize / 1024.0 / 1024.0:F2} MB)");

            return outputPath;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Job {jobId}: Video processing failed");
            throw;
        }
        finally
        {
            // Clean up temporary segment files
            _logger.LogInformation($"Job {jobId}: Cleaning up temporary files");
            try
            {
                var segmentFiles = Directory.GetFiles(tempDir, $"segment_*_{jobId}.mp4");
                foreach (var file in segmentFiles)
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
            catch (Exception cleanupEx)
            {
                _logger.LogWarning(cleanupEx, $"Error during cleanup for job {jobId}");
            }
        }
    }

    private async Task<bool> ExtractSegmentWithFFmpeg(string inputPath, string outputPath, double startTime, double endTime, string jobId)
    {
        try
        {
            var startTimeSpan = TimeSpan.FromSeconds(startTime);
            var duration = TimeSpan.FromSeconds(endTime - startTime);

            _logger.LogDebug($"Job {jobId}: Extracting segment from {startTimeSpan} for {duration} duration using FFMpeg.SubVideo");

            // Use FFMpeg.SubVideo for simple segment extraction
            await Task.Run(() => FFMpeg.SubVideo(inputPath, outputPath, startTimeSpan, duration));

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Job {jobId}: Error extracting segment with FFMpeg.SubVideo");
            return false;
        }
    }

    private async Task<bool> ConcatenateSegments(List<string> segmentFiles, string outputPath, string jobId)
    {
        try
        {
            if (segmentFiles.Count == 1)
            {
                // Single segment, just copy
                File.Copy(segmentFiles[0], outputPath, true);
                return true;
            }

            _logger.LogDebug($"Job {jobId}: Joining {segmentFiles.Count} segments using FFMpeg.Join");

            // Use FFMpeg.Join for simple concatenation
            await Task.Run(() => FFMpeg.Join(outputPath, segmentFiles.ToArray()));

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Job {jobId}: Error joining segments with FFMpeg.Join");
            return false;
        }
    }


    private async Task<string> CombineMultipleVideos(List<string> videoPaths, string tempDir, string jobId)
    {
        var outputPath = Path.Combine(tempDir, "combined_final_video.mp4");

        try
        {
            _logger.LogInformation($"Job {jobId}: Combining {videoPaths.Count} video files using FFMpeg.Join");
            await UpdateJobStatus(jobId, "Processing", 80, "Combining multiple video segments...");

            if (videoPaths.Count == 1)
            {
                File.Copy(videoPaths[0], outputPath, true);
                return outputPath;
            }

            // Use FFMpeg.Join for simple video combination
            await Task.Run(() => FFMpeg.Join(outputPath, videoPaths.ToArray()));

            var fileSize = new FileInfo(outputPath).Length;
            _logger.LogInformation($"Job {jobId}: Video combination completed: {outputPath} ({fileSize / 1024.0 / 1024.0:F2} MB)");

            return outputPath;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, $"Job {jobId}: Error combining videos with FFMpeg.Join");
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