import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import cors from "cors";
import { GoogleAuth } from "google-auth-library";
import { logger } from "firebase-functions";
import { google } from "googleapis";
import Stripe from "stripe";
import nodemailer from "nodemailer";

initializeApp();
const db = getFirestore('jre-clipper-db');
const auth = getAuth();

// Email configuration
const EMAIL_CONFIG = {
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'vohoanvu96@gmail.com',
        pass: process.env.EMAIL_APP_PASSWORD || 'your-app-password'
    }
};

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'vohoanvu96@gmail.com';

// Create nodemailer transporter
let emailTransporter;
try {
    emailTransporter = nodemailer.createTransporter(EMAIL_CONFIG);
    logger.info("Email transporter initialized successfully");
} catch (error) {
    logger.error("Failed to initialize email transporter:", error);
}

const corsHandler = cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'your-api-key-here';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_your_stripe_secret_key';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_your_webhook_secret';
const DOMAIN = process.env.DOMAIN || 'https://your-domain.com';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1234567890';


logger.info("Configuration status:", {
    hasYouTubeKey: !!process.env.YOUTUBE_API_KEY,
    hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
    hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
    hasPriceId: !!process.env.STRIPE_PRICE_ID,
    domain: DOMAIN
});

let stripe;
try {
    stripe = new Stripe(STRIPE_SECRET_KEY, {
        apiVersion: '2023-10-16',
    });
    logger.info("Stripe initialized successfully");
} catch (error) {
    logger.error("Failed to initialize Stripe:", error);
}

// YouTube Data API v3 client
const youtube = google.youtube({
    version: 'v3',
    auth: YOUTUBE_API_KEY
});

// Rate limiting configuration - Updated for new model
const RATE_LIMITS = {
    free: {
        searches: null, // unlimited searches for free users
        videoGeneration: 0 // no video generation for free users
    },
    pro: {
        searches: null, // unlimited searches for pro users
        videoGeneration: null // unlimited video generation for pro users
    }
};

