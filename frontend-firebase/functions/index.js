import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { GoogleAuth } from "google-auth-library";
import { createHash, randomUUID } from "node:crypto";

// Keep module-level work cheap: every exported function shares this module, so
// anything initialized here is paid on every cold start. Heavy or rarely used
// clients (Storage, Google auth) are created lazily inside the handlers.
initializeApp();
const db = getFirestore('jre-clipper-db');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'vohoanvu96@gmail.com').toLowerCase();
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || null;

// ===== Shared helpers =====

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

let googleAuth = null;
// Uses the runtime service account of whichever function calls it.
async function googleRequest(options) {
    googleAuth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await googleAuth.getClient();
    return client.request(options);
}

function describeGoogleError(error) {
    const status = error?.response?.status ?? null;
    const message = error?.response?.data?.error?.message || error?.message || String(error);
    return { status, message };
}

function requireAuth(request, message = "Please sign in first.") {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", message);
    }
    return request.auth;
}

function isAdmin(auth) {
    const token = auth?.token || {};
    return typeof token.email === 'string'
        && token.email_verified === true
        && token.email.toLowerCase() === ADMIN_EMAIL;
}

function utcDay(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function toIso(value) {
    if (value == null) return null;
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    return null;
}

function formatDuration(totalSeconds) {
    const s = Math.round(totalSeconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Small in-memory LRU with TTL. Values may be promises so concurrent identical
// requests on the same instance share one upstream call.
class TtlLru {
    constructor(maxEntries, ttlMs) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.map = new Map();
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            this.map.delete(key);
            return undefined;
        }
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        this.map.delete(key);
        this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        while (this.map.size > this.maxEntries) {
            this.map.delete(this.map.keys().next().value);
        }
    }

    deleteIfSame(key, value) {
        if (this.map.get(key)?.value === value) this.map.delete(key);
    }
}

// Per-client fixed-window limiter, in memory per instance. With maxInstances 10
// the worst case is 10x the limit for one IP; App Check is the stronger guard.
class RateLimiter {
    constructor(limit, windowMs, maxKeys = 10000) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.maxKeys = maxKeys;
        this.windows = new Map(); // key -> { start, count }
    }

    // Returns true if the call is allowed.
    take(key) {
        const now = Date.now();
        let w = this.windows.get(key);
        if (!w || now - w.start >= this.windowMs) {
            if (this.windows.size >= this.maxKeys) {
                for (const [k, v] of this.windows) {
                    if (now - v.start >= this.windowMs) this.windows.delete(k);
                }
                if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value);
            }
            w = { start: now, count: 0 };
            this.windows.set(key, w);
        }
        w.count++;
        return w.count <= this.limit;
    }
}

