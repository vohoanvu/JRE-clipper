import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { PubSub } from "@google-cloud/pubsub";
import { Firestore } from "@google-cloud/firestore";
import cors from "cors";
import { GoogleAuth } from "google-auth-library";
import { logger } from "firebase-functions";
import { randomUUID } from "crypto";

// Initialize CORS with proper configuration
const corsHandler = cors({ 
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
});

// Initialize Google Cloud clients once for reuse
const pubSubClient = new PubSub();
const firestore = new Firestore();

// This function will be used to get a token for the Vertex AI Search widget
export const getVertexAiToken = onRequest(async (req, res) => {
    // Handle CORS first
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
    // Enforce that the user must be logged in to call this function.
    // Change to `false` for unauthenticated access if needed.
    enforceAppCheck: false, // Use App Check for security instead of auth
}, async (request) => {
    logger.info("Received video job request:", request.data);

    // Validate incoming data - expect segments array
    const { segments } = request.data;
    if (!segments || !Array.isArray(segments) || segments.length === 0) {
        throw new HttpsError(
            "invalid-argument",
            "The function must be called with a segments array containing videoId, startTimeSeconds, and endTimeSeconds."
        );
    }

    const jobId = randomUUID();
    const topicId = "jre-video-processing-jobs"; //Pub/Sub topic name

    const payload = {
        jobId,
        segments: segments, // Pass all segments
    };

    try {
        // Create a Firestore document to track the job status immediately
        await firestore.collection("videoJobs").doc(jobId).set({
            status: "Queued",
            createdAt: new Date().toISOString(),
            jobId: jobId,
            videoTitle: segments[0]?.videoTitle || "Untitled",
            segmentCount: segments.length,
        });
        logger.info(`Job ${jobId} status set to Queued in Firestore with ${segments.length} segments.`);

        // Publish the job payload to the Pub/Sub topic
        await pubSubClient.topic(topicId).publishMessage({ json: payload });
        logger.info(`Job ${jobId} published to Pub/Sub topic ${topicId}.`);

        // Return the Job ID to the client so it can track the status
        return { jobId: jobId };

    } catch (error) {
        logger.error(`Failed to initiate job:`, error);
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