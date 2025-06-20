import base64
import json
import os
import tempfile
import logging
from datetime import datetime
from pathlib import Path

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

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
BUCKET_NAME = "jre-processed-clips-bucker"
FIRESTORE_DB = "jre-clipper-db"

# Initialize clients with Application Default Credentials
try:
    credentials, project_id = default()
    storage_client = storage.Client(credentials=credentials, project=project_id)
    # Use the specific database name instead of default
    firestore_client = firestore.Client(credentials=credentials, project=project_id, database=FIRESTORE_DB)
    logger.info(f"Initialized clients for project: {project_id}, Firestore DB: {FIRESTORE_DB}")
except Exception as e:
    logger.error(f"Failed to initialize clients: {e}")
    # Initialize without explicit credentials (will use ADC) but with correct database
    storage_client = storage.Client()
    firestore_client = firestore.Client(database=FIRESTORE_DB)


# Triggered from a message on a Cloud Pub/Sub topic
@functions_framework.cloud_event
def processVideo(cloud_event):
    """
    Process video segments from Pub/Sub message
    """
    try:
        # Decode the Pub/Sub message
        message_data = base64.b64decode(cloud_event.data["message"]["data"]).decode(
            "utf-8"
        )
        payload = json.loads(message_data)

        logger.info(f"Received Pub/Sub message: {payload}")

        job_id = payload.get("jobId")
        segments = payload.get("segments")

        if not job_id or not segments:
            logger.error("Invalid payload: missing jobId or segments")
            return

        # Check if job is already being processed
        job_ref = firestore_client.collection("videoJobs").document(job_id)
        job_doc = job_ref.get()

        if job_doc.exists:
            job_data = job_doc.to_dict()
            if job_data.get("status") in ["Processing", "Complete"]:
                logger.info(
                    f"Job {job_id} is already {job_data.get('status')}, skipping"
                )
                return

        # Process the video
        logger.info(f"Starting video processing for job {job_id}")
        process_video_job(job_id, segments)

    except Exception as e:
        logger.error(f"Error processing Pub/Sub message: {e}")
        raise


def process_video_job(job_id, segments):
    """
    Main video processing logic
    """
    start_time = datetime.now()
    temp_dir = None

    try:
        # Update status to processing
        update_job_status(job_id, "Processing", 5, "Initializing video processing...")

        # Create temporary directory
        temp_dir = tempfile.mkdtemp(prefix=f"video_job_{job_id}_")
        logger.info(f"Created temp directory: {temp_dir}")

        # Validate segments
        if not segments or not isinstance(segments, list):
            raise ValueError("Invalid segments array")

        video_id = segments[0].get("videoId")
        if not video_id:
            raise ValueError("No videoId found in segments")

        logger.info(f"Processing {len(segments)} segments for video {video_id}")

        # Download YouTube video
        update_job_status(job_id, "Processing", 20, "Downloading YouTube video...")
        video_path = download_youtube_video(video_id, temp_dir)

        # Process video segments
        update_job_status(job_id, "Processing", 60, "Processing video segments...")
        final_video_path = process_video_segments(video_path, segments, temp_dir)

        # Upload to Google Cloud Storage
        update_job_status(job_id, "Processing", 90, "Uploading final video...")
        final_video_url = upload_to_gcs(final_video_path, job_id)

        # Update status to complete
        processing_time = (datetime.now() - start_time).total_seconds()
        update_job_status(
            job_id,
            "Complete",
            100,
            "Video processing completed!",
            error=None,
            video_url=final_video_url,
        )

        logger.info(
            f"Job {job_id} completed in {processing_time}s. Video URL: {final_video_url}"
        )

    except Exception as e:
        error_msg = f"Error processing job {job_id}: {str(e)}"
        logger.error(error_msg)
        update_job_status(job_id, "Failed", None, None, error=str(e))
        raise

    finally:
        # Cleanup temporary directory
        if temp_dir and os.path.exists(temp_dir):
            try:
                import shutil

                shutil.rmtree(temp_dir)
                logger.info(f"Cleaned up temp directory: {temp_dir}")
            except Exception as cleanup_error:
                logger.warning(f"Failed to cleanup temp directory: {cleanup_error}")


def download_youtube_video(video_id, temp_dir):
    """
    Download YouTube video using yt-dlp Python API
    """
    output_path = os.path.join(temp_dir, f"{video_id}.%(ext)s")

    # yt-dlp options
    ydl_opts = {
        "outtmpl": output_path,
        "format": "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best",
        "noplaylist": True,
        "max_filesize": 500 * 1024 * 1024,  # 500MB limit
        "no_warnings": True,
        "quiet": False,
        "no_color": True,
        # Retry options
        "retries": 3,
        "fragment_retries": 3,
        "skip_unavailable_fragments": True,
        # Headers for better compatibility
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
    }

    video_url = f"https://www.youtube.com/watch?v={video_id}"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            logger.info(f"Downloading video: {video_url}")
            ydl.download([video_url])

        # Find the downloaded file
        downloaded_files = [
            f
            for f in os.listdir(temp_dir)
            if f.startswith(video_id) and f.endswith((".mp4", ".mkv", ".webm"))
        ]

        if not downloaded_files:
            raise Exception("No video file was downloaded")

        downloaded_path = os.path.join(temp_dir, downloaded_files[0])
        file_size = os.path.getsize(downloaded_path)

        logger.info(
            f"Successfully downloaded: {downloaded_path} ({file_size / 1024 / 1024:.2f} MB)"
        )
        return downloaded_path

    except Exception as e:
        logger.error(f"YouTube download failed: {e}")
        raise Exception(f"Failed to download video {video_id}: {str(e)}")