// Express trusts X-Forwarded-For, so req.ip is its leftmost (client-supplied) entry.
// Google's front end appends the address it saw, so use the rightmost entry.
function clientIp(request) {
    const raw = request.rawRequest;
    const forwarded = String(raw?.headers?.['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return forwarded.at(-1) || raw?.socket?.remoteAddress || 'unknown';
}

function enforceRateLimit(limiter, request, what) {
    const ip = clientIp(request);
    if (!limiter.take(ip)) {
        logger.warn(`${what}: rate limited`, { ip });
        throw new HttpsError("resource-exhausted", "You're searching too fast. Please wait a minute and try again.");
    }
}

function cachedCall(cache, key, producer, shouldCache = () => true) {
    const hit = cache.get(key);
    if (hit) return hit;
    const promise = producer();
    cache.set(key, promise);
    promise.then(
        (value) => { if (!shouldCache(value)) cache.deleteIfSame(key, promise); },
        () => cache.deleteIfSame(key, promise)
    );
    return promise;
}

// ===== Search proxy (Vertex AI Search / Discovery Engine) =====
// The browser never sees a Google access token: these callables run as a
// service account that only has roles/discoveryengine.user.

const SEARCH_SERVICE_ACCOUNT = "jre-search-reader@gen-lang-client-demo.iam.gserviceaccount.com";
const DE_ENGINE = "projects/408323719521/locations/us/collections/default_collection/engines/jreclipper_1750261043616";
const DE_SERVING_CONFIG_URL = `https://us-discoveryengine.googleapis.com/v1alpha/${DE_ENGINE}/servingConfigs/default_search`;
const DE_SESSION_RE = /^projects\/408323719521\/locations\/us\/collections\/default_collection\/engines\/jreclipper_1750261043616\/sessions\/[A-Za-z0-9_-]{1,64}$/;
const DE_QUERY_ID_RE = /^projects\/408323719521\/locations\/us\/questions\/[A-Za-z0-9_-]{1,64}$/;
const MAX_QUERY_LENGTH = 300;
const SEARCH_PAGE_SIZE = 30;
const SNIPPET_WORDS = 30;
const MAX_ANSWER_SOURCES = 8;

// The answer is shown next to real clips under Joe Rogan's name, so it must summarize what
// was said, never speak as him or invent quotes (an "AI Joe" persona was used until 2026-10-31).
const ANSWER_PREAMBLE = "You summarize what was actually said on The Joe Rogan Experience podcast, using only the transcript excerpts in the search results. Write in a neutral third-person voice; never write as Joe Rogan or impersonate anyone. Attribute a view to Joe Rogan or to the guest only when the excerpt makes the speaker clear; otherwise say \"on the podcast\". Never invent quotes or facts. If the excerpts don't address the question, say so briefly. Keep it under 150 words, using short bullet points when there are several distinct points.";

const searchCache = new TtlLru(300, 10 * 60 * 1000);
const answerCache = new TtlLru(300, 10 * 60 * 1000);
// answerQuery is the expensive call (LLM answer generation).
const searchLimiter = new RateLimiter(30, 60 * 1000);
const answerLimiter = new RateLimiter(10, 60 * 1000);

const SEARCH_FUNCTION_OPTIONS = {
    serviceAccount: SEARCH_SERVICE_ACCOUNT,
    memory: "256MiB",
    maxInstances: 10, // high concurrency per instance keeps the in-memory cache effective
    minInstances: 0,
};

function cleanQueryText(value) {
    if (typeof value !== 'string') {
        throw new HttpsError("invalid-argument", "A search query is required.");
    }
    const text = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!text) {
        throw new HttpsError("invalid-argument", "A search query is required.");
    }
    if (text.length > MAX_QUERY_LENGTH) {
        throw new HttpsError("invalid-argument", `Search queries are limited to ${MAX_QUERY_LENGTH} characters.`);
    }
    return text;
}

function cleanTimeZone(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(value) ? value : 'UTC';
}

function toHttpsError(error, fallbackMessage) {
    const { status } = describeGoogleError(error);
    if (status === 429) {
        return new HttpsError("resource-exhausted", "Too many requests right now. Please try again in a minute.");
    }
    if (status === 400) {
        return new HttpsError("invalid-argument", "This query could not be processed. Try rephrasing it.");
    }
    return new HttpsError("unavailable", fallbackMessage);
}

const SNIPPET_STOP_WORDS = new Set(['the', 'and', 'about', 'what', 'did', 'does', 'joe', 'rogan', 'say', 'says',
    'said', 'talk', 'talks', 'talked', 'his', 'that', 'with', 'for', 'how', 'why', 'who', 'when', 'think', 'thinks']);

// Crude stems so "bears" matches "bear" and "attacking" matches "attack".
function snippetStems(query) {
    const stems = query.toLowerCase().split(/[^a-z0-9']+/)
        .filter((word) => word.length > 2 && !SNIPPET_STOP_WORDS.has(word))
        .map((word) => word.replace(/(ing|ed|es|s)$/, ''))
        .filter((stem) => stem.length >= 3);
    return [...new Set(stems)];
}

// A ~30-word excerpt of a segment's transcript: the window with the most query-word hits, else
// the opening. Only excerpts leave the server; the full transcript is never sent to the browser.
function excerpt(content, stems) {
    const words = String(content || '').split(/\s+/).filter(Boolean);
    if (words.length <= SNIPPET_WORDS) return words.join(' ');
    const hits = words.map((word) => {
        const bare = word.toLowerCase().replace(/[^a-z0-9']/g, '');
        return stems.some((stem) => bare.startsWith(stem)) ? 1 : 0;
    });
    let best = 0;
    let bestScore = 0;
    let score = hits.slice(0, SNIPPET_WORDS).reduce((sum, hit) => sum + hit, 0);
    if (score > bestScore) bestScore = score;
    for (let start = 1; start + SNIPPET_WORDS <= words.length; start++) {
        score += hits[start + SNIPPET_WORDS - 1] - hits[start - 1];
        if (score > bestScore) {
            bestScore = score;
            best = start;
        }
    }
    let start = 0;
    if (bestScore > 0) {
        // The first best window ends on a hit; re-center it on the hits it contains.
        const inWindow = [];
        for (let i = best; i < best + SNIPPET_WORDS; i++) if (hits[i]) inWindow.push(i);
        const center = (inWindow[0] + inWindow[inWindow.length - 1]) / 2;
        start = Math.max(0, Math.min(Math.round(center - SNIPPET_WORDS / 2), words.length - SNIPPET_WORDS));
    }
    const end = start + SNIPPET_WORDS;
    return `${start > 0 ? '… ' : ''}${words.slice(start, end).join(' ')}${end < words.length ? ' …' : ''}`;
}

async function runSearch(normalizedQuery, timeZone) {
    const response = await googleRequest({
        url: `${DE_SERVING_CONFIG_URL}:search`,
        method: "POST",
        timeout: 20000,
        data: {
            query: normalizedQuery,
            pageSize: SEARCH_PAGE_SIZE,
            queryExpansionSpec: { condition: "AUTO" },
            spellCorrectionSpec: { mode: "AUTO" },
            languageCode: "en-US",
            userInfo: { timeZone },
            session: `${DE_ENGINE}/sessions/-`,
        },
    });

    const data = response.data || {};
    const stems = snippetStems(normalizedQuery);
    const results = [];
    for (const item of data.results || []) {
        // Documents are shaped structData.{content, structData{videoId,startTime,endTime,videoTitle,channelName}}.
        const meta = item?.document?.structData?.structData;
        const startTime = Number(meta?.startTime);
        const endTime = Number(meta?.endTime);
        if (!meta || typeof meta.videoId !== 'string' || !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
            continue;
        }
        results.push({
            // Document id; answerQuery's sourceIds refer to it.
            id: typeof item.id === 'string' ? item.id : null,
            videoId: meta.videoId,
            videoTitle: typeof meta.videoTitle === 'string' ? meta.videoTitle : '',
            startTime,
            endTime,
            snippet: excerpt(item.document.structData.content, stems),
        });
    }

    return {
        results,
        session: data.sessionInfo?.name || null,
        queryId: data.sessionInfo?.queryId || null,
    };
}

export const searchSegments = onCall({ ...SEARCH_FUNCTION_OPTIONS, timeoutSeconds: 30 }, async (request) => {
    enforceRateLimit(searchLimiter, request, "searchSegments");
    const queryText = cleanQueryText(request.data?.query);
    const cacheKey = queryText.toLowerCase();
    const timeZone = cleanTimeZone(request.data?.timeZone);

    try {
        return await cachedCall(searchCache, cacheKey, () => runSearch(cacheKey, timeZone));
    } catch (error) {
        logger.error("searchSegments failed", describeGoogleError(error));
        throw toHttpsError(error, "Search is temporarily unavailable. Please try again.");
    }
});

async function callAnswerApi(queryText, session, queryId) {
    const payload = {
        query: queryId ? { text: queryText, queryId } : { text: queryText },
        session: session || `${DE_ENGINE}/sessions/-`,
        answerGenerationSpec: {
            ignoreAdversarialQuery: false,
            ignoreNonAnswerSeekingQuery: false,
            ignoreLowRelevantContent: false,
            multimodalSpec: {},
            includeCitations: true,
            promptSpec: { preamble: ANSWER_PREAMBLE },
            modelSpec: { modelVersion: "stable" },
        },
    };
    const response = await googleRequest({
        url: `${DE_SERVING_CONFIG_URL}:answer`,
        method: "POST",
        timeout: 80000,
        data: payload,
    });
    const answer = response.data?.answer || {};
    // References name the cited documents; their ids match searchSegments' result ids.
    const sourceIds = [];
    for (const reference of answer.references || []) {
        const id = String(reference?.structuredDocumentInfo?.document || '').split('/').pop();
        if (id && !sourceIds.includes(id)) sourceIds.push(id);
    }
    return { answerText: answer.answerText || null, sourceIds: sourceIds.slice(0, MAX_ANSWER_SOURCES) };
}

async function runAnswer(queryText, session, queryId) {
    if (session && queryId) {
        try {
            return await callAnswerApi(queryText, session, queryId);
        } catch (error) {
            const { status, message } = describeGoogleError(error);
            if (status !== 400 && status !== 404) throw error;
            // Session/queryId no longer usable: answer without the search context.
            logger.warn("answerQuery: session answer failed, retrying standalone", { status, message });
        }
    }
    return callAnswerApi(queryText, null, null);
}

// Custom instructions were dropped on 2026-10-31; an `instruction` from an old client is ignored.
export const answerQuery = onCall({ ...SEARCH_FUNCTION_OPTIONS, timeoutSeconds: 90 }, async (request) => {
    enforceRateLimit(answerLimiter, request, "answerQuery");
    const queryText = cleanQueryText(request.data?.query);
    const session = typeof request.data?.session === 'string' && DE_SESSION_RE.test(request.data.session)
        ? request.data.session : null;
    const queryId = typeof request.data?.queryId === 'string' && DE_QUERY_ID_RE.test(request.data.queryId)
        ? request.data.queryId : null;

    const cacheKey = queryText.toLowerCase();
    try {
        return await cachedCall(
            answerCache,
            cacheKey,
            () => runAnswer(queryText, session, queryId),
            (value) => !!value?.answerText
        );
    } catch (error) {
        logger.error("answerQuery failed", describeGoogleError(error));
        throw toHttpsError(error, "Could not generate an answer right now. Please try again.");
    }
});

// ===== YouTube metadata =====

const youtubeCache = new TtlLru(2000, 60 * 60 * 1000);

async function fetchYouTubeMetadata(videoIds) {
    const videos = {};
    const missing = [];
    for (const id of videoIds) {
        const hit = youtubeCache.get(id);
        if (hit) videos[id] = hit;
        else missing.push(id);
    }
    if (missing.length === 0) return videos;

    if (!YOUTUBE_API_KEY) {
        logger.error("YOUTUBE_API_KEY is not configured");
        throw new HttpsError("failed-precondition", "Video metadata service is not configured.");
    }

    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.search = new URLSearchParams({
        part: "snippet,statistics",
        id: missing.join(","),
        maxResults: "50",
        fields: "items(id,snippet(title,channelTitle,publishedAt),statistics(viewCount))",
        key: YOUTUBE_API_KEY,
    }).toString();

    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const reason = body?.error?.errors?.[0]?.reason || '';
        logger.error("YouTube API error", { status: response.status, reason, message: body?.error?.message });
        if (response.status === 403 && /quota|rateLimit/i.test(reason)) {
            throw new HttpsError("resource-exhausted", "YouTube API quota exceeded. Please try again later.");
        }
        if (response.status === 403) {
            throw new HttpsError("permission-denied", "YouTube API access denied.");
        }
        throw new HttpsError("internal", "YouTube API error.");
    }

    const body = await response.json();
    for (const item of body.items || []) {
        const meta = {
            id: item.id,
            title: item.snippet?.title || '',
            channelTitle: item.snippet?.channelTitle || '',
            publishedAt: item.snippet?.publishedAt || null,
            viewCount: item.statistics?.viewCount ?? null,
        };
        youtubeCache.set(item.id, meta);
        videos[item.id] = meta;
    }
    return videos;
}

// Input: { videoIds: string[] } -> { success, videos: { [videoId]: metadata } }.
// The legacy input { segments } (pre-rollout clients) still returns { videoGroups }.
export const getVideoMetadata = onCall({
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    const legacySegments = Array.isArray(request.data?.segments) ? request.data.segments : null;
    const requestedIds = legacySegments ? legacySegments.map((s) => s?.videoId) : request.data?.videoIds;

    if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
        throw new HttpsError("invalid-argument", "videoIds array is required.");
    }
    const videoIds = [...new Set(requestedIds)];
    if (videoIds.length > 50 || !videoIds.every((id) => typeof id === 'string' && VIDEO_ID_RE.test(id))) {
        throw new HttpsError("invalid-argument", "Provide between 1 and 50 valid YouTube video IDs.");
    }

    const [videos, availableIds] = await Promise.all([fetchYouTubeMetadata(videoIds), availableVideoIds()]);

    if (legacySegments) {
        const videoGroups = {};
        for (const segment of legacySegments) {
            const id = segment.videoId;
            videoGroups[id] ??= { metadata: videos[id] || null, segments: [] };
            videoGroups[id].segments.push(segment);
        }
        return { success: true, videoGroups, totalVideos: videoIds.length, totalSegments: legacySegments.length };
    }

    // available[id] is false when the episode has no source MP4 yet, so the page can
    // keep its segments out of a compilation. Omitted when the bucket listing failed.
    const available = availableIds
        ? Object.fromEntries(videoIds.map((id) => [id, availableIds.has(id)]))
        : undefined;
    return { success: true, videos, available };
});

// ===== Video jobs =====

const DAILY_JOB_LIMIT = 5;
const MAX_SEGMENTS = 30;
const MAX_SEGMENT_SECONDS = 600;
const MAX_TOTAL_SECONDS = 1200;
const MAX_ACTIVE_JOBS = 3;
const ACTIVE_JOB_WINDOW_MS = 2 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(["Queued", "Processing", "Uploading"]);
const TERMINAL_STATUSES = new Set(["Complete", "Failed"]);
const SOURCE_BUCKET = "jre-all-episodes";
const RENDERER_RUN_URL = "https://run.googleapis.com/v2/projects/gen-lang-client-demo/locations/us-central1/jobs/jre-clip-renderer:run";
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const jobsCollection = () => db.collection('videoJobs');
const usageRef = (uid, day) => db.collection('usageDaily').doc(`${uid}_${day}`);

function validateSegments(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SEGMENTS) {
        throw new HttpsError("invalid-argument", `Select between 1 and ${MAX_SEGMENTS} segments.`);
    }
    let totalSeconds = 0;
    const segments = input.map((segment, index) => {
        const label = `Segment ${index + 1}`;
        if (!segment || typeof segment !== 'object') {
            throw new HttpsError("invalid-argument", `${label} is malformed.`);
        }
        const { videoId, startTimeSeconds: start, endTimeSeconds: end } = segment;
        if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
            throw new HttpsError("invalid-argument", `${label} has an invalid video ID.`);
        }
        if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
            || start < 0 || start >= end) {
            throw new HttpsError("invalid-argument", `${label} has an invalid time range.`);
        }
        const duration = end - start;
        if (duration > MAX_SEGMENT_SECONDS) {
            throw new HttpsError("invalid-argument", `${label} is longer than ${MAX_SEGMENT_SECONDS / 60} minutes.`);
        }
        totalSeconds += duration;
        const videoTitle = typeof segment.videoTitle === 'string' ? segment.videoTitle.trim().slice(0, 300) : '';
        return { videoId, startTimeSeconds: start, endTimeSeconds: end, videoTitle };
    });
    if (totalSeconds > MAX_TOTAL_SECONDS) {
        throw new HttpsError("invalid-argument",
            `Your selection is ${formatDuration(totalSeconds)} long; the maximum is ${MAX_TOTAL_SECONDS / 60} minutes.`);
    }
    return segments;
}

