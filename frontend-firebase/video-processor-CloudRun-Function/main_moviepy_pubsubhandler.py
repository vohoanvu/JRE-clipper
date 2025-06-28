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
from datetime import datetime, timedelta
from pathlib import Path
import logging
import sys
from urllib.parse import quote
from typing import Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
import functions_framework
from google.cloud import storage
from google.cloud import firestore
from google.cloud import pubsub_v1
from google.auth import default
from google.auth.transport.requests import Request
from google.oauth2 import service_account
from google.cloud.exceptions import NotFound, GoogleCloudError
import glob
from moviepy import VideoFileClip, concatenate_videoclips

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

# This file is a Pub/Sub consumer only - no publisher client needed here
def process_video_segments(video_path, segments, temp_dir, job_id):
    """
    Process video segments using MoviePy library with bundled FFmpeg
    Enhanced version with better error handling and progress tracking
    """
    # Create unique output filename for this video
    video_id = segments[0].get("videoId", "unknown") if segments else "unknown"
    output_path = os.path.join(temp_dir, f"processed_{video_id}_{job_id}.mp4")

    try:
        logger.info(f"Job {job_id}: Starting segment processing")

        # Validate segments and convert to proper format
        valid_segments = []
        for i, segment in enumerate(segments):
            try:
                start = float(segment.get("startTimeSeconds", 0))
                end = float(segment.get("endTimeSeconds", 0))
                if start >= 0 and end > start:
                    valid_segments.append(
                        {
                            "start": start,
                            "end": end,
                            "videoId": segment.get("videoId"),
                            "duration": end - start,
                        }
                    )
                    logger.info(
                        f"Job {job_id}: Valid segment {i+1}: {segment.get('videoId')} {start}s-{end}s (duration: {end-start:.2f}s)"
                    )
                else:
                    logger.warning(
                        f"Job {job_id}: Invalid segment {i+1} skipped: start={start}, end={end}"
                    )
            except (ValueError, TypeError) as e:
                logger.warning(
                    f"Job {job_id}: Skipping segment {i+1} due to format error: {e}"
                )

        if not valid_segments:
            raise ValueError("No valid segments to process")

        total_segment_duration = sum(seg["duration"] for seg in valid_segments)
        logger.info(
            f"Job {job_id}: Processing {len(valid_segments)} valid segments from video: {os.path.basename(video_path)}"
        )
        logger.info(
            f"Job {job_id}: Total segments duration: {total_segment_duration:.2f}s"
        )

        # Verify input video exists
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Input video file not found: {video_path}")

        # Test MoviePy availability by loading the input video
        try:
            logger.info(f"Job {job_id}: Loading input video with MoviePy...")
            input_clip = VideoFileClip(video_path)
            video_duration = input_clip.duration
            video_fps = input_clip.fps
            video_size = input_clip.size
            logger.info(
                f"Job {job_id}: Video loaded successfully - Duration: {video_duration:.2f}s, FPS: {video_fps}, Size: {video_size}"
            )
        except Exception as e:
            logger.error(f"Job {job_id}: MoviePy failed to load video: {e}")
            raise Exception(f"MoviePy cannot process this video file: {str(e)}")

        # Update job status
        update_job_status(
            job_id,
            "Processing",
            60,
            f"Processing {len(valid_segments)} video segments...",
        )

        # Process segments and create clips
        segment_clips = []

        for i, segment in enumerate(valid_segments):
            start_time = segment["start"]
            end_time = segment["end"]
            duration = end_time - start_time

            logger.info(
                f"Job {job_id}: Processing segment {i+1}/{len(valid_segments)}: {start_time}s-{end_time}s (duration: {duration:.2f}s)"
            )

            # Validate segment times against video duration
            if start_time >= video_duration:
                logger.warning(
                    f"Job {job_id}: Segment {i+1} start time {start_time}s exceeds video duration {video_duration}s, skipping"
                )
                continue

            if end_time > video_duration:
                logger.warning(
                    f"Job {job_id}: Segment {i+1} end time {end_time}s exceeds video duration {video_duration}s, adjusting to {video_duration}s"
                )
                end_time = video_duration

            try:
                # Create subclip for this segment
                segment_clip = input_clip.subclipped(start_time, end_time)
                segment_clips.append(segment_clip)

                logger.info(
                    f"Job {job_id}: Segment {i+1} created successfully - Duration: {segment_clip.duration:.2f}s"
                )

                # Update progress
                progress = (
                    60 + (i + 1) / len(valid_segments) * 15
                )  # Progress from 60% to 75%
                update_job_status(
                    job_id,
                    "Processing",
                    int(progress),
                    f"Processed segment {i+1}/{len(valid_segments)}",
                )

            except Exception as e:
                logger.error(f"Job {job_id}: Failed to create segment {i+1}: {e}")
                # Continue with other segments if one fails
                continue

        if not segment_clips:
            input_clip.close()
            raise Exception("No valid video segments could be created")

        logger.info(
            f"Job {job_id}: Created {len(segment_clips)} segment clips successfully"
        )

        # Update progress
        update_job_status(
            job_id, "Processing", 75, "Combining segments and encoding final video..."
        )

        # Concatenate all segments
        logger.info(
            f"Job {job_id}: Concatenating {len(segment_clips)} video segments..."
        )
        if len(segment_clips) > 1:
            final_clip = concatenate_videoclips(segment_clips, method="compose")
            logger.info(
                f"Job {job_id}: Segments concatenated - Final duration: {final_clip.duration:.2f}s"
            )
        else:
            final_clip = segment_clips[0]
            logger.info(
                f"Job {job_id}: Single segment - Duration: {final_clip.duration:.2f}s"
            )

        try:
            logger.info(
                f"Job {job_id}: Writing final processed video to: {output_path}"
            )
            final_clip.write_videofile(
                output_path,
                codec="libx264",
                audio_codec="aac",
                threads=1,
                ffmpeg_params=[
                    "-y",  # Force overwrite (prevents hanging on existing files)
                    "-crf",
                    "28",
                    "-preset",
                    "ultrafast",  # Fastest encoding to reduce hang risk
                    "-movflags",
                    "+faststart",
                    "-pix_fmt",
                    "yuv420p",
                    "-f",
                    "mp4",  # Force format
                    "-avoid_negative_ts",
                    "make_zero",  # Handle timestamp issues
                    "-fflags",
                    "+genpts",  # Generate presentation timestamps
                    "-timeout",
                    "600000000",  # 10 minute timeout (microseconds)
                    "-nostdin",  # Don't wait for stdin input
                    "-loglevel",
                    "error",  # Reduce log verbosity
                ],
                temp_audiofile=f"/tmp/temp_audio_{job_id}.m4a",
                remove_temp=True,
                logger=None,
            )
            logger.info(f"Job {job_id}: MoviePy processing completed successfully")
            file_size = os.path.getsize(output_path)
            logger.info(
                f"Job {job_id}: Output file: {output_path} ({file_size / 1024 / 1024:.2f} MB)"
            )
            return output_path
        except TimeoutError:
            logger.error(f"Job {job_id}: Video encoding timeout after 10 minutes")
            raise Exception("Video encoding timeout - try shorter segments")
        except Exception as e:
            logger.error(f"Job {job_id}: MoviePy write_videofile failed: {e}")
            raise Exception(f"Video encoding failed: {str(e)}")
        finally:
            # Clean up clips ONLY after write_videofile completes
            logger.info(f"Job {job_id}: Cleaning up clips from memory")
            try:
                if input_clip:
                    input_clip.close()
                for clip in segment_clips:
                    if clip and clip != final_clip:
                        clip.close()
                if final_clip:
                    final_clip.close()
            except Exception as cleanup_error:
                logger.warning(f"Job {job_id}: Cleanup warning: {cleanup_error}")

    except Exception as e:
        logger.error(f"Job {job_id}: Video processing failed: {e}")
        # Update job status with specific error
        error_msg = str(e)
        suggestions = []

        if "moviepy" in error_msg.lower():
            suggestions.append("MoviePy processing failed - video encoding issue")
            suggestions.append(
                "Try selecting shorter segments or check video format compatibility"
            )
        elif "ffmpeg" in error_msg.lower():
            suggestions.append("FFmpeg configuration failed - bundled FFmpeg issue")
            suggestions.append("Check that imageio-ffmpeg is properly installed")
        elif "invalid" in error_msg.lower():
            suggestions.append("Invalid segment timestamps detected")
        elif "permission" in error_msg.lower():
            suggestions.append("File permission error - check container permissions")
        elif "not found" in error_msg.lower():
            suggestions.append("Input video file not found")
        elif "duration" in error_msg.lower():
            suggestions.append("Segment times exceed video duration - check timestamps")
        elif "memory" in error_msg.lower():
            suggestions.append(
                "Memory issue - try processing fewer or shorter segments"
            )
        else:
            suggestions.append("Video processing encountered an unexpected error")

        update_job_status(job_id, "Failed", error=error_msg, suggestions=suggestions)
        raise Exception(f"Failed to process video segments: {str(e)}")