def process_video_segments(video_path, segments, temp_dir):
    """
    Process video segments using ffmpeg-python
    """
    output_path = os.path.join(temp_dir, "final_video.mp4")

    try:
        # Validate segments
        valid_segments = []
        for segment in segments:
            start = float(segment.get("startTimeSeconds", 0))
            end = float(segment.get("endTimeSeconds", 0))
            if start >= 0 and end > start:
                valid_segments.append({"start": start, "end": end})

        if not valid_segments:
            raise ValueError("No valid segments to process")

        logger.info(f"Processing {len(valid_segments)} valid segments")

        # Create input stream
        input_stream = ffmpeg.input(video_path)

        # Process segments
        video_segments = []
        audio_segments = []

        for i, segment in enumerate(valid_segments):
            duration = segment["end"] - segment["start"]

            # Trim video and audio
            video_segment = input_stream.video.filter(
                "trim", start=segment["start"], duration=duration
            ).filter("setpts", "PTS-STARTPTS")

            audio_segment = input_stream.audio.filter(
                "atrim", start=segment["start"], duration=duration
            ).filter("asetpts", "PTS-STARTPTS")

            video_segments.append(video_segment)
            audio_segments.append(audio_segment)

        # Concatenate segments
        if len(video_segments) > 1:
            video_concat = ffmpeg.concat(*video_segments, v=1, a=0)
            audio_concat = ffmpeg.concat(*audio_segments, v=0, a=1)
        else:
            video_concat = video_segments[0]
            audio_concat = audio_segments[0]

        # Output with encoding settings
        output = ffmpeg.output(
            video_concat,
            audio_concat,
            output_path,
            vcodec="libx264",
            preset="fast",
            crf=23,
            acodec="aac",
            audio_bitrate="128k",
            movflags="+faststart",
        )

        # Run ffmpeg
        logger.info("Starting FFmpeg processing...")
        ffmpeg.run(output, overwrite_output=True, quiet=True)

        # Verify output file
        if not os.path.exists(output_path):
            raise Exception("FFmpeg processing failed - no output file created")

        file_size = os.path.getsize(output_path)
        logger.info(
            f"Video processing completed: {output_path} ({file_size / 1024 / 1024:.2f} MB)"
        )

        return output_path

    except Exception as e:
        logger.error(f"Video processing failed: {e}")
        raise Exception(f"Failed to process video segments: {str(e)}")


def upload_to_gcs(local_path, job_id):
    """
    Upload processed video to Google Cloud Storage
    """
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"videos/{job_id}/final_video.mp4"
        blob = bucket.blob(blob_name)

        logger.info(f"Uploading to GCS: gs://{BUCKET_NAME}/{blob_name}")

        # Upload file
        blob.upload_from_filename(local_path, content_type="video/mp4")

        # Make publicly accessible
        blob.make_public()

        public_url = f"https://storage.googleapis.com/{BUCKET_NAME}/{blob_name}"
        logger.info(f"Upload successful: {public_url}")

        return public_url

    except Exception as e:
        logger.error(f"GCS upload failed: {e}")
        raise Exception(f"Failed to upload video: {str(e)}")


def update_job_status(
    job_id, status, progress=None, message=None, error=None, video_url=None
):
    """
    Update job status in Firestore
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

        job_ref.update(update_data)
        logger.info(f"Updated job {job_id} status: {status}")

    except Exception as e:
        logger.error(f"Failed to update job status: {e}")


# HTTP endpoint for job status (optional, for direct access)
@functions_framework.http
def getJobStatus(request):
    """
    HTTP endpoint to get job status
    """
    # Enable CORS
    if request.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "3600",
        }
        return ("", 204, headers)

    headers = {"Access-Control-Allow-Origin": "*"}

    try:
        request_json = request.get_json(silent=True)
        if not request_json or "jobId" not in request_json:
            return jsonify({"error": "Job ID is required"}), 400, headers

        job_id = request_json["jobId"]
        job_ref = firestore_client.collection("videoJobs").document(job_id)
        job_doc = job_ref.get()

        if not job_doc.exists:
            return jsonify({"error": "Job not found"}), 404, headers

        job_data = job_doc.to_dict()
        return jsonify({"jobData": job_data}), 200, headers

    except Exception as e:
        logger.error(f"Error getting job status: {e}")
        return jsonify({"error": "Internal server error"}), 500, headers
