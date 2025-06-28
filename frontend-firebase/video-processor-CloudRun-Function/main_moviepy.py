import base64
import json
import os
import tempfile
import logging
import random
import time
import shutil
import re
import uuid
import requests
from datetime import datetime, timedelta
from pathlib import Path
import logging
import sys

import functions_framework
from flask import Flask, request, jsonify
from flask_cors import CORS

from google.cloud import storage
from google.cloud import firestore
from google.cloud import pubsub_v1
from google.auth import default
from google.auth.transport.requests import Request
from google.oauth2 import service_account
from google.cloud.exceptions import NotFound, GoogleCloudError
import glob

# MoviePy imports instead of ffmpeg-python
from moviepy import VideoFileClip, concatenate_videoclips
from apify_client import ApifyClient

# Set up logging to work in Cloud Run environment
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    )
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

BUCKET_NAME = "jre-processed-clips-bucker"
FIRESTORE_DB = "jre-clipper-db"

apify_token = os.environ.get("APIFY_KEY")
if not apify_token:
    logger.error("APIFY_KEY environment variable is not set")
    apify_client = None
else:
    apify_client = ApifyClient(apify_token)
    logger.info("Apify client initialized successfully")

storage_client = None
firestore_client = None
project_id = None
gcs_service_account_json_apify = os.environ.get("GCS_SERVICE_ACCOUNT_JSON_APIFY")
gcs_service_account_json = os.environ.get("GCS_SERVICE_ACCOUNT_JSON")

try:
    # Parse and validate service account JSON
    service_account_info = json.loads(gcs_service_account_json)

    # Validate required fields
    required_fields = ["type", "project_id", "private_key", "client_email"]
    if not all(field in service_account_info for field in required_fields):
        raise ValueError("Missing required fields in service account JSON")

    # Create credentials with proper scopes
    credentials = service_account.Credentials.from_service_account_info(
        service_account_info, scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )

    project_id = service_account_info.get("project_id")

    # Initialize clients
    storage_client = storage.Client(credentials=credentials, project=project_id)
    firestore_client = firestore.Client(
        credentials=credentials, project=project_id, database=FIRESTORE_DB
    )

    logger.info(
        f"Initialized clients for project: {project_id}, Firestore DB: {FIRESTORE_DB}"
    )
    logger.info("Using service account credentials (supports signed URLs)")

except (json.JSONDecodeError, ValueError, KeyError) as e:
    logger.error(f"Service account JSON error: {e}")
    gcs_service_account_json = None  # Force fallback
except Exception as e:
    logger.error(f"Failed to initialize clients with service account: {e}")
    gcs_service_account_json = None  # Force fallback

# Fallback to default credentials
if not storage_client:
    try:
        credentials, default_project_id = default()
        project_id = project_id or default_project_id

        storage_client = storage.Client(credentials=credentials, project=project_id)
        firestore_client = firestore.Client(
            credentials=credentials, project=project_id, database=FIRESTORE_DB
        )

        logger.info(f"Using default credentials for project: {project_id}")
        logger.warning("Default credentials may not support signed URLs")

    except Exception as e:
        logger.error(f"Failed to initialize with default credentials: {e}")

        # Last resort
        try:
            storage_client = storage.Client()
            firestore_client = firestore.Client(database=FIRESTORE_DB)
            logger.warning("Initialized clients without explicit project/credentials")
        except Exception as final_e:
            logger.error(f"Complete initialization failure: {final_e}")
            raise RuntimeError(f"Cannot initialize GCP clients: {final_e}")

def update_job_status(
    job_id,
    status,
    progress=None,
    message=None,
    error=None,
    video_url=None,
    suggestions=None,
    download_progress=None,
):
    """
    Update job status in Firestore with enhanced error information
    """
    try:
        job_ref = firestore_client.collection("videoJobs").document(job_id)

        update_data = {"status": status, "updatedAt": datetime.now()}

        if progress is not None:
            update_data["progress"] = progress
        if message:
            update_data["progressMessage"] = message
        if error:
            update_data["error"] = error
        if video_url:
            update_data["finalVideoUrl"] = video_url
        if suggestions:
            update_data["suggestions"] = suggestions
        if download_progress is not None:
            update_data["download_progress"] = download_progress

        job_ref.update(update_data)
        logger.info(f"Updated job {job_id} status: {status}")

    except Exception as e:
        logger.error(f"Failed to update job status: {e}")

