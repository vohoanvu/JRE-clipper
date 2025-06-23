import base64
import json
import os
import tempfile
import logging
import random
import time
import shutil
import subprocess
import re
import uuid
import threading
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

import yt_dlp
import ffmpeg
from apify_client import ApifyClient
import http.client

# Set up logging to work in Cloud Run environment
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

BUCKET_NAME = "jre-processed-clips-bucker"
FIRESTORE_DB = "jre-clipper-db"

apify_token = os.environ.get("APIFY_KEY")
if not apify_token:
    logger.error("APIFY_KEY environment variable is not set")
    api_client = None
else:
    api_client = ApifyClient(apify_token)
    logger.info("Apify client initialized successfully")

try:
    credentials, project_id = default()
    storage_client = storage.Client(credentials=credentials, project=project_id)
    firestore_client = firestore.Client(
        credentials=credentials, project=project_id, database=FIRESTORE_DB
    )
    logger.info(
        f"Initialized clients for project: {project_id}, Firestore DB: {FIRESTORE_DB}"
    )
except Exception as e:
    logger.error(f"Failed to initialize clients: {e}")
    storage_client = storage.Client()
    firestore_client = firestore.Client(database=FIRESTORE_DB)


def process_video_segments(video_path, segments, temp_dir, job_id):
    """
    Process video segments using ffmpeg-python
    Enhanced version with better error handling and progress tracking
    """
    # Create unique output filename for this video
    video_id = segments[0].get('videoId', 'unknown') if segments else 'unknown'
    output_path = os.path.join(temp_dir, f"processed_{video_id}_{job_id}.mp4")

    try:
        logger.info(f"Starting segment processing for job {job_id}")
        
        # Validate segments and convert to proper format
        valid_segments = []
        for segment in segments:
            try:
                start = float(segment.get("startTimeSeconds", 0))
                end = float(segment.get("endTimeSeconds", 0))
                if start >= 0 and end > start:
                    valid_segments.append({"start": start, "end": end, "videoId": segment.get("videoId")})
                    logger.info(f"Valid segment: {segment.get('videoId')} {start}s-{end}s")
                else:
                    logger.warning(f"Invalid segment skipped: start={start}, end={end}")
            except (ValueError, TypeError) as e:
                logger.warning(f"Skipping invalid segment due to format error: {e}")

        if not valid_segments:
            raise ValueError("No valid segments to process")

        logger.info(f"Processing {len(valid_segments)} valid segments from video: {video_path}")

        # Verify input video exists
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Input video file not found: {video_path}")

        # Update job status
        update_job_status(job_id, "Processing", 60, f"Processing {len(valid_segments)} video segments...")

        # Create input stream
        input_stream = ffmpeg.input(video_path)

        # Process segments
        video_segments = []
        audio_segments = []

        for i, segment in enumerate(valid_segments):
            duration = segment["end"] - segment["start"]
            logger.info(f"Processing segment {i+1}/{len(valid_segments)}: {segment['start']}s-{segment['end']}s (duration: {duration}s)")

            # Trim video and audio with safer approach
            video_segment = input_stream.video.filter(
                "trim", start=segment["start"], duration=duration
            ).filter("setpts", "PTS-STARTPTS")

            audio_segment = input_stream.audio.filter(
                "atrim", start=segment["start"], duration=duration  
            ).filter("asetpts", "PTS-STARTPTS")

            video_segments.append(video_segment)
            audio_segments.append(audio_segment)

        # Concatenate segments
        logger.info("Concatenating video segments...")
        if len(video_segments) > 1:
            video_concat = ffmpeg.concat(*video_segments, v=1, a=0)
            audio_concat = ffmpeg.concat(*audio_segments, v=0, a=1)
        else:
            video_concat = video_segments[0]
            audio_concat = audio_segments[0]

        # Update progress
        update_job_status(job_id, "Processing", 75, "Encoding final video...")

        # Output with optimized encoding settings for web
        output = ffmpeg.output(
            video_concat,
            audio_concat,
            output_path,
            vcodec="libx264",
            preset="medium",  # Better quality than "fast"
            crf=23,           # Good balance of quality and size
            acodec="aac",
            audio_bitrate="128k",
            movflags="+faststart",  # Enable web streaming
            **{"profile:v": "main", "level": "3.1"}  # Ensure compatibility
        )

        # Run ffmpeg with better error handling
        logger.info("Starting FFmpeg processing...")
        try:
            # Check if ffmpeg is available
            import subprocess  # Explicit import to ensure availability
            try:
                subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
            except (subprocess.CalledProcessError, FileNotFoundError):
                raise Exception("FFmpeg is not installed or not accessible. Please ensure FFmpeg is available in the environment.")
            
            ffmpeg.run(output, overwrite_output=True, capture_stdout=True, capture_stderr=True)
        except ffmpeg.Error as e:
            stderr = e.stderr.decode('utf-8') if e.stderr else "Unknown ffmpeg error"
            logger.error(f"FFmpeg failed: {stderr}")
            raise Exception(f"FFmpeg processing failed: {stderr}")
        except Exception as e:
            if "ffmpeg" in str(e).lower():
                raise Exception(f"FFmpeg not available: {str(e)}")
            else:
                raise

        # Verify output file
        if not os.path.exists(output_path):
            raise Exception("FFmpeg processing failed - no output file created")

        file_size = os.path.getsize(output_path)
        logger.info(f"Video processing completed: {output_path} ({file_size / 1024 / 1024:.2f} MB)")

        return output_path

    except Exception as e:
        logger.error(f"Video processing failed for job {job_id}: {e}")
        # Update job status with specific error
        error_msg = str(e)
        suggestions = []
        
        if "ffmpeg" in error_msg.lower():
            suggestions.append("FFmpeg processing failed - video encoding issue")
            suggestions.append("Try selecting shorter segments or fewer videos")
        elif "invalid" in error_msg.lower():
            suggestions.append("Invalid segment timestamps detected")
        else:
            suggestions.append("Video processing encountered an unexpected error")
            
        update_job_status(job_id, "Failed", error=error_msg, suggestions=suggestions)
        raise Exception(f"Failed to process video segments: {str(e)}")

