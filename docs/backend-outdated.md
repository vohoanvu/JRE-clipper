# Backend Implementation Plan for "What would Joe Rogan say?" App

**Version: 1.0**

**Date: June 10, 2025**

## 1. API Design

The API provides endpoints for submitting topics and retrieving results, designed for simplicity and usability.

- **POST /api/topics**
  - **Description**: Submits a topic for processing.
  - **Method**: POST
  - **Payload**: `{ "topic": "string" }` (e.g., `{ "topic": "artificial intelligence" }`)
  - **Response**: `{ "request_id": "string" }` (e.g., `{ "request_id": "123e4567-e89b-12d3-a456-426614174000" }`)
  - **Status Codes**:
    - 201: Created
    - 400: Bad Request (missing topic)

- **GET /api/topics/{request_id}**
  - **Description**: Retrieves the status and results of a topic request.
  - **Method**: GET
  - **Path Parameter**: `request_id` (e.g., `123e4567-e89b-12d3-a456-426614174000`)
  - **Response**: `{ "status": "string", "video_url": "string", "report_url": "string" }` (e.g., `{ "status": "completed", "video_url": "https://storage.google.bucker.com/video.mp4", "report_url": "https://storage.google.bucker.com/report.json" }`)
  - **Status Codes**:
    - 200: OK
    - 404: Not Found

## 2. Data Models

The backend uses a NoSQL database (e.g., MongoDB) for general data storage and Google Cloud’s Vertex AI Vector Search for transcript segments to enable efficient similarity searches.

- **Episodes** (NoSQL)
  - `episode_id` (string): Unique identifier (e.g., "JRE1234")
  - `title` (string): Episode title (e.g., "JRE #1234 - Guest Name")
  - `date` (date): Publication date (e.g., "2023-01-15")

- **TranscriptSegments** (Vector Database)
  - `segment_id` (string): Unique identifier (e.g., "seg_001")
  - `episode_id` (string): Reference to episode (e.g., "JRE1234")
  - `start_time` (float): Start time in seconds (e.g., 120.5)
  - `end_time` (float): End time in seconds (e.g., 150.0)
  - `text` (string): Transcript text (e.g., "Joe discusses AI advancements...")
  - `vector_embedding` (vector): Semantic embedding for similarity search

- **Requests** (NoSQL)
  - `request_id` (string): Unique identifier (e.g., "123e4567-e89b-12d3-a456-426614174000")
  - `topic` (string): User-submitted topic (e.g., "artificial intelligence")
  - `status` (string): State of request ("pending", "processing", "completed", "failed")
  - `video_url` (string): URL to summary video (e.g., "https://storage.example.com/video.mp4")
  - `report_url` (string): URL to timestamp report (e.g., "https://storage.example.com/report.json")
  - `created_at` (datetime): Creation timestamp (e.g., "2025-06-10T12:00:00Z")

- **Clips** (NoSQL)
  - `clip_id` (string): Unique identifier (e.g., "clip_001")
  - `request_id` (string): Reference to request (e.g., "123e4567-e89b-12d3-a456-426614174000")
  - `episode_id` (string): Reference to episode (e.g., "JRE1234")
  - `start_time` (float): Clip start time in seconds (e.g., 120.5)
  - `end_time` (float): Clip end time in seconds (e.g., 180.0)

## 3. Business Logic

The core backend processes handle data ingestion, topic analysis, and content generation.

- **Ingestion Pipeline**
  - Periodically fetch new JRE episodes via YouTube API.
  - Download audio/video, generate transcripts (using YouTube captions or speech-to-text if unavailable).
  - Split transcripts into 30-second segments, compute vector embeddings (e.g., using Vertex AI), and store in the Vector Database.

- **Topic Search**
  - Generate an embedding for the user-submitted topic using the same model as transcript segments.
  - Query the Vector Database for the top 100 similar segments based on vector embeddings.

- **Clip Selection**
  - Group relevant segments by episode.
  - Merge consecutive segments (e.g., if end_time of one is within 1 second of start_time of next) into single clips.
  - Add 3-second buffers before and after each clip for context, if within episode bounds.

- **Video Generation**
  - Extract clips from episode videos using FFmpeg (stored in cloud storage).
  - Concatenate clips into a single summary video.

- **Report Generation**
  - Create a JSON report listing episode titles and clip timestamps.

