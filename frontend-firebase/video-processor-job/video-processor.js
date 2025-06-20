const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Initialize Google Cloud clients once for reuse across invocations
const firestore = new Firestore();
const storage = new Storage();
// IMPORTANT: Replace with your actual GCS bucket name
const bucket = storage.bucket("jre-processed-clips-bucker");

// Register a CloudEvent callback for Pub/Sub messages.
// The function name 'processVideoJob' is for clarity; you can name it anything.
functions.cloudEvent('processVideoJob', async (cloudEvent) => {
    // --- 1. Decode the Pub/Sub Message ---
    const pubSubMessage = cloudEvent.data.message;
    if (!pubSubMessage || !pubSubMessage.data) {
        console.error("Received an empty or invalid Pub/Sub message.");
        return; // Exit gracefully
    }

    // The message data is base64 encoded. Decode it to get the JSON payload.
    const payloadString = Buffer.from(pubSubMessage.data, 'base64').toString();
    const payload = JSON.parse(payloadString);
    const { jobId, segmentData } = payload;

    if (!jobId || !segmentData) {
        console.error("Decoded payload is missing 'jobId' or 'segmentData'.", payload);
        return;
    }

    console.log(`[${jobId}] Starting processing for Video ID: ${segmentData.videoId}`);

    // --- 2. Setup Temporary Directory ---
    const tempDir = path.join(os.tmpdir(), jobId);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[${jobId}] Created temporary directory: ${tempDir}`);

    try {
        // --- 3. Update Job Status in Firestore ---
        const jobRef = firestore.collection("videoJobs").doc(jobId);
        await jobRef.update({ status: "Processing", progress: 10 });

        // --- 4. Download Original Video using yt-dlp ---
        console.log(`[${jobId}] Downloading video...`);
        const videoUrl = `https://www.youtube.com/watch?v=${segmentData.videoId}`;
        const originalVideoPath = path.join(tempDir, `${segmentData.videoId}.mp4`);
        // Use { stdio: 'inherit' } to see the download progress in the Cloud Run logs
        execSync(`yt-dlp -f 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4' -o '${originalVideoPath}' ${videoUrl}`, { stdio: 'inherit' });
        console.log(`[${jobId}] Download complete.`);
        await jobRef.update({ progress: 40 });

        // --- 5. Clip Video using FFmpeg ---
        console.log(`[${jobId}] Clipping video from ${segmentData.startTimeSeconds}s to ${segmentData.endTimeSeconds}s.`);
        const clippedVideoPath = path.join(tempDir, "summary_video.mp4");
        const duration = segmentData.endTimeSeconds - segmentData.startTimeSeconds;
        // Use -c copy for fast, lossless clipping
        execSync(`ffmpeg -ss ${segmentData.startTimeSeconds} -i '${originalVideoPath}' -t ${duration} -c copy '${clippedVideoPath}'`, { stdio: 'inherit' });
        console.log(`[${jobId}] Clipping complete.`);
        await jobRef.update({ progress: 80 });

        // --- 6. Upload Final Video to GCS ---
        const gcsVideoPath = `job-output/${jobId}/summary_video.mp4`;
        await bucket.upload(clippedVideoPath, { destination: gcsVideoPath });
        // Get a long-lived, publicly accessible URL for the video
        const [signedVideoUrl] = await bucket.file(gcsVideoPath).getSignedUrl({ action: 'read', expires: '03-09-2491' });
        console.log(`[${jobId}] Final video uploaded to GCS.`);

        // --- 7. Final Firestore Update on Success ---
        await jobRef.update({
            status: "Complete",
            progress: 100,
            videoUrl: signedVideoUrl,
            completedAt: new Date().toISOString(),
        });

        console.log(`[${jobId}] Job successfully completed.`);

    } catch (error) {
        console.error(`[${jobId}] Job failed during processing:`, error);
        // Update Firestore with the failure status and error message
        await firestore.collection("videoJobs").doc(jobId).update({
            status: "Failed",
            error: error.message || "An unknown error occurred during processing.",
        });
        // Re-throw the error to ensure the Cloud Run Job is marked as "Failed"
        throw error;
    } finally {
        // --- 8. Cleanup ---
        console.log(`[${jobId}] Cleaning up temporary directory: ${tempDir}`);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});