async function countActiveJobs() {
    // Single-field range query (no composite index needed); the 2h window is small.
    const cutoff = new Date(Date.now() - ACTIVE_JOB_WINDOW_MS);
    const snapshot = await jobsCollection()
        .where('createdAt', '>=', cutoff)
        .select('status')
        .limit(500)
        .get();
    return snapshot.docs.filter((doc) => ACTIVE_STATUSES.has(doc.get('status'))).length;
}

// Returns { videoId: objectName | null } using one prefix listing per video.
async function resolveSourceObjects(videoIds) {
    const { getStorage } = await import("firebase-admin/storage");
    const bucket = getStorage().bucket(SOURCE_BUCKET);
    const entries = await Promise.all(videoIds.map(async (videoId) => {
        const [files] = await bucket.getFiles({ prefix: videoId, maxResults: 10, autoPaginate: false });
        const names = files.map((file) => file.name);
        const exact = names.find((name) => name === `${videoId}.mp4`);
        const legacy = names.find((name) => name.startsWith(`${videoId}_`) && name.endsWith('.mp4'));
        return [videoId, exact || legacy || null];
    }));
    return Object.fromEntries(entries);
}

// Ids of every video with a source MP4 ({id}.mp4 or legacy {id}_….mp4), from a
// full bucket listing (~2.4k objects, 3 list calls) cached per instance.
// Returns null if the listing fails; callers then treat everything as available.
const AVAILABLE_TTL_MS = 15 * 60 * 1000;
const SOURCE_NAME_RE = /^([A-Za-z0-9_-]{11})(?:_.*)?\.mp4$/;
let availableCache = null; // { promise, expiresAt }