def combine_multiple_videos(video_paths, temp_dir, job_id):
    """
    Combine multiple processed video files into a single final video using MoviePy
    with bundled FFmpeg from imageio-ffmpeg
    """
    try:
        logger.info(f"Job {job_id}: Combining {len(video_paths)} video files")

        output_path = os.path.join(temp_dir, "combined_final_video.mp4")

        # Update job status
        update_job_status(
            job_id, "Processing", 80, "Combining multiple video segments..."
        )

        if len(video_paths) > 1:
            # Load all video clips
            clips = []
            for i, video_path in enumerate(video_paths):
                try:
                    logger.info(
                        f"Job {job_id}: Loading video {i+1}/{len(video_paths)}: {os.path.basename(video_path)}"
                    )
                    clip = VideoFileClip(video_path)
                    clips.append(clip)
                    logger.info(
                        f"Job {job_id}: Video {i+1} loaded successfully - Duration: {clip.duration:.2f}s"
                    )
                except Exception as e:
                    logger.error(
                        f"Job {job_id}: Failed to load video {video_path}: {e}"
                    )
                    # Continue with other videos if one fails
                    continue

            if not clips:
                raise Exception("No valid video clips could be loaded for combination")

            # Concatenate all video clips
            logger.info(
                f"Job {job_id}: Concatenating {len(clips)} video clips with MoviePy..."
            )
            final_clip = concatenate_videoclips(clips, method="compose")

            # Calculate total duration for logging
            total_duration = sum(clip.duration for clip in clips)
            logger.info(
                f"Job {job_id}: Total combined video duration: {total_duration:.2f}s"
            )

            # Write the final video with optimized settings
            logger.info(f"Job {job_id}: Writing combined video to: {output_path}")
            final_clip.write_videofile(
                output_path,
                codec="libx264",
                audio_codec="aac",
                threads=1,
                ffmpeg_params=[
                    "-y",  # Force overwrite (prevents hanging on existing files)
                    "-crf",
                    "28",
                    "-preset",
                    "ultrafast",  # Fastest encoding to reduce hang risk
                    "-movflags",
                    "+faststart",
                    "-pix_fmt",
                    "yuv420p",
                    "-f",
                    "mp4",  # Force format
                    "-avoid_negative_ts",
                    "make_zero",  # Handle timestamp issues
                    "-fflags",
                    "+genpts",  # Generate presentation timestamps
                    "-timeout",
                    "600000000",  # 10 minute timeout (microseconds)
                    "-nostdin",  # Don't wait for stdin input
                    "-loglevel",
                    "error",  # Reduce log verbosity
                ],
                temp_audiofile=f"/tmp/temp_audio_{job_id}.m4a",
                remove_temp=True,
                logger=None,
            )

            # Close all clips to free memory
            logger.info(f"Job {job_id}: Cleaning up video clips from memory")
            for clip in clips:
                clip.close()
            final_clip.close()

        else:
            # Only one video, just copy it
            logger.info(f"Job {job_id}: Only one video to process, copying file...")
            shutil.copy2(video_paths[0], output_path)

        # Verify output
        if not os.path.exists(output_path):
            raise Exception("Video combination failed - no output file created")

        file_size = os.path.getsize(output_path)
        logger.info(
            f"Job {job_id}: Video combination completed: {output_path} ({file_size / 1024 / 1024:.2f} MB)"
        )

        return output_path

    except Exception as e:
        logger.error(f"Job {job_id}: Failed to combine videos: {e}")
        raise Exception(f"Video combination failed: {str(e)}")


