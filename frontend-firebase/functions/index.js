import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { PubSub } from "@google-cloud/pubsub";
import { Storage } from "@google-cloud/storage";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import cors from "cors";
import { GoogleAuth } from "google-auth-library";
import { logger } from "firebase-functions";
import { randomUUID } from "crypto";
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import tmp from "tmp";
import fs from "fs";
import path from "path";

initializeApp();

// Initialize CORS with proper configuration
const corsHandler = cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
});

const pubSubClient = new PubSub();
const firestore = getFirestore('jre-clipper-db');
const storage = new Storage();
const BUCKET_NAME = 'jre-processed-clips-bucker';

// Promisified exec function
const execAsync = promisify(exec);

// Multi-purpose function: handles Vertex AI tokens
export const getVertexAiToken = onRequest(async (req, res) => {
    corsHandler(req, res, async () => {
        try {
            logger.info("Attempting to get Vertex AI access token");

            const auth = new GoogleAuth({
                scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            });

            logger.info("GoogleAuth initialized, getting client...");
            const client = await auth.getClient();

            logger.info("Client obtained, getting access token...");
            const accessToken = await client.getAccessToken();

            if (!accessToken || !accessToken.token) {
                logger.error("Access token is null or empty");
                res.status(500).json({ error: "Could not generate access token - token is empty" });
                return;
            }

            logger.info("Access token generated successfully");
            res.status(200).json({ accessToken: accessToken.token });

        } catch (error) {
            logger.error("Error getting access token:", {
                message: error.message,
                stack: error.stack,
                code: error.code
            });
            res.status(500).json({
                error: "Could not generate access token",
                details: error.message
            });
        }
    });
});

export const initiateVideoJob = onCall({
    enforceAppCheck: false,
}, async (request) => {
    logger.info("Received video job request");
    logger.info("Request data:", request.data);
    logger.info("Request auth:", request.auth ? "authenticated" : "not authenticated");

    // Check if request.data exists
    if (!request.data) {
        logger.error("No data received in request");
        throw new HttpsError(
            "invalid-argument",
            "No data received in the request."
        );
    }

    // Validate incoming data - expect segments array
    const { segments } = request.data;
    logger.info("Extracted segments count:", segments ? segments.length : 0);

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
        logger.error("Invalid segments data:", {
            hasSegments: !!segments,
            type: typeof segments,
            isArray: Array.isArray(segments),
            length: segments ? segments.length : 0
        });
        throw new HttpsError(
            "invalid-argument",
            "The function must be called with a segments array containing videoId, startTimeSeconds, and endTimeSeconds."
        );
    }

    const jobId = randomUUID();
    const topicId = "jre-video-processing-jobs";

    const payload = {
        jobId,
        segments: segments,
    };

    try {
        // Create a Firestore document to track the job status immediately
        await firestore.collection("videoJobs").doc(jobId).set({
            videoId: segments[0].videoId,
            status: "Queued",
            createdAt: new Date().toISOString(),
            jobId: jobId,
            videoTitle: segments[0].videoTitle || "Untitled",
            segmentCount: segments.length,
        });
        logger.info(`Job ${jobId} status set to Queued in Firestore with ${segments.length} segments.`);

        // Publish the job payload to the Pub/Sub topic for processing
        await pubSubClient.topic(topicId).publishMessage({ json: payload });
        logger.info(`Job ${jobId} published to Pub/Sub topic ${topicId}.`);

        return { jobId: jobId };

    } catch (error) {
        logger.error(`Failed to initiate job:`, error);

        // Try to update Firestore to reflect the failure
        try {
            await firestore.collection("videoJobs").doc(jobId).set({
                status: "Failed",
                error: "Failed to publish job to processing queue.",
                createdAt: new Date().toISOString(),
            });
        } catch (firestoreError) {
            logger.error("Failed to update Firestore with error status:", firestoreError);
        }

        throw new HttpsError(
            "internal",
            "An error occurred while queueing the job."
        );
    }
});

// Function to get job status for the frontend (HTTP endpoint)
export const getJobStatus = onRequest(async (req, res) => {
    corsHandler(req, res, async () => {
        try {
            logger.info("Received job status request");

            const { jobId } = req.body;
            if (!jobId) {
                return res.status(400).json({ error: "Job ID is required" });
            }

            const jobDoc = await firestore.collection("videoJobs").doc(jobId).get();

            if (!jobDoc.exists) {
                return res.status(404).json({ error: "Job not found" });
            }

            const jobData = jobDoc.data();
            logger.info(`Job status retrieved for ${jobId}: ${jobData.status}`);
            res.status(200).json({ jobData });

        } catch (error) {
            logger.error("Error getting job status:", error);
            res.status(500).json({ error: "Internal server error" });
        }
    });
});