function availableVideoIds() {
    if (availableCache && availableCache.expiresAt > Date.now()) return availableCache.promise;
    const promise = (async () => {
        const { getStorage } = await import("firebase-admin/storage");
        const [files] = await getStorage().bucket(SOURCE_BUCKET).getFiles({ fields: "items(name),nextPageToken" });
        const ids = new Set();
        for (const file of files) {
            const match = SOURCE_NAME_RE.exec(file.name);
            if (match) ids.add(match[1]);
        }
        return ids;
    })().catch((error) => {
        logger.error("availableVideoIds: bucket listing failed", { message: error.message });
        if (availableCache?.promise === promise) availableCache = null;
        return null;
    });
    availableCache = { promise, expiresAt: Date.now() + AVAILABLE_TTL_MS };
    return promise;
}

export const createVideoJob = onCall({
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 3,
    minInstances: 0,
}, async (request) => {
    const auth = requireAuth(request, "Please sign in to generate videos.");
    // Keeps throwaway email/password accounts from multiplying the daily quota.
    // Google sign-ins are always verified.
    if (auth.token?.email_verified !== true) {
        throw new HttpsError("failed-precondition", "Please verify your email address to generate videos.",
            { reason: "email-unverified" });
    }
    const uid = auth.uid;
    const admin = isAdmin(auth);
    const requestedSegments = validateSegments(request.data?.segments);

    if (await countActiveJobs() >= MAX_ACTIVE_JOBS) {
        throw new HttpsError("resource-exhausted",
            "Our video renderer is busy with other compilations right now. Please try again in a few minutes.");
    }

    const uniqueVideoIds = [...new Set(requestedSegments.map((s) => s.videoId))];
    let resolved;
    try {
        resolved = await resolveSourceObjects(uniqueVideoIds);
    } catch (error) {
        logger.error("createVideoJob: failed to list source videos", { message: error.message });
        throw new HttpsError("internal", "Could not check source videos. Please try again.");
    }

    const sourceObjects = {};
    const missingVideoIds = [];
    for (const videoId of uniqueVideoIds) {
        if (resolved[videoId]) sourceObjects[videoId] = resolved[videoId];
        else missingVideoIds.push(videoId);
    }
    const segments = requestedSegments.filter((s) => sourceObjects[s.videoId]);
    if (segments.length === 0) {
        throw new HttpsError("failed-precondition",
            "None of the selected episodes are available for video generation yet. Try segments from other episodes.");
    }

    const jobId = randomUUID();
    const jobRef = jobsCollection().doc(jobId);
    const day = utcDay();
    const quotaRef = usageRef(uid, day);
    const requestedDurationSeconds = segments.reduce((sum, s) => sum + (s.endTimeSeconds - s.startTimeSeconds), 0);

    const quotaExceeded = await db.runTransaction(async (tx) => {
        const usage = await tx.get(quotaRef);
        const used = usage.exists ? Number(usage.get('count')) || 0 : 0;
        if (!admin && used >= DAILY_JOB_LIMIT) {
            return true;
        }
        const previousJobIds = usage.exists && Array.isArray(usage.get('jobIds')) ? usage.get('jobIds') : [];
        tx.set(quotaRef, {
            userId: uid,
            date: day,
            count: used + 1,
            jobIds: [...previousJobIds, jobId].slice(-50),
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.create(jobRef, {
            userId: uid,
            userEmail: auth.token?.email || null,
            status: "Queued",
            progress: 0,
            progressMessage: "Queued, waiting for the renderer to start",
            segments,
            sourceObjects,
            missingVideoIds,
            segmentCount: segments.length,
            totalVideos: Object.keys(sourceObjects).length,
            requestedDurationSeconds,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        });
        return false;
    });
    if (quotaExceeded) {
        throw new HttpsError("resource-exhausted",
            `You've reached today's limit of ${DAILY_JOB_LIMIT} videos. The limit resets at midnight UTC.`);
    }

    let executionOperation = null;
    try {
        const response = await googleRequest({
            url: RENDERER_RUN_URL,
            method: "POST",
            timeout: 30000,
            data: { overrides: { containerOverrides: [{ env: [{ name: "JOB_ID", value: jobId }] }] } },
        });
        executionOperation = response.data?.name || null;
    } catch (error) {
        const { status, message } = describeGoogleError(error);
        logger.error("createVideoJob: failed to start renderer", { jobId, status, message });
        await Promise.allSettled([
            jobRef.update({
                status: "Failed",
                error: `Could not start the video renderer${status ? ` (HTTP ${status})` : ''}. Please try again later.`,
                progressMessage: "Failed to start",
                updatedAt: FieldValue.serverTimestamp(),
            }),
            // The user got nothing, so give the quota back.
            quotaRef.update({ count: FieldValue.increment(-1) }),
        ]);
        throw new HttpsError("internal", "Could not start video processing. Please try again in a few minutes.");
    }

    try {
        // Only this field: the renderer may already be updating status/progress.
        await jobRef.update({ executionOperation });
    } catch (error) {
        logger.error("createVideoJob: failed to store executionOperation", { jobId, executionOperation, message: error.message });
    }

    logger.info("createVideoJob: queued", { jobId, uid, segmentCount: segments.length, missingVideoIds });
    return { jobId, status: "Queued", segmentCount: segments.length, missingVideoIds };
});

function serializeJob(jobId, job, { includeSegments }) {
    const result = {
        jobId,
        status: job.status || 'Unknown',
        progress: typeof job.progress === 'number' ? job.progress : null,
        progressMessage: job.progressMessage || null,
        segmentCount: job.segmentCount ?? null,
        totalVideos: job.totalVideos ?? null,
        missingVideoIds: Array.isArray(job.missingVideoIds) ? job.missingVideoIds : [],
        requestedDurationSeconds: job.requestedDurationSeconds ?? null,
        error: job.error || null,
        createdAt: toIso(job.createdAt),
        updatedAt: toIso(job.updatedAt),
        completedAt: toIso(job.completedAt),
    };
    if (job.status === 'Complete') {
        result.finalVideoUrl = job.finalVideoUrl || null;
        result.finalVideoExpiresAt = toIso(job.finalVideoExpiresAt);
        result.outputDurationSeconds = job.outputDurationSeconds ?? null;
        result.outputSizeBytes = job.outputSizeBytes ?? null;
    }
    if (includeSegments && Array.isArray(job.segments)) {
        result.segments = job.segments.map((s) => ({
            videoId: s.videoId,
            startTimeSeconds: s.startTimeSeconds,
            endTimeSeconds: s.endTimeSeconds,
            videoTitle: s.videoTitle || '',
        }));
    }
    return result;
}

// Finished videos are kept indefinitely (until 2026-10-27 a lifecycle rule deleted them after
// 8 days), but the URL the renderer stores expires after 7 days. Functions that hand out video
// links run as jre-clip-reader@ (Firestore read, read on edited-clips/, signBlob as itself) and
// sign a fresh short-lived URL on every request.
const CLIP_READER_SERVICE_ACCOUNT = "jre-clip-reader@gen-lang-client-demo.iam.gserviceaccount.com";
const OUTPUT_BUCKET = "jre-processed-clips-bucker";
const PLAYBACK_URL_TTL_MS = 12 * 60 * 60 * 1000;

// { url, expiresAt } for a finished job's MP4, or null when the file no longer exists.
async function playbackUrl(jobId) {
    const { getStorage } = await import("firebase-admin/storage");
    const file = getStorage().bucket(OUTPUT_BUCKET).file(`edited-clips/${jobId}/final_video.mp4`);
    const [exists] = await file.exists();
    if (!exists) return null;
    const expires = Date.now() + PLAYBACK_URL_TTL_MS;
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires });
    return { url, expiresAt: new Date(expires).toISOString() };
}