def upload_to_gcs(local_path, job_id):
    """
    Upload processed video to Google Cloud Storage
    Enhanced with better error handling and progress tracking
    """
    try:
        logger.info(f"Starting upload to GCS for job {job_id}")
        update_job_status(job_id, "Uploading", 85, "Uploading final video to cloud storage...")
        
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"edited-clips/{job_id}/final_video.mp4"
        blob = bucket.blob(blob_name)

        logger.info(f"Uploading to GCS: gs://{BUCKET_NAME}/{blob_name}")

        # Upload file with progress tracking
        blob.upload_from_filename(local_path, content_type="video/mp4")

        # Generate signed URL for public access (valid for 7 days)
        # This works with uniform bucket-level access
        try:
            expiration_time = datetime.now() + timedelta(days=7)
            
            public_url = blob.generate_signed_url(
                version="v4",
                expiration=expiration_time,
                method="GET"
            )
            
            logger.info(f"Upload successful with signed URL (valid for 7 days)")
            logger.info(f"Signed URL generated successfully")
            
        except Exception as url_error:
            logger.warning(f"Failed to generate signed URL: {url_error}")
            # Fallback to basic GCS URL (may not be publicly accessible)
            public_url = f"https://storage.googleapis.com/{BUCKET_NAME}/{blob_name}"
            logger.info(f"Using fallback GCS URL: {public_url}")

        # Update job status with final URL
        update_job_status(job_id, "Complete", 100, "Video ready for download!", video_url=public_url)

        return public_url

    except Exception as e:
        logger.error(f"GCS upload failed for job {job_id}: {e}")
        error_msg = f"Failed to upload video: {str(e)}"
        suggestions = ["Upload to cloud storage failed", "Please try generating the video again"]
        update_job_status(job_id, "Failed", error=error_msg, suggestions=suggestions)
        raise Exception(error_msg)

