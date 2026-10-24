"""Exact Python port of the C# chunking used to build the search corpus.

Sources ported (keep in sync if those change):
  JREClipper.Core/Services/TranscriptSegmentationUtil.cs  GroupIntoUtterancesByPause / ParseTimestamp
  JREClipper.Core/Services/IntelligentTranscriptProcessor.cs  CreateSemanticChunks / FinalizeSegment
  JREClipper.Api/Controllers/IngestionController.cs  RunSematicChunking (record shape)

Verified against jre-segments-all.ndjson: on old episodes, feeding the original
Apify transcripts through this port reproduces the existing segment ids/text
(see calibrate.py).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Callable, Sequence

import numpy as np

from . import config


@dataclass
class Utterance:
    text: str
    start: int          # seconds (C# TimeSpan built from integer parts)
    end: int            # timestamp of the LAST entry in the utterance (not its end)
    embedding: np.ndarray | None = field(default=None, repr=False)


@dataclass
class Segment:
    video_id: str
    text: str
    start: int
    end: int
    video_title: str
    channel_name: str

    @property
    def segment_id(self) -> str:
        # C#: $"{videoId}_{startTime.TotalSeconds:F0}_{endTime.TotalSeconds:F0}"
        return f"{self.video_id}_{self.start}_{self.end}"


def parse_timestamp(ts: str | None) -> int:
    """TranscriptSegmentationUtil.ParseTimestamp: int parts only, anything else -> 0."""
    if not ts:
        return 0
    parts = ts.strip().split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 1:
            return int(parts[0])
    except ValueError:
        return 0
    return 0


def group_into_utterances(entries: Sequence[dict]) -> list[Utterance]:
    """TranscriptSegmentationUtil.GroupIntoUtterancesByPause (0.7 s pause, 2000 chars)."""
    utterances: list[Utterance] = []
    if not entries or len(entries) < 2:
        return utterances
    # LINQ OrderBy is stable, so is sorted()
    ordered = sorted(((parse_timestamp(e.get("timestamp")), e.get("text") or "") for e in entries), key=lambda x: x[0])
    buf: list[str] = []
    buf_len = 0
    start = ordered[0][0]
    for i in range(len(ordered) - 1):
        ts, text = ordered[i]
        next_ts = ordered[i + 1][0]
        buf.append(text + " ")
        buf_len += len(text) + 1
        significant_pause = (next_ts - ts) > config.PAUSE_THRESHOLD_SECONDS
        over_length = buf_len > config.MAX_CHARS_PER_UTTERANCE
        if significant_pause or over_length:
            if buf_len > 10:  # avoid tiny fragments
                utterances.append(Utterance("".join(buf).strip(), start, ts))
            buf, buf_len = [], 0
            start = next_ts
    last_ts, last_text = ordered[-1]
    buf.append(last_text)
    buf_len += len(last_text)
    if buf_len > 0:
        utterances.append(Utterance("".join(buf).strip(), start, last_ts))
    return utterances


def cosine(a: np.ndarray | None, b: np.ndarray | None) -> float:
    if a is None or b is None or a.shape != b.shape:
        return 0.0
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def consecutive_similarities(utterances: Sequence[Utterance]) -> list[float]:
    """sims[i] = cosine(utt[i], utt[i+1]); vectorised but numerically the same as cosine()."""
    if len(utterances) < 2:
        return []
    m = np.stack([u.embedding for u in utterances]).astype(np.float32)
    norms = np.linalg.norm(m, axis=1)
    dots = np.einsum("ij,ij->i", m[:-1], m[1:])
    denom = norms[:-1] * norms[1:]
    with np.errstate(divide="ignore", invalid="ignore"):
        sims = np.where(denom > 0, dots / denom, 0.0)
    return [float(s) for s in sims]


def create_semantic_chunks(
    utterances: Sequence[Utterance],
    video_id: str,
    video_title: str,
    channel_name: str,
    threshold: float,
    sims: Sequence[float] | None = None,
    min_s: int = config.MIN_CHUNK_SECONDS,
    max_s: int = config.MAX_CHUNK_SECONDS,
    overlap: int = config.OVERLAP_UTTERANCES,
) -> list[Segment]:
    """IntelligentTranscriptProcessor.CreateSemanticChunks, line for line.

    `sims[i]` is the similarity between utterance i and i+1. If omitted it is
    computed from `utterance.embedding`.
    """
    segments: list[Segment] = []
    if not utterances:
        return segments
    if sims is None:
        sims = consecutive_similarities(utterances) if len(utterances) > 1 else []
    n = len(utterances)
    current: list[Utterance] = []
    for i, utt in enumerate(utterances):
        current.append(utt)
        similarity_with_next = sims[i] if i < n - 1 else 1.0
        duration = current[-1].end - current[0].start
        is_semantic_break = similarity_with_next < threshold
        is_max_duration = duration >= max_s
        is_last = i == n - 1
        if (is_semantic_break and duration >= min_s) or is_max_duration or is_last:
            segments.append(
                Segment(
                    video_id=video_id,
                    text=" ".join(u.text for u in current),
                    start=current[0].start,
                    end=current[-1].end,
                    video_title=video_title,
                    channel_name=channel_name,
                )
            )
            overlap_index = max(0, len(current) - overlap)
            current = current[overlap_index:]
            if not is_semantic_break:
                current = []
    return segments


# ------------------------------------------------------------------ records
def segment_record(seg: Segment) -> dict:
    """Same object RunSematicChunking serialises (property order matters for the line hash)."""
    return {
        "id": seg.segment_id,
        "content": seg.text,
        "structData": {
            "videoId": seg.video_id,
            "startTime": float(seg.start),   # TimeSpan.TotalSeconds is a double -> Newtonsoft writes 1.0
            "endTime": float(seg.end),
            "videoTitle": seg.video_title,
            "channelName": seg.channel_name,
        },
    }


def record_line(record: dict) -> str:
    """Serialise like Newtonsoft JsonConvert.SerializeObject defaults (compact, raw UTF-8)."""
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"))


def discovery_doc_id(line: str) -> str:
    """Document id the data store assigned to the original import (autoGenerateIds):
    first 32 hex chars of SHA-256 over the exact NDJSON line bytes. Verified on
    sampled live documents."""
    return hashlib.sha256(line.encode("utf-8")).hexdigest()[:32]


def chunk_transcript(
    transcript: dict,
    video_id: str,
    embed_fn: Callable[[list[str]], np.ndarray],
    threshold: float = config.SIMILARITY_THRESHOLD,
) -> tuple[list[Segment], list[float]]:
    """Full chunking for one transcript dict (the single object inside transcript-{id}.json)."""
    entries = transcript.get("transcriptWithTimestamps") or []
    if not entries or not transcript.get("transcript"):
        return [], []
    utts = group_into_utterances(entries)
    if not utts:
        return [], []
    vecs = embed_fn([u.text for u in utts])
    for u, v in zip(utts, vecs):
        u.embedding = v
    sims = consecutive_similarities(utts)
    segs = create_semantic_chunks(
        utts,
        video_id,
        transcript.get("videoTitle") or "",
        transcript.get("channelName") or config.CHANNEL_NAME,
        threshold,
        sims,
    )
    return segs, sims