def upload_to_gcs(local_path, job_id):
    """
    Upload processed video to Google Cloud Storage
    Enhanced with better error handling and progress tracking
    """
    try:
        logger.info(f"Starting upload to GCS for job {job_id}")
        update_job_status(
            job_id, "Uploading", 85, "Uploading final video to cloud storage..."
        )

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
                version="v4", expiration=expiration_time, method="GET"
            )

            logger.info(f"Upload successful with signed URL (valid for 7 days)")
            logger.info(f"Signed URL generated successfully")

        except Exception as url_error:
            logger.warning(f"Failed to generate signed URL: {url_error}")
            # Fallback to basic GCS URL (may not be publicly accessible)
            public_url = f"https://storage.googleapis.com/{BUCKET_NAME}/{blob_name}"
            logger.info(f"Using fallback GCS URL: {public_url}")

        # Update job status with final URL
        update_job_status(
            job_id, "Complete", 100, "Video ready for download!", video_url=public_url
        )

        return public_url

    except Exception as e:
        logger.error(f"GCS upload failed for job {job_id}: {e}")
        error_msg = f"Failed to upload video: {str(e)}"
        suggestions = [
            "Upload to cloud storage failed",
            "Please try generating the video again",
        ]
        update_job_status(job_id, "Failed", error=error_msg, suggestions=suggestions)
        raise Exception(error_msg)


