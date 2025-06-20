const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Initialize Google Cloud clients
const firestore = new Firestore();
const storage = new Storage();
// IMPORTANT: Replace with your actual GCS bucket name
const bucket = storage.bucket("jre-processed-clips-bucker");

// Register a CloudEvent callback for Pub/Sub messages.
functions.cloudEvent('processVideoJob', async (cloudEvent) => {
    const pubSubMessage = cloudEvent.data.message;
    if (!pubSubMessage || !pubSubMessage.data) {
        console.error("Received an empty or invalid Pub/Sub message.");
        return;
    }

    const payloadString = Buffer.from(pubSubMessage.data, 'base64').toString();
    const payload = JSON.parse(payloadString);
    // The frontend now sends an array of segments
    const { jobId, segments } = payload;

    if (!jobId || !segments || !Array.isArray(segments) || segments.length === 0) {
        console.error("Payload is missing 'jobId' or has invalid 'segments'.", payload);
        return;
    }

    console.log(`[${jobId}] Starting processing for ${segments.length} segments.`);

    const tempDir = path.join(os.tmpdir(), jobId);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[${jobId}] Created temporary directory: ${tempDir}`);

    const jobRef = firestore.collection("videoJobs").doc(jobId);

    try {
        await jobRef.update({ status: "Processing", progress: 5, progressMessage: "Starting job..." });

        const downloadedVideos = new Map();
        const clipFilePaths = [];
        const totalSegments = segments.length;

        for (let i = 0; i < totalSegments; i++) {
            const segment = segments[i];
            const { videoId, startTimeSeconds, endTimeSeconds } = segment;
            let originalVideoPath = downloadedVideos.get(videoId);

            const progress = 10 + Math.round((i / totalSegments) * 50); // Progress from 10% to 60%
            await jobRef.update({ progress: progress, progressMessage: `Processing segment ${i + 1}/${totalSegments}...` });

            // --- Download video only if we haven't already for this job ---
            if (!originalVideoPath) {
                console.log(`[${jobId}] Downloading video: ${videoId}`);
                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                originalVideoPath = path.join(tempDir, `${videoId}.mp4`);
                execSync(`yt-dlp -f 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4' -o '${originalVideoPath}' ${videoUrl}`, { stdio: 'inherit' });
                downloadedVideos.set(videoId, originalVideoPath);
                console.log(`[${jobId}] Download complete for ${videoId}.`);
            }

            // --- Clip the segment ---
            console.log(`[${jobId}] Clipping ${videoId} from ${startTimeSeconds}s to ${endTimeSeconds}s.`);
            const clipPath = path.join(tempDir, `clip_${i}.mp4`);
            const duration = endTimeSeconds - startTimeSeconds;
            execSync(`ffmpeg -ss ${startTimeSeconds} -i '${originalVideoPath}' -t ${duration} -c copy '${clipPath}'`, { stdio: 'inherit' });
            clipFilePaths.push(clipPath);
        }

        // --- Concatenate all clips into one video ---
        await jobRef.update({ progress: 70, progressMessage: "Joining clips..." });
        console.log(`[${jobId}] Concatenating ${clipFilePaths.length} clips.`);
        const fileListPath = path.join(tempDir, 'file_list.txt');
        const fileContent = clipFilePaths.map(p => `file '${p}'`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);

        const finalVideoPath = path.join(tempDir, "summary_video.mp4");
        execSync(`ffmpeg -f concat -safe 0 -i '${fileListPath}' -c copy '${finalVideoPath}'`, { stdio: 'inherit' });
        console.log(`[${jobId}] Concatenation complete.`);

        // --- Upload Final Video to GCS ---
        await jobRef.update({ progress: 90, progressMessage: "Uploading final video..." });
        const gcsVideoPath = `job-output/${jobId}/summary_video.mp4`;
        await bucket.upload(finalVideoPath, { destination: gcsVideoPath });
        const [signedVideoUrl] = await bucket.file(gcsVideoPath).getSignedUrl({ action: 'read', expires: '03-09-2491' });
        console.log(`[${jobId}] Final video uploaded to GCS.`);

        // --- Final Firestore Update on Success ---
        await jobRef.update({
            status: "Complete",
            progress: 100,
            progressMessage: "Done",
            videoUrl: signedVideoUrl,
            completedAt: new Date().toISOString(),
        });

        console.log(`[${jobId}] Job successfully completed.`);

    } catch (error) {
        console.error(`[${jobId}] Job failed during processing:`, error);
        await jobRef.update({
            status: "Failed",
            error: error.message || "An unknown error occurred during processing.",
        });
        throw error;
    } finally {
        console.log(`[${jobId}] Cleaning up temporary directory: ${tempDir}`);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});