// Multi-purpose function: handles Vertex AI tokens
// Optimized for cost: minimal memory, short timeout
export const getVertexAiToken = onRequest({
    memory: "256MiB", // Minimum memory for cost optimization
    timeoutSeconds: 30, // Short timeout
    maxInstances: 10, // Limit concurrent instances
    minInstances: 0, // No warm instances to save cost
}, async (req, res) => {
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

// YouTube video metadata function with cost optimization
export const getVideoMetadata = onCall({
    enforceAppCheck: false,
    memory: "512MiB", // Moderate memory for API calls
    timeoutSeconds: 60, // Longer timeout for API calls
    maxInstances: 5, // Lower max instances
    minInstances: 0, // No warm instances
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

// Stripe checkout session creation with cost optimization
export const createCheckoutSession = onCall({
    enforceAppCheck: false,
    memory: "256MiB", // Minimal memory for simple operations
    timeoutSeconds: 30, // Short timeout
    maxInstances: 5, // Lower max instances
    minInstances: 0, // No warm instances
}, async (request) => {
    try {
        logger.info("createCheckoutSession called with data:", request.data);
        
        const { userId, sessionId } = request.data || {};
        
        // Use sessionId as fallback for anonymous users
        const identifier = userId || sessionId;
        
        if (!identifier) {
            logger.error("No identifier provided");
            throw new HttpsError("invalid-argument", "User ID or session ID is required");
        }

        // Check Stripe initialization
        if (!stripe) {
            logger.error("Stripe not initialized");
            throw new HttpsError("failed-precondition", "Payment service not available");
        }

        // Check if user is already a pro subscriber (with Firestore error handling)
        let userData = {};
        try {
            logger.info("Fetching user document for identifier:", identifier);
            userData = await ensureUserDocument(identifier);
            logger.info("User data retrieved:", { plan: userData.plan, hasSubscription: !!userData.stripeSubscriptionStatus });
        } catch (firestoreError) {
            logger.error("Firestore error when checking user status:", firestoreError);
            // Continue with empty userData - we'll still allow checkout attempt
            userData = { plan: 'free' };
        }
        
        if (userData.plan === 'pro' && userData.stripeSubscriptionStatus === 'active') {
            throw new HttpsError("failed-precondition", "User is already a Pro subscriber");
        }

        logger.info("Creating Stripe checkout session with price ID:", STRIPE_PRICE_ID);
        
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [
                {
                    price: STRIPE_PRICE_ID, // Use environment variable
                    quantity: 1,
                },
            ],
            success_url: `${DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${DOMAIN}/pricing.html`,
            client_reference_id: identifier,
            metadata: {
                userId: identifier,
                plan: 'pro'
            },
            // Add customer email if available
            ...(userData.email && { customer_email: userData.email })
        });

        logger.info("Stripe checkout session created successfully:", session.id);
        
        // Store pending subscription info (with error handling)
        try {
            await db.collection('users').doc(identifier).set({
                ...userData,
                pendingSubscription: {
                    sessionId: session.id,
                    createdAt: new Date(),
                    status: 'pending'
                }
            }, { merge: true });
            logger.info("Pending subscription stored in database");
        } catch (firestoreError) {
            logger.error("Failed to store pending subscription, but continuing:", firestoreError);
            // Don't fail the checkout if we can't store pending status
        }
        
        return { sessionId: session.id };
        
    } catch (error) {
        logger.error("Stripe checkout error:", error);
        
        // Provide more specific error messages
        if (error instanceof HttpsError) {
            throw error;
        }
        
        if (error.type === 'StripeInvalidRequestError') {
            throw new HttpsError("invalid-argument", `Stripe configuration error: ${error.message}`);
        }
        
        throw new HttpsError("internal", `Payment service error: ${error.message}`);
    }
});

// Stripe webhook handler with cost optimization and proper plan enforcement
export const handleStripeWebhook = onRequest({
    memory: "256MiB", // Minimal memory
    timeoutSeconds: 30, // Short timeout
    maxInstances: 3, // Very low max instances for webhooks
    minInstances: 0, // No warm instances
}, async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        logger.error(`Webhook signature verification failed: ${err.message}`);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }
    
    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = session.client_reference_id;
                
                if (userId) {
                    // Upgrade user to pro plan
                    await db.collection('users').doc(userId).set({
                        plan: 'pro',
                        stripeCustomerId: session.customer,
                        stripeSubscriptionId: session.subscription,
                        stripeSubscriptionStatus: 'active',
                        upgradedAt: new Date(),
                        pendingSubscription: null // Clear pending status
                    }, { merge: true });
                    
                    logger.info(`User ${userId} upgraded to pro plan via checkout session ${session.id}`);
                }
                break;
            }
            
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                const subscriptionId = invoice.subscription;
                
                // Update subscription status to active
                const usersQuery = await db.collection('users')
                    .where('stripeSubscriptionId', '==', subscriptionId)
                    .limit(1)
                    .get();
                
                if (!usersQuery.empty) {
                    const userDoc = usersQuery.docs[0];
                    await userDoc.ref.update({
                        stripeSubscriptionStatus: 'active',
                        lastPaymentAt: new Date()
                    });
                    logger.info(`Payment succeeded for subscription ${subscriptionId}`);
                }
                break;
            }
            
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const subscriptionId = invoice.subscription;
                
                // Update subscription status to past_due
                const usersQuery = await db.collection('users')
                    .where('stripeSubscriptionId', '==', subscriptionId)
                    .limit(1)
                    .get();
                
                if (!usersQuery.empty) {
                    const userDoc = usersQuery.docs[0];
                    await userDoc.ref.update({
                        stripeSubscriptionStatus: 'past_due',
                        paymentFailedAt: new Date()
                    });
                    logger.warn(`Payment failed for subscription ${subscriptionId}`);
                }
                break;
            }
            
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                
                // Downgrade user to free plan
                const usersQuery = await db.collection('users')
                    .where('stripeSubscriptionId', '==', subscription.id)
                    .limit(1)
                    .get();
                
                if (!usersQuery.empty) {
                    const userDoc = usersQuery.docs[0];
                    await userDoc.ref.update({
                        plan: 'free',
                        stripeSubscriptionStatus: 'canceled',
                        canceledAt: new Date()
                    });
                    logger.info(`User downgraded to free plan after subscription ${subscription.id} was canceled`);
                }
                break;
            }
            
            default:
                logger.info(`Unhandled event type: ${event.type}`);
        }
        
        res.json({ received: true });
        
    } catch (error) {
        logger.error("Error processing webhook:", error);
        res.status(500).json({ error: "Webhook processing failed" });
    }
});