def download_video_from_gcs(video_id, temp_dir, source_bucket="jre-content"):
    """
    Download video from GCS bucket where Apify uploaded it
    """
    try:
        logger.info(f"Downloading video {video_id} from GCS bucket: {source_bucket}")
        
        # Connect to the source bucket (where Apify uploads)
        source_bucket_obj = storage_client.bucket(source_bucket)
        
        # List all blobs to find the video file for this video_id
        # Convert iterator to list to avoid "Iterator has already started" error
        # Blobs are stored directly in root of bucket: {videoId}_{VideoTitle}.mp4.mp4
        blobs_list = list(source_bucket_obj.list_blobs())
        logger.info(f"Found {len(blobs_list)} blobs in {source_bucket}")
        
        video_blob = None
        
        # Use regex to find video files matching the pattern: {videoId}_*.mp4.mp4
        import re
        video_pattern = rf"^{re.escape(video_id)}_.*\.mp4\.mp4$"
        
        for blob in blobs_list:
            # Check if blob matches the expected pattern
            if re.match(video_pattern, blob.name):
                video_blob = blob
                logger.info(f"Found video file matching pattern: {blob.name}")
                break
        
        if not video_blob:
            # Fallback: try broader pattern matching for any video files containing the video_id
            logger.info(f"Exact pattern match failed, trying broader search for {video_id}")
            for blob in blobs_list:
                blob_name_lower = blob.name.lower()
                if (video_id.lower() in blob_name_lower and 
                    (blob_name_lower.endswith('.mp4') or blob_name_lower.endswith('.webm'))):
                    video_blob = blob
                    logger.info(f"Found video file with broader matching: {blob.name}")
                    break
        
        if not video_blob:
            # Log all available video files for debugging
            available_files = [blob.name for blob in blobs_list if blob.name.endswith(('.mp4', '.webm'))]
            logger.error(f"Video file for {video_id} not found. Pattern searched: {video_id}_*.mp4.mp4")
            logger.error(f"Available video files: {available_files[:10]}")  # Show first 10 files to avoid huge logs
            raise FileNotFoundError(f"Video file for {video_id} not found in GCS bucket {source_bucket}. Expected pattern: {video_id}_*.mp4.mp4. Found {len(available_files)} video files total.")
        
        # Download to local temp directory
        local_path = os.path.join(temp_dir, f"{video_id}_{os.path.basename(video_blob.name)}")
        logger.info(f"Downloading {video_blob.name} to {local_path}")
        
        video_blob.download_to_filename(local_path)
        
        # Verify download
        if not os.path.exists(local_path):
            raise Exception(f"Download verification failed: {local_path} does not exist")
            
        file_size = os.path.getsize(local_path)
        logger.info(f"Successfully downloaded video: {local_path} ({file_size / 1024 / 1024:.2f} MB)")
        
        return local_path
        
    except Exception as e:
        logger.error(f"Failed to download video {video_id} from GCS: {e}")
        raise Exception(f"GCS download failed for {video_id}: {str(e)}")

def process_segments_for_job(job_id, job_data):
    """
    Main function to process video segments for a completed download job
    This runs the full pipeline: download from GCS -> process segments -> upload result
    """
    temp_dir = None
    try:
        logger.info(f"Starting segment processing pipeline for job {job_id}")
        
        # Create temporary directory
        temp_dir = tempfile.mkdtemp(prefix=f"job_{job_id}_")
        logger.info(f"Created temp directory: {temp_dir}")
        
        # Get job information
        video_ids = job_data.get('videoIds', [])
        segments = job_data.get('segments', [])
        
        if not video_ids or not segments:
            raise ValueError("Job missing video IDs or segments data")
        
        logger.info(f"Processing {len(segments)} segments across {len(video_ids)} videos")
        
        # Group segments by video ID
        segments_by_video = {}
        for segment in segments:
            video_id = segment.get('videoId')
            if video_id:
                if video_id not in segments_by_video:
                    segments_by_video[video_id] = []
                segments_by_video[video_id].append(segment)
        
        # Process each video's segments separately
        all_processed_segments = []
        
        for video_id in video_ids:
            if video_id in segments_by_video:
                video_segments = segments_by_video[video_id]
                logger.info(f"Processing {len(video_segments)} segments for video {video_id}")
                
                # Download video from GCS
                video_path = download_video_from_gcs(video_id, temp_dir)
                
                # Process segments for this video
                processed_path = process_video_segments(video_path, video_segments, temp_dir, job_id)
                all_processed_segments.append(processed_path)
            else:
                logger.warning(f"No segments found for video {video_id}")
        
        if not all_processed_segments:
            raise Exception("No video segments were successfully processed")
        
        # If we have multiple processed videos, we need to combine them
        if len(all_processed_segments) > 1:
            logger.info(f"Combining {len(all_processed_segments)} processed video files")
            final_video_path = combine_multiple_videos(all_processed_segments, temp_dir, job_id)
        else:
            # Single video case
            final_video_path = all_processed_segments[0]
        
        # Upload final result to GCS
        public_url = upload_to_gcs(final_video_path, job_id)
        
        logger.info(f"Successfully completed segment processing for job {job_id}: {public_url}")
        return public_url
        
    except Exception as e:
        logger.error(f"Segment processing pipeline failed for job {job_id}: {e}")
        # Error status is already updated in the individual functions
        raise
        
    finally:
        # Clean up temporary directory
        if temp_dir and os.path.exists(temp_dir):
            try:
                import shutil
                shutil.rmtree(temp_dir)
                logger.info(f"Cleaned up temp directory: {temp_dir}")
            except Exception as cleanup_error:
                logger.warning(f"Failed to clean up temp directory {temp_dir}: {cleanup_error}")

