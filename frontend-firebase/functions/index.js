const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { PubSub } = require("@google-cloud/pubsub");
const { Firestore } = require("@google-cloud/firestore");
const cors = require("cors")({ origin: true });
const { GoogleAuth } = require("google-auth-library");
const { logger } = require("firebase-functions");

// Initialize Google Cloud clients once for reuse
const pubSubClient = new PubSub();
const firestore = new Firestore();


// This function will be used to get a token for the Vertex AI Search widget
exports.getVertexAiToken = onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const auth = new GoogleAuth({
                scopes: "https://www.googleapis.com/auth/cloud-platform",
            });
            const client = await auth.getClient();
            const accessToken = await client.getAccessToken();
            res.status(200).send({ accessToken: accessToken.token });
        } catch (error) {
            logger.error("Error getting access token:", error);
            res.status(500).send({ error: "Could not generate access token." });
        }
    });
});


// --- NEW FUNCTION 1: Job Initiation (Callable Function) ---
// This is called directly from your frontend app to start a job.
exports.initiateVideoJob = onCall({
    // Enforce that the user must be logged in to call this function.
    // Change to `false` for unauthenticated access if needed.
    enforceAppCheck: false, // Use App Check for security instead of auth
}, async (request) => {
    logger.info("Received video job request:", request.data);

    // Validate incoming data
    const { videoId, startTimeSeconds, endTimeSeconds, videoTitle, segmentText } = request.data;
    if (!videoId || startTimeSeconds == null || endTimeSeconds == null) {
        throw new HttpsError(
            "invalid-argument",
            "The function must be called with videoId, startTimeSeconds, and endTimeSeconds."
        );
    }

    const jobId = require("crypto").randomUUID();
    const topicId = "jre-video-processing-jobs"; // Your Pub/Sub topic name

    const payload = {
        jobId,
        segmentData: {
            videoId,
            startTimeSeconds,
            endTimeSeconds,
            videoTitle,
            segmentText,
        },
    };

    try {
        // Create a Firestore document to track the job status immediately
        await firestore.collection("videoJobs").doc(jobId).set({
            status: "Queued",
            createdAt: new Date().toISOString(),
            jobId: jobId,
            videoTitle: videoTitle || "Untitled",
        });
        logger.info(`Job ${jobId} status set to Queued in Firestore.`);

        // Publish the job payload to the Pub/Sub topic
        await pubSubClient.topic(topicId).publishMessage({ json: payload });
        logger.info(`Job ${jobId} published to Pub/Sub topic ${topicId}.`);

        // Return the Job ID to the client so it can track the status
        return { jobId: jobId };

    } catch (error) {
        logger.error(`Failed to initiate job for Video ID ${videoId}:`, error);
        // Update Firestore to reflect the failure
        await firestore.collection("videoJobs").doc(jobId).set({
            status: "Failed",
            error: "Failed to publish job to processing queue.",
        });
        throw new HttpsError(
            "internal",
            "An error occurred while queueing the job."
        );
    }
});