// Function to increment search count with plan validation
export const recordSearch = onCall({
    enforceAppCheck: false,
    memory: "256MiB", // Minimal memory
    timeoutSeconds: 10, // Very short timeout
    maxInstances: 10, // Allow more instances for frequent calls
    minInstances: 0, // No warm instances
}, async (request) => {
    try {
        const { userId, sessionId } = request.data;
        
        // Use sessionId as fallback if no userId (for anonymous users)
        const identifier = userId || sessionId;
        
        if (!identifier) {
            throw new HttpsError("invalid-argument", "User ID or session ID required");
        }
        
        // Update user's last search time for analytics
        const userRef = db.collection('users').doc(identifier);
        
        await userRef.set({
            lastSearchAt: new Date()
        }, { merge: true });
        
        return { success: true };
        
    } catch (error) {
        logger.error("Error recording search:", error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError("internal", "Error recording search");
    }
});

// Add utility function to get user subscription status
export const getUserSubscriptionStatus = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 10,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    try {
        logger.info("getUserSubscriptionStatus called with data:", request.data);
        logger.info("Auth context:", request.auth ? `UID: ${request.auth.uid}` : "No auth");
        
        const { userId, sessionId } = request.data || {};
        
        // Prefer authenticated user UID over provided userId/sessionId
        const identifier = request.auth?.uid || userId || sessionId;
        
        if (!identifier) {
            logger.error("No identifier provided and user not authenticated");
            throw new HttpsError("invalid-argument", "User ID, session ID required, or user must be authenticated");
        }

        logger.info("Using identifier for user lookup:", identifier);
        
        // Try to get user document with proper error handling
        let userData;
        try {
            userData = await ensureUserDocument(identifier);
            logger.info("Successfully fetched/created user document:", { 
                plan: userData.plan, 
                hasSubscription: !!userData.stripeSubscriptionStatus,
                identifier: identifier 
            });
        } catch (firestoreError) {
            logger.error("Firestore error when fetching user document:", firestoreError);
            // Return default values if Firestore is unavailable
            return {
                plan: 'free',
                subscriptionStatus: null,
                subscriptionId: null,
                upgradedAt: null,
                canceledAt: null,
                error: 'Database temporarily unavailable'
            };
        }
        
        return {
            plan: userData.plan || 'free',
            subscriptionStatus: userData.stripeSubscriptionStatus || null,
            subscriptionId: userData.stripeSubscriptionId || null,
            upgradedAt: userData.upgradedAt || null,
            canceledAt: userData.canceledAt || null
        };
        
    } catch (error) {
        logger.error("Error getting subscription status:", error);
        // Return safe defaults instead of throwing
        return {
            plan: 'free',
            subscriptionStatus: null,
            subscriptionId: null,
            upgradedAt: null,
            canceledAt: null,
            error: 'Service temporarily unavailable'
        };
    }
});

