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
import socket
import requests
from urllib.parse import quote
from typing import Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

import functions_framework
from flask import Flask, request, jsonify
from flask_cors import CORS

from google.cloud import storage
from google.cloud import firestore
from google.cloud import pubsub_v1
from google.auth import default
from google.auth.transport.requests import Request
import google.auth
import google.auth.transport.requests
from google.oauth2 import service_account
from google.cloud.exceptions import NotFound, GoogleCloudError
import glob

import ffmpeg
from apify_client import ApifyClient

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

storage_client = None
firestore_client = None
project_id = None
gcs_service_account_json_apify = os.environ.get("GCS_SERVICE_ACCOUNT_JSON_APIFY")
gcs_service_account_json = os.environ.get("GCS_SERVICE_ACCOUNT_JSON")
try:
    # Parse and validate service account JSON
    service_account_info = json.loads(gcs_service_account_json)
    
    # Validate required fields
    required_fields = ['type', 'project_id', 'private_key', 'client_email']
    if not all(field in service_account_info for field in required_fields):
        raise ValueError("Missing required fields in service account JSON")
    
    # Create credentials with proper scopes
    credentials = service_account.Credentials.from_service_account_info(
        service_account_info,
        scopes=['https://www.googleapis.com/auth/cloud-platform']
    )
    
    project_id = service_account_info.get('project_id')
    
    # Initialize clients
    storage_client = storage.Client(credentials=credentials, project=project_id)
    firestore_client = firestore.Client(
        credentials=credentials, 
        project=project_id, 
        database=FIRESTORE_DB
    )
    
    logger.info(f"Initialized clients for project: {project_id}, Firestore DB: {FIRESTORE_DB}")
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
            credentials=credentials, 
            project=project_id, 
            database=FIRESTORE_DB
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

