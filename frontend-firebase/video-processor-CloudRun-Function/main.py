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
    firestore_client = firestore.Client(
        credentials=credentials, project=project_id, database=FIRESTORE_DB
    )
    logger.info(
        f"Initialized clients for project: {project_id}, Firestore DB: {FIRESTORE_DB}"
    )
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

        # Download YouTube video with enhanced error handling
        update_job_status(job_id, "Processing", 20, f"Downloading YouTube video (may take 30-60s due to rate limiting)...")
        
        try:
            video_path = download_youtube_video(video_id, temp_dir)
        except Exception as download_error:
            error_msg = str(download_error)
            logger.error(f"Video download failed for {video_id}: {error_msg}")
            
            # Provide user-friendly error messages based on error type
            if "bot detection" in error_msg.lower() or "sign in to confirm" in error_msg.lower():
                video_title = segments[0].get('videoTitle', video_id)
                friendly_error = f"YouTube is restricting video content scraping right now. The video '{video_title}' couldn't be downloaded due to bot detection."
                suggestions = f"Try selecting 2-3 different videos from your search results instead of {len(set(s.get('videoId') for s in segments))} videos to avoid detection."
                update_job_status(job_id, "Failed - Retry Recommended", None, None, 
                                error=friendly_error, 
                                suggestions=suggestions)
            elif "private" in error_msg.lower() or "unavailable" in error_msg.lower():
                friendly_error = f"The video '{segments[0].get('videoTitle', video_id)}' is private or no longer available on YouTube."
                update_job_status(job_id, "Failed - Video Unavailable", None, None, error=friendly_error)
            elif "age" in error_msg.lower() or "restricted" in error_msg.lower():
                friendly_error = f"The video '{segments[0].get('videoTitle', video_id)}' has age restrictions that prevent automated processing."
                update_job_status(job_id, "Failed - Age Restricted", None, None, error=friendly_error)
            else:
                friendly_error = f"Unable to download the video due to technical restrictions. This may be temporary."
                suggestions = "Try again in a few minutes, or select different videos from your search results."
                update_job_status(job_id, "Failed - Technical Issue", None, None, 
                                error=friendly_error, suggestions=suggestions)
            
            return  # Exit gracefully instead of raising exception

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
    Download YouTube video using yt-dlp Python API with enhanced bot evasion, 
    real cookie support, and aggressive rate limiting
    """
    import time
    import random
    
    output_path = os.path.join(temp_dir, f"{video_id}.%(ext)s")
    
    # Load real YouTube cookies from environment variable or fallback to embedded cookies
    cookie_content = load_youtube_cookies()
    
    cookie_file = os.path.join(temp_dir, f"cookies_{video_id}.txt")
    with open(cookie_file, 'w') as f:
        f.write(cookie_content)
    
    logger.info(f"Created cookie file with {len(cookie_content.splitlines())} lines for video {video_id}")
    
    # Enhanced strategies with real cookie support and aggressive rate limiting
    strategies = [
        # Strategy 1: Authenticated approach with real cookies
        {
            "outtmpl": output_path,
            "format": "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best",
            "noplaylist": True,
            "max_filesize": 300 * 1024 * 1024,  # Higher limit with auth
            "no_warnings": True,
            "quiet": True,
            "no_color": True,
            "age_limit": 999,
            "cookiefile": cookie_file,  # Real authenticated cookies
            "retries": 3,
            "fragment_retries": 3,
            "skip_unavailable_fragments": True,
            "http_headers": {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "DNT": "1",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
                "Cache-Control": "max-age=0",
                "Referer": "https://www.youtube.com/"
            },
            "extractor_args": {
                "youtube": {
                    "player_client": ["web", "android"],  # Try both with auth
                    "skip": ["dash"],  # Skip DASH, prefer direct links
                    "lang": ["en"]
                }
            }
        },
        
        # Strategy 2: Conservative authenticated approach
        {
            "outtmpl": output_path,
            "format": "best[height<=480][ext=mp4]/best[height<=480]/best",
            "noplaylist": True,
            "max_filesize": 200 * 1024 * 1024,
            "no_warnings": True,
            "quiet": True,
            "age_limit": 999,
            "cookiefile": cookie_file,  # Real authenticated cookies
            "retries": 2,
            "http_headers": {
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Accept-Encoding": "gzip, deflate",
                "Referer": "https://www.youtube.com/"
            },
            "extractor_args": {
                "youtube": {
                    "player_client": ["ios", "android"],
                    "skip": ["dash", "hls"]
                }
            }
        },
        
        # Strategy 3: Fallback without cookies (last resort)
        {
            "outtmpl": output_path,
            "format": "worst[ext=mp4]/worst",
            "noplaylist": True,
            "max_filesize": 100 * 1024 * 1024,
            "no_warnings": True,
            "quiet": True,
            "ignore_errors": True,
            "no_check_certificate": True,
            "extractor_args": {
                "youtube": {
                    "player_client": ["web"],
                    "skip": ["dash", "hls"]
                }
            }
        }
    ]
    
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    
    # Initial aggressive delay to avoid rapid requests
    initial_delay = random.uniform(8, 20)  # Longer initial delay with auth
    logger.info(f"Starting authenticated download with {initial_delay:.1f}s initial delay")
    time.sleep(initial_delay)
    
    for i, ydl_opts in enumerate(strategies, 1):
        try:
            logger.info(f"Attempting authenticated download strategy {i}/{len(strategies)} for video: {video_id}")
            
            # Progressive delay between strategies (longer with real cookies)
            if i > 1:
                strategy_delay = random.uniform(15 * i, 30 * i)  # More conservative with auth
                logger.info(f"Strategy {i} delay: {strategy_delay:.1f}s")
                time.sleep(strategy_delay)
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # Additional random delay during processing
                processing_delay = random.uniform(3, 8)  # Slightly longer with auth
                logger.info(f"Processing delay: {processing_delay:.1f}s")
                time.sleep(processing_delay)
                
                # Try info extraction first with timeout
                try:
                    logger.info(f"Extracting video info for strategy {i}...")
                    info = ydl.extract_info(video_url, download=False)
                    
                    if info:
                        logger.info(f"Video info: '{info.get('title', 'Unknown')}' - Duration: {info.get('duration', 'Unknown')}s")
                        
                        # Another delay before actual download
                        download_delay = random.uniform(5, 12)  # Longer delay with auth
                        logger.info(f"Pre-download delay: {download_delay:.1f}s")
                        time.sleep(download_delay)
                        
                        # Perform actual download
                        logger.info(f"Starting authenticated download with strategy {i}...")
                        ydl.download([video_url])
                    else:
                        raise Exception("Failed to extract video information")
                        
                except Exception as extract_error:
                    logger.warning(f"Info extraction failed for strategy {i}: {extract_error}")
                    # Try direct download as fallback
                    logger.info(f"Attempting direct download fallback for strategy {i}...")
                    ydl.download([video_url])
            
            # Find and validate downloaded file
            downloaded_files = [
                f for f in os.listdir(temp_dir)
                if f.startswith(video_id) and f.endswith((".mp4", ".mkv", ".webm", ".m4a"))
            ]
            
            if not downloaded_files:
                raise Exception(f"No video file was downloaded with strategy {i}")
            
            downloaded_path = os.path.join(temp_dir, downloaded_files[0])
            file_size = os.path.getsize(downloaded_path)
            
            # Verify file integrity
            if file_size < 1024:  # Less than 1KB indicates failure
                raise Exception(f"Downloaded file is corrupted or too small ({file_size} bytes)")
            
            logger.info(f"SUCCESS: Strategy {i} downloaded {downloaded_path} ({file_size / 1024 / 1024:.2f} MB)")
            
            # Clean up cookie file
            try:
                if os.path.exists(cookie_file):
                    os.remove(cookie_file)
            except:
                pass
                
            return downloaded_path
            
        except Exception as e:
            error_msg = str(e)
            logger.warning(f"Strategy {i} failed: {error_msg}")
            
            # Clean up any partial downloads
            try:
                for f in os.listdir(temp_dir):
                    if f.startswith(video_id) and not f.endswith('.txt'):  # Keep cookie file
                        file_path = os.path.join(temp_dir, f)
                        if os.path.exists(file_path):
                            os.remove(file_path)
            except Exception as cleanup_err:
                logger.warning(f"Cleanup failed: {cleanup_err}")
            
            # If this is the last strategy, prepare final error
            if i == len(strategies):
                break
    
    # All strategies failed - clean up and raise descriptive error
    try:
        if os.path.exists(cookie_file):
            os.remove(cookie_file)
    except:
        pass
    
    logger.error(f"All {len(strategies)} download strategies failed for video {video_id}")
    
    # Determine error type and raise appropriate exception
    if "Sign in to confirm" in error_msg or "bot" in error_msg.lower():
        raise Exception(f"YouTube bot detection blocked all download attempts for video {video_id}. This indicates aggressive rate limiting is in effect.")
    elif "Private video" in error_msg or "unavailable" in error_msg.lower():
        raise Exception(f"Video {video_id} is private, unlisted, or no longer available.")
    elif "age" in error_msg.lower() or "restricted" in error_msg.lower():
        raise Exception(f"Video {video_id} has age restrictions that prevent automated access.")
    else:
        raise Exception(f"Failed to download video {video_id} after trying all strategies with rate limiting. Last error: {error_msg}")


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


def load_youtube_cookies():
    """
    Load YouTube cookies from environment variable or return fallback cookies.
    Expected environment variable: YOUTUBE_COOKIES (base64 encoded cookie file content)
    """
    import base64
    
    # Try to load cookies from environment variable
    try:
        cookies_env = os.environ.get('YOUTUBE_COOKIES')
        if cookies_env:
            # If base64 encoded, decode it
            try:
                decoded_cookies = base64.b64decode(cookies_env).decode('utf-8')
                logger.info("Successfully loaded YouTube cookies from environment variable (base64 decoded)")
                return decoded_cookies
            except Exception:
                # If not base64, use as-is
                logger.info("Successfully loaded YouTube cookies from environment variable (plain text)")
                return cookies_env
    except Exception as e:
        logger.warning(f"Failed to load cookies from environment: {e}")
    
    # Fallback to your real exported cookies (embedded for local testing)
    fallback_cookies = """# Netscape HTTP Cookie File
