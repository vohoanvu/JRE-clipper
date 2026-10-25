"""Central configuration for the incremental JRE ingestion pipeline.

Everything that touches live infrastructure is named here so it is easy to audit.
Paths can be moved with the JRE_DATA_ROOT environment variable.
"""
from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------- local paths
DATA_ROOT = Path(os.environ.get("JRE_DATA_ROOT", r"F:\jre-all-episodes"))
WORK_DIR = DATA_ROOT / "ingestion"
STATE_FILE = WORK_DIR / "state.json"
LOG_FILE = WORK_DIR / "ingestion.log"
TRANSCRIPTS_DIR = DATA_ROOT / "transcriptions"          # transcript-{id}.json (same format as gs://jre-content/transcriptions)
CAPTIONS_RAW_DIR = WORK_DIR / "captions_raw"             # raw json3 caption files + trimmed metadata, kept for provenance
CHUNKS_DIR = WORK_DIR / "chunks"                         # {id}.ndjson, one per episode
NDJSON_DIR = WORK_DIR / "ndjson"                         # combined batches handed to the import step
MODELS_DIR = WORK_DIR / "models"                         # fastembed ONNX model cache
CALIBRATION_DIR = WORK_DIR / "calibration"
VIDEO_DIR = DATA_ROOT                                    # {id}.mp4 lands here, deleted after verified upload

# ---------------------------------------------------------------- YouTube
PLAYLIST_ID = "PLk1Sqn_f33KuWf3tW9BBe_4TP7x8l0m3T"
CHANNEL_ID = "UCzQUP1qoWDoEbmsQxvdjxgQ"
PLAYLIST_URL = f"https://www.youtube.com/playlist?list={PLAYLIST_ID}"
EPISODE_TITLE_RE = r"^\s*Joe Rogan Experience\s*#\s*(\d+)\b"
VIDEO_FORMAT = "bestvideo[height<=480]+bestaudio/best[height<=480]"   # owner's batch_download.sh convention

# ---------------------------------------------------------------- GCP
PROJECT_ID = "gen-lang-client-demo"
PROJECT_NUMBER = "408323719521"
FIRESTORE_DB = "jre-clipper-db"
FIRESTORE_COLLECTION = "jre-episodes"
FIRESTORE_BASE = (
    f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/{FIRESTORE_DB}"
    f"/documents/{FIRESTORE_COLLECTION}"
)
TRANSCRIPTS_BUCKET_PREFIX = "gs://jre-content/transcriptions"
VIDEO_BUCKET = "gs://jre-all-episodes"
INCREMENTAL_GCS_PREFIX = "gs://jre-processed-clips-bucker/final-semantic-chunks/incremental"
EXISTING_SEGMENTS_URI = "gs://jre-processed-clips-bucker/final-semantic-chunks/jre-segments-all.ndjson"

DISCOVERY_HOST = "https://us-discoveryengine.googleapis.com"
DATA_STORE = (
    f"projects/{PROJECT_NUMBER}/locations/us/collections/default_collection"
    "/dataStores/jre-transcriptions_1750261216656"
)
BRANCH = f"{DATA_STORE}/branches/default_branch"

# ---------------------------------------------------------------- chunking
# Values the June 2025 corpus was actually built with, inferred from the data
# (see calibrate.py): 99.7% of existing chunks end at the first utterance where
# the chunk reaches 30 s, every chunk end keeps a 2-utterance overlap.
# The committed appsettings.json (20/5) and the C# fallback (60/10) were NOT
# what produced jre-segments-all.ndjson.
MIN_CHUNK_SECONDS = 30
MAX_CHUNK_SECONDS = 60          # unobservable in the data (never the deciding rule); kept from the C# fallback
OVERLAP_UTTERANCES = 2
PAUSE_THRESHOLD_SECONDS = 0.7
MAX_CHARS_PER_UTTERANCE = 2000

EMBED_MODEL = "BAAI/bge-small-en-v1.5"
# Recalibrated for EMBED_MODEL so the rate of "no semantic break" decisions at
# eligible chunk ends matches the original text-embedding-005 @ 0.82 corpus
# (original 0.82% vs 0.83% at 0.80, on 40 episodes / 14.7k decision points).
# Produced by `python -m ingestion calibrate`; see calibration\report.json.
SIMILARITY_THRESHOLD = 0.80

CHANNEL_NAME = "PowerfulJRE"

# ---------------------------------------------------------------- captions
# YouTube's transcript panel (what the old Apify actor scraped) groups ASR
# caption lines into ~5 s entries: a new entry starts at the first line that
# begins >= 5.0 s after the current entry's first line. Reproduces the old
# transcript-*.json entry boundaries on episodes whose captions are unchanged.
TRANSCRIPT_GROUP_SECONDS = 5.0
CAPTION_LANGS = ["en-orig", "en", "en-US", "en-GB"]

# ---------------------------------------------------------------- politeness
CAPTION_SLEEP_RANGE = (20.0, 45.0)      # seconds between videos in the captions step
DOWNLOAD_SLEEP_RANGE = (60.0, 150.0)    # seconds between videos in the download step
MAX_CONSECUTIVE_FAILURES = 3            # stop a run instead of hammering YouTube
# Kill a yt-dlp download that makes no progress this long (2026-10-24: #2536 sat at 0% for 2.5 h).
# Generous because extraction, yt-dlp's own retries and the ffmpeg merge report no byte progress.
DOWNLOAD_STALL_SECONDS = 15 * 60


def ensure_dirs() -> None:
    for d in (WORK_DIR, TRANSCRIPTS_DIR, CAPTIONS_RAW_DIR, CHUNKS_DIR, NDJSON_DIR, MODELS_DIR, CALIBRATION_DIR):
        d.mkdir(parents=True, exist_ok=True)