// Signing failures degrade to "no link" instead of failing the whole response.
async function playbackUrlOrNull(jobId) {
    try {
        return await playbackUrl(jobId);
    } catch (error) {
        logger.error("playbackUrl failed", { jobId, message: error.message });
        return null;
    }
}

// Polled by status.html. Only returns the caller's own job.
export const getVideoJob = onCall({
    serviceAccount: CLIP_READER_SERVICE_ACCOUNT,
    memory: "256MiB",
    timeoutSeconds: 15,
    maxInstances: 10,
    minInstances: 0,
}, async (request) => {
    const auth = requireAuth(request, "Please sign in to view this job.");
    const jobId = request.data?.jobId;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
        throw new HttpsError("invalid-argument", "A valid job ID is required.");
    }
    const snapshot = await jobsCollection().doc(jobId).get();
    const job = snapshot.exists ? snapshot.data() : null;
    if (!job || (job.userId !== auth.uid && !isAdmin(auth))) {
        throw new HttpsError("not-found", "Job not found.");
    }
    const result = serializeJob(snapshot.id, job, { includeSegments: TERMINAL_STATUSES.has(job.status) });
    if (job.status === 'Complete') {
        const playback = await playbackUrlOrNull(snapshot.id);
        result.finalVideoUrl = playback?.url || null;
        result.finalVideoExpiresAt = playback?.expiresAt || null;
    }
    return result;
});