# Initialize Pub/Sub publisher client for publishing video processing jobs
pubsub_publisher = None
try:
    if credentials:
        pubsub_publisher = pubsub_v1.PublisherClient(credentials=credentials)
    else:
        pubsub_publisher = pubsub_v1.PublisherClient()
    logger.info("Pub/Sub publisher client initialized successfully")
except Exception as e:
    logger.error(f"Failed to initialize Pub/Sub publisher: {e}")
    pubsub_publisher = None

# Single HTTP entry point for Cloud Run with routing
@functions_framework.http
def main_handler(request):
    """
    Main HTTP handler that routes requests to appropriate functions based on path
    """
    # Enable CORS for all requests
    if request.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "3600",
        }
        return ("", 204, headers)

    # Route based on path
    path = request.path.strip("/")

    if path == "processVideoJob":
        return processVideoJob(request)
    elif path == "handleVideoDownloadSuccess":
        return handleVideoDownloadSuccess(request)
    elif path == "getSourceVideos":
        return getSourceVideos(request)
    elif path == "getApifyProgress":
        return getApifyProgress(request)
    else:
        return (
            jsonify({"error": f"Unknown endpoint: /{path}"}),
            404,
            {"Access-Control-Allow-Origin": "*"},
        )

def processVideoJob(request):
    """
    Request format: {
        segments: [
            {
                videoId: "VIDEO_ID",
                startTimeSeconds: 0,
                endTimeSeconds: 60
            },
            ...
        ],
        user_session_id: "client_session_id",
    }
    """
    headers = {"Access-Control-Allow-Origin": "*"}

    try:
        # Parse request JSON
        request_json = request.get_json(silent=True)
        if not request_json:
            return jsonify({"error": "Invalid JSON payload"}), 400, headers

        segments = request_json.get("segments")
        user_session_id = request_json.get("user_session_id")

        # Check if Apify client is available
        if not apify_client:
            return (
                jsonify(
                    {
                        "error": "Apify client not initialized - APIFY_KEY environment variable is required"
                    }
                ),
                500,
                headers,
            )

        # Validate required environment variable
        if not gcs_service_account_json_apify:
            return (
                jsonify(
                    {
                        "error": "GCS_SERVICE_ACCOUNT_JSON_APIFY environment variable is not set"
                    }
                ),
                500,
                headers,
            )

        # Validate segments data
        if not segments or not isinstance(segments, list) or len(segments) == 0:
            error_msg = f"Invalid segments data: {segments}"
            print(error_msg)  # Fallback logging
            if logger:
                logger.error(error_msg)
            return (
                jsonify(
                    {
                        "error": "The function must be called with a segments array containing videoId, startTimeSeconds, and endTimeSeconds."
                    }
                ),
                400,
                headers,
            )

        info_msg = f"Received request to process {len(segments)} segments for user session {user_session_id}"
        print(info_msg)  # Fallback logging
        if logger:
            logger.info(info_msg)

        # Extract unique video IDs from all segments
        unique_video_ids = []
        seen_video_ids = set()

        for segment in segments:
            video_id = segment.get("videoId")
            if not video_id:
                return (
                    jsonify({"error": "videoId is required in all segments"}),
                    400,
                    headers,
                )

            if video_id not in seen_video_ids:
                unique_video_ids.append(video_id)
                seen_video_ids.add(video_id)

        if not unique_video_ids:
            return (
                jsonify({"error": "No valid video IDs found in segments"}),
                400,
                headers,
            )

        info_msg = f"Found {len(unique_video_ids)} unique videos to process: {unique_video_ids}"
        print(info_msg)  # Fallback logging
        if logger:
            logger.info(info_msg)

        # Check for existing videos in GCS to avoid unnecessary downloads
        existing_videos = check_existing_videos_in_gcs(unique_video_ids)

        # Separate videos that need downloading from those already available
        videos_needing_download = []
        videos_already_available = []

        for video_id in unique_video_ids:
            if existing_videos.get(video_id):
                videos_already_available.append(video_id)
                logger.info(
                    f"Video {video_id} already exists in GCS: {existing_videos[video_id]}"
                )
            else:
                videos_needing_download.append(video_id)
                logger.info(f"Video {video_id} needs to be downloaded")

        info_msg = f"GCS optimization results: {len(videos_already_available)} videos exist, {len(videos_needing_download)} need downloading"
        print(info_msg)  # Fallback logging
        if logger:
            logger.info(info_msg)

        # Generate a job ID for this processing request
        job_id = str(uuid.uuid4())

        # Determine processing strategy based on video availability
        if len(videos_needing_download) == 0:
            # All videos are already available - skip download and go straight to processing
            logger.info("All videos already exist in GCS - skipping download phase")

            # Create job document in Firestore (no Apify run needed)
            firestore_client.collection("videoJobs").document(job_id).set(
                {
                    "userSessionId": user_session_id,
                    "createdAt": datetime.now(),
                    "videoIds": unique_video_ids,
                    "totalVideos": len(unique_video_ids),
                    "segmentCount": len(segments),
                    "status": "Processing",  # Skip download phase
                    "segments": segments,
                    "videosAlreadyAvailable": videos_already_available,
                    "videosNeedingDownload": [],
                    "skipDownload": True,
                }
            )

            # Update status to indicate we're queueing for processing
            update_job_status(
                job_id,
                "Queued",
                40,
                f"All {len(videos_already_available)} videos found in storage - queueing for processing...",
            )

            # Publish job to Pub/Sub for background processing
            job_data = {
                "videoIds": unique_video_ids, 
                "segments": segments,
                "userSessionId": user_session_id,
                "videosAlreadyAvailable": videos_already_available,
                "videosNeedingDownload": [],
                "skipDownload": True
            }
            
            try:
                message_id = publish_video_processing_job(job_id, job_data)
                logger.info(f"Published video processing job {job_id} to Pub/Sub with message ID: {message_id}")
                
                # Update status to indicate job has been queued
                update_job_status(
                    job_id,
                    "Queued",
                    45,
                    "Job queued for background processing...",
                )
            except Exception as pub_error:
                logger.error(f"Failed to publish job to Pub/Sub: {pub_error}")
                update_job_status(
                    job_id,
                    "Failed",
                    error=str(pub_error),
                    suggestions=["Failed to queue job for processing", "Please try again"]
                )
                return jsonify({"error": f"Failed to queue job for processing: {str(pub_error)}"}), 500, headers

            # Return immediately without waiting for processing to complete
            logger.info(
                f"Queued background processing for job {job_id} via Pub/Sub - returning immediately"
            )

            return (
                jsonify(
                    {
                        "message": f"Video processing queued - all videos were pre-downloaded",
                        "jobId": job_id,
                        "status": "Queued",
                        "totalVideos": len(unique_video_ids),
                        "totalSegments": len(segments),
                        "videosSkipped": len(videos_already_available),
                        "finalVideoUrl": None,  # Will be available once processing completes
                        "note": "Processing queued via message queue due to existing videos in storage. Check job status for updates.",
                    }
                ),
                201,
                headers,
            )

        else:
            # Some or all videos need downloading - use Apify
            logger.info(
                f"Starting Apify download for {len(videos_needing_download)} videos"
            )

            # Prepare the Actor input with videos that need downloading
            videos_list = []
            for video_id in videos_needing_download:
                videos_list.append(
                    {
                        "url": f"https://www.youtube.com/watch?v={video_id}",
                        "method": "GET",
                    }
                )

            run_input = {
                "videos": videos_list,
                "preferredFormat": "mp4",
                "preferredQuality": "480p",
                "filenameTemplateParts": ["title"],
                "googleCloudBucketName": "jre-all-episodes",
                "googleCloudServiceKey": gcs_service_account_json_apify,
            }

            # Start the Actor asynchronously (non-blocking)
            run = apify_client.actor("UUhJDfKJT2SsXdclR").start(run_input=run_input)

            # Check if the actor was started successfully
            if not run or "id" not in run:
                return jsonify({"error": "Failed to start Apify actor"}), 500, headers

            # Use Apify run ID as the job ID for tracking
            job_id = run["id"]

            # Create a new job document in Firestore with enhanced tracking
            firestore_client.collection("videoJobs").document(job_id).set(
                {
                    "apifyRunId": job_id,
                    "userSessionId": user_session_id,
                    "createdAt": datetime.now(),
                    "videoIds": unique_video_ids,  # Store all video IDs
                    "totalVideos": len(unique_video_ids),  # Total videos in request
                    "segmentCount": len(
                        segments
                    ),  # Track total segments across all videos
                    "status": "Downloading",  # Current state
                    "segments": segments,  # Store full segment data for later processing
                    "videosAlreadyAvailable": videos_already_available,  # Videos that were pre-downloaded
                    "videosNeedingDownload": videos_needing_download,  # Videos being downloaded now
                    "skipDownload": False,
                }
            )

            info_msg = f"Started Apify actor for job ID: {job_id} with {len(videos_needing_download)} videos (skipped {len(videos_already_available)} existing)"
            print(info_msg)  # Fallback logging
            if logger:
                logger.info(info_msg)

            return (
                jsonify(
                    {
                        "message": f"Video processing job started with ID {job_id} for {len(unique_video_ids)} unique videos",
                        "jobId": job_id,
                        "status": "Downloading",
                        "totalVideos": len(unique_video_ids),
                        "totalSegments": len(segments),
                        "videosSkipped": len(videos_already_available),
                        "videosDownloading": len(videos_needing_download),
                        "note": "Job is running in background. Use the webhook or check job status for updates.",
                    }
                ),
                201,
                headers,
            )

    except Exception as e:
        error_msg = f"Error processing video job request: {e}"
        print(error_msg)  # Fallback logging
        if logger:
            logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

