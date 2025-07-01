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
        const emailDoc = await db.collection('emailNotifications').add({
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

                // Check if emailResult and emailResult.data exists before accessing id
                const emailId = emailResult?.data?.id || null;
                logger.info(`✅ Email sent successfully via Resend: ${emailId || 'No ID returned'}`);
                
                // Update Firestore record with success status
                // Only include emailId if it's not undefined or null
                const updateData = { 
                    status: 'sent', 
                    sentAt: new Date()
                };
                
                if (emailId) {
                    updateData.emailId = emailId;
                }
                
                // Use the direct reference instead of querying again
                await emailDoc.update(updateData);
                return { success: true, emailId: emailId };
            } catch (resendError) {
                logger.error("❌ Resend email error:", resendError);
                
                // Update Firestore with error status
                await emailDoc.update({ 
                    status: 'failed', 
                    error: resendError.message, 
                    failedAt: new Date() 
                });

                return { success: false, error: resendError.message };
            }
        } else {
            logger.info("📋 Email logged to Firestore (no Resend API key configured)");
            
            // Update status to indicate it was only logged
            await emailDoc.update({ status: 'logged_only' });
            
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

export const handleStripeWebhook = onRequest({
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 3,
    minInstances: 0,
    cors: false,
    invoker: 'public'
}, async (req, res) => {
    // Set CORS headers manually since we disabled automatic CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, stripe-signature');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        const rawBody = req.rawBody;
        
        if (!rawBody) {
            throw new Error('Request body is empty or not available as raw buffer');
        }
        
        event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
        logger.info(`Webhook signature verified successfully for event: ${event.type}`);
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

                //VALIDATION: Ensure required Stripe data exists
                if (!session.customer || !session.subscription) {
                    logger.error(`Checkout session ${session.id} missing required data - customer: ${session.customer}, subscription: ${session.subscription}`);
                    break;
                }
                
                // Validate that the userId corresponds to a Firebase Auth user
                try {
                    const userRecord = await auth.getUser(userId);
                    logger.info(`Validated Firebase Auth user for payment: ${userRecord.email || userRecord.uid}`);
                } catch (authError) {
                    logger.error(`Payment completed for invalid Firebase Auth user: ${userId}`, authError);
                    //Still process the payment but log the error for later investigation
                }
                
                const subscriptionData = {
                    plan: 'pro',
                    email: session.customer_details?.email || session.metadata?.email || 'unknown@email.com',
                    stripeCustomerId: session.customer,
                    stripeSubscriptionId: session.subscription,
                    stripeSubscriptionStatus: 'active',
                    upgradedAt: new Date(),
                    createdAt: new Date(),
                    lastUpdated: new Date(),
                    pendingSubscription: null,
                    paymentHistory: FieldValue.arrayUnion({
                        type: 'subscription_created',
                        sessionId: session.id,
                        customerId: session.customer,
                        subscriptionId: session.subscription,
                        // Stripe amount_total is in cents for USD, so convert to dollars
                        amount: session.amount_total ? session.amount_total / 100 : null,
                        currency: session.currency,
                        timestamp: new Date()
                    })
                };

                //ATOMIC UPDATE: Use set with merge to ensure consistency
                await db.collection('subscriptions').doc(userId).set(subscriptionData, { merge: true });
                
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
                const subscriptionId = invoice.parent?.subscription_details?.subscription;
                if (!subscriptionId) {
                    logger.info(`Invoice ${invoice.id} payment succeeded but no subscription ID - likely a one-time payment, skipping`);
                    break;
                }
                logger.info(`Processing payment success for subscription: ${subscriptionId}`);
                const subscriptionsQuery = await db.collection('subscriptions')
                    .where('stripeSubscriptionId', '==', subscriptionId)
                    .limit(1)
                    .get();
                if (!subscriptionsQuery.empty) {
                    const subscriptionDoc = subscriptionsQuery.docs[0];
                    const userId = subscriptionDoc.id;
                    const currentData = subscriptionDoc.data();
                    
                    if (currentData.stripeSubscriptionId !== subscriptionId) {
                        logger.error(`Subscription ID mismatch! Incoming: ${subscriptionId}, Stored: ${currentData.stripeSubscriptionId}`);
                        logger.info(`Invoice details for mismatched subscription: ${JSON.stringify({
                            invoiceId: invoice.id,
                            amount: invoice.amount_paid ? invoice.amount_paid / 100 : null,
                            customer: invoice.customer,
                            currency: invoice.currency
                        })}`);
                        
                        // Update the subscription ID if it doesn't exist
                        if (!currentData.stripeSubscriptionId) {
                            logger.warn(`Subscription document ${userId} missing stripeSubscriptionId field, updating with verification warning`);
                            await subscriptionDoc.ref.update({
                                stripeSubscriptionId: subscriptionId,
                                verificationNotes: FieldValue.arrayUnion({
                                    type: 'subscription_id_added',
                                    timestamp: new Date(),
                                    note: 'ID added during payment verification, may need investigation'
                                })
                            });
                        }
                    } else {
                        logger.info(`Subscription ID verification successful for ${userId}`);
                    }
                    
                    try {
                        await auth.getUser(userId);
                        logger.info(`Validated Firebase Auth user for payment success: ${userId}`);
                    } catch (authError) {
                        logger.error(`Payment succeeded for invalid Firebase Auth user: ${userId}`, authError);
                    }
                    
                    await subscriptionDoc.ref.update({
                        plan: 'pro',
                        stripeSubscriptionStatus: 'active',
                        lastPaymentAt: new Date(),
                        lastUpdated: new Date(),
                        paymentHistory: FieldValue.arrayUnion({
                            type: 'payment_succeeded',
                            invoiceId: invoice.id,
                            subscriptionId: subscriptionId,
                            subscriptionVerified: currentData.stripeSubscriptionId === subscriptionId,
                            amount: invoice.amount_paid ? invoice.amount_paid / 100 : null,
                            currency: invoice.currency,
                            timestamp: new Date()
                        })
                    });
                    
                    await auth.setCustomUserClaims(userId, {
                        plan: 'pro',
                        subscriptionStatus: 'active',
                        subscriptionId: subscriptionId,
                        lastPaymentAt: new Date().toISOString()
                    });
                    
                    logger.info(`Payment succeeded for subscription ${subscriptionId}, user ${userId} updated`);
                } else {
                    logger.error(`No subscription document found for Stripe subscription ${subscriptionId} - this indicates data inconsistency`);
                    logger.info(`Attempting recovery for orphaned subscription ${subscriptionId}`);
                    
                    try {
                        const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
                        const customerId = stripeSubscription.customer;
                        const createdAtTimestamp = stripeSubscription.created;
                        
                        logger.info(`Retrieved subscription details from Stripe: Customer ID ${customerId}, created at ${new Date(createdAtTimestamp * 1000).toISOString()}`);

                        const customerQuery = await db.collection('subscriptions')
                            .where('stripeCustomerId', '==', customerId)
                            .limit(1)
                            .get();
                        
                        if (!customerQuery.empty) {
                            const doc = customerQuery.docs[0];
                            const existingData = doc.data();
                            logger.info(`Found subscription by customer ID ${customerId}, comparing with existing data`);
                            
                            // Check if there's a conflict with existing subscription ID
                            if (existingData.stripeSubscriptionId && existingData.stripeSubscriptionId !== subscriptionId) {
                                logger.warn(`Customer ${customerId} already has subscription ${existingData.stripeSubscriptionId}, but new payment is for ${subscriptionId}`);
                                
                                await doc.ref.update({
                                    conflictingSubscriptionId: subscriptionId,
                                    stripeSubscriptionStatus: 'needs_investigation',
                                    lastUpdated: new Date(),
                                    verificationNotes: FieldValue.arrayUnion({
                                        type: 'subscription_id_conflict',
                                        existing: existingData.stripeSubscriptionId,
                                        incoming: subscriptionId,
                                        timestamp: new Date(),
                                        note: 'Multiple subscription IDs found for customer'
                                    }),
                                    paymentHistory: FieldValue.arrayUnion({
                                        type: 'payment_succeeded_conflict',
                                        invoiceId: invoice.id,
                                        existingSubscriptionId: existingData.stripeSubscriptionId,
                                        incomingSubscriptionId: subscriptionId,
                                        amount: invoice.amount_paid ? invoice.amount_paid / 100 : null,
                                        currency: invoice.currency,
                                        timestamp: new Date(),
                                        note: 'Payment for a different subscription ID than stored'
                                    })
                                });
                            } else {
                                logger.info(`Found subscription by customer ID ${customerId}, updating with missing subscription ID`);
                                
                                await doc.ref.update({
                                    stripeSubscriptionId: subscriptionId,
                                    stripeSubscriptionStatus: 'active',
                                    lastPaymentAt: new Date(),
                                    lastUpdated: new Date(),
                                    paymentHistory: FieldValue.arrayUnion({
                                        type: 'payment_succeeded_recovery',
                                        invoiceId: invoice.id,
                                        subscriptionId: subscriptionId,
                                        amount: invoice.amount_paid ? invoice.amount_paid / 100 : null,
                                        currency: invoice.currency,
                                        timestamp: new Date(),
                                        note: 'Recovered from orphaned subscription'
                                    })
                                });
                                
                                logger.info(`Successfully recovered subscription data for ${subscriptionId}`);
                            }
                        }
                    } catch (recoveryError) {
                        logger.error(`Failed to recover subscription ${subscriptionId}:`, recoveryError);
                    }
                }
                break;
            }
            
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const subscriptionId = invoice.parent?.subscription_details?.subscription;
                
                if (!subscriptionId) {
                    logger.info(`Invoice ${invoice.id} payment failed but no subscription ID - likely a one-time payment, skipping`);
                    break;
                }
                
                logger.info(`Processing payment failure for subscription: ${subscriptionId}`);
                
                const subscriptionsQuery = await db.collection('subscriptions')
                    .where('stripeSubscriptionId', '==', subscriptionId)
                    .limit(1)
                    .get();
                
                if (!subscriptionsQuery.empty) {
                    const subscriptionDoc = subscriptionsQuery.docs[0];
                    const userId = subscriptionDoc.id;
                    const currentData = subscriptionDoc.data();
                    
                    if (!currentData.stripeSubscriptionId) {
                        logger.error(`Subscription document ${userId} missing stripeSubscriptionId field`);
                        await subscriptionDoc.ref.update({
                            stripeSubscriptionId: subscriptionId
                        });
                    }
                    
                    try {
                        await auth.getUser(userId);
                        logger.info(`Validated Firebase Auth user for payment failure: ${userId}`);
                    } catch (authError) {
                        logger.error(`Payment failed for invalid Firebase Auth user: ${userId}`, authError);
                    }
                    
                    await subscriptionDoc.ref.update({
                        plan: 'free',
                        stripeSubscriptionStatus: 'past_due',
                        paymentFailedAt: new Date(),
                        lastUpdated: new Date(),
                        paymentHistory: FieldValue.arrayUnion({
                            type: 'payment_failed',
                            invoiceId: invoice.id,
                            subscriptionId: subscriptionId,
                            amount: invoice.amount_due ? invoice.amount_due / 100 : null,
                            currency: invoice.currency,
                            timestamp: new Date(),
                            error: invoice.last_finalization_error?.message || 'Unknown payment error'
                        })
                    });
                    
                    await auth.setCustomUserClaims(userId, {
                        plan: 'free',
                        subscriptionStatus: 'past_due',
                        subscriptionId: subscriptionId,
                        paymentFailedAt: new Date().toISOString()
                    });
                    
                    logger.warn(`Payment failed for subscription ${subscriptionId}, user ${userId} downgraded`);
                } else {
                    logger.error(`No subscription document found for failed payment on subscription ${subscriptionId}`);
                }
                break;
            }
            
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const subscriptionId = subscription.parent?.subscription_details?.subscription || subscription.id;
                
                if (!subscriptionId) {
                    logger.error(`Subscription deletion event missing subscription ID`);
                    break;
                }
                
                logger.info(`Processing subscription deletion for: ${subscriptionId}`);
                
                const subscriptionsQuery = await db.collection('subscriptions')
                    .where('stripeSubscriptionId', '==', subscriptionId)
                    .limit(1)
                    .get();
                
                if (!subscriptionsQuery.empty) {
                    const subscriptionDoc = subscriptionsQuery.docs[0];
                    const userId = subscriptionDoc.id;
                    const currentData = subscriptionDoc.data();
                    
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
                        lastUpdated: new Date(),
                        paymentHistory: FieldValue.arrayUnion({
                            type: 'subscription_canceled',
                            subscriptionId: subscriptionId,
                            canceledAt: new Date(subscription.canceled_at * 1000),
                            cancelReason: subscription.cancellation_details?.reason || 'Unknown',
                            timestamp: new Date()
                        })
                    });
                    
                    await auth.setCustomUserClaims(userId, {
                        plan: 'free',
                        subscriptionStatus: 'canceled',
                        subscriptionId: null,
                        canceledAt: new Date().toISOString()
                    });
                    
                    logger.info(`User ${userId} downgraded to free plan after subscription ${subscriptionId} was canceled`);
                } else {
                    logger.error(`No subscription document found for canceled subscription ${subscriptionId}`);
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

        if (!stripe) {
            logger.error("Stripe not initialized");
            throw new HttpsError("failed-precondition", "Payment service not available");
        }

        const userRecord = await auth.getUser(userId);
        const customClaims = userRecord.customClaims || {};
        let userPlan = customClaims.plan || 'free';
        let subscriptionStatus = customClaims.subscriptionStatus || null;

        if (!customClaims.plan) {
            try {
                const subscriptionRef = db.collection('subscriptions').doc(userId);
                const subscriptionDoc = await subscriptionRef.get();
                
                if (subscriptionDoc.exists) {
                    const subscriptionData = subscriptionDoc.data();
                    userPlan = subscriptionData.plan || 'free';
                    subscriptionStatus = subscriptionData.stripeSubscriptionStatus || null;
                    
                    if (subscriptionData.plan === 'pro' && !subscriptionData.stripeSubscriptionId) {
                        logger.warn(`User ${userId} has pro plan but no stripeSubscriptionId - data inconsistency detected`);
                        userPlan = 'free';
                        subscriptionStatus = null;
                    }
                }
                
                logger.info("User subscription data retrieved:", { 
                    plan: userPlan, 
                    hasSubscription: !!subscriptionStatus,
                    userId: userId 
                });
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
            success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${DOMAIN}/index.html`,
            client_reference_id: userId,
            metadata: {
                userId: userId,
                plan: 'pro',
                email: userEmail
            },
            customer_email: userEmail
        });

        logger.info("Stripe checkout session created successfully:", session.id);

        try {
            const pendingData = {
                plan: 'free',
                email: userEmail,
                userId: userId,
                createdAt: new Date(),
                lastUpdated: new Date(),
                pendingSubscription: {
                    sessionId: session.id,
                    createdAt: new Date(),
                    status: 'pending',
                    amount: session.amount_total ? session.amount_total / 100 : null,
                    currency: session.currency
                }
            };

            await db.collection('subscriptions').doc(userId).set(pendingData, { merge: true });
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

// Cancel subscription function
export const cancelSubscription = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    try {
        // Require authentication
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Please sign in to cancel subscription");
        }

        const userId = request.auth.uid;
        logger.info("cancelSubscription called for user:", userId);

        // Check Stripe initialization
        if (!stripe) {
            logger.error("Stripe not initialized");
            throw new HttpsError("failed-precondition", "Payment service not available");
        }

        // Get user's subscription data from Firestore
        const subscriptionRef = db.collection('subscriptions').doc(userId);
        const subscriptionDoc = await subscriptionRef.get();

        if (!subscriptionDoc.exists) {
            throw new HttpsError("not-found", "No subscription found for this user");
        }

        const subscriptionData = subscriptionDoc.data();
        const stripeSubscriptionId = subscriptionData.stripeSubscriptionId;

        if (!stripeSubscriptionId) {
            throw new HttpsError("not-found", "No active Stripe subscription found");
        }

        if (subscriptionData.stripeSubscriptionStatus === 'canceled') {
            throw new HttpsError("failed-precondition", "Subscription is already canceled");
        }

        // Cancel the subscription in Stripe (at period end)
        const canceledSubscription = await stripe.subscriptions.update(stripeSubscriptionId, {
            cancel_at_period_end: true,
            metadata: {
                canceledBy: 'user',
                canceledAt: new Date().toISOString()
            }
        });

        logger.info("Stripe subscription canceled:", canceledSubscription.id);

        // Update subscription in Firestore
        await subscriptionRef.update({
            stripeSubscriptionStatus: 'cancel_at_period_end',
            canceledAt: new Date(),
            canceledBy: 'user',
            periodEnd: new Date(canceledSubscription.current_period_end * 1000)
        });

        // Update custom claims
        await auth.setCustomUserClaims(userId, {
            plan: 'pro', // Still pro until period ends
            subscriptionStatus: 'cancel_at_period_end',
            subscriptionId: stripeSubscriptionId,
            canceledAt: new Date().toISOString()
        });

        // Send cancellation email notification
        const userRecord = await auth.getUser(userId);
        await sendEmailNotification(
            userRecord.email,
            'JRE Clipper - Subscription Canceled',
            `
            <h2>Subscription Canceled</h2>
            <p>Your JRE Clipper Pro subscription has been canceled and will expire at the end of your current billing period.</p>
            <p>You will continue to have access to Pro features until ${new Date(canceledSubscription.current_period_end * 1000).toLocaleDateString()}.</p>
            <p>You can reactivate your subscription anytime before the expiration date.</p>
            <p>Thank you for using JRE Clipper!</p>
            `
        );

        return {
            success: true,
            message: 'Subscription canceled successfully',
            periodEnd: canceledSubscription.current_period_end
        };

    } catch (error) {
        logger.error("Cancel subscription error:", error);

        if (error instanceof HttpsError) {
            throw error;
        }

        if (error.type === 'StripeInvalidRequestError') {
            throw new HttpsError("invalid-argument", `Stripe error: ${error.message}`);
        }

        throw new HttpsError("internal", `Failed to cancel subscription: ${error.message}`);
    }
});

// Create Stripe Customer Portal session for billing management
export const createCustomerPortalSession = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    try {
        // Require authentication
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Please sign in to access billing management");
        }

        const userId = request.auth.uid;
        logger.info("createCustomerPortalSession called for user:", userId);

        // Check Stripe initialization
        if (!stripe) {
            logger.error("Stripe not initialized");
            throw new HttpsError("failed-precondition", "Payment service not available");
        }

        // Get user's subscription data from Firestore
        const subscriptionRef = db.collection('subscriptions').doc(userId);
        const subscriptionDoc = await subscriptionRef.get();

        if (!subscriptionDoc.exists) {
            throw new HttpsError("not-found", "No subscription found for this user");
        }

        const subscriptionData = subscriptionDoc.data();
        const stripeCustomerId = subscriptionData.stripeCustomerId;

        if (!stripeCustomerId) {
            throw new HttpsError("not-found", "No Stripe customer found");
        }

        // Create customer portal session
        const session = await stripe.billingPortal.sessions.create({
            customer: stripeCustomerId,
            return_url: `${DOMAIN}/account.html`,
        });

        logger.info("Customer portal session created:", session.id);

        return {
            success: true,
            url: session.url
        };

    } catch (error) {
        logger.error("Create customer portal error:", error);

        if (error instanceof HttpsError) {
            throw error;
        }

        if (error.type === 'StripeInvalidRequestError') {
            throw new HttpsError("invalid-argument", `Stripe error: ${error.message}`);
        }

        throw new HttpsError("internal", `Failed to create customer portal: ${error.message}`);
    }
});

// Get user usage statistics
export const getUserUsageStats = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 10,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    try {
        logger.info("getUserUsageStats called");
        
        // If no authentication, return default stats
        if (!request.auth) {
            return {
                searchesThisMonth: 0,
                videosGenerated: 0,
                totalSearches: 0,
                accountCreated: null
            };
        }

        const userId = request.auth.uid;
        
        // Get current month's usage from user_sessions collection
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        
        const sessionsQuery = await db.collection('user_sessions')
            .where('userId', '==', userId)
            .where('createdAt', '>=', startOfMonth)
            .get();
        
        let searchesThisMonth = 0;
        let videosGenerated = 0;
        
        sessionsQuery.forEach(doc => {
            const sessionData = doc.data();
            if (sessionData.searchCount) {
                searchesThisMonth += sessionData.searchCount;
            }
            if (sessionData.videosGenerated) {
                videosGenerated += sessionData.videosGenerated;
            }
        });
        
        // Get total searches from all time
        const allSessionsQuery = await db.collection('user_sessions')
            .where('userId', '==', userId)
            .get();
        
        let totalSearches = 0;
        allSessionsQuery.forEach(doc => {
            const sessionData = doc.data();
            if (sessionData.searchCount) {
                totalSearches += sessionData.searchCount;
            }
        });
        
        // Get account creation date
        const userRecord = await auth.getUser(userId);
        
        return {
            searchesThisMonth,
            videosGenerated,
            totalSearches,
            accountCreated: userRecord.metadata.creationTime
        };
        
    } catch (error) {
        logger.error("Error getting usage stats:", error);
        // Return safe defaults instead of throwing
        return {
            searchesThisMonth: 0,
            videosGenerated: 0,
            totalSearches: 0,
            accountCreated: null,
            error: 'Could not load usage statistics'
        };
    }
});