// My videos page: the caller's jobs, newest first, with a fresh playable URL for each finished one.
// Pages with `cursor` = the last jobId of the previous page. Needs the composite index
// videoJobs (userId ASC, createdAt DESC) in jre-clipper-db.
const MY_VIDEOS_PAGE_SIZE = 12;

export const listMyVideos = onCall({
    serviceAccount: CLIP_READER_SERVICE_ACCOUNT,
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    const auth = requireAuth(request, "Please sign in to see your videos.");
    let query = jobsCollection()
        .where('userId', '==', auth.uid)
        .orderBy('createdAt', 'desc')
        .select('status', 'createdAt', 'completedAt', 'segmentCount', 'totalVideos', 'progress', 'error',
            'segments', 'outputDurationSeconds', 'outputSizeBytes')
        .limit(MY_VIDEOS_PAGE_SIZE + 1);

    const cursor = request.data?.cursor;
    if (cursor != null) {
        if (typeof cursor !== 'string' || !JOB_ID_RE.test(cursor)) {
            throw new HttpsError("invalid-argument", "Invalid page cursor.");
        }
        const cursorSnapshot = await jobsCollection().doc(cursor).get();
        if (!cursorSnapshot.exists || cursorSnapshot.get('userId') !== auth.uid) {
            throw new HttpsError("invalid-argument", "Invalid page cursor.");
        }
        query = query.startAfter(cursorSnapshot);
    }

    const snapshot = await query.get();
    const docs = snapshot.docs.slice(0, MY_VIDEOS_PAGE_SIZE);
    const videos = await Promise.all(docs.map(async (doc) => {
        const job = doc.data();
        const episodes = [];
        const seen = new Set();
        for (const segment of Array.isArray(job.segments) ? job.segments : []) {
            if (seen.has(segment.videoId)) continue;
            seen.add(segment.videoId);
            episodes.push({ videoId: segment.videoId, title: segment.videoTitle || '' });
        }
        const playback = job.status === 'Complete' ? await playbackUrlOrNull(doc.id) : null;
        return {
            jobId: doc.id,
            status: job.status || 'Unknown',
            createdAt: toIso(job.createdAt),
            completedAt: toIso(job.completedAt),
            segmentCount: job.segmentCount ?? null,
            totalVideos: job.totalVideos ?? null,
            progress: typeof job.progress === 'number' ? job.progress : null,
            error: job.status === 'Failed' ? job.error || null : null,
            outputDurationSeconds: job.outputDurationSeconds ?? null,
            outputSizeBytes: job.outputSizeBytes ?? null,
            episodes,
            videoUrl: playback?.url || null,
            videoUrlExpiresAt: playback?.expiresAt || null,
        };
    }));

    return {
        videos,
        nextCursor: snapshot.docs.length > MY_VIDEOS_PAGE_SIZE ? docs[docs.length - 1].id : null,
    };
});

