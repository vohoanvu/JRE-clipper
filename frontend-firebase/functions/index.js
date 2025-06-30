import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import cors from "cors";
import { GoogleAuth } from "google-auth-library";
import { logger } from "firebase-functions";
import { google } from "googleapis";
import Stripe from "stripe";
import { Resend } from "resend";

initializeApp();
const db = getFirestore('jre-clipper-db');
const auth = getAuth();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'vohoanvu96@gmail.com';

// Initialize Resend email service (free tier: 3,000 emails/month)
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
let resend = null;

if (RESEND_API_KEY) {
    resend = new Resend(RESEND_API_KEY);
    logger.info("Resend email service initialized");
} else {
    logger.warn("Resend API key not found - emails will be logged only");
}

// Simple email function using Resend (free email service)
async function sendEmailNotification(to, subject, htmlContent) {
    try {
        // Always log the email for debugging
        logger.info("📧 EMAIL NOTIFICATION:", {
            to: to,
            subject: subject,
            timestamp: new Date().toISOString()
        });

        // Store in Firestore for backup/manual processing
        await db.collection('emailNotifications').add({
            to: to,
            subject: subject,
            html: htmlContent,
            status: 'pending',
            createdAt: new Date()
        });

        // Send via Resend if API key is configured
        if (resend) {
            try {
                const emailResult = await resend.emails.send({
                    from: 'JRE Clipper <onboarding@resend.dev>', // Default Resend sender
                    to: [to],
                    subject: subject,
                    html: htmlContent,
                });

                logger.info("✅ Email sent successfully via Resend:", emailResult.data?.id);
                
                // Update Firestore record with success status
                await db.collection('emailNotifications').where('to', '==', to).where('subject', '==', subject).limit(1).get().then(snapshot => {
                    if (!snapshot.empty) {
                        snapshot.docs[0].ref.update({ status: 'sent', sentAt: new Date(), emailId: emailResult.data?.id });
                    }
                });

                return { success: true, emailId: emailResult.data?.id };
                
            } catch (resendError) {
                logger.error("❌ Resend email error:", resendError);
                
                // Update Firestore with error status
                await db.collection('emailNotifications').where('to', '==', to).where('subject', '==', subject).limit(1).get().then(snapshot => {
                    if (!snapshot.empty) {
                        snapshot.docs[0].ref.update({ status: 'failed', error: resendError.message, failedAt: new Date() });
                    }
                });

                return { success: false, error: resendError.message };
            }
        } else {
            logger.info("📋 Email logged to Firestore (no Resend API key configured)");
            return { success: true, note: "Email logged to Firestore - configure RESEND_API_KEY to send actual emails" };
        }
        
    } catch (error) {
        logger.error("Error in email notification system:", error);
        return { success: false, error: error.message };
    }
}