# HTTP webhook endpoint to signal successful YT Download operation from Apify actor run
def handleVideoDownloadSuccess(request):
    """
    Webhook endpoint called by Apify when video download is successful.
    Expected payload: {
        "runId": "apify_run_id",
        "runStatus": "SUCCEEDED"
    }
    """
    headers = {"Access-Control-Allow-Origin": "*"}

    try:
        request_json = request.get_json(silent=True)
        if not request_json or "runId" not in request_json:
            error_msg = "Invalid webhook payload: missing runId"
            print(error_msg)  # Fallback logging
            if logger:
                logger.error(error_msg)
            return jsonify({"error": "runId is required"}), 400, headers

        job_run_id = request_json["runId"]
        info_msg = f"Received download success webhook for job: {job_run_id}"
        print(info_msg)  # Fallback logging
        if logger:
            logger.info(info_msg)

        # Check if job exists
        job_ref = firestore_client.collection("videoJobs").document(job_run_id)
        job_doc = job_ref.get()

        if not job_doc.exists:
            error_msg = f"Job {job_run_id} not found in database"
            print(error_msg)  # Fallback logging
            if logger:
                logger.error(error_msg)
            return jsonify({"error": "Run Job not found"}), 404, headers

        job_data = job_doc.to_dict()
        current_status = job_data.get("status", "Processing")

        # Update job status to indicate successful download and queueing for processing
        update_job_status(
            job_run_id,
            "Queued",
            50,
            "Videos downloaded successfully, queueing for segment processing...",
        )

        info_msg = f"Successfully updated job {job_run_id} to Queued status"
        print(info_msg)  # Fallback logging
        if logger:
            logger.info(info_msg)

        # Publish to Pub/Sub for background processing instead of direct processing
        try:
            logger.info(f"Publishing segment processing job {job_run_id} to Pub/Sub")

            message_id = publish_video_processing_job(job_run_id, job_data)
            logger.info(f"Published video processing job {job_run_id} to Pub/Sub with message ID: {message_id}")
            
            # Update status to indicate job has been queued
            update_job_status(
                job_run_id,
                "Queued",
                55,
                "Job queued for background processing...",
            )

        except Exception as pub_error:
            logger.error(f"Failed to publish job to Pub/Sub after download: {pub_error}")

            # Update job status with error
            suggestions = [
                "Video download succeeded but failed to queue for processing",
                "This could be due to messaging system issues",
                "Please try submitting the job again",
            ]

            update_job_status(
                job_run_id,
                "Failed",
                error=f"Failed to queue for processing: {str(pub_error)}",
                suggestions=suggestions,
            )

            # Still return success for webhook (download succeeded, processing failed)
            return (
                jsonify(
                    {
                        "message": "Download succeeded but failed to queue for processing",
                        "jobId": job_run_id,
                        "downloadStatus": "Complete",
                        "error": str(pub_error),
                    }
                ),
                500,
                headers,
            )

        return (
            jsonify(
                {
                    "message": "Job download completed and queued for processing",
                    "jobId": job_run_id,
                    "status": "Queued",
                    "messageId": message_id,
                }
            ),
            200,
            headers,
        )

    except Exception as e:
        error_msg = f"Error handling video download success webhook: {e}"
        print(error_msg)  # Fallback logging
        if logger:
            logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