def combine_multiple_videos(video_paths, temp_dir, job_id):
    """
    Combine multiple processed video files into a single final video
    """
    try:
        logger.info(f"Combining {len(video_paths)} video files for job {job_id}")
        
        output_path = os.path.join(temp_dir, "combined_final_video.mp4")
        
        # Update job status
        update_job_status(job_id, "Processing", 80, "Combining multiple video segments...")
        
        # Create input streams for all videos
        inputs = [ffmpeg.input(path) for path in video_paths]
        
        # Concatenate all videos
        if len(inputs) > 1:
            concat_video = ffmpeg.concat(*inputs, v=1, a=1)
            
            # Output with optimized settings
            output = ffmpeg.output(
                concat_video,
                output_path,
                vcodec="libx264",
                preset="medium",
                crf=23,
                acodec="aac",
                audio_bitrate="128k",
                movflags="+faststart",
                **{"profile:v": "main", "level": "3.1"}
            )
            
            # Run ffmpeg
            logger.info("Combining videos with FFmpeg...")
            try:
                # Check if ffmpeg is available
                import subprocess  # Explicit import to ensure availability
                try:
                    subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
                except (subprocess.CalledProcessError, FileNotFoundError):
                    raise Exception("FFmpeg is not installed or not accessible for video combination.")
                
                ffmpeg.run(output, overwrite_output=True, capture_stdout=True, capture_stderr=True)
            except ffmpeg.Error as e:
                stderr = e.stderr.decode('utf-8') if e.stderr else "Unknown ffmpeg error"
                logger.error(f"FFmpeg combination failed: {stderr}")
                raise Exception(f"Video combination failed: {stderr}")
            except Exception as e:
                if "ffmpeg" in str(e).lower():
                    raise Exception(f"FFmpeg not available for combination: {str(e)}")
                else:
                    raise
        else:
            # Only one video, just copy it
            logger.info("Only one video to process, copying file...")
            shutil.copy2(video_paths[0], output_path)
        
        # Verify output
        if not os.path.exists(output_path):
            raise Exception("Video combination failed - no output file created")
            
        file_size = os.path.getsize(output_path)
        logger.info(f"Video combination completed: {output_path} ({file_size / 1024 / 1024:.2f} MB)")
        
        return output_path
        
    except Exception as e:
        logger.error(f"Failed to combine videos for job {job_id}: {e}")
        raise Exception(f"Video combination failed: {str(e)}")

def start_background_processing(job_id, job_data):
    """
    Start video segment processing in background thread
    This allows the API to return immediately while processing continues
    """
    def background_task():
        try:
            logger.info(f"Starting background segment processing for job {job_id}")
            final_video_url = process_segments_for_job(job_id, job_data)
            logger.info(f"Background segment processing completed for job {job_id}: {final_video_url}")
            
        except Exception as processing_error:
            logger.error(f"Background processing failed for job {job_id}: {processing_error}")
            error_suggestions = [
                "Video segment processing failed",
                "This could be due to FFmpeg encoding issues or invalid timestamps",
                "Try selecting different video segments or shorter clips"
            ]
            update_job_status(job_id, "Failed", error=str(processing_error), suggestions=error_suggestions)
    
    # Start processing in background thread
    processing_thread = threading.Thread(target=background_task)
    processing_thread.daemon = True  # Thread will not prevent program from exiting
    processing_thread.start()
    logger.info(f"Started background processing thread for job {job_id}")