// Pub/Sub triggered video processor
export const processVideoFromPubSub = onMessagePublished({
    topic: "jre-video-processing-jobs",
    timeoutSeconds: 540, // 9 minutes - maximum for Firebase Functions
    memory: "8GiB",
    cpu: 4
}, async (event) => {
    logger.info("Received Pub/Sub message for video processing");

    try {
        const messageData = event.data.message.data;
        const payload = JSON.parse(Buffer.from(messageData, 'base64').toString());
        console.log("Parsed Pub/Sub payload:", payload);
        const { jobId, segments } = payload;

        if (!jobId || !segments) {
            logger.error("Invalid Pub/Sub message format");
            return;
        }

        // Check if job is already being processed or completed
        const jobDoc = await firestore.collection('videoJobs').doc(jobId).get();
        const jobData = jobDoc.data();

        if (jobData && ['Processing', 'Complete'].includes(jobData.status)) {
            logger.info(`Job ${jobId} is already ${jobData.status}, skipping Pub/Sub processing`);
            return;
        }

        logger.info(`Processing job ${jobId} from Pub/Sub backup`);

        // Call the same video processing function
        await processVideoJobInternal(jobId, segments);

    } catch (error) {
        logger.error("Error processing Pub/Sub video job:", error);
    }
});

// Internal video processing function (shared between direct call and Pub/Sub)
async function processVideoJobInternal(jobId, segments) {
    const startTime = Date.now();
    let tempDir = null;

    try {
        // Update job status to processing
        await updateJobStatus(jobId, 'Processing', 5, 'Initializing video processing...');

        // Create temporary directory
        tempDir = tmp.dirSync({ prefix: 'video_job_', unsafeCleanup: true });
        logger.info(`Created temp directory: ${tempDir.name}`);

        // Validate segments
        if (!Array.isArray(segments) || segments.length === 0) {
            throw new Error("Invalid segments array");
        }

        const videoId = segments[0].videoId;
        if (!videoId) {
            throw new Error("No videoId found in segments");
        }

        logger.info(`Processing ${segments.length} segments for video ${videoId}`);

        // Download YouTube video with optimization
        await updateJobStatus(jobId, 'Processing', 20, 'Downloading YouTube video...');
        const videoPath = await downloadYouTubeVideo(videoId, tempDir.name);

        // Process segments efficiently
        await updateJobStatus(jobId, 'Processing', 60, 'Processing video segments...');
        const finalVideoPath = await processVideoSegments(videoPath, segments, tempDir.name);

        // Upload to Google Cloud Storage
        await updateJobStatus(jobId, 'Processing', 90, 'Uploading final video...');
        const finalVideoUrl = await uploadToCloudStorage(finalVideoPath, jobId);

        // Update status to complete
        await updateJobStatus(jobId, 'Complete', 100, 'Video processing completed!',
            null, finalVideoUrl);

        const processingTime = (Date.now() - startTime) / 1000;
        logger.info(`Job ${jobId} completed in ${processingTime}s. Video URL: ${finalVideoUrl}`);

        return { finalVideoUrl, processingTime };

    } catch (error) {
        const errorMsg = `Error processing job ${jobId}: ${error.message}`;
        logger.error(errorMsg, error);

        await updateJobStatus(jobId, 'Failed', null, null, error.message);
        throw error;

    } finally {
        // Cleanup temporary directory
        if (tempDir) {
            try {
                tempDir.removeCallback();
                logger.info(`Cleaned up temp directory: ${tempDir.name}`);
            } catch (cleanupError) {
                logger.warning(`Failed to cleanup temp directory: ${cleanupError.message}`);
            }
        }
    }
}

