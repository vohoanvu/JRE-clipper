import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { PubSub } from "@google-cloud/pubsub";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import cors from "cors";
import { GoogleAuth } from "google-auth-library";
import { logger } from "firebase-functions";
import { randomUUID } from "crypto";

initializeApp();

// Initialize CORS with proper configuration
const corsHandler = cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
});

const pubSubClient = new PubSub();
const firestore = getFirestore('jre-clipper-db');

// Multi-purpose function: handles both Vertex AI tokens AND job status requests
export const getVertexAiToken = onRequest(async (req, res) => {
    corsHandler(req, res, async () => {
        try {
            // Check if this is a job status request
            if (req.body && req.body.jobId) {
                logger.info("Processing job status request");

                const { jobId } = req.body;
                const jobDoc = await firestore.collection("videoJobs").doc(jobId).get();

                if (!jobDoc.exists) {
                    return res.status(404).json({ error: "Job not found" });
                }

                const jobData = jobDoc.data();
                logger.info(`Job status retrieved for ${jobId}: ${jobData.status}`);
                return res.status(200).json({ jobData });
            }

            // Otherwise, handle Vertex AI token request
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
            logger.error("Error in getVertexAiToken function:", {
                message: error.message,
                stack: error.stack,
                code: error.code
            });
            res.status(500).json({
                error: "Could not process request",
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