def getSourceVideos(request):
    """
    Get download URLs for source videos of a completed job.
    Request format: GET /getSourceVideos?jobId=<job_id>
    """
    headers = {"Access-Control-Allow-Origin": "*"}

    try:
        # Get job ID from query parameters
        job_id = request.args.get("jobId")
        if not job_id:
            return jsonify({"error": "jobId query parameter is required"}), 400, headers

        # Get job document from Firestore
        job_ref = firestore_client.collection("videoJobs").document(job_id)
        job_doc = job_ref.get()

        if not job_doc.exists:
            return jsonify({"error": "Job not found"}), 404, headers

        job_data = job_doc.to_dict()

        # Check if job has downloaded source videos
        if job_data.get("status") not in [
            "Downloaded",
            "Processing",
            "Uploading",
            "Complete",
        ]:
            return (
                jsonify(
                    {
                        "error": "Source videos not yet available. Job must be in Downloaded status or later."
                    }
                ),
                400,
                headers,
            )

        source_videos = []

        # Get source video information from job data
        segments = job_data.get("segments", [])
        if not segments:
            return jsonify({"error": "No segments found for this job"}), 404, headers

        # Get unique video IDs from segments
        video_ids = list(
            set(
                segment.get("videoId") for segment in segments if segment.get("videoId")
            )
        )

        # For each video ID, generate GCS download URL
        for video_id in video_ids:
            try:
                # Source videos are stored in jre-all-episodes bucket by Apify
                # Pattern: {videoId}_{VideoTitle}.mp4.mp4
                bucket = storage_client.bucket(
                    "jre-all-episodes"
                )  # Source videos bucket

                # Use regex to find the actual blob name
                import re

                video_pattern = rf"^{re.escape(video_id)}_.*\.mp4\.mp4$"

                # List all blobs and find matching one
                blobs_list = list(bucket.list_blobs())
                video_blob = None

                for blob in blobs_list:
                    if re.match(video_pattern, blob.name):
                        video_blob = blob
                        break

                if video_blob:
                    # Generate a signed URL for download (valid for 1 hour)
                    download_url = video_blob.generate_signed_url(
                        expiration=datetime.utcnow() + timedelta(hours=1), method="GET"
                    )

                    source_videos.append(
                        {
                            "videoId": video_id,
                            "url": download_url,
                            "title": f"Source Video {video_id}",
                            "filename": video_blob.name,  # Use actual filename from GCS
                        }
                    )
                else:
                    logger.warning(
                        f"Source video not found in GCS for pattern: {video_id}_*.mp4.mp4"
                    )

            except Exception as e:
                logger.error(f"Error getting source video for {video_id}: {e}")
                continue

        if not source_videos:
            return jsonify({"error": "No source videos found in storage"}), 404, headers

        return (
            jsonify(
                {
                    "jobId": job_id,
                    "sourceVideos": source_videos,
                    "totalVideos": len(source_videos),
                }
            ),
            200,
            headers,
        )

    except Exception as e:
        error_msg = f"Error getting source videos: {e}"
        print(error_msg)  # Fallback logging
        if logger:
            logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