// Enhanced YouTube video download using direct yt-dlp subprocess calls
async function downloadYouTubeVideo(videoId, tempDir) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const outputTemplate = path.join(tempDir, `${videoId}.%(ext)s`);

            logger.info(`Downloading video with direct yt-dlp call (attempt ${attempt}/${maxRetries}): ${videoUrl}`);

            // Build the command exactly like your successful CLI call
            let cmd = `yt-dlp`;
            
            // Add format selection with progressive quality reduction
            if (attempt === 1) {
                cmd += ` --format "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"`;
            } else if (attempt === 2) {
                cmd += ` --format "best[height<=480]/best"`;
            } else {
                cmd += ` --format "worst/best"`;  // Last resort
            }
            
            // Add other options
            cmd += ` --no-playlist`;
            cmd += ` --max-filesize 500M`;
            cmd += ` --output "${outputTemplate}"`;
            cmd += ` --no-warnings`;
            cmd += ` --no-check-certificates`;
            cmd += ` --retries 3`;
            cmd += ` --fragment-retries 3`;
            cmd += ` --skip-unavailable-fragments`;
            
            // Add user agent for attempts 2+
            if (attempt >= 2) {
                cmd += ` --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`;
                cmd += ` --add-header "Accept-Language:en-US,en;q=0.9"`;
                cmd += ` --add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"`;
            }
            
            // Add the video URL (properly escaped)
            cmd += ` "${videoUrl}"`;

            logger.info(`Executing yt-dlp command (attempt ${attempt}): ${cmd}`);

            // Execute the command with timeout
            const { stdout, stderr } = await execAsync(cmd, {
                timeout: 300000, // 5 minute timeout
                maxBuffer: 1024 * 1024 * 10, // 10MB buffer
                cwd: tempDir // Set working directory
            });

            if (stderr) {
                logger.info(`yt-dlp stderr: ${stderr}`);
                
                // Check for critical errors in stderr
                if (stderr.toLowerCase().includes('error:') && 
                    !stderr.toLowerCase().includes('warning:')) {
                    throw new Error(`yt-dlp error: ${stderr}`);
                }
            }

            logger.info(`Download completed successfully on attempt ${attempt}`);

            // Find the downloaded file
            const files = fs.readdirSync(tempDir);
            logger.info(`Files in temp directory: ${files.join(', ')}`);
            
            const downloadedFile = files.find(file => 
                file.startsWith(videoId) && 
                (file.endsWith('.mp4') || file.endsWith('.mkv') || file.endsWith('.webm') || file.endsWith('.m4a'))
            );
            
            if (downloadedFile) {
                const fullPath = path.join(tempDir, downloadedFile);
                
                // Verify file exists and has content
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    if (stats.size > 0) {
                        logger.info(`Successfully downloaded: ${fullPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                        return fullPath;
                    } else {
                        throw new Error('Downloaded file is empty');
                    }
                } else {
                    throw new Error('Downloaded file does not exist');
                }
            } else {
                logger.error(`Downloaded files in ${tempDir}: ${files.join(', ')}`);
                throw new Error('Downloaded file not found');
            }

        } catch (error) {
            lastError = error;
            logger.error(`YouTube download attempt ${attempt} failed: ${error.message}`);
            
            // If this isn't the last attempt, wait before retrying
            if (attempt < maxRetries) {
                const delay = attempt * 2000; // Exponential backoff: 2s, 4s
                logger.info(`Waiting ${delay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // All attempts failed, provide specific error handling
    logger.error(`All ${maxRetries} download attempts failed for video ${videoId}`);
    
    const errorMessage = lastError.message.toLowerCase();
    if (errorMessage.includes('video unavailable') || errorMessage.includes('private')) {
        throw new Error(`Video ${videoId} is unavailable or private`);
    } else if (errorMessage.includes('age-gated') || errorMessage.includes('sign in')) {
        throw new Error(`Video ${videoId} requires age verification or sign-in`);
    } else if (errorMessage.includes('region')) {
        throw new Error(`Video ${videoId} is not available in this region`);
    } else if (errorMessage.includes('not found') || errorMessage.includes('404')) {
        throw new Error(`Video ${videoId} not found`);
    } else if (errorMessage.includes('player response') || errorMessage.includes('extract')) {
        throw new Error(`Video ${videoId} extraction failed - YouTube may be blocking requests. Try again later.`);
    } else if (errorMessage.includes('certificate') || errorMessage.includes('ssl')) {
        throw new Error(`Video ${videoId} download failed due to SSL/certificate issues`);
    } else if (errorMessage.includes('timeout')) {
        throw new Error(`Video ${videoId} download timed out - video may be too large or network is slow`);
    } else {
        throw new Error(`Failed to download video ${videoId} after ${maxRetries} attempts: ${lastError.message}`);
    }
}

// Optimized video segment processing using FFmpeg
async function processVideoSegments(videoPath, segments, tempDir) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(tempDir, 'final_video.mp4');

        logger.info(`Processing ${segments.length} segments using FFmpeg ${ffmpegPath.path}`);

        // Validate segments
        const validSegments = segments.filter(segment => {
            const start = parseFloat(segment.startTimeSeconds);
            const end = parseFloat(segment.endTimeSeconds);
            return start >= 0 && end > start;
        });

        if (validSegments.length === 0) {
            return reject(new Error('No valid segments to process'));
        }

        // Create FFmpeg filter complex
        let filterComplex = '';

        validSegments.forEach((segment, index) => {
            const start = parseFloat(segment.startTimeSeconds);
            const end = parseFloat(segment.endTimeSeconds);
            const duration = end - start;

            // Trim video and audio streams
            filterComplex += `[0:v]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS[v${index}];`;
            filterComplex += `[0:a]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS[a${index}];`;
        });

        // Concatenate all segments
        const videoInputs = validSegments.map((_, i) => `[v${i}]`).join('');
        const audioInputs = validSegments.map((_, i) => `[a${i}]`).join('');

        filterComplex += `${videoInputs}concat=n=${validSegments.length}:v=1:a=0[outv];`;
        filterComplex += `${audioInputs}concat=n=${validSegments.length}:v=0:a=1[outa]`;

        // Build FFmpeg command arguments
        const ffmpegArgs = [
            '-i', videoPath,
            '-filter_complex', filterComplex,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y', // Overwrite output file
            outputPath
        ];

        logger.info(`FFmpeg command: ${ffmpegPath.path} ${ffmpegArgs.join(' ')}`);

        // Execute FFmpeg
        const ffmpegProcess = spawn(ffmpegPath.path, ffmpegArgs);

        let stderrData = '';

        ffmpegProcess.stderr.on('data', (data) => {
            stderrData += data.toString();

            // Parse progress from stderr (FFmpeg outputs progress to stderr)
            const progressMatch = data.toString().match(/time=(\d{2}):(\d{2}):(\d{2})/);
            if (progressMatch) {
                const [, hours, minutes, seconds] = progressMatch;
                const currentTime = parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);
                logger.info(`FFmpeg progress: ${currentTime}s processed`);
            }
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                logger.info(`Video processing completed: ${outputPath}`);
                resolve(outputPath);
            } else {
                logger.error(`FFmpeg exited with code ${code}`);
                logger.error(`FFmpeg stderr: ${stderrData}`);
                reject(new Error(`FFmpeg failed with exit code ${code}`));
            }
        });

        ffmpegProcess.on('error', (error) => {
            logger.error(`FFmpeg spawn error: ${error.message}`);
            reject(error);
        });
    });
}