const corsHandler = cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'your-api-key-here';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_your_stripe_secret_key';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_your_webhook_secret';
const DOMAIN = process.env.DOMAIN || 'https://whatwouldjoerogansay.com';
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
                
                if (!userId) {
                    logger.error(`Checkout session ${session.id} completed but no user ID found in client_reference_id`);
                    break;
                }
                
                // Validate that the userId corresponds to a Firebase Auth user
                try {
                    const userRecord = await auth.getUser(userId);
                    logger.info(`Validated Firebase Auth user for payment: ${userRecord.email || userRecord.uid}`);
                } catch (authError) {
                    logger.error(`Payment completed for invalid Firebase Auth user: ${userId}`, authError);
                    // Still process the payment but log the error for investigation
                }
                
                // Upgrade user to pro plan in subscriptions collection
                await db.collection('subscriptions').doc(userId).set({
                    plan: 'pro',
                    stripeCustomerId: session.customer,
                    stripeSubscriptionId: session.subscription,
                    stripeSubscriptionStatus: 'active',
                    upgradedAt: new Date(),
                    pendingSubscription: null, // Clear pending status
                    // Add payment audit trail
                    paymentHistory: FieldValue.arrayUnion({
                        type: 'subscription_created',
                        sessionId: session.id,
                        customerId: session.customer,
                        subscriptionId: session.subscription,
                        amount: session.amount_total,
                        currency: session.currency,
                        timestamp: new Date()
                    })
                }, { merge: true });
                
                // Update Firebase Auth custom claims for fast access
                await auth.setCustomUserClaims(userId, {
                    plan: 'pro',
                    subscriptionStatus: 'active',
                    subscriptionId: session.subscription,
                    upgradedAt: new Date().toISOString()
                });
                
                logger.info(`User ${userId} upgraded to pro plan via checkout session ${session.id}`);
                break;
            }
            
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                const subscriptionId = invoice.subscription;
                
                // Update subscription status to active in subscriptions collection
                const subscriptionsQuery = await db.collection('subscriptions')
                    .where('stripeSubscriptionId', '==', subscriptionId)
                    .limit(1)
                    .get();
                
                if (!subscriptionsQuery.empty) {
                    const subscriptionDoc = subscriptionsQuery.docs[0];
                    const userId = subscriptionDoc.id;
                    
                    // Validate Firebase Auth user
                    try {
                        await auth.getUser(userId);
                        logger.info(`Validated Firebase Auth user for payment success: ${userId}`);
                    } catch (authError) {
                        logger.error(`Payment succeeded for invalid Firebase Auth user: ${userId}`, authError);
                    }
                    
                    await subscriptionDoc.ref.update({
                        stripeSubscriptionStatus: 'active',
                        lastPaymentAt: new Date(),
                        // Add payment audit trail
                        paymentHistory: FieldValue.arrayUnion({
                            type: 'payment_succeeded',
                            invoiceId: invoice.id,
                            subscriptionId: subscriptionId,
                            amount: invoice.amount_paid,
                            currency: invoice.currency,
                            timestamp: new Date()
                        })
                    });
                    
                    // Update Firebase Auth custom claims
                    await auth.setCustomUserClaims(userId, {
                        plan: 'pro',
                        subscriptionStatus: 'active',
                        subscriptionId: subscriptionId,
                        lastPaymentAt: new Date().toISOString()
                    });
                    
                    logger.info(`Payment succeeded for subscription ${subscriptionId}`);
                } else {
                    logger.error(`No subscription found for subscription ${subscriptionId} payment success`);
                }
                break;
            }
            
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const subscriptionId = invoice.subscription;
                
                // Update subscription status to past_due in subscriptions collection
                const subscriptionsQuery = await db.collection('subscriptions')
                    .where('stripeSubscriptionId', '==', subscriptionId)
                    .limit(1)
                    .get();
                
                if (!subscriptionsQuery.empty) {
                    const subscriptionDoc = subscriptionsQuery.docs[0];
                    const userId = subscriptionDoc.id;
                    
                    // Validate Firebase Auth user
                    try {
                        await auth.getUser(userId);
                        logger.info(`Validated Firebase Auth user for payment failure: ${userId}`);
                    } catch (authError) {
                        logger.error(`Payment failed for invalid Firebase Auth user: ${userId}`, authError);
                    }
                    
                    await subscriptionDoc.ref.update({
                        stripeSubscriptionStatus: 'past_due',
                        paymentFailedAt: new Date(),
                        // Add payment audit trail
                        paymentHistory: FieldValue.arrayUnion({
                            type: 'payment_failed',
                            invoiceId: invoice.id,
                            subscriptionId: subscriptionId,
                            amount: invoice.amount_due,
                            currency: invoice.currency,
                            timestamp: new Date(),
                            error: invoice.last_finalization_error?.message || 'Unknown payment error'
                        })
                    });
                    
                    // Update Firebase Auth custom claims
                    await auth.setCustomUserClaims(userId, {
                        plan: 'free', // Downgrade to free on payment failure
                        subscriptionStatus: 'past_due',
                        subscriptionId: subscriptionId,
                        paymentFailedAt: new Date().toISOString()
                    });
                    
                    logger.warn(`Payment failed for subscription ${subscriptionId}`);
                } else {
                    logger.error(`No subscription found for subscription ${subscriptionId} payment failure`);
                }
                break;
            }
            
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                
                // Downgrade user to free plan in subscriptions collection
                const subscriptionsQuery = await db.collection('subscriptions')
                    .where('stripeSubscriptionId', '==', subscription.id)
                    .limit(1)
                    .get();
                
                if (!subscriptionsQuery.empty) {
                    const subscriptionDoc = subscriptionsQuery.docs[0];
                    const userId = subscriptionDoc.id;
                    
                    // Validate Firebase Auth user
                    try {
                        await auth.getUser(userId);
                        logger.info(`Validated Firebase Auth user for subscription cancellation: ${userId}`);
                    } catch (authError) {
                        logger.error(`Subscription canceled for invalid Firebase Auth user: ${userId}`, authError);
                    }
                    
                    await subscriptionDoc.ref.update({
                        plan: 'free',
                        stripeSubscriptionStatus: 'canceled',
                        canceledAt: new Date(),
                        // Add payment audit trail
                        paymentHistory: FieldValue.arrayUnion({
                            type: 'subscription_canceled',
                            subscriptionId: subscription.id,
                            canceledAt: new Date(subscription.canceled_at * 1000),
                            cancelReason: subscription.cancellation_details?.reason || 'Unknown',
                            timestamp: new Date()
                        })
                    });
                    
                    // Update Firebase Auth custom claims
                    await auth.setCustomUserClaims(userId, {
                        plan: 'free',
                        subscriptionStatus: 'canceled',
                        subscriptionId: null,
                        canceledAt: new Date().toISOString()
                    });
                    
                    logger.info(`User downgraded to free plan after subscription ${subscription.id} was canceled`);
                } else {
                    logger.error(`No subscription found for canceled subscription ${subscription.id}`);
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

// Get user subscription status using Firebase Auth and subscriptions collection
export const getUserSubscriptionStatus = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 10,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    try {
        logger.info("getUserSubscriptionStatus called");
        logger.info("Auth context:", request.auth ? `UID: ${request.auth.uid}` : "No auth");
        
        // If no authentication, return default free plan
        if (!request.auth) {
            logger.info("No authentication - returning default free plan");
            return {
                plan: 'free',
                subscriptionStatus: null,
                subscriptionId: null,
                upgradedAt: null,
                canceledAt: null
            };
        }

        const userId = request.auth.uid;
        logger.info("Getting subscription status for authenticated user:", userId);
        
        try {
            // Get user's custom claims from Firebase Auth
            const userRecord = await auth.getUser(userId);
            const customClaims = userRecord.customClaims || {};
            
            // If user has subscription info in custom claims, use it for quick response
            if (customClaims.plan && customClaims.subscriptionStatus) {
                logger.info("Using cached subscription data from custom claims");
                return {
                    plan: customClaims.plan,
                    subscriptionStatus: customClaims.subscriptionStatus,
                    subscriptionId: customClaims.subscriptionId || null,
                    upgradedAt: customClaims.upgradedAt || null,
                    canceledAt: customClaims.canceledAt || null
                };
            }
            
            // Check subscriptions collection for detailed info
            const subscriptionRef = db.collection('subscriptions').doc(userId);
            const subscriptionDoc = await subscriptionRef.get();
            
            if (subscriptionDoc.exists) {
                const subscriptionData = subscriptionDoc.data();
                logger.info("Found subscription data:", { 
                    plan: subscriptionData.plan,
                    status: subscriptionData.stripeSubscriptionStatus
                });
                
                // Update custom claims for faster future lookups
                await auth.setCustomUserClaims(userId, {
                    plan: subscriptionData.plan || 'free',
                    subscriptionStatus: subscriptionData.stripeSubscriptionStatus || null,
                    subscriptionId: subscriptionData.stripeSubscriptionId || null,
                    upgradedAt: subscriptionData.upgradedAt?.toDate?.()?.toISOString() || null,
                    canceledAt: subscriptionData.canceledAt?.toDate?.()?.toISOString() || null
                });
                
                return {
                    plan: subscriptionData.plan || 'free',
                    subscriptionStatus: subscriptionData.stripeSubscriptionStatus || null,
                    subscriptionId: subscriptionData.stripeSubscriptionId || null,
                    upgradedAt: subscriptionData.upgradedAt || null,
                    canceledAt: subscriptionData.canceledAt || null
                };
            }
            
            // No subscription found - user is free plan
            logger.info("No subscription found - user is free plan");
            return {
                plan: 'free',
                subscriptionStatus: null,
                subscriptionId: null,
                upgradedAt: null,
                canceledAt: null
            };
            
        } catch (authError) {
            logger.error("Firebase Auth error:", authError);
            // Return default values if Auth is unavailable
            return {
                plan: 'free',
                subscriptionStatus: null,
                subscriptionId: null,
                upgradedAt: null,
                canceledAt: null,
                error: 'Authentication service temporarily unavailable'
            };
        }
        
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

        // Get user's subscription status from Firebase Auth custom claims first
        const userRecord = await auth.getUser(userId);
        const customClaims = userRecord.customClaims || {};
        let userPlan = customClaims.plan || 'free';
        let subscriptionStatus = customClaims.subscriptionStatus || null;

        // If no custom claims, check subscriptions collection
        if (!customClaims.plan) {
            try {
                const subscriptionRef = db.collection('subscriptions').doc(userId);
                const subscriptionDoc = await subscriptionRef.get();
                
                if (subscriptionDoc.exists) {
                    const subscriptionData = subscriptionDoc.data();
                    userPlan = subscriptionData.plan || 'free';
                    subscriptionStatus = subscriptionData.stripeSubscriptionStatus || null;
                    
                    // Update custom claims for faster future access
                    await auth.setCustomUserClaims(userId, {
                        plan: userPlan,
                        subscriptionStatus: subscriptionStatus,
                        subscriptionId: subscriptionData.stripeSubscriptionId || null
                    });
                }
            } catch (error) {
                logger.error("Error fetching subscription data:", error);
                // Continue with default free plan
            }
        }

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

        // Send email notification to admin (no password required!)
        try {
            const emailHtml = `
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
            `;

            await sendEmailNotification(
                ADMIN_EMAIL,
                `🎬 New Manual Video Generation Request - JRE Clipper`,
                emailHtml
            );
            
            logger.info(`Manual video request notification sent for request ${requestId}`);
        } catch (emailError) {
            logger.error(`Failed to send notification for request ${requestId}:`, emailError);
            // Don't fail the request if email fails
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

// Stripe checkout - requires authentication
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

        // Check if user is already a pro subscriber using Firebase Auth custom claims
        const userRecord = await auth.getUser(userId);
        const customClaims = userRecord.customClaims || {};
        let userPlan = customClaims.plan || 'free';
        let subscriptionStatus = customClaims.subscriptionStatus || null;

        // If no custom claims, check subscriptions collection
        if (!customClaims.plan) {
            try {
                const subscriptionRef = db.collection('subscriptions').doc(userId);
                const subscriptionDoc = await subscriptionRef.get();
                
                if (subscriptionDoc.exists) {
                    const subscriptionData = subscriptionDoc.data();
                    userPlan = subscriptionData.plan || 'free';
                    subscriptionStatus = subscriptionData.stripeSubscriptionStatus || null;
                }
                
                logger.info("User subscription data retrieved:", { plan: userPlan, hasSubscription: !!subscriptionStatus });
            } catch (firestoreError) {
                logger.error("Firestore error when checking user status:", firestoreError);
                userPlan = 'free';
                subscriptionStatus = null;
            }
        }

        if (userPlan === 'pro' && subscriptionStatus === 'active') {
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

        // Store pending subscription info in subscriptions collection
        try {
            await db.collection('subscriptions').doc(userId).set({
                plan: 'free', // Current plan
                email: userEmail,
                pendingSubscription: {
                    sessionId: session.id,
                    createdAt: new Date(),
                    status: 'pending'
                }
            }, { merge: true });
            logger.info("Pending subscription stored in subscriptions collection");
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