def get_apify_run_progress(apify_run_id):
    """
    Fetch progress information from Apify API for a specific run.
    Returns run details including status, stats, and completion info.
    """
    try:
        # Check if Apify client is available
        if not apify_client:
            return {"error": "Apify client not initialized - APIFY_KEY not configured"}
        
        # Use the Apify Python client to get run details
        run_info = apify_client.run(apify_run_id).get()
        
        if not run_info:
            return {"error": "Run not found or access denied"}
        
        return run_info
        
    except Exception as e:
        logger.error(f"Error fetching Apify run progress: {e}")
        return {"error": f"Failed to fetch run details: {str(e)}"}

def calculate_download_progress(video_ids, apify_progress):
    """
    Calculate download progress percentage based on video IDs and Apify run status.
    Checks GCS bucket to see which videos have been downloaded.
    """
    try:
        if not video_ids:
            return 0
        
        # Check Apify run status first
        apify_status = apify_progress.get("status", "").upper()
        
        # If Apify run hasn't started or failed, progress is 0
        if apify_status in ["READY", "RUNNING"] and not apify_progress.get("startedAt"):
            return 0
        
        # If Apify run failed, return 0
        if apify_status in ["FAILED", "ABORTED", "TIMED_OUT"]:
            return 0
        
        # Check which videos are already downloaded in GCS
        existing_videos = check_existing_videos_in_gcs(video_ids)
        downloaded_count = sum(1 for blob_name in existing_videos.values() if blob_name is not None)
        
        progress_percentage = (downloaded_count / len(video_ids)) * 100
        
        # If Apify run is finished but not all videos are downloaded, cap at 95%
        # This handles cases where some videos might have failed to download
        if apify_status == "SUCCEEDED" and progress_percentage < 100:
            progress_percentage = min(progress_percentage, 95)
        
        # If all videos are downloaded, return 100%
        if downloaded_count == len(video_ids):
            progress_percentage = 100
        
        logger.info(f"Download progress: {downloaded_count}/{len(video_ids)} videos ({progress_percentage:.1f}%)")
        return round(progress_percentage, 1)
        
    except Exception as e:
        logger.error(f"Error calculating download progress: {e}")
        return 0