def find_video_file_fuse(video_id: str, mount_path: str = "/jre-videos") -> str:
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
    pattern = f"{mount_path}/{video_id}.mp4"

    matching_files = glob.glob(pattern)

    if not matching_files:
        # Try broader search in subdirectories
        pattern = f"{mount_path}/**/{video_id}.mp4"
        matching_files = glob.glob(pattern, recursive=True)

    if not matching_files:
        raise FileNotFoundError(
            f"Video file with ID '{video_id}' not found in mounted bucket"
        )

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
        video_ids = job_data.get("videoIds", [])
        segments = job_data.get("segments", [])

        if not video_ids or not segments:
            raise ValueError("Job missing video IDs or segments data")

        logger.info(
            f"Processing {len(segments)} segments across {len(video_ids)} videos"
        )

        # Update initial progress
        update_job_status(
            job_id,
            "Processing",
            55,
            f"Analyzing {len(segments)} segments across {len(video_ids)} videos...",
        )

        # Group segments by video ID for efficient processing
        segments_by_video = {}
        for segment in segments:
            video_id = segment.get("videoId")
            if video_id:
                if video_id not in segments_by_video:
                    segments_by_video[video_id] = []
                segments_by_video[video_id].append(segment)

        logger.info(
            f"Segments grouped by video: {[(vid, len(segs)) for vid, segs in segments_by_video.items()]}"
        )

        # Process videos with segments (resilient approach with per-video timeouts)
        all_processed_segments = []
        total_videos_to_process = len(segments_by_video)
        processed_videos = 0
        failed_videos = []

        for video_id, video_segments in segments_by_video.items():
            video_start_time = time.time()

            try:
                processed_videos += 1
                progress_percent = (
                    55 + (processed_videos / total_videos_to_process) * 25
                )  # 55% to 80%

                logger.info(
                    f"Processing video {processed_videos}/{total_videos_to_process}: {video_id} ({len(video_segments)} segments)"
                )
                update_job_status(
                    job_id,
                    "Processing",
                    int(progress_percent),
                    f"Processing video {processed_videos}/{total_videos_to_process}: {video_id} ({len(video_segments)} segments)",
                )

                # Per-video timeout protection (60 minutes per video) using threading.Timer
                import threading

                video_timeout_flag = threading.Event()

                def video_timeout_handler():
                    video_timeout_flag.set()
                    logger.error(
                        f"Video {video_id} processing timed out after 60 minutes"
                    )

                video_timer = threading.Timer(
                    60 * 60, video_timeout_handler
                )  # 60 minute timeout per video
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
                        logger.info(
                            f"Video {video_id} downloaded and cached ({(time.time() - video_start_time):.1f}s)"
                        )
                    else:
                        video_path = downloaded_videos[video_id]
                        logger.info(f"Using cached video for {video_id}")

                    # Check timeout before processing
                    if video_timeout_flag.is_set():
                        raise TimeoutError(
                            f"Video {video_id} processing timed out during download"
                        )

                    # Process segments for this video
                    logger.info(
                        f"Processing {len(video_segments)} segments for video {video_id}"
                    )
                    processed_path = process_video_segments(
                        video_path, video_segments, temp_dir, job_id
                    )

                    if processed_path and os.path.exists(processed_path):
                        all_processed_segments.append(processed_path)
                        processing_time = time.time() - video_start_time
                        logger.info(
                            f"Successfully processed segments for video {video_id} in {processing_time:.1f}s"
                        )
                    else:
                        logger.error(
                            f"Failed to process segments for video {video_id} - no output file"
                        )
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
                    f"Warning: Video {video_id} timed out, continuing with remaining videos...",
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
                    f"Warning: Failed to process video {video_id}, continuing with remaining videos...",
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
            logger.warning(
                f"Partial success: {success_count}/{total_count} videos processed. Failed: {', '.join(failed_videos)}"
            )
            update_job_status(
                job_id,
                "Processing",
                80,
                f"Processed {success_count}/{total_count} videos successfully. Combining results...",
            )
        else:
            # Complete success
            logger.info(f"Successfully processed all {success_count} video segments")
            update_job_status(
                job_id,
                "Processing",
                80,
                f"Successfully processed all {success_count} videos. Combining results...",
            )

        # Combine multiple videos if needed
        if len(all_processed_segments) > 1:
            logger.info(
                f"Combining {len(all_processed_segments)} processed video files"
            )
            final_video_path = combine_multiple_videos(
                all_processed_segments, temp_dir, job_id
            )
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
        update_job_status(
            job_id, "Complete", 100, completion_message, video_url=public_url
        )

        logger.info(
            f"Successfully completed optimized segment processing for job {job_id}: {public_url}"
        )
        return public_url

    except Exception as e:
        logger.error(
            f"Optimized segment processing pipeline failed for job {job_id}: {e}"
        )
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
                logger.warning(
                    f"Failed to clean up temp directory {temp_dir}: {cleanup_error}"
                )


