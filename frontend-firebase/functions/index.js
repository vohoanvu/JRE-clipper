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
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import ytdl from "ytdl-core";
import tmp from "tmp";
import fs from "fs";
import path from "path";

// Configure FFmpeg path
ffmpeg.setFfmpegPath(ffmpegPath.path);

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

// Optimized YouTube video download
async function downloadYouTubeVideo(videoId, tempDir) {
    return new Promise((resolve, reject) => {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const outputPath = path.join(tempDir, `${videoId}.mp4`);
        
        logger.info(`Downloading video: ${videoUrl}`);
        
        // Get video info with quality filter
        ytdl.getInfo(videoId).then(info => {
            // Choose format - prefer 720p mp4 for balance of quality and processing speed
            const format = ytdl.chooseFormat(info.formats, { 
                quality: 'highest',
                filter: format => format.container === 'mp4' && format.hasVideo && format.hasAudio
            });
            
            if (!format) {
                return reject(new Error('No suitable video format found'));
            }
            
            const stream = ytdl(videoUrl, { format });
            const writeStream = fs.createWriteStream(outputPath);
            
            let downloadedBytes = 0;
            
            stream.on('data', (chunk) => {
                downloadedBytes += chunk.length;
            });
            
            stream.on('error', reject);
            writeStream.on('error', reject);
            
            stream.pipe(writeStream);
            
            writeStream.on('finish', () => {
                logger.info(`Downloaded ${downloadedBytes} bytes to ${outputPath}`);
                resolve(outputPath);
            });
            
        }).catch(reject);
    });
}

// Optimized video segment processing using FFmpeg
async function processVideoSegments(videoPath, segments, tempDir) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(tempDir, 'final_video.mp4');
        
        logger.info(`Processing ${segments.length} segments`);
        
        // Validate segments and create filter complex
        const validSegments = segments.filter(segment => {
            const start = parseFloat(segment.startTimeSeconds);
            const end = parseFloat(segment.endTimeSeconds);
            return start >= 0 && end > start;
        });
        
        if (validSegments.length === 0) {
            return reject(new Error('No valid segments to process'));
        }
        
        // Create FFmpeg filter complex for efficient processing
        let filterComplex = '';
        const inputMaps = [];
        
        validSegments.forEach((segment, index) => {
            const start = parseFloat(segment.startTimeSeconds);
            const end = parseFloat(segment.endTimeSeconds);
            const duration = end - start;
            
            // Trim video and audio streams
            filterComplex += `[0:v]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS[v${index}];`;
            filterComplex += `[0:a]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS[a${index}];`;
            
            inputMaps.push(`[v${index}]`);
            inputMaps.push(`[a${index}]`);
        });
        
        // Concatenate all segments
        const videoInputs = validSegments.map((_, i) => `[v${i}]`).join('');
        const audioInputs = validSegments.map((_, i) => `[a${i}]`).join('');
        
        filterComplex += `${videoInputs}concat=n=${validSegments.length}:v=1:a=0[outv];`;
        filterComplex += `${audioInputs}concat=n=${validSegments.length}:v=0:a=1[outa]`;
        
        // Execute FFmpeg with optimized settings
        ffmpeg(videoPath)
            .complexFilter(filterComplex)
            .outputOptions([
                '-map [outv]',
                '-map [outa]',
                '-c:v libx264',
                '-preset fast',        // Fast encoding for time optimization
                '-crf 23',            // Good quality/size balance
                '-c:a aac',
                '-b:a 128k',
                '-movflags +faststart' // Optimize for web playback
            ])
            .output(outputPath)
            .on('start', (command) => {
                logger.info(`FFmpeg command: ${command}`);
            })
            .on('progress', (progress) => {
                if (progress.percent) {
                    logger.info(`FFmpeg progress: ${Math.round(progress.percent)}%`);
                }
            })
            .on('end', () => {
                logger.info(`Video processing completed: ${outputPath}`);
                resolve(outputPath);
            })
            .on('error', (error) => {
                logger.error(`FFmpeg error: ${error.message}`);
                reject(error);
            })
            .run();
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