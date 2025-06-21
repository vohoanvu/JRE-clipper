import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import cors from "cors";
import { GoogleAuth } from "google-auth-library";
import { logger } from "firebase-functions";
import { google } from "googleapis";

initializeApp();

// Initialize CORS with proper configuration
const corsHandler = cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
});

// YouTube Data API v3 client with API key
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'your-api-key-here';
const youtube = google.youtube({
    version: 'v3',
    auth: YOUTUBE_API_KEY
});

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

export const getVideoMetadata = onCall({
    enforceAppCheck: false,
}, async (request) => {
    logger.info("Received video metadata request");
    
    if (!request.data) {
        throw new HttpsError("invalid-argument", "No data received in the request.");
    }

    const { segments } = request.data;
    
    if (!segments || !Array.isArray(segments) || segments.length === 0) {
        throw new HttpsError("invalid-argument", "Segments array is required.");
    }

    try {
        // Extract unique video IDs
        const videoIds = [...new Set(segments.map(segment => segment.videoId))];
        logger.info(`Fetching YouTube metadata for ${videoIds.length} videos`);

        // Fetch video details using API key authentication
        const response = await youtube.videos.list({
            part: ['snippet', 'contentDetails', 'statistics'],
            id: videoIds.join(','),
            maxResults: 50
        });

        const videoDetails = response.data.items || [];
        logger.info(`Successfully fetched metadata for ${videoDetails.length} videos`);

        // Process and return data
        const videoMetadataMap = {};
        videoDetails.forEach(video => {
            videoMetadataMap[video.id] = {
                id: video.id,
                title: video.snippet.title,
                description: video.snippet.description,
                publishedAt: video.snippet.publishedAt,
                channelTitle: video.snippet.channelTitle,
                duration: video.contentDetails.duration,
                viewCount: video.statistics.viewCount,
                likeCount: video.statistics.likeCount,
                thumbnails: video.snippet.thumbnails
            };
        });

        // Group segments by video
        const videoGroups = {};
        segments.forEach(segment => {
            const videoId = segment.videoId;
            if (!videoGroups[videoId]) {
                videoGroups[videoId] = {
                    metadata: videoMetadataMap[videoId] || null,
                    segments: []
                };
            }
            videoGroups[videoId].segments.push(segment);
        });

        return {
            success: true,
            videoGroups: videoGroups,
            totalVideos: videoIds.length,
            totalSegments: segments.length
        };

    } catch (error) {
        logger.error(`YouTube API error:`, error);
        throw new HttpsError("internal", `YouTube API error: ${error.message}`);
    }
});