def update_job_status(
    job_id,
    status,
    progress=None,
    message=None,
    error=None,
    video_url=None,
    suggestions=None,
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


# Triggered from a message on a Cloud Pub/Sub topic.
@functions_framework.cloud_event
def process_video_job(cloud_event):
    """
    # Print out the Video Processing Job data from Pub/Sub
    {
        "data": {
            "message": {
                "data": "<base64-encoded-job-data>",
                "attributes": {
                    "jobId": "091f3803-1d02-4a46-b2d9-b573fdf40432",
                    "createdAt": "2025-06-27T13:12:00Z",
                    "error": "",
                    "progress": 0,
                    "progressMessage": "Processing segments",
                    "segmentCount": 3,
                    "segments": [
                        {
                            "endTimeSeconds": 1370,
                            "startTimeSeconds": 1340,
                            "videoId": "OfkKlekmIBo",
                            "videoTitle": "Joe Rogan Experience #125 - Giorgio A. Tsoukalos, Eddie Bravo"
                        },
                        {
                            "endTimeSeconds": 1771,
                            "startTimeSeconds": 1740,
                            "videoId": "OfkKlekmIBo",
                            "videoTitle": "Joe Rogan Experience #125 - Giorgio A. Tsoukalos, Eddie Bravo"
                        },
                        {
                            "endTimeSeconds": 1908,
                            "startTimeSeconds": 1873,
                            "videoId": "OfkKlekmIBo",
                            "videoTitle": "Joe Rogan Experience #125 - Giorgio A. Tsoukalos, Eddie Bravo"
                        }
                    ],
                    "skipDownload": true,
                    "status": "Processing",
                    "totalVideos": 1,
                    "updatedAt": "2025-06-27T13:14:38Z",
                    "userSessionId": "session_vdrzn3nrajamcetzkve",
                    "videoIds": [ "OfkKlekmIBo" ],
                    "videosAlreadyAvailable": [ "OfkKlekmIBo" ],
                    "videosNeedingDownload": []
                }
            }
        }
    }
    """
    try:
        logger.info("Received Pub/Sub message for video processing job")

        # Decode and parse the message data
        message_data = base64.b64decode(cloud_event.data["message"]["data"]).decode(
            "utf-8"
        )
        job_data = json.loads(message_data)

        # Get job ID from message attributes
        job_id = cloud_event.data["message"]["attributes"].get("jobId")

        if not job_id:
            logger.error("No jobId found in message attributes")
            return {"status": "error", "message": "Missing jobId in message attributes"}

        logger.info(f"Processing video job {job_id} via Pub/Sub")
        logger.info(
            f"Job data contains {len(job_data.get('segments', []))} segments for {len(job_data.get('videoIds', []))} videos"
        )

        # Update status to indicate processing has started
        update_job_status(
            job_id, "Processing", 50, "Starting video segment processing via Pub/Sub..."
        )

        # Process the video segments
        final_video_url = process_segments_for_job(job_id, job_data)

        # Update final status with completion
        update_job_status(
            job_id,
            "Complete",
            100,
            "Video processing completed successfully",
            video_url=final_video_url,
        )

        logger.info(
            f"Successfully completed video processing for job {job_id}: {final_video_url}"
        )

        return {
            "status": "success",
            "message": f"Job {job_id} processed successfully",
            "videoUrl": final_video_url,
        }

    except json.JSONDecodeError as e:
        logger.error(f"Failed to decode Pub/Sub message data: {e}")
        return {"status": "error", "message": f"Invalid JSON in message data: {str(e)}"}

    except Exception as e:
        logger.error(f"Error processing video job via Pub/Sub: {e}")

        # Update job status with error if we have a job_id
        if "job_id" in locals() and job_id:
            update_job_status(
                job_id,
                "Failed",
                error=str(e),
                suggestions=[
                    "Video processing failed in Pub/Sub handler",
                    "Check logs for detailed error information",
                    "Try submitting the job again",
                ],
            )

    return {"status": "error", "message": f"Failed to process video job: {str(e)}"}