// Server-Sent Events endpoint for real-time job status updates
export const streamJobStatus = onRequest({
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 3600, // 1 hour timeout for long-running connections
    memory: '256MiB'
}, async (req, res) => {
    try {
        // Extract jobId from URL path: /streamJobStatus/{jobId}
        const jobId = req.path.split('/').pop();
        
        if (!jobId) {
            res.status(400).json({ error: 'Job ID is required in URL path' });
            return;
        }

        logger.info(`Starting SSE stream for job: ${jobId}`);

        // Set up Server-Sent Events headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });

        // Send initial connection confirmation
        res.write(`data: ${JSON.stringify({ 
            type: 'connected', 
            jobId: jobId, 
            timestamp: new Date().toISOString() 
        })}\n\n`);

        // Get initial job status
        const jobRef = db.collection('videoJobs').doc(jobId);
        
        try {
            logger.info(`Fetching job from Firestore: videoJobs/${jobId}`);
            const initialDoc = await jobRef.get();
            
            if (initialDoc.exists) {
                const jobData = initialDoc.data();
                logger.info(`Found job data for ${jobId}:`, {
                    status: jobData.status,
                    totalVideos: jobData.totalVideos,
                    createdAt: jobData.createdAt?.toDate?.()?.toISOString()
                });
                
                const statusUpdate = {
                    type: 'status',
                    jobId: jobId,
                    status: jobData.status || 'Unknown',
                    progress: jobData.progress,
                    progressMessage: jobData.progressMessage,
                    totalVideos: jobData.totalVideos,
                    totalSegments: jobData.segmentCount,
                    videosAlreadyAvailable: jobData.videosAlreadyAvailable,
                    videosNeedingDownload: jobData.videosNeedingDownload,
                    skipDownload: jobData.skipDownload,
                    finalVideoUrl: jobData.finalVideoUrl,
                    error: jobData.error,
                    suggestions: jobData.suggestions,
                    createdAt: jobData.createdAt?.toDate?.()?.toISOString(),
                    updatedAt: jobData.updatedAt?.toDate?.()?.toISOString(),
                    timestamp: new Date().toISOString()
                };
                
                res.write(`data: ${JSON.stringify(statusUpdate)}\n\n`);
                logger.info(`Sent initial status for job ${jobId}: ${jobData.status}`);
            } else {
                logger.warn(`Job not found in Firestore: ${jobId}`);
                res.write(`data: ${JSON.stringify({ 
                    type: 'error', 
                    jobId: jobId, 
                    error: 'Job not found',
                    timestamp: new Date().toISOString() 
                })}\n\n`);
                res.end();
                return;
            }
        } catch (error) {
            logger.error(`Error fetching initial job status for ${jobId}:`, {
                error: error.message,
                stack: error.stack,
                code: error.code
            });
            res.write(`data: ${JSON.stringify({ 
                type: 'error', 
                jobId: jobId, 
                error: `Failed to fetch job status: ${error.message}`,
                timestamp: new Date().toISOString() 
            })}\n\n`);
        }

        // Set up Firestore real-time listener
        const unsubscribe = jobRef.onSnapshot((doc) => {
            try {
                if (!doc.exists) {
                    res.write(`data: ${JSON.stringify({ 
                        type: 'error', 
                        jobId: jobId, 
                        error: 'Job no longer exists',
                        timestamp: new Date().toISOString() 
                    })}\n\n`);
                    res.end();
                    return;
                }

                const jobData = doc.data();
                const statusUpdate = {
                    type: 'status',
                    jobId: jobId,
                    status: jobData.status || 'Unknown',
                    progress: jobData.progress,
                    progressMessage: jobData.progressMessage,
                    totalVideos: jobData.totalVideos,
                    totalSegments: jobData.segmentCount,
                    videosAlreadyAvailable: jobData.videosAlreadyAvailable,
                    videosNeedingDownload: jobData.videosNeedingDownload,
                    skipDownload: jobData.skipDownload,
                    finalVideoUrl: jobData.finalVideoUrl,
                    error: jobData.error,
                    suggestions: jobData.suggestions,
                    createdAt: jobData.createdAt?.toDate?.()?.toISOString(),
                    updatedAt: jobData.updatedAt?.toDate?.()?.toISOString(),
                    timestamp: new Date().toISOString()
                };

                res.write(`data: ${JSON.stringify(statusUpdate)}\n\n`);
                logger.info(`Streamed status update for job ${jobId}: ${jobData.status}`);

                // Close connection if job is complete or permanently failed
                if (jobData.status === 'Complete' || 
                    (jobData.status && jobData.status.startsWith('Failed') && !jobData.status.includes('Retry'))) {
                    logger.info(`Job ${jobId} finished with status: ${jobData.status}. Closing SSE connection.`);
                    res.write(`data: ${JSON.stringify({ 
                        type: 'complete', 
                        jobId: jobId, 
                        finalStatus: jobData.status,
                        timestamp: new Date().toISOString() 
                    })}\n\n`);
                    res.end();
                }
            } catch (error) {
                logger.error(`Error in Firestore listener for job ${jobId}:`, error);
                res.write(`data: ${JSON.stringify({ 
                    type: 'error', 
                    jobId: jobId, 
                    error: 'Failed to process status update',
                    timestamp: new Date().toISOString() 
                })}\n\n`);
            }
        }, (error) => {
            logger.error(`Firestore listener error for job ${jobId}:`, error);
            res.write(`data: ${JSON.stringify({ 
                type: 'error', 
                jobId: jobId, 
                error: 'Database connection lost',
                timestamp: new Date().toISOString() 
            })}\n\n`);
            res.end();
        });

        // Handle client disconnect
        req.on('close', () => {
            logger.info(`SSE connection closed for job: ${jobId}`);
            unsubscribe();
        });

        req.on('error', (error) => {
            logger.error(`SSE connection error for job ${jobId}:`, error);
            unsubscribe();
        });

        // Keep-alive ping every 30 seconds
        const keepAlive = setInterval(() => {
            try {
                res.write(`data: ${JSON.stringify({ 
                    type: 'ping', 
                    timestamp: new Date().toISOString() 
                })}\n\n`);
            } catch (error) {
                logger.error(`Keep-alive error for job ${jobId}:`, error);
                clearInterval(keepAlive);
                unsubscribe();
            }
        }, 30000);

        // Clean up keep-alive on connection close
        req.on('close', () => {
            clearInterval(keepAlive);
        });

    } catch (error) {
        logger.error('Error in streamJobStatus:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to start status stream' });
        }
    }
});