def update_job_status(
    job_id, status, progress=None, message=None, error=None, video_url=None, suggestions=None
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

        job_ref.update(update_data)
        logger.info(f"Updated job {job_id} status: {status}")

    except Exception as e:
        logger.error(f"Failed to update job status: {e}")



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
    path = request.path.strip('/')
    
    if path == 'processVideoJob':
        return processVideoJob(request)
    elif path == 'handleVideoDownloadSuccess':
        return handleVideoDownloadSuccess(request)
    elif path == 'getJobStatus':
        return getJobStatus(request)
    elif path == 'getSourceVideos':
        return getSourceVideos(request)
    else:
        return jsonify({"error": f"Unknown endpoint: /{path}"}), 404, {"Access-Control-Allow-Origin": "*"}

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
        if not api_client:
            return jsonify({
                "error": "Apify client not initialized - APIFY_KEY environment variable is required"
            }), 500, headers
        
        # Validate required environment variable
        gcs_service_account_json = os.environ.get("GCS_SERVICE_ACCOUNT_JSON")
        if not gcs_service_account_json:
            return jsonify({
                "error": "GCS_SERVICE_ACCOUNT_JSON environment variable is not set"
            }), 500, headers

        # Validate segments data
        if not segments or not isinstance(segments, list) or len(segments) == 0:
            error_msg = f"Invalid segments data: {segments}"
            print(error_msg)  # Fallback logging
            if logger:
                logger.error(error_msg)
            return jsonify({
                "error": "The function must be called with a segments array containing videoId, startTimeSeconds, and endTimeSeconds."
            }), 400, headers

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
                return jsonify({"error": "videoId is required in all segments"}), 400, headers
            
            if video_id not in seen_video_ids:
                unique_video_ids.append(video_id)
                seen_video_ids.add(video_id)
        
        if not unique_video_ids:
            return jsonify({"error": "No valid video IDs found in segments"}), 400, headers

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
                logger.info(f"Video {video_id} already exists in GCS: {existing_videos[video_id]}")
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
            firestore_client.collection("videoJobs").document(job_id).set({
                "userSessionId": user_session_id,
                "createdAt": datetime.now(),
                "videoIds": unique_video_ids,
                "totalVideos": len(unique_video_ids),
                "segmentCount": len(segments),
                "status": "Processing",  # Skip download phase
                "segments": segments,
                "videosAlreadyAvailable": videos_already_available,
                "videosNeedingDownload": [],
                "skipDownload": True
            })

            # Update status to indicate we're skipping download
            update_job_status(
                job_id, 
                "Processing", 
                50, 
                f"All {len(videos_already_available)} videos found in storage - starting segment processing..."
            )

            # Start segment processing in background (non-blocking)
            job_data = {
                'videoIds': unique_video_ids,
                'segments': segments
            }
            start_background_processing(job_id, job_data)
            
            # Return immediately without waiting for processing to complete
            logger.info(f"Started background processing for job {job_id} - returning immediately")
            
            return jsonify({
                "message": f"Video processing started - all videos were pre-downloaded",
                "jobId": job_id,
                "status": "Processing",
                "totalVideos": len(unique_video_ids),
                "totalSegments": len(segments),
                "videosSkipped": len(videos_already_available),
                "finalVideoUrl": None,  # Will be available once processing completes
                "note": "Processing started immediately due to existing videos in storage. Check job status for updates."
            }), 201, headers
                
        else:
            # Some or all videos need downloading - use Apify
            logger.info(f"Starting Apify download for {len(videos_needing_download)} videos")
            
            # Prepare the Actor input with videos that need downloading
            videos_list = []
            for video_id in videos_needing_download:
                videos_list.append({
                    "url": f"https://www.youtube.com/watch?v={video_id}",
                    "method": "GET"
                })

            run_input = {
                "videos": videos_list,
                "preferredFormat": "mp4",
                "preferredQuality": "480p",
                "filenameTemplateParts": ["title"],
                "googleCloudBucketName": "jre-content",
                "googleCloudServiceKey": gcs_service_account_json,
            }

            # Start the Actor asynchronously (non-blocking)
            run = api_client.actor("UUhJDfKJT2SsXdclR").start(run_input=run_input)
            
            # Check if the actor was started successfully
            if not run or "id" not in run:
                return jsonify({"error": "Failed to start Apify actor"}), 500, headers

            # Use Apify run ID as the job ID for tracking
            job_id = run["id"]
        
            # Create a new job document in Firestore with enhanced tracking
            firestore_client.collection("videoJobs").document(job_id).set({
                "apifyRunId": job_id,
                "userSessionId": user_session_id,
                "createdAt": datetime.now(),
                "videoIds": unique_video_ids,  # Store all video IDs
                "totalVideos": len(unique_video_ids),  # Total videos in request
                "segmentCount": len(segments),  # Track total segments across all videos
                "status": "Downloading",  # Current state
                "segments": segments,  # Store full segment data for later processing
                "videosAlreadyAvailable": videos_already_available,  # Videos that were pre-downloaded
                "videosNeedingDownload": videos_needing_download,  # Videos being downloaded now
                "skipDownload": False
            })

            info_msg = f"Started Apify actor for job ID: {job_id} with {len(videos_needing_download)} videos (skipped {len(videos_already_available)} existing)"
            print(info_msg)  # Fallback logging
            if logger:
                logger.info(info_msg)
            
            return jsonify({
                "message": f"Video processing job started with ID {job_id} for {len(unique_video_ids)} unique videos",
                "jobId": job_id,
                "status": "Downloading",
                "totalVideos": len(unique_video_ids),
                "totalSegments": len(segments),
                "videosSkipped": len(videos_already_available),
                "videosDownloading": len(videos_needing_download),
                "note": "Job is running in background. Use the webhook or check job status for updates."
            }), 201, headers

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
        
        # Update job status to indicate successful download
        update_job_status(
            job_run_id, 
            current_status, 
            50,
            "Full Videos download successful, processing segments..."
        )
        
        info_msg = f"Successfully updated job {job_run_id} to Processing status"
        print(info_msg)  # Fallback logging
        if logger:
            logger.info(info_msg)
        
        # Start segment processing in background
        try:
            logger.info(f"Starting segment processing for job {job_run_id}")
            
            # Process segments asynchronously (this might take a while)
            final_video_url = process_segments_for_job(job_run_id, job_data)
            
            logger.info(f"Segment processing completed successfully for job {job_run_id}: {final_video_url}")
            
        except Exception as processing_error:
            error_msg = f"Segment processing failed for job {job_run_id}: {processing_error}"
            logger.error(error_msg)
            
            # Update job status with processing error
            suggestions = [
                "Video segment processing failed", 
                "This could be due to FFmpeg encoding issues or invalid timestamps",
                "Try selecting different video segments or shorter clips"
            ]
            
            update_job_status(
                job_run_id, 
                "Failed", 
                error=str(processing_error),
                suggestions=suggestions
            )
            
            # Still return success for webhook (download succeeded, processing failed)
            return jsonify({
                "message": "Download succeeded but segment processing failed",
                "jobId": job_run_id,
                "downloadStatus": "Processing",
                "error": str(processing_error)
            }), 200, headers
        
        return jsonify({
            "message": "Job status updated successfully",
            "jobId": job_run_id,
            "newStatus": "Processing"
        }), 200, headers

    except Exception as e:
        error_msg = f"Error handling video download success webhook: {e}"
        print(error_msg)  # Fallback logging
        if logger:
            logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

# HTTP REST API endpoint to check video processing job status
def getJobStatus(request):
    """
    Get the status of a video processing job.
    Request format: GET /getJobStatus?jobId=<job_id>
    """
    headers = {"Access-Control-Allow-Origin": "*"}
    
    try:
        # Get job ID from query parameters
        job_id = request.args.get('jobId')
        if not job_id:
            return jsonify({"error": "jobId query parameter is required"}), 400, headers

        # Get job document from Firestore
        job_ref = firestore_client.collection("videoJobs").document(job_id)
        job_doc = job_ref.get()

        if not job_doc.exists:
            return jsonify({"error": "Job not found"}), 404, headers

        job_data = job_doc.to_dict()
        
        # If job is still downloading, check Apify status
        if job_data.get("status") == "Downloading" and api_client:
            try:
                # Check the actor run status from Apify
                run_info = api_client.run(job_id).get()
                if run_info:
                    apify_status = run_info.get("status")
                    if apify_status == "SUCCEEDED":
                        # Update job status if Apify completed but we haven't processed yet
                        update_job_status(job_id, "Processing", 50, "Download completed, processing segments...")
                        job_data["status"] = "Processing"
                        job_data["progress"] = 50
                        job_data["progressMessage"] = "Download completed, processing segments..."
                    elif apify_status == "FAILED":
                        # Update job status if Apify failed
                        update_job_status(job_id, "Failed", None, None, error="Apify actor run failed")
                        job_data["status"] = "Failed"
                        job_data["error"] = "Apify actor run failed"
            except Exception as e:
                print(f"Failed to check Apify status: {e}")
                # Continue with existing job data if Apify check fails

        # Return job status
        response_data = {
            "jobId": job_id,
            "status": job_data.get("status", "Unknown"),
            "progress": job_data.get("progress"),
            "progressMessage": job_data.get("progressMessage"),
            "totalVideos": job_data.get("totalVideos"),
            "totalSegments": job_data.get("segmentCount"),
            "createdAt": job_data.get("createdAt").isoformat() if job_data.get("createdAt") else None,
            "updatedAt": job_data.get("updatedAt").isoformat() if job_data.get("updatedAt") else None,
            "finalVideoUrl": job_data.get("finalVideoUrl") if job_data.get("status") == "Complete" else None,
        }

        # Include cache optimization fields if available
        if job_data.get("videosAlreadyAvailable"):
            response_data["videosAlreadyAvailable"] = job_data["videosAlreadyAvailable"]
        if job_data.get("videosNeedingDownload"):
            response_data["videosNeedingDownload"] = job_data["videosNeedingDownload"]
        if job_data.get("skipDownload") is not None:
            response_data["skipDownload"] = job_data["skipDownload"]

        # Include additional fields based on status
        if job_data.get("error"):
            response_data["error"] = job_data["error"]
        if job_data.get("suggestions"):
            response_data["suggestions"] = job_data["suggestions"]

        return jsonify(response_data), 200, headers

    except Exception as e:
        error_msg = f"Error getting job status: {e}"
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
        job_id = request.args.get('jobId')
        if not job_id:
            return jsonify({"error": "jobId query parameter is required"}), 400, headers

        # Get job document from Firestore
        job_ref = firestore_client.collection("videoJobs").document(job_id)
        job_doc = job_ref.get()

        if not job_doc.exists:
            return jsonify({"error": "Job not found"}), 404, headers

        job_data = job_doc.to_dict()
        
        # Check if job has downloaded source videos
        if job_data.get("status") not in ["Downloaded", "Processing", "Uploading", "Complete"]:
            return jsonify({"error": "Source videos not yet available. Job must be in Downloaded status or later."}), 400, headers
        
        source_videos = []
        
        # Get source video information from job data
        segments = job_data.get("segments", [])
        if not segments:
            return jsonify({"error": "No segments found for this job"}), 404, headers
        
        # Get unique video IDs from segments
        video_ids = list(set(segment.get("videoId") for segment in segments if segment.get("videoId")))
        
        # For each video ID, generate GCS download URL
        for video_id in video_ids:
            try:
                # Source videos are stored in jre-content bucket by Apify
                # Pattern: {videoId}_{VideoTitle}.mp4.mp4
                bucket = storage_client.bucket("jre-content")  # Source videos bucket
                
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
                        expiration=datetime.utcnow() + timedelta(hours=1),
                        method="GET"
                    )
                    
                    source_videos.append({
                        "videoId": video_id,
                        "url": download_url,
                        "title": f"Source Video {video_id}",
                        "filename": video_blob.name  # Use actual filename from GCS
                    })
                else:
                    logger.warning(f"Source video not found in GCS for pattern: {video_id}_*.mp4.mp4")
                    
            except Exception as e:
                logger.error(f"Error getting source video for {video_id}: {e}")
                continue
        
        if not source_videos:
            return jsonify({"error": "No source videos found in storage"}), 404, headers
        
        return jsonify({
            "jobId": job_id,
            "sourceVideos": source_videos,
            "totalVideos": len(source_videos)
        }), 200, headers

    except Exception as e:
        error_msg = f"Error getting source videos: {e}"
        print(error_msg)  # Fallback logging
        if logger:
            logger.error(error_msg)
        return jsonify({"error": "Internal server error"}), 500, headers

def check_existing_videos_in_gcs(video_ids, source_bucket="jre-content"):
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
        
        logger.info(f"GCS check results: {existing_count} videos already exist, {missing_count} need downloading")
        
        return existing_videos
        
    except Exception as e:
        logger.error(f"Failed to check existing videos in GCS: {e}")
        # Return empty dict to indicate no existing videos found (safe fallback)
        return {video_id: None for video_id in video_ids}