def getApifyProgress(request):
    """
    Get granular Apify download progress for a job.
    Request format: GET /getApifyProgress?jobId=<job_id>
    Returns progress details including per-video download status.
    """
    headers = {"Access-Control-Allow-Origin": "*"}

    try:
        # Get job ID from query parameters
        job_id = request.args.get("jobId")
        if not job_id:
            return jsonify({"error": "jobId query parameter is required"}), 400, headers

        # Get job document from Firestore
        job_ref = firestore_client.collection("videoJobs").document(job_id)
        job_doc = job_ref.get()

        if not job_doc.exists:
            return jsonify({"error": "Job not found"}), 404, headers

        job_data = job_doc.to_dict()

        # Check if job has an apify_run_id
        apify_run_id = job_data.get("apifyRunId")  # Note: using camelCase to match job creation
        if not apify_run_id:
            return jsonify({
                "error": "No Apify run ID found for this job",
                "jobId": job_id,
                "status": job_data.get("status", "Unknown")
            }), 400, headers

        # Check if job is in downloading status
        current_status = job_data.get("status")
        if current_status not in ["Queued", "Downloading"]:
            # If job is already past downloading, return completed state
            return jsonify({
                "jobId": job_id,
                "apifyRunId": apify_run_id,
                "status": current_status,
                "isDownloadComplete": True,
                "progress": 100,
                "message": f"Download phase completed. Current status: {current_status}"
            }), 200, headers

        # Get Apify progress
        apify_progress = get_apify_run_progress(apify_run_id)
        
        if apify_progress.get("error"):
            return jsonify({
                "error": f"Failed to fetch Apify progress: {apify_progress['error']}",
                "jobId": job_id,
                "apifyRunId": apify_run_id
            }), 500, headers

        # Calculate download progress based on job segments
        segments = job_data.get("segments", [])
        video_ids = list(set(segment.get("videoId") for segment in segments if segment.get("videoId")))
        
        download_progress = calculate_download_progress(video_ids, apify_progress)

        # Update job status with download progress if significant change
        current_download_progress = job_data.get("download_progress", 0)
        if abs(download_progress - current_download_progress) >= 5:  # Update every 5% change
            update_job_status(
                job_id=job_id,
                status="Downloading",
                progress=None,  # Keep overall progress unchanged
                message=f"Downloading videos... {download_progress}% complete",
                download_progress=download_progress
            )

        return jsonify({
            "jobId": job_id,
            "apifyRunId": apify_run_id,
            "status": current_status,
            "isDownloadComplete": download_progress >= 100,
            "downloadProgress": download_progress,
            "totalVideos": len(video_ids),
            "videoIds": video_ids,
            "apifyDetails": {
                "runId": apify_run_id,
                "status": apify_progress.get("status"),
                "runStartedAt": apify_progress.get("startedAt"),
                "runFinishedAt": apify_progress.get("finishedAt"),
                "stats": apify_progress.get("stats", {})
            },
            "message": f"Downloading videos... {download_progress}% complete"
        }), 200, headers

    except Exception as e:
        error_msg = f"Error getting Apify progress: {e}"
        print(error_msg)  # Fallback logging
        if logger:
            logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

