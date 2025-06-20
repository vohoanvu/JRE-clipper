# Project Status: "What would Joe Rogan say?" - Web App

**Date:** 2025-06-21
**Overall Status:** `In Progress`

---

## 1. Architecture Overview

This project has been implemented as a serverless web application using the Google Cloud Platform and Firebase.

-   **Frontend:** Firebase Hosting (Vanilla JavaScript, HTML, CSS)
    -   `index.html`: Main page with search functionality.
    -   `status.html`: Page to display the real-time status of a video generation job.
-   **Backend API:** Firebase Functions (Node.js)
    -   `getVertexAiToken`: A callable function that provides a short-lived OAuth 2.0 access token to the frontend for authenticating with Vertex AI Search.
    -   `initiateVideoJob`: A callable function that receives video segments from the frontend, creates a job document in Firestore, and publishes a message to a Pub/Sub topic to trigger the video processor.
    -   `processVideoFromPubSub`: Pub/Sub triggered function for video processing using yt-dlp and FFmpeg.
-   **Video Processing:** Firebase Functions (Node.js, ffmpeg, yt-dlp)
    -   **Updated Architecture**: Moved from Cloud Run to Firebase Functions for simpler deployment and better integration.
    -   Downloads YouTube videos using direct yt-dlp subprocess calls.
    -   Processes video segments using FFmpeg with efficient filter chains.
    -   Uploads final videos to Google Cloud Storage.
-   **Job Management:** Firestore
    -   A `videoJobs` collection stores the status, progress, and final output URL for each video generation request.
-   **Video Storage:** Google Cloud Storage
    -   A dedicated bucket (`jre-processed-clips-bucker`) to store the generated video summaries.
-   **Search Provider:** Vertex AI Search (Discovery Engine)
    -   Provides the core search functionality over the JRE episode transcripts.

---

## 2. Implementation Phases

| Phase                                      | Description                                                                                                                                                            | Status            | Notes / Blockers                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| **Phase 1: Frontend UI**                   | Create the user interface for searching, viewing results, and tracking job status.                                                                                     | `[x] Completed`   | UI is minimalist and functional.                                                 |
| **Phase 2: Vertex AI Search Integration**  | Implement the client-side logic to call the Vertex AI Search API and display results.                                                                                  | `[x] Completed`   | Using a custom implementation instead of the widget for more control.            |
| **Phase 3: Backend Foundation**            | Set up Firebase Functions for secure token handling and job initiation.                                                                                                | `[x] Completed`   | `getVertexAiToken` and `initiateVideoJob` functions are implemented.             |
| **Phase 4: Video Processing (Firebase Functions)**| Implement the core video processing logic using Firebase Functions with yt-dlp and FFmpeg.                                                                      | `[x] Completed`   | **MAJOR UPDATE**: YouTube download via direct yt-dlp subprocess calls working. FFmpeg video processing implemented. GCS upload configured.            |
| **Phase 5: Job Status & Tracking**         | Use Firestore to track job progress and update the `status.html` page in real-time.                                                                                    | `[x] Completed`   | Firestore listeners are implemented on the client-side.                          |
| **Phase 6: Deployment & E2E Testing**      | Deploy all components (Firebase Hosting, Functions) and conduct end-to-end testing of the entire workflow.                                                            | `[ ] Ready`       | All components implemented. Ready for deployment and testing.                    |

---

## 3. Milestone Checklist

| Milestone                                        | Requirement Addressed                                                              | Status  | Validation Notes                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| **M1: User can search for episodes**             | The user can enter a query and see a list of relevant video segments.              | `[x]`   | Verified. The frontend calls Vertex AI Search and displays results.           |
| **M2: User can initiate a video generation job** | The "Generate Video" button sends the selected segments to the backend.            | `[x]`   | Verified. The `initiateVideoJob` function is called with the correct data.    |
| **M3: Video processing job is triggered**        | The backend successfully publishes a message to Pub/Sub to start the job.          | `[ ]`   | To be verified after deployment.                                              |
| **M4: Video is correctly processed and uploaded**| The Cloud Run Job downloads, clips, concatenates, and uploads the video to GCS.    | `[ ]`   | To be verified after deployment.                                              |
| **M5: User can see real-time job status**        | The `status.html` page reflects the current state of the job from Firestore.       | `[x]`   | Verified. The page correctly listens for and displays status updates.         |
| **M6: User can download the final video**        | A download link for the generated video appears on the status page upon completion.| `[ ]`   | To be verified after a successful E2E run.                                    |

---

## 4. Deployment Stages

| Stage                           | Description                                                                                                                                                           | Status            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Stage 1: Local Development**  | Use the Firebase Emulator Suite to run Functions and test frontend interactions locally.                                                                              | `[x] Ready`       |
| **Stage 2: Firebase Deployment**| Deploy the frontend (Hosting) and backend functions to the Firebase project.                                                                                          | `[ ] Not Started` |
| **Stage 3: Cloud Run Deployment** | Build the Docker image for the video processor, push it to Google Artifact Registry, and create the Cloud Run Job with a Pub/Sub trigger.                             | `[ ] Not Started` |

---

## 5. Recent Progress: YouTube Download Implementation

**Date:** 2025-06-21
**Status:** `BREAKTHROUGH - YouTube downloading working!`

### Problem Solved: yt-dlp Integration Issues

**Issue:** The `youtube-dl-exec` Node.js wrapper was failing with "Failed to extract any player response" errors, even though the CLI version of yt-dlp worked perfectly.

**Root Cause:** The Node.js wrapper was not properly handling YouTube's anti-bot measures and SSL certificate verification.

**Solution Implemented:**
1. **Replaced Node.js wrapper with direct subprocess calls** - Using `child_process.exec` to call yt-dlp directly
2. **Progressive retry strategy** - 3 attempts with different quality levels and options
3. **Enhanced error handling** - Specific error messages for common YouTube issues
4. **Working command format:**
   ```bash
   yt-dlp --format "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best" 
          --no-playlist --max-filesize 500M --no-warnings --no-check-certificates 
          --retries 3 --fragment-retries 3 --skip-unavailable-fragments 
          "<video_url>"
   ```

**Test Results:**
- ✅ Successfully downloaded test video: Joe Rogan Experience #1366 - Richard Dawkins (149.15 MB)
- ✅ Direct yt-dlp subprocess calls working reliably
- ✅ Proper file detection and validation
- ✅ Clean temporary directory management

**Key Components Updated:**
- `/frontend-firebase/functions/index.js` - Updated `downloadYouTubeVideo` function
- `/frontend-firebase/functions/package.json` - Removed `youtube-dl-exec` dependency
- `/frontend-firebase/functions/.gitignore` - Added patterns for test files and videos

**Next Steps:**
- Deploy updated Firebase Functions
- End-to-end testing with full video processing pipeline
- Production validation

---