// Utility function to ensure user document exists with default values
async function ensureUserDocument(identifier) {
    try {
        const userRef = db.collection('users').doc(identifier);
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
            const defaultUserData = {
                plan: 'free',
                createdAt: new Date(),
                usage: {},
                stripeSubscriptionStatus: null,
                stripeSubscriptionId: null,
                stripeCustomerId: null
            };
            
            await userRef.set(defaultUserData);
            logger.info(`Created new user document for identifier: ${identifier}`);
            return defaultUserData;
        }
        
        return userDoc.data();
    } catch (error) {
        logger.error("Error ensuring user document:", error);
        // Return safe defaults if database is unavailable
        return {
            plan: 'free',
            createdAt: new Date(),
            usage: {}
        };
    }
}

// Check video generation permission - requires authentication for premium features
export const checkVideoGenerationPermission = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 10,
    maxInstances: 10,
    minInstances: 0,
}, async (request) => {
    try {
        // Check if user is authenticated
        if (!request.auth) {
            return {
                allowed: false,
                requiresAuth: true,
                message: 'Sign in to access premium video generation features',
                signInUrl: '/signin.html',
                hasManualOption: true
            };
        }

        const userId = request.auth.uid;
        const userEmail = request.auth.token.email;

        // Get user's current plan and subscription status
        const userData = await ensureUserDocument(userId);
        const userPlan = userData.plan || 'free';
        const subscriptionStatus = userData.stripeSubscriptionStatus;

        // Check if pro user has valid subscription
        if (userPlan === 'pro' && subscriptionStatus === 'active') {
            return {
                allowed: true,
                plan: userPlan,
                message: 'Premium video generation available',
                subscriptionStatus: 'active',
                userEmail: userEmail
            };
        }

        // Authenticated but free user - offer upgrade
        return {
            allowed: false,
            plan: 'free',
            message: 'Upgrade to Pro for instant video generation',
            subscriptionStatus: subscriptionStatus || null,
            upgradeUrl: '/pricing.html',
            requiresUpgrade: true,
            userEmail: userEmail,
            hasManualOption: true
        };

    } catch (error) {
        logger.error("Error checking video generation permission:", error);
        throw new HttpsError("internal", "Error checking video generation permission");
    }
});