// Account page: today's quota plus the last 7 days of jobs (download links are
// 7-day signed URLs, so older jobs have nothing to download anyway).
export const getUserUsageStats = onCall({
    memory: "256MiB",
    timeoutSeconds: 15,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    const auth = requireAuth(request);
    const uid = auth.uid;
    const admin = isAdmin(auth);

    const now = new Date();
    const days = Array.from({ length: 7 }, (_, i) => utcDay(new Date(now.getTime() - i * 86400000)));
    const usageSnapshots = await db.getAll(...days.map((day) => usageRef(uid, day)), { fieldMask: ['count', 'jobIds'] });

    const usedToday = usageSnapshots[0].exists ? Number(usageSnapshots[0].get('count')) || 0 : 0;
    const recentJobIds = [];
    for (const snapshot of usageSnapshots) {
        const ids = snapshot.exists && Array.isArray(snapshot.get('jobIds')) ? snapshot.get('jobIds') : [];
        recentJobIds.push(...[...ids].reverse());
    }

    const jobIds = recentJobIds.slice(0, 20);
    const jobSnapshots = jobIds.length
        ? await db.getAll(...jobIds.map((id) => jobsCollection().doc(id)), {
            fieldMask: ['userId', 'status', 'createdAt', 'segmentCount', 'totalVideos', 'progress',
                'finalVideoUrl', 'finalVideoExpiresAt', 'outputDurationSeconds'],
        })
        : [];

    const recentJobs = jobSnapshots
        .filter((snapshot) => snapshot.exists && snapshot.get('userId') === uid)
        .map((snapshot) => {
            const job = snapshot.data();
            const expiresAt = toIso(job.finalVideoExpiresAt);
            const linkValid = job.status === 'Complete' && job.finalVideoUrl
                && (!expiresAt || Date.parse(expiresAt) > Date.now());
            return {
                jobId: snapshot.id,
                status: job.status || 'Unknown',
                createdAt: toIso(job.createdAt),
                segmentCount: job.segmentCount ?? null,
                totalVideos: job.totalVideos ?? null,
                progress: typeof job.progress === 'number' ? job.progress : null,
                outputDurationSeconds: job.outputDurationSeconds ?? null,
                finalVideoUrl: linkValid ? job.finalVideoUrl : null,
                finalVideoExpiresAt: linkValid ? expiresAt : null,
            };
        });

    const nextUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return {
        unlimited: admin,
        dailyLimit: DAILY_JOB_LIMIT,
        usedToday,
        remainingToday: admin ? null : Math.max(0, DAILY_JOB_LIMIT - usedToday),
        resetsAt: nextUtcMidnight.toISOString(),
        recentJobs,
    };
});

// ===== Analytics =====
// Write pattern (all O(1), no reads, no transactions, no unbounded documents):
//   searchActivity/{auto}                         one raw record per search
//   dailySearchStats/{date}                       counters via FieldValue.increment
//   dailySearchStats/{date}/visitors/{hash}       first-seen marker; create() fails on repeats,
//                                                 so unique counters only increment once per visitor/day
//   dailySearchStats/{date}/terms/{hash}          per-term counts (top terms: orderBy('count', 'desc'))
// The previous version re-wrote one daily doc in a transaction with ever-growing user/session
// id arrays (1 MB document limit, contention on every search) and trimmed terms to a top 20
// on each write, which reset any new term before it could accumulate.

const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const ALREADY_EXISTS = 6;
// privacy.html promises deletion after 24 months: searchActivity, dailySearchStats/*/visitors and
// analyticsEvents carry expireAt, and a Firestore TTL policy on that field per collection group
// deletes them (gcloud firestore fields ttls update expireAt --collection-group=<name> --enable-ttl).
const LOG_RETENTION_MS = 730 * 24 * 60 * 60 * 1000;

