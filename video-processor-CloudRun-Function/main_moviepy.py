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

storage_client = None
firestore_client = None
project_id = None
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
    missing_videos=None,
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
        if missing_videos is not None:
            update_data["missingVideos"] = missing_videos

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
    elif path == "getSourceVideos":
        return getSourceVideos(request)
    elif path == "getJobStatus":
        return getJobStatus(request)
    elif path == "resumeVideoJob":
        return resumeVideoJob(request)
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

        # Validate segments data
        if not segments or not isinstance(segments, list) or len(segments) == 0:
            error_msg = f"Invalid segments data: {segments}"
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

        logger.info(f"Received request to process {len(segments)} segments for user session {user_session_id}")

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

        logger.info(f"Found {len(unique_video_ids)} unique videos to process: {unique_video_ids}")

        # Check for existing videos in GCS
        existing_videos = check_existing_videos_in_gcs(unique_video_ids)

        # Separate videos that are available from those that are missing
        videos_available = []
        videos_missing = []

        for video_id in unique_video_ids:
            if existing_videos.get(video_id):
                videos_available.append(video_id)
                logger.info(f"Video {video_id} found in GCS: {existing_videos[video_id]}")
            else:
                videos_missing.append(video_id)
                logger.warning(f"Video {video_id} not found in GCS - will be skipped")

        logger.info(f"GCS check results: {len(videos_available)} videos available, {len(videos_missing)} videos missing")

        # Generate a job ID for this processing request
        job_id = str(uuid.uuid4())

        # Determine processing strategy based on video availability
        if len(videos_available) == 0:
            # No videos are available - cannot proceed
            logger.error("No videos available in GCS - cannot process job")

            # Create job document in Firestore to track the failure
            firestore_client.collection("videoJobs").document(job_id).set(
                {
                    "userSessionId": user_session_id,
                    "createdAt": datetime.now(),
                    "videoIds": unique_video_ids,
                    "totalVideos": len(unique_video_ids),
                    "segmentCount": len(segments),
                    "status": "Failed",
                    "segments": segments,
                    "videosAvailable": [],
                    "videosMissing": videos_missing,
                    "error": f"All {len(videos_missing)} required videos are missing from storage",
                    "missingVideos": videos_missing,
                }
            )

            return (
                jsonify(
                    {
                        "error": f"All {len(videos_missing)} required videos are missing from storage",
                        "jobId": job_id,
                        "status": "Failed",
                        "missingVideos": videos_missing,
                        "suggestions": [
                            "The requested videos are not available in storage",
                            "Try searching for different content",
                            "Contact support if you believe this is an error"
                        ]
                    }
                ),
                400,
                headers,
            )

        else:
            # Some or all videos are available - proceed with processing
            logger.info(f"Proceeding with {len(videos_available)} available videos")

            # Filter segments to only include those with available videos
            available_segments = [
                segment for segment in segments 
                if segment.get("videoId") in videos_available
            ]

            logger.info(f"Filtered segments: {len(available_segments)} out of {len(segments)} segments can be processed")

            # Create job document in Firestore
            job_data = {
                "userSessionId": user_session_id,
                "createdAt": datetime.now(),
                "videoIds": videos_available,  # Only include available videos
                "originalVideoIds": unique_video_ids,  # Track original request
                "totalVideos": len(videos_available),
                "originalTotalVideos": len(unique_video_ids),
                "segmentCount": len(available_segments),
                "originalSegmentCount": len(segments),
                "status": "Processing",
                "segments": available_segments,  # Only include processable segments
                "originalSegments": segments,  # Track original request
                "videosAvailable": videos_available,
                "videosMissing": videos_missing,
                "skipDownload": True,  # No download needed - videos are pre-downloaded
            }

            # Add missing video information if any
            if videos_missing:
                job_data["missingVideos"] = videos_missing
                job_data["warningMessage"] = f"{len(videos_missing)} videos were missing from storage and will be skipped"

            firestore_client.collection("videoJobs").document(job_id).set(job_data)

            # Update status message based on missing videos
            if videos_missing:
                warning_msg = f"Processing {len(videos_available)} available videos - {len(videos_missing)} videos missing from storage"
                update_job_status(
                    job_id,
                    "Processing",
                    20,
                    warning_msg,
                    missing_videos=videos_missing,
                )
                logger.warning(f"Job {job_id}: {warning_msg}")
            else:
                update_job_status(
                    job_id,
                    "Processing",
                    20,
                    f"All {len(videos_available)} videos found in storage - processing segments...",
                )

            # Publish job to Pub/Sub for background processing
            try:
                message_id = publish_video_processing_job(job_id, job_data)
                logger.info(f"Published video processing job {job_id} to Pub/Sub with message ID: {message_id}")
                
                # Update status to indicate job has been queued
                final_status_msg = f"Job queued for processing with {len(videos_available)} videos"
                if videos_missing:
                    final_status_msg += f" ({len(videos_missing)} videos skipped due to missing files)"
                
                update_job_status(
                    job_id,
                    "Queued",
                    25,
                    final_status_msg,
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

            # Return response
            response_data = {
                "message": f"Video processing job started with {len(videos_available)} available videos",
                "jobId": job_id,
                "status": "Queued",
                "totalVideos": len(videos_available),
                "totalSegments": len(available_segments),
                "originalTotalVideos": len(unique_video_ids),
                "originalTotalSegments": len(segments),
                "note": "Job queued for background processing using pre-downloaded videos from storage."
            }

            # Add warning information if videos are missing
            if videos_missing:
                response_data["warning"] = f"{len(videos_missing)} videos were missing from storage"
                response_data["missingVideos"] = videos_missing
                response_data["videosSkipped"] = len(videos_missing)

            return (
                jsonify(response_data),
                201,
                headers,
            )

    except Exception as e:
        error_msg = f"Error processing video job request: {e}"
        logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

def resumeVideoJob(request):
    """
    Resume an existing video job by job ID
    Request format: POST /resumeVideoJob
    {
        "jobId": "existing_job_id"
    }
    """
    headers = {"Access-Control-Allow-Origin": "*"}

    try:
        # Parse request JSON
        request_json = request.get_json(silent=True)
        if not request_json:
            return jsonify({"error": "Invalid JSON payload"}), 400, headers

        job_id = request_json.get("jobId")
        if not job_id:
            return jsonify({"error": "jobId is required"}), 400, headers

        # Get existing job from Firestore
        job_ref = firestore_client.collection("videoJobs").document(job_id)
        job_doc = job_ref.get()

        if not job_doc.exists:
            return jsonify({"error": "Job not found"}), 404, headers

        job_data = job_doc.to_dict()
        
        # Extract segments from the existing job
        segments = job_data.get("originalSegments") or job_data.get("segments")
        if not segments:
            return jsonify({"error": "No segments found in existing job"}), 400, headers

        user_session_id = job_data.get("userSessionId", f"resumed_{job_id}")

        logger.info(f"Resuming job {job_id} with {len(segments)} segments")

        # Extract unique video IDs from segments
        unique_video_ids = []
        seen_video_ids = set()

        for segment in segments:
            video_id = segment.get("videoId")
            if video_id and video_id not in seen_video_ids:
                unique_video_ids.append(video_id)
                seen_video_ids.add(video_id)

        # Check for existing videos in GCS
        existing_videos = check_existing_videos_in_gcs(unique_video_ids)

        # Separate available and missing videos
        videos_available = []
        videos_missing = []

        for video_id in unique_video_ids:
            if existing_videos.get(video_id):
                videos_available.append(video_id)
            else:
                videos_missing.append(video_id)

        logger.info(f"Resume job {job_id}: {len(videos_available)} videos available, {len(videos_missing)} videos missing")

        if len(videos_available) == 0:
            # Update existing job with failure status
            update_job_status(
                job_id,
                "Failed",
                error=f"All {len(videos_missing)} required videos are missing from storage",
                missing_videos=videos_missing,
            )

            return jsonify({
                "error": f"All {len(videos_missing)} required videos are missing from storage",
                "jobId": job_id,
                "status": "Failed",
                "missingVideos": videos_missing,
            }), 400, headers

        # Filter segments to only include those with available videos
        available_segments = [
            segment for segment in segments 
            if segment.get("videoId") in videos_available
        ]

        # Update existing job document with new data
        updated_job_data = {
            "videoIds": videos_available,
            "totalVideos": len(videos_available),
            "segmentCount": len(available_segments),
            "status": "Processing",
            "segments": available_segments,
            "videosAvailable": videos_available,
            "videosMissing": videos_missing,
            "updatedAt": datetime.now(),
            "resumedAt": datetime.now(),
        }

        # Add missing video information if any
        if videos_missing:
            updated_job_data["missingVideos"] = videos_missing
            updated_job_data["warningMessage"] = f"{len(videos_missing)} videos were missing from storage and will be skipped"

        # Update the existing job document
        job_ref.update(updated_job_data)

        # Update status message
        if videos_missing:
            warning_msg = f"Resumed processing {len(videos_available)} available videos - {len(videos_missing)} videos missing from storage"
            update_job_status(
                job_id,
                "Processing",
                20,
                warning_msg,
                missing_videos=videos_missing,
            )
        else:
            update_job_status(
                job_id,
                "Processing",
                20,
                f"Resumed - all {len(videos_available)} videos found in storage",
            )

        # Publish job to Pub/Sub for background processing
        try:
            # Get the updated job data for pub/sub
            combined_job_data = {**job_data, **updated_job_data}
            message_id = publish_video_processing_job(job_id, combined_job_data)
            logger.info(f"Published resumed video processing job {job_id} to Pub/Sub with message ID: {message_id}")
            
            update_job_status(
                job_id,
                "Queued",
                25,
                f"Job resumed and queued for processing with {len(videos_available)} videos",
            )
        except Exception as pub_error:
            logger.error(f"Failed to publish resumed job to Pub/Sub: {pub_error}")
            update_job_status(
                job_id,
                "Failed",
                error=str(pub_error),
                suggestions=["Failed to queue resumed job for processing", "Please try again"]
            )
            return jsonify({"error": f"Failed to queue resumed job for processing: {str(pub_error)}"}), 500, headers

        # Return response with same job ID
        response_data = {
            "message": f"Video job resumed with {len(videos_available)} available videos",
            "jobId": job_id,  # Same job ID!
            "status": "Queued",
            "totalVideos": len(videos_available),
            "totalSegments": len(available_segments),
            "note": "Job resumed and queued for background processing."
        }

        if videos_missing:
            response_data["warning"] = f"{len(videos_missing)} videos were missing from storage"
            response_data["missingVideos"] = videos_missing
            response_data["videosSkipped"] = len(videos_missing)

        return jsonify(response_data), 200, headers

    except Exception as e:
        error_msg = f"Error resuming video job: {e}"
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

        # Check if job has available videos
        if job_data.get("status") not in [
            "Processing",
            "Queued",
            "Uploading",
            "Complete",
        ]:
            return (
                jsonify(
                    {
                        "error": "Source videos not yet available. Job must be in Processing status or later."
                    }
                ),
                400,
                headers,
            )

        source_videos = []

        # Get available video information from job data
        video_ids = job_data.get("videosAvailable", job_data.get("videoIds", []))
        if not video_ids:
            return jsonify({"error": "No available videos found for this job"}), 404, headers

        # For each video ID, generate GCS download URL
        for video_id in video_ids:
            try:
                # Source videos are stored in jre-all-episodes bucket
                bucket = storage_client.bucket("jre-all-episodes")

                # Find the actual blob using enhanced patterns
                existing_videos = check_existing_videos_in_gcs([video_id])
                blob_name = existing_videos.get(video_id)

                if blob_name:
                    video_blob = bucket.blob(blob_name)
                    
                    # Generate a signed URL for download (valid for 1 hour)
                    download_url = video_blob.generate_signed_url(
                        expiration=datetime.utcnow() + timedelta(hours=1), method="GET"
                    )

                    source_videos.append(
                        {
                            "videoId": video_id,
                            "url": download_url,
                            "title": f"Source Video {video_id}",
                            "filename": blob_name,
                        }
                    )
                else:
                    logger.warning(f"Source video not found in GCS for video ID: {video_id}")

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
        logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

def getJobStatus(request):
    """
    Get job status from Firestore.
    Request format: GET /getJobStatus?jobId=<job_id>
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

        # Convert datetime objects to strings for JSON serialization
        if job_data.get("createdAt"):
            job_data["createdAt"] = job_data["createdAt"].isoformat()
        if job_data.get("updatedAt"):
            job_data["updatedAt"] = job_data["updatedAt"].isoformat()

        return jsonify(job_data), 200, headers

    except Exception as e:
        error_msg = f"Error getting job status: {e}"
        logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

def check_existing_videos_in_gcs(video_ids, source_bucket="jre-all-episodes"):
    """
    Check which video IDs already have videos downloaded in GCS bucket
    Returns dict: {video_id: blob_name or None}
    """
    try:
        logger.info(f"Checking for existing videos in GCS bucket: {source_bucket}")

        # Connect to the source bucket (where videos are stored)
        source_bucket_obj = storage_client.bucket(source_bucket)

        # List all blobs to find existing video files
        # Convert iterator to list to avoid "Iterator has already started" error
        blobs_list = list(source_bucket_obj.list_blobs())
        logger.info(f"Found {len(blobs_list)} total blobs in {source_bucket}")

        existing_videos = {}

        for video_id in video_ids:
            # Enhanced regex patterns to match multiple video file formats:
            # - {videoId}_*.mp4.mp4 (original pattern)
            # - {videoId}_*.mp4 (new pattern)
            # - {videoId}.mp4 (new pattern)
            video_patterns = [
                rf"^{re.escape(video_id)}_.*\.mp4\.mp4$",  # Original: {videoId}_*.mp4.mp4
                rf"^{re.escape(video_id)}_.*\.mp4$",       # New: {videoId}_*.mp4
                rf"^{re.escape(video_id)}\.mp4$"           # New: {videoId}.mp4
            ]

            found_blob = None
            for blob in blobs_list:
                # Check if blob name matches any of the patterns
                for pattern in video_patterns:
                    if re.match(pattern, blob.name):
                        found_blob = blob.name
                        logger.info(f"Found existing video for {video_id}: {blob.name}")
                        break
                
                # Break outer loop if blob found
                if found_blob:
                    break

            existing_videos[video_id] = found_blob

            if not found_blob:
                logger.info(f"No existing video found for {video_id}")

        existing_count = sum(1 for blob_name in existing_videos.values() if blob_name)
        missing_count = len(video_ids) - existing_count

        logger.info(
            f"GCS check results: {existing_count} videos already exist, {missing_count} missing from storage"
        )

        return existing_videos

    except Exception as e:
        logger.error(f"Failed to check existing videos in GCS: {e}")
        # Return empty dict to indicate no existing videos found (safe fallback)
        return {video_id: None for video_id in video_ids}

def serialize_job_data_for_pubsub(job_data):
    """
    Convert Firestore DatetimeWithNanoseconds objects to JSON-serializable format
    """
    try:
        serialized_data = {}
        
        for key, value in job_data.items():
            if hasattr(value, 'isoformat'):  # Check if it's a datetime object
                # Convert datetime to ISO format string
                serialized_data[key] = value.isoformat()
            elif isinstance(value, list):
                # Handle lists that might contain datetime objects
                serialized_list = []
                for item in value:
                    if isinstance(item, dict):
                        # Recursively handle dictionaries in lists
                        serialized_item = {}
                        for sub_key, sub_value in item.items():
                            if hasattr(sub_value, 'isoformat'):
                                serialized_item[sub_key] = sub_value.isoformat()
                            else:
                                serialized_item[sub_key] = sub_value
                        serialized_list.append(serialized_item)
                    else:
                        serialized_list.append(item)
                serialized_data[key] = serialized_list
            else:
                serialized_data[key] = value
                
        return serialized_data
        
    except Exception as e:
        logger.error(f"Error serializing job data: {e}")
        raise

def publish_video_processing_job(job_id, job_data):
    """
    Publish a video processing job to the Pub/Sub topic for background processing
    """
    try:
        if not pubsub_publisher:
            raise Exception("Pub/Sub publisher not initialized")
            
        # Define the topic path
        topic_path = pubsub_publisher.topic_path(project_id, "video-editing-job")
        
        # Serialize job data to handle Firestore datetime objects
        serialized_job_data = serialize_job_data_for_pubsub(job_data)
        
        # Prepare message data
        message_data = json.dumps(serialized_job_data).encode("utf-8")
        
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