# http://curl.haxx.se/rfc/cookie_spec.html
# This is a generated file!  Do not edit.

.youtube.com	TRUE	/	TRUE	0	YSC	Ct8xpDbJ6gE
.youtube.com	TRUE	/	TRUE	1766044912	VISITOR_INFO1_LIVE	2EDpIgMJMqc
.youtube.com	TRUE	/	TRUE	1766044912	VISITOR_PRIVACY_METADATA	CgJWThIEGgAgUw%3D%3D
.youtube.com	TRUE	/	FALSE	1784378498	HSID	AP4kKMRmwj5zzAAkV
.youtube.com	TRUE	/	TRUE	1784378498	SSID	Afby7ta2KBUFy9Tqn
.youtube.com	TRUE	/	FALSE	1784378498	APISID	2z_BF_EDjw_qXZn6/AIpC8Od16LzKVJME8
.youtube.com	TRUE	/	TRUE	1784378498	SAPISID	6R77uMTgefUcuz_B/AcvVuYV3BjmSPVXoB
.youtube.com	TRUE	/	TRUE	1784378498	__Secure-1PAPISID	6R77uMTgefUcuz_B/AcvVuYV3BjmSPVXoB
.youtube.com	TRUE	/	TRUE	1784963303	__Secure-3PAPISID	6R77uMTgefUcuz_B/AcvVuYV3BjmSPVXoB
.youtube.com	TRUE	/	TRUE	1765630118	LOGIN_INFO	AFmmF2swRAIgMCUrTPulJ80uxdYVEq7qEMaB93lZ5xot_sgYifdP7hwCIEiwWJTuO5XEY0qr-0oO62gl2Ye8HItd1ANz63RVIqyp:QUQ3MjNmd0JWT1Bob1gxSDZ6aF8zcjBaMXkySlVodklmNG14bmlfNlA5SlRBaHZHQ1JYbVlhQVJFR2IwbXlsN2lWMWY1ODFYV2tlX3YzNEptWkdfN1pGUkxzczRaWnlZMkk4VGJlZXlnTERXSGxPbkJ5N2dzTWhjMHE1TFkxaVJQaFZKakd0M25LeHowT3VmclZSbmhYOG1FeVpqMjRqMFV3
.youtube.com	TRUE	/	FALSE	1750971069	_gcl_au	1.1.727154505.1743195069
.youtube.com	TRUE	/	FALSE	0	wide	1
.youtube.com	TRUE	/	TRUE	0	S	youtube_lounge_remote=4vnI-iX9Y32eSUQgQkd7q51rgbngO31n
.youtube.com	TRUE	/	FALSE	1783615625	_ga	GA1.1.554065419.1748985416
.youtube.com	TRUE	/	FALSE	1783615629	_ga_M0180HEFCY	GS2.1.s1749055625$o2$g0$t1749055629$j56$l0$h0
.youtube.com	TRUE	/	FALSE	1784378498	SID	g.a000yAjyalSfvZ65KjCGLnMOlVaZk90ZXx9qz3KxV92j2JK5Qi8P44yk1BnJMK4vbQPN3nQwHwACgYKAdoSARMSFQHGX2MibeSQb2IkbMq5JewVj-7c2xoVAUF8yKp2sK6YfttD9i1XZ5D0JpSc0076
.youtube.com	TRUE	/	TRUE	1784378498	__Secure-1PSID	g.a000yAjyalSfvZ65KjCGLnMOlVaZk90ZXx9qz3KxV92j2JK5Qi8PdWjVTsTsLJGmCh5C6kwVTwACgYKAcESARMSFQHGX2MizoTcpc6Np0oDUaIj6lDwthoVAUF8yKrC8wiDu1JlGy9MtCi9q6dY0076
.youtube.com	TRUE	/	TRUE	1784963303	__Secure-3PSID	g.a000yAjyalSfvZ65KjCGLnMOlVaZk90ZXx9qz3KxV92j2JK5Qi8PYUzBAgbWg77L7AMORycLjAACgYKAUkSARMSFQHGX2Mixgc3HusHmNFNPZq8GlypThoVAUF8yKoHuUcGjWtCKIXCYzOFSz2n0076
.youtube.com	TRUE	/	TRUE	1785052936	PREF	f6=80&tz=Asia.Saigon&f7=100&f5=20000&repeat=NONE&autoplay=true&volume=30&guide_collapsed=false&f4=4000000
.youtube.com	TRUE	/	TRUE	1782028958	__Secure-1PSIDTS	sidts-CjEB5H03P9_w5YwsdlqSDDyxTe01RM8dqXj1X48pGvCcGW0FXx8oeGOH818wQf4oncmUEAA
.youtube.com	TRUE	/	TRUE	1782028958	__Secure-3PSIDTS	sidts-CjEB5H03P9_w5YwsdlqSDDyxTe01RM8dqXj1X48pGvCcGW0FXx8oeGOH818wQf4oncmUEAA
.youtube.com	TRUE	/	FALSE	1782028958	SIDCC	AKEyXzWXyK3Ud6HcObfpd82LfZIAg9MKxy4dyePFLI14GTprCxsoc6gyK0dsK5BQTdXEqpa8MXI
.youtube.com	TRUE	/	TRUE	1782028958	__Secure-1PSIDCC	AKEyXzVVY2SMwcNr3taVt1BHkdrj6AhT4ht6oL-Lq7DivwKxZgYMglGcQ6tMT0G7bq2yh1UPsVen
.youtube.com	TRUE	/	TRUE	1782028958	__Secure-3PSIDCC	AKEyXzVEf0gzrSQJ7a9EoNCIShj0ytwx4_0FFmytu4kFB34jVynJTGp0Vth1h7UdwlxSBEenQCZ6
"""
    
    logger.info("Using fallback YouTube cookies (embedded real cookies)")
    return fallback_cookies