def process_video_segments(video_path, segments, temp_dir, job_id):
    """
    Process video segments using ffmpeg-python library
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

        # Test ffmpeg-python library availability
        try:
            # Simple test to ensure ffmpeg-python can create a basic input
            test_input = ffmpeg.input(video_path)
            logger.info("FFmpeg-python library is working correctly")
        except Exception as e:
            logger.error(f"FFmpeg-python library test failed: {e}")
            raise Exception(f"FFmpeg-python library is not working: {str(e)}")

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

        # Run ffmpeg using the python library (NOT subprocess)
        logger.info("Starting FFmpeg processing via python library...")
        try:
            # Execute the ffmpeg command through the library
            ffmpeg.run(output)
            logger.info("FFmpeg processing completed successfully")
        except ffmpeg.Error as e:
            # Handle ffmpeg-python specific errors
            stderr_output = ""
            stdout_output = ""
            
            if e.stderr:
                stderr_output = e.stderr.decode('utf-8')
                logger.error(f"FFmpeg stderr: {stderr_output}")
            
            if e.stdout:
                stdout_output = e.stdout.decode('utf-8')
                logger.error(f"FFmpeg stdout: {stdout_output}")
            
            # Provide more specific error messages
            if "No such file or directory" in stderr_output:
                raise Exception("FFmpeg binary not found in container. Please ensure FFmpeg is installed.")
            elif "Invalid argument" in stderr_output:
                raise Exception(f"Invalid FFmpeg arguments: {stderr_output}")
            elif "Permission denied" in stderr_output:
                raise Exception(f"Permission error during FFmpeg processing: {stderr_output}")
            else:
                raise Exception(f"FFmpeg processing failed: {stderr_output or 'Unknown error'}")
        except Exception as e:
            logger.error(f"Unexpected error during FFmpeg processing: {str(e)}")
            raise Exception(f"Video processing failed: {str(e)}")

        # Verify output file
        if not os.path.exists(output_path):
            raise Exception("FFmpeg processing failed - no output file created")

        file_size = os.path.getsize(output_path)
        if file_size == 0:
            raise Exception("FFmpeg processing failed - output file is empty")
            
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
        elif "permission" in error_msg.lower():
            suggestions.append("File permission error - check container permissions")
        elif "no such file" in error_msg.lower():
            suggestions.append("FFmpeg binary not found - ensure FFmpeg is installed in container")
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

def find_video_file_fuse(
    video_id: str,
    mount_path: str = "/jre-videos"
) -> str:
    """
    Find video file using FUSE mounted GCS bucket.
    
    Args:
        video_id: Video ID to search for
        mount_path: FUSE mount path for GCS bucket
        
    Returns:
        str: Full path to the video file
        
    Raises:
        FileNotFoundError: If video file doesn't exist
    """
    
    # Pattern: "<videoID>_<IgnoreTitleString>.mp4.mp4"
    pattern = f"{mount_path}/{video_id}_*.mp4.mp4"
    
    matching_files = glob.glob(pattern)
    
    if not matching_files:
        # Try broader search in subdirectories
        pattern = f"{mount_path}/**/{video_id}_*.mp4.mp4"
        matching_files = glob.glob(pattern, recursive=True)
    
    if not matching_files:
        raise FileNotFoundError(f"Video file with ID '{video_id}' not found in mounted bucket")
    
    video_path = matching_files[0]
    logger.info(f"Found video file via FUSE mount: {video_path}")
    
    # File is now accessible as regular filesystem file
    # No download needed - can be used directly for processing
    return video_path

def process_segments_for_job(job_id, job_data):
    """
    Main function to process video segments for a completed download job
    Optimized version with robust error handling, caching, and per-video timeout protection
    """
    temp_dir = None
    downloaded_videos = {}  # Cache for downloaded videos
    
    try:
        logger.info(f"Starting optimized segment processing pipeline for job {job_id}")
        
        # Create temporary directory
        temp_dir = tempfile.mkdtemp(prefix=f"job_{job_id}_")
        logger.info(f"Created temp directory: {temp_dir}")
        
        # Get job information
        video_ids = job_data.get('videoIds', [])
        segments = job_data.get('segments', [])
        
        if not video_ids or not segments:
            raise ValueError("Job missing video IDs or segments data")
        
        logger.info(f"Processing {len(segments)} segments across {len(video_ids)} videos")
        
        # Update initial progress
        update_job_status(job_id, "Processing", 55, f"Analyzing {len(segments)} segments across {len(video_ids)} videos...")
        
        # Group segments by video ID for efficient processing
        segments_by_video = {}
        for segment in segments:
            video_id = segment.get('videoId')
            if video_id:
                if video_id not in segments_by_video:
                    segments_by_video[video_id] = []
                segments_by_video[video_id].append(segment)
        
        logger.info(f"Segments grouped by video: {[(vid, len(segs)) for vid, segs in segments_by_video.items()]}")
        
        # Process videos with segments (resilient approach with per-video timeouts)
        all_processed_segments = []
        total_videos_to_process = len(segments_by_video)
        processed_videos = 0
        failed_videos = []
        
        for video_id, video_segments in segments_by_video.items():
            video_start_time = time.time()
            
            try:
                processed_videos += 1
                progress_percent = 55 + (processed_videos / total_videos_to_process) * 25  # 55% to 80%
                
                logger.info(f"Processing video {processed_videos}/{total_videos_to_process}: {video_id} ({len(video_segments)} segments)")
                update_job_status(
                    job_id, 
                    "Processing", 
                    int(progress_percent), 
                    f"Processing video {processed_videos}/{total_videos_to_process}: {video_id} ({len(video_segments)} segments)"
                )
                
                # Per-video timeout protection (60 minutes per video) using threading.Timer
                import threading
                video_timeout_flag = threading.Event()
                
                def video_timeout_handler():
                    video_timeout_flag.set()
                    logger.error(f"Video {video_id} processing timed out after 60 minutes")
                
                video_timer = threading.Timer(60 * 60, video_timeout_handler)  # 60 minute timeout per video
                video_timer.start()
                
                try:
                    # Check timeout before proceeding
                    if video_timeout_flag.is_set():
                        raise TimeoutError(f"Video {video_id} processing timed out")
                    
                    # Download video only if not already cached
                    if video_id not in downloaded_videos:
                        logger.info(f"Downloading video {video_id} from GCS...")
                        video_path = find_video_file_fuse(video_id)
                        downloaded_videos[video_id] = video_path
                        logger.info(f"Video {video_id} downloaded and cached ({(time.time() - video_start_time):.1f}s)")
                    else:
                        video_path = downloaded_videos[video_id]
                        logger.info(f"Using cached video for {video_id}")
                    
                    # Check timeout before processing
                    if video_timeout_flag.is_set():
                        raise TimeoutError(f"Video {video_id} processing timed out during download")
                    
                    # Process segments for this video
                    logger.info(f"Processing {len(video_segments)} segments for video {video_id}")
                    processed_path = process_video_segments(video_path, video_segments, temp_dir, job_id)
                    
                    if processed_path and os.path.exists(processed_path):
                        all_processed_segments.append(processed_path)
                        processing_time = time.time() - video_start_time
                        logger.info(f"Successfully processed segments for video {video_id} in {processing_time:.1f}s")
                    else:
                        logger.error(f"Failed to process segments for video {video_id} - no output file")
                        failed_videos.append(f"{video_id} (no output)")
                    
                finally:
                    # Cancel the video timeout timer
                    video_timer.cancel()
                
            except TimeoutError as timeout_error:
                logger.error(f"Video {video_id} processing timed out: {timeout_error}")
                failed_videos.append(f"{video_id} (timeout)")
                
                # Continue with other videos
                update_job_status(
                    job_id, 
                    "Processing", 
                    int(progress_percent), 
                    f"Warning: Video {video_id} timed out, continuing with remaining videos..."
                )
                continue
                
            except Exception as video_error:
                logger.error(f"Failed to process video {video_id}: {video_error}")
                failed_videos.append(f"{video_id} ({str(video_error)[:50]})")
                
                # Continue with other videos instead of failing completely
                update_job_status(
                    job_id, 
                    "Processing", 
                    int(progress_percent), 
                    f"Warning: Failed to process video {video_id}, continuing with remaining videos..."
                )
                continue
        
        # Check if we have any successful results
        success_count = len(all_processed_segments)
        total_count = len(segments_by_video)
        
        if not all_processed_segments:
            # Complete failure
            error_msg = f"No video segments were successfully processed. Failed videos: {', '.join(failed_videos)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        elif len(failed_videos) > 0:
            # Partial success - log warnings but continue
            logger.warning(f"Partial success: {success_count}/{total_count} videos processed. Failed: {', '.join(failed_videos)}")
            update_job_status(
                job_id, 
                "Processing", 
                80, 
                f"Processed {success_count}/{total_count} videos successfully. Combining results..."
            )
        else:
            # Complete success
            logger.info(f"Successfully processed all {success_count} video segments")
            update_job_status(job_id, "Processing", 80, f"Successfully processed all {success_count} videos. Combining results...")
        
        # Combine multiple videos if needed
        if len(all_processed_segments) > 1:
            logger.info(f"Combining {len(all_processed_segments)} processed video files")
            final_video_path = combine_multiple_videos(all_processed_segments, temp_dir, job_id)
        else:
            # Single video case
            final_video_path = all_processed_segments[0]
            logger.info("Single video processed, skipping combination step")
        
        # Upload final result to GCS
        logger.info(f"Uploading final video to GCS...")
        public_url = upload_to_gcs(final_video_path, job_id)
        
        # Include summary of any failures in the completion message
        completion_message = f"Video processing complete!"
        if failed_videos:
            completion_message += f" Note: {len(failed_videos)} videos failed but {success_count} were processed successfully."
        
        # Update final status
        update_job_status(job_id, "Complete", 100, completion_message, video_url=public_url)
        
        logger.info(f"Successfully completed optimized segment processing for job {job_id}: {public_url}")
        return public_url
        
    except Exception as e:
        logger.error(f"Optimized segment processing pipeline failed for job {job_id}: {e}")
        # Error status is already updated in the individual functions unless it's a complete failure
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
                
                ffmpeg.run(output)
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
    Start video segment processing in background thread with timeout and comprehensive error handling
    This allows the API to return immediately while processing continues
    """
    def background_task():
        import threading
        
        # Thread-safe timeout mechanism using Timer instead of signal (which only works in main thread)
        timeout_flag = threading.Event()
        timeout_timer = None
        
        def timeout_handler():
            logger.error(f"Background processing for job {job_id} timed out after 30 minutes")
            timeout_flag.set()
            update_job_status(
                job_id, 
                "Failed", 
                error="Processing timed out after 30 minutes",
                suggestions=[
                    "The video processing took too long and was terminated",
                    "Try selecting shorter video segments (max 2-3 minutes each)",
                    "Reduce the number of videos in your request (max 3-5 videos)",
                    "The system may be experiencing high load - try again in a few minutes"
                ]
            )
        
        # Set 30-minute timeout for entire background process
        timeout_timer = threading.Timer(60 * 60, timeout_handler)  # 60 minutes
        timeout_timer.start()
        
        try:
            logger.info(f"Starting background segment processing for job {job_id} with 30-minute timeout")
            
            # Update status to show processing has started
            update_job_status(
                job_id, 
                "Processing", 
                50, 
                f"Starting optimized video segment processing..."
            )
            
            # Check timeout flag before starting processing
            if timeout_flag.is_set():
                return
            
            final_video_url = process_segments_for_job(job_id, job_data)
            
            # Cancel timeout since processing completed successfully
            if timeout_timer:
                timeout_timer.cancel()
            
            if not timeout_flag.is_set():
                logger.info(f"Background segment processing completed successfully for job {job_id}: {final_video_url}")
            
        except Exception as processing_error:
            # Cancel timeout
            if timeout_timer:
                timeout_timer.cancel()
            
            # Don't update status if we already timed out
            if timeout_flag.is_set():
                return
            
            logger.error(f"Background processing failed for job {job_id}: {processing_error}")
            
            # Determine appropriate error suggestions based on error type
            error_suggestions = []
            error_msg = str(processing_error).lower()
            
            if "timeout" in error_msg or "timed out" in error_msg:
                error_suggestions = [
                    "Video processing timed out - this usually happens with very long videos or segments",
                    "Try selecting shorter video segments (max 2-3 minutes each)",
                    "Reduce the number of videos in your request (max 3-5 videos)",
                    "The system may be experiencing high load - try again in 10-15 minutes"
                ]
            elif "ffmpeg" in error_msg:
                error_suggestions = [
                    "Video encoding failed - this is usually due to invalid timestamps",
                    "Make sure your start and end times are within the video duration",
                    "Try selecting different time ranges for your segments",
                    "Avoid segments shorter than 5 seconds or longer than 10 minutes"
                ]
            elif "download" in error_msg or "gcs" in error_msg or "not found" in error_msg:
                error_suggestions = [
                    "Failed to download source videos from storage",
                    "Some videos may not be available or may have been moved",
                    "Try selecting different videos or check that the video IDs are correct",
                    "If this persists, the video may need to be re-uploaded to storage"
                ]
            elif "no video segments were successfully processed" in error_msg:
                error_suggestions = [
                    "All video processing attempts failed",
                    "This could be due to invalid video files or corrupted timestamps",
                    "Try selecting different videos or different time segments",
                    "Check that your segments are within the actual video duration"
                ]
            elif "memory" in error_msg or "space" in error_msg:
                error_suggestions = [
                    "The system ran out of memory or disk space",
                    "Try processing fewer videos at once (max 3-5 videos)",
                    "Select shorter video segments to reduce memory usage",
                    "Try again later when system resources are available"
                ]
            else:
                error_suggestions = [
                    "Video segment processing encountered an unexpected error",
                    "This could be due to video encoding issues or invalid timestamps",
                    "Try selecting different video segments or shorter clips",
                    "If the problem persists, please contact support with this job ID"
                ]
            
            update_job_status(job_id, "Failed", error=str(processing_error), suggestions=error_suggestions)
    
    # Start processing in background thread
    processing_thread = threading.Thread(target=background_task, name=f"job-{job_id}")
    processing_thread.daemon = True  # Thread will not prevent program from exiting
    processing_thread.start()
    logger.info(f"Started background processing thread for job {job_id} with comprehensive timeout protection")

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
        if not gcs_service_account_json_apify:
            return jsonify({
                "error": "GCS_SERVICE_ACCOUNT_JSON_APIFY environment variable is not set"
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
                "googleCloudBucketName": "jre-all-episodes",
                "googleCloudServiceKey": gcs_service_account_json_apify,
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
                # Source videos are stored in jre-all-episodes bucket by Apify
                # Pattern: {videoId}_{VideoTitle}.mp4.mp4
                bucket = storage_client.bucket("jre-all-episodes")  # Source videos bucket
                
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
        
        logger.info(f"GCS check results: {existing_count} videos already exist, {missing_count} need downloading")
        
        return existing_videos
        
    except Exception as e:
        logger.error(f"Failed to check existing videos in GCS: {e}")
        # Return empty dict to indicate no existing videos found (safe fallback)
        return {video_id: None for video_id in video_ids}