- **Storage and Delivery**
  - Upload summary video and report to cloud storage (e.g., Google Cloud Storage).
  - Update the request with URLs and set status to "completed".

## 4. Security

As a public-facing app without user accounts (assumed for initial version):

- **Rate Limiting**: Limit requests per IP address (e.g., 10/hour) using a library like Flask-Limiter to prevent abuse.
- **CAPTCHA**: Optionally add CAPTCHA (e.g., reCAPTCHA) for topic submissions if abuse is detected.
- **Secure Storage**: Use signed, time-limited URLs for video and report access to prevent unauthorized downloads.

## 5. Performance

To ensure scalability and responsiveness:

- **Asynchronous Processing**: Use a task queue (e.g., Celery with Redis) for video processing, allowing immediate API responses.
- **Caching**: Cache results for popular topics in Redis to reduce processing load.
- **Optimization**: Use efficient FFmpeg settings (e.g., `-c copy` for extraction) and parallelize clip processing where possible.
- **Database Indexing**: Index `request_id` and `episode_id` fields for fast lookups.

## 6. Code Examples

Below are practical examples for key functionalities using Python, Flask, and Celery.

**API Endpoints (Flask)**

```python
from flask import Flask, request, jsonify
import uuid
from datetime import datetime
from database import db  # MongoDB connection assumed

app = Flask(__name__)

@app.route('/api/topics', methods=['POST'])
def submit_topic():
    data = request.json
    topic = data.get('topic')
    if not topic:
        return jsonify({"error": "Topic is required"}), 400
    request_id = str(uuid.uuid4())
    created_at = datetime.now()
    db.requests.insert_one({
        "request_id": request_id,
        "topic": topic,
        "status": "pending",
        "video_url": None,
        "report_url": None,
        "created_at": created_at
    })
    process_topic.delay(request_id)  # Async task
    return jsonify({"request_id": request_id}), 201

@app.route('/api/topics/<request_id>', methods=['GET'])
def get_topic_status(request_id):
    req = db.requests.find_one({"request_id": request_id})
    if not req:
        return jsonify({"error": "Request not found"}), 404
    return jsonify({
        "status": req["status"],
        "video_url": req.get("video_url"),
        "report_url": req.get("report_url")
    })
```

**Processing Task (Celery)**

```python
from celery import Celery
from vector_database import vector_search  # Vertex AI Vector Search integration
from video_processing import extract_clip, concatenate_clips
from storage import upload_file
import json

celery = Celery('tasks', broker='redis://localhost:6379/0')

@celery.task
def process_topic(request_id):
    req = db.requests.find_one({"request_id": request_id})
    topic = req["topic"]
    db.requests.update_one({"request_id": request_id}, {"$set": {"status": "processing"}})
    
    # Generate topic embedding and search
    topic_embedding = generate_embedding(topic)
    similar_segments = vector_search(topic_embedding, top_k=100)
    
    # Select clips
    clips = select_clips(similar_segments)
    
    # Generate video
    clip_files = [extract_clip(c["episode_id"], c["start_time"], c["end_time"]) for c in clips]
    summary_video = concatenate_clips(clip_files)
    
    # Generate report
    report_data = [{"episode_title": db.episodes.find_one({"episode_id": c["episode_id"]})["title"],
                    "start_time": c["start_time"], "end_time": c["end_time"]} for c in clips]
    report = json.dumps(report_data)
    
    # Upload and update
    video_url = upload_file(summary_video, 'videos')
    report_url = upload_file(report, 'reports')
    db.requests.update_one(
        {"request_id": request_id},
        {"$set": {"status": "completed", "video_url": video_url, "report_url": report_url}}
    )

def generate_embedding(text):
    # Use Vertex AI or pre-trained model (e.g., Sentence-BERT)
    pass  # Placeholder for embedding logic

def select_clips(segments):
    clips = []
    current_clip = None
    for seg in sorted(segments, key=lambda x: (x["episode_id"], x["start_time"])):
        if not current_clip or seg["episode_id"] != current_clip["episode_id"] or seg["start_time"] > current_clip["end_time"] + 1:
            if current_clip:
                clips.append(current_clip)
            current_clip = {"episode_id": seg["episode_id"], "start_time": seg["start_time"], "end_time": seg["end_time"]}
        else:
            current_clip["end_time"] = seg["end_time"]
    if current_clip:
        clips.append(current_clip)
    return clips
```

This plan provides a robust foundation for the app’s backend, balancing functionality, performance, and security.