// Upload to Google Cloud Storage
async function uploadToCloudStorage(localPath, jobId) {
    try {
        logger.info(`Uploading to GCS bucket: ${BUCKET_NAME}`);

        const bucket = storage.bucket(BUCKET_NAME);

        // Verify bucket exists and we have access
        const [exists] = await bucket.exists();
        if (!exists) {
            throw new Error(`Bucket ${BUCKET_NAME} does not exist`);
        }

        const fileName = `videos/${jobId}/final_video.mp4`;

        logger.info(`Uploading file: gs://${BUCKET_NAME}/${fileName}`);

        // Upload with retry logic
        const [file] = await bucket.upload(localPath, {
            destination: fileName,
            metadata: {
                contentType: 'video/mp4',
                metadata: {
                    jobId: jobId,
                    createdAt: new Date().toISOString(),
                    originalName: `final_video_${jobId}.mp4`
                }
            },
            resumable: false // For smaller files, use simple upload
        });

        // Make publicly accessible
        await file.makePublic();

        const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${fileName}`;
        logger.info(`Upload successful: ${publicUrl}`);

        return publicUrl;

    } catch (error) {
        logger.error(`GCS upload failed: ${error.message}`);

        // Provide specific error messages for common auth issues
        if (error.code === 403) {
            throw new Error('Insufficient permissions to access Google Cloud Storage');
        } else if (error.code === 404) {
            throw new Error(`Bucket ${BUCKET_NAME} not found`);
        } else {
            throw new Error(`Upload failed: ${error.message}`);
        }
    }
}

// Helper function to update job status
async function updateJobStatus(jobId, status, progress = null, progressMessage = null, error = null, finalVideoUrl = null) {
    try {
        const updateData = {
            status,
            updatedAt: new Date().toISOString()
        };

        if (progress !== null) updateData.progress = progress;
        if (progressMessage) updateData.progressMessage = progressMessage;
        if (error) updateData.error = error;
        if (finalVideoUrl) updateData.finalVideoUrl = finalVideoUrl;

        await firestore.collection('videoJobs').doc(jobId).update(updateData);
        logger.info(`Updated job ${jobId} status to ${status}`);

    } catch (error) {
        logger.error(`Error updating job status: ${error.message}`);
    }
}