def check_existing_videos_in_gcs(video_ids, source_bucket="jre-all-episodes"):
    """
    Check which video IDs already have videos downloaded in GCS bucket
    Returns dict: {video_id: blob_name or None}
    """
    try:
        logger.info(f"Checking for existing videos in GCS bucket: {source_bucket}")

        # Connect to the source bucket (where Apify uploads)
        source_bucket_obj = storage_client.bucket(source_bucket)

        # List all blobs to find existing video files
        # Convert iterator to list to avoid "Iterator has already started" error
        blobs_list = list(source_bucket_obj.list_blobs())
        logger.info(f"Found {len(blobs_list)} total blobs in {source_bucket}")

        existing_videos = {}

        for video_id in video_ids:
            # Use regex to find video files matching the pattern: {videoId}_*.mp4.mp4
            video_pattern = rf"^{re.escape(video_id)}_.*\.mp4\.mp4$"

            found_blob = None
            for blob in blobs_list:
                if re.match(video_pattern, blob.name):
                    found_blob = blob.name
                    logger.info(f"Found existing video for {video_id}: {blob.name}")
                    break

            existing_videos[video_id] = found_blob

            if not found_blob:
                logger.info(f"No existing video found for {video_id}")

        existing_count = sum(1 for blob_name in existing_videos.values() if blob_name)
        missing_count = len(video_ids) - existing_count

        logger.info(
            f"GCS check results: {existing_count} videos already exist, {missing_count} need downloading"
        )

        return existing_videos

    except Exception as e:
        logger.error(f"Failed to check existing videos in GCS: {e}")
        # Return empty dict to indicate no existing videos found (safe fallback)
        return {video_id: None for video_id in video_ids}

def publish_video_processing_job(job_id, job_data):
    """
    Publish a video processing job to the Pub/Sub topic for background processing
    """
    try:
        if not pubsub_publisher:
            raise Exception("Pub/Sub publisher not initialized")
            
        # Define the topic path
        topic_path = pubsub_publisher.topic_path(project_id, "video-editing-job")
        
        # Prepare message data
        message_data = json.dumps(job_data).encode("utf-8")
        
        # Prepare message attributes
        message_attributes = {
            "jobId": job_id,
            "createdAt": datetime.now().isoformat() + "Z",
            "segmentCount": str(len(job_data.get("segments", []))),
            "totalVideos": str(len(job_data.get("videoIds", [])))
        }
        
        # Publish the message
        future = pubsub_publisher.publish(
            topic_path, 
            message_data, 
            **message_attributes
        )
        
        # Wait for the publish to complete
        message_id = future.result()
        
        logger.info(f"Published video processing job {job_id} to Pub/Sub topic with message ID: {message_id}")
        return message_id
        
    except Exception as e:
        logger.error(f"Failed to publish video processing job to Pub/Sub: {e}")
        raise Exception(f"Failed to publish job to message queue: {str(e)}")