// Manual video generation request for non-premium users
export const requestManualVideoGeneration = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    try {
        const { userEmail, segments, searchQuery, sessionId, userName } = request.data;

        if (!userEmail || !segments || segments.length === 0) {
            throw new HttpsError("invalid-argument", "Email and segments are required");
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(userEmail)) {
            throw new HttpsError("invalid-argument", "Invalid email format");
        }

        // Limit segments to prevent abuse
        if (segments.length > 50) {
            throw new HttpsError("invalid-argument", "Too many segments. Maximum 50 segments allowed for manual requests.");
        }

        // Generate unique request ID
        const requestId = `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store the request in Firestore
        const requestData = {
            userEmail,
            userName: userName || 'Anonymous',
            segments,
            searchQuery: searchQuery || '',
            sessionId: sessionId || null,
            requestedAt: new Date(),
            status: 'pending',
            requestId: requestId,
            segmentCount: segments.length
        };

        await db.collection('manualVideoRequests').add(requestData);
        logger.info(`Manual video request created: ${requestId}`);

        // Send email notification to admin
        if (emailTransporter) {
            try {
                const emailContent = {
                    from: EMAIL_CONFIG.auth.user,
                    to: ADMIN_EMAIL,
                    subject: `🎬 New Manual Video Generation Request - JRE Clipper`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2 style="color: #ff6b35;">🎬 New Manual Video Generation Request</h2>
                            
                            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                                <h3>Request Details</h3>
                                <p><strong>Request ID:</strong> ${requestId}</p>
                                <p><strong>User Email:</strong> ${userEmail}</p>
                                <p><strong>User Name:</strong> ${userName || 'Not provided'}</p>
                                <p><strong>Search Query:</strong> ${searchQuery || 'Not provided'}</p>
                                <p><strong>Number of Segments:</strong> ${segments.length}</p>
                                <p><strong>Session ID:</strong> ${sessionId || 'Not provided'}</p>
                                <p><strong>Requested At:</strong> ${new Date().toLocaleString()}</p>
                            </div>

                            <div style="background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 8px;">
                                <h3>Selected Segments</h3>
                                <div style="max-height: 400px; overflow-y: auto;">
                                    ${segments.map((segment, index) => `
                                        <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
                                            <p><strong>Segment ${index + 1}:</strong></p>
                                            <p><strong>Video ID:</strong> ${segment.videoId}</p>
                                            <p><strong>Time Range:</strong> ${segment.startTime}s - ${segment.endTime}s</p>
                                            <p><strong>Content:</strong> ${(segment.text || 'No text available').substring(0, 200)}${segment.text && segment.text.length > 200 ? '...' : ''}</p>
                                            <p><strong>YouTube URL:</strong> <a href="https://www.youtube.com/watch?v=${segment.videoId}&t=${segment.startTime}s">Watch Segment</a></p>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>

                            <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <h4>Next Steps:</h4>
                                <ol>
                                    <li>Download the video segments</li>
                                    <li>Edit the compilation video</li>
                                    <li>Reply to ${userEmail} with the final video</li>
                                    <li>Update request status in Firebase</li>
                                </ol>
                            </div>
                        </div>
                    `
                };

                await emailTransporter.sendMail(emailContent);
                logger.info(`Manual video request email sent for request ${requestId}`);
            } catch (emailError) {
                logger.error(`Failed to send email for request ${requestId}:`, emailError);
                // Don't fail the request if email fails
            }
        }

        return {
            success: true,
            requestId: requestId,
            message: 'Your video compilation request has been submitted! We will manually create your video and email it to you within 24-48 hours.',
            estimatedDelivery: '24-48 hours'
        };

    } catch (error) {
        logger.error("Error processing manual video request:", error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError("internal", "Error processing video request");
    }
});

// Updated Stripe checkout - requires authentication
export const createCheckoutSessionAuth = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    try {
        // Require authentication for Stripe operations
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Please sign in to subscribe to premium features");
        }

        const userId = request.auth.uid;
        const userEmail = request.auth.token.email;

        logger.info("createCheckoutSessionAuth called for user:", userId);

        // Check Stripe initialization
        if (!stripe) {
            logger.error("Stripe not initialized");
            throw new HttpsError("failed-precondition", "Payment service not available");
        }

        // Check if user is already a pro subscriber
        let userData = {};
        try {
            userData = await ensureUserDocument(userId);
            logger.info("User data retrieved:", { plan: userData.plan, hasSubscription: !!userData.stripeSubscriptionStatus });
        } catch (firestoreError) {
            logger.error("Firestore error when checking user status:", firestoreError);
            userData = { plan: 'free' };
        }

        if (userData.plan === 'pro' && userData.stripeSubscriptionStatus === 'active') {
            throw new HttpsError("failed-precondition", "You are already a Pro subscriber");
        }

        logger.info("Creating Stripe checkout session with price ID:", STRIPE_PRICE_ID);

        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [
                {
                    price: STRIPE_PRICE_ID,
                    quantity: 1,
                },
            ],
            success_url: `${DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${DOMAIN}/pricing.html`,
            client_reference_id: userId,
            metadata: {
                userId: userId,
                plan: 'pro'
            },
            customer_email: userEmail
        });

        logger.info("Stripe checkout session created successfully:", session.id);

        // Store pending subscription info
        try {
            await db.collection('users').doc(userId).set({
                ...userData,
                email: userEmail,
                pendingSubscription: {
                    sessionId: session.id,
                    createdAt: new Date(),
                    status: 'pending'
                }
            }, { merge: true });
            logger.info("Pending subscription stored in database");
        } catch (firestoreError) {
            logger.error("Failed to store pending subscription, but continuing:", firestoreError);
        }

        return { sessionId: session.id };

    } catch (error) {
        logger.error("Stripe checkout error:", error);

        if (error instanceof HttpsError) {
            throw error;
        }

        if (error.type === 'StripeInvalidRequestError') {
            throw new HttpsError("invalid-argument", `Stripe configuration error: ${error.message}`);
        }

        throw new HttpsError("internal", `Payment service error: ${error.message}`);
    }
});