export const recordSearchActivity = onCall({
    enforceAppCheck: false,
    memory: "256MiB",
    timeoutSeconds: 10,
    maxInstances: 10,
    minInstances: 0,
}, async (request) => {
    try {
        const { searchQuery, sessionId, userAgent } = request.data || {};

        if (!searchQuery || typeof searchQuery !== 'string') {
            throw new HttpsError("invalid-argument", "Search query is required");
        }

        const userId = request.auth?.uid || null;
        const isAuthenticated = !!request.auth;
        // sessionId is the browser's persistent visitor id since 2026-10-31 (per page load before).
        const internal = request.data?.internal === true || isAdmin(request.auth);
        const session = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 128) : null;
        const now = new Date();
        const dateString = now.toISOString().split('T')[0]; // YYYY-MM-DD format
        const normalizedQuery = searchQuery.toLowerCase().trim().slice(0, MAX_QUERY_LENGTH);
        const dailyStatsRef = db.collection('dailySearchStats').doc(dateString);

        const batch = db.batch();
        batch.create(db.collection('searchActivity').doc(), {
            searchQuery: normalizedQuery,
            userId,
            sessionId: session,
            isAuthenticated,
            internal,
            timestamp: now,
            date: dateString,
            userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
            createdAt: now,
            expireAt: new Date(now.getTime() + LOG_RETENTION_MS),
        });
        batch.set(dailyStatsRef, {
            date: dateString,
            totalSearches: FieldValue.increment(1),
            [isAuthenticated ? 'authenticatedSearches' : 'anonymousSearches']: FieldValue.increment(1),
            lastUpdated: now,
        }, { merge: true });
        batch.set(dailyStatsRef.collection('terms').doc(sha(normalizedQuery)), {
            term: normalizedQuery,
            count: FieldValue.increment(1),
            lastSearchedAt: now,
        }, { merge: true });
        await batch.commit();

        const visitorKey = isAuthenticated ? `user:${userId}` : (session ? `session:${session}` : null);
        if (visitorKey) {
            try {
                await dailyStatsRef.collection('visitors').doc(sha(visitorKey)).create({
                    kind: isAuthenticated ? 'authenticated' : 'anonymous',
                    firstSeenAt: now,
                    expireAt: new Date(now.getTime() + LOG_RETENTION_MS),
                });
                await dailyStatsRef.set({
                    [isAuthenticated ? 'uniqueAuthenticatedUsers' : 'uniqueAnonymousUsers']: FieldValue.increment(1),
                }, { merge: true });
            } catch (error) {
                if (error.code !== ALREADY_EXISTS) throw error;
            }
        }

        logger.info(`Search activity recorded: ${normalizedQuery} (authenticated: ${isAuthenticated})`);

        return {
            success: true,
            recorded: true
        };

    } catch (error) {
        logger.error("Error recording search activity:", error);

        if (error instanceof HttpsError) {
            throw error;
        }

        // Don't fail the search if logging fails
        return {
            success: false,
            error: error.message
        };
    }
});

// ===== Product analytics =====
// analyticsEvents/{auto}: one doc per event sent by public/analytics.js, which batches them.
// No cookies and no third-party scripts: the browser keeps a random visitor id in localStorage.
// Own traffic is tagged internal (the admin account, or a browser that opened any page with
// ?internal=1). Read the funnel with frontend-firebase/tools/analytics_report.py.

const ANALYTICS_EVENTS = new Set([
    'page_view',
    'search',             // props: query, source (typed|example|url|history), results, episodes, ms | error
    'answer_shown',       // props: ok, sources
    'moment_play',        // props: videoId, start, via (thumbnail|seek|answer)
    'youtube_open',       // props: videoId, start
    'citation_copy',      // props: videoId, start
    'search_link_copy',   // props: query
    'compile_click',      // props: segments, signedIn
    'signin_prompt',      // props: context
    'signin_complete',    // props: method
    'job_created',        // props: segments, seconds
    'job_complete',       // props: jobId
    'video_download',     // props: jobId, page
]);
const MAX_EVENTS_PER_CALL = 20;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PROP_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const analyticsLimiter = new RateLimiter(120, 60 * 1000);

function cleanProps(value) {
    const props = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return props;
    for (const [key, v] of Object.entries(value).slice(0, 12)) {
        if (!PROP_KEY_RE.test(key)) continue;
        if (typeof v === 'string') props[key] = v.slice(0, 300);
        else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) props[key] = v;
    }
    return props;
}

function cleanText(value, maxLength) {
    return typeof value === 'string' && value ? value.slice(0, maxLength) : null;
}

// Analytics must never break a page, so bad input is dropped rather than rejected.
export const trackEvents = onCall({
    memory: "256MiB",
    timeoutSeconds: 10,
    maxInstances: 5,
    minInstances: 0,
}, async (request) => {
    if (!analyticsLimiter.take(clientIp(request))) return { recorded: 0 };
    const data = request.data || {};
    const visitorId = typeof data.visitorId === 'string' && CLIENT_ID_RE.test(data.visitorId) ? data.visitorId : null;
    if (!visitorId || !Array.isArray(data.events)) return { recorded: 0 };

    const sessionId = typeof data.sessionId === 'string' && CLIENT_ID_RE.test(data.sessionId) ? data.sessionId : null;
    const internal = data.internal === true || isAdmin(request.auth);
    const device = data.device === 'mobile' ? 'mobile' : 'desktop';
    const now = new Date();
    const date = utcDay(now);

    const batch = db.batch();
    let recorded = 0;
    for (const event of data.events.slice(0, MAX_EVENTS_PER_CALL)) {
        if (!event || !ANALYTICS_EVENTS.has(event.name)) continue;
        // Client clocks can be wrong; keep their timestamp only if it is within a day of ours.
        const clientAt = typeof event.ts === 'number' && Math.abs(event.ts - now.getTime()) < 86400000
            ? new Date(event.ts) : null;
        batch.create(db.collection('analyticsEvents').doc(), {
            name: event.name,
            props: cleanProps(event.props),
            visitorId,
            sessionId,
            userId: request.auth?.uid || null,
            internal,
            device,
            path: cleanText(event.path, 200),
            date,
            clientAt,
            createdAt: now,
            expireAt: new Date(now.getTime() + LOG_RETENTION_MS),
        });
        recorded++;
    }
    if (recorded === 0) return { recorded };

    try {
        await batch.commit();
    } catch (error) {
        logger.error("trackEvents: write failed", { message: error.message, recorded });
        return { recorded: 0 };
    }
    return { recorded };
});
