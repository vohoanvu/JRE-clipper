"""transcribe step: Whisper fallback for episodes YouTube has no captions for.

Targets episodes whose captions step ended in `no_captions`, plus backfill episodes
(registered by `discover --backfill-empty`) that haven't been transcribed yet. For each:
fetch metadata (if English captions turned up after all, use them instead), download the
audio track only, decode it with ffmpeg to 16 kHz mono float32, and transcribe on CPU
with faster-whisper. The output is the same transcript-{id}.json format the captions
step writes, so chunk / import / mark work unchanged.

Measured on the i3-12100 (2026-10-23, other ingestion jobs running): base.en int8
~29x realtime (~6 min per 3 h episode), small.en ~11x (~16 min).
"""
from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path

import numpy as np

from . import captions, config, yt
from .state import State

log = logging.getLogger(__name__)

AUDIO_DIR = config.WORK_DIR / "audio"
WHISPER_MODELS_DIR = config.MODELS_DIR / "whisper"
SAMPLE_RATE = 16000


def needs_transcription(v: dict) -> bool:
    status = (v.get("captions") or {}).get("status")
    return status == "no_captions" or (bool(v.get("backfill")) and status not in ("done", "empty"))


def fetch_info(vid: str, cookies: str | None) -> dict:
    import yt_dlp

    with yt_dlp.YoutubeDL({**yt.base_opts(cookies), "skip_download": True}) as ydl:
        return ydl.sanitize_info(ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False))


def has_english_captions(info: dict) -> bool:
    langs = set(info.get("subtitles") or {}) | set(info.get("automatic_captions") or {})
    return any(lang in langs for lang in config.CAPTION_LANGS)


def download_audio(vid: str, cookies: str | None) -> Path:
    """Audio-only download (~50-80 MB for a 3 h episode, vs ~400 MB for the 480p mp4)."""
    import yt_dlp

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    opts = {
        **yt.base_opts(cookies),
        "format": "bestaudio[ext=webm]/bestaudio",
        "outtmpl": {"default": str(AUDIO_DIR / "%(id)s.%(ext)s")},
        "continuedl": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=True)
        path = Path(ydl.prepare_filename(info))
    if not path.exists():
        matches = sorted(AUDIO_DIR.glob(f"{vid}.*"))
        if not matches:
            raise FileNotFoundError(f"audio for {vid} not found after download")
        path = matches[0]
    return path


def decode_audio(path: Path) -> np.ndarray:
    """ffmpeg -> 16 kHz mono float32 PCM. Bypasses PyAV, whose 16.x API faster-whisper 1.2 can't open files with."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
         "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        capture_output=True, check=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.float32)


_model = None


def get_model(name: str, threads: int):
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads,
                              download_root=str(WHISPER_MODELS_DIR))
    return _model


def transcribe_audio(audio: np.ndarray, model_name: str, threads: int) -> list[tuple[float, str]]:
    segments, _ = get_model(model_name, threads).transcribe(
        audio,
        language="en",
        vad_filter=True,                    # skips silence/music: faster and fewer hallucinated lines
        beam_size=1,                        # greedy: ~2x faster than beam 5 for a small accuracy cost
        condition_on_previous_text=False,   # prevents the repetition loops long podcasts trigger
    )
    return [(s.start, s.text.strip()) for s in segments if s.text.strip()]


def process_one(vid: str, args) -> dict:
    t0 = time.perf_counter()
    info = fetch_info(vid, args.cookies_from_browser)
    if has_english_captions(info):
        # Captions appeared since the last check: they're better and far cheaper than Whisper.
        log.info("%s has English captions now; using the captions path", vid)
        return {**captions.process_one(vid, config.TRANSCRIPTS_DIR, args.cookies_from_browser), "viaTranscribe": True}

    audio_path = download_audio(vid, args.cookies_from_browser)
    downloaded = time.perf_counter()
    audio = decode_audio(audio_path)
    lines = transcribe_audio(audio, args.model, args.threads)
    transcribed = time.perf_counter()

    transcript = captions.build_transcript(info, captions.group_lines(lines))
    out = config.TRANSCRIPTS_DIR / f"transcript-{vid}.json"
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(out)

    source = {"kind": "whisper", "model": args.model, "lang": "en"}
    meta = captions.trimmed_meta(info, source)
    config.CAPTIONS_RAW_DIR.mkdir(parents=True, exist_ok=True)
    (config.CAPTIONS_RAW_DIR / f"{vid}.meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    if not args.keep_audio:
        audio_path.unlink(missing_ok=True)

    entries = transcript[0]["transcriptWithTimestamps"]
    audio_seconds = len(audio) / SAMPLE_RATE
    return {
        "title": info.get("title"),
        "date": captions.iso_date(info),
        "durationSeconds": info.get("duration"),
        "status": "done" if entries else "empty",
        "source": source,
        "entries": len(entries),
        "words": len(transcript[0]["transcript"].split()),
        "file": str(out),
        "downloadSeconds": round(downloaded - t0, 1),
        "transcribeSeconds": round(transcribed - downloaded, 1),
        "realtimeFactor": round(audio_seconds / max(0.1, transcribed - downloaded), 1),
        "seconds": round(time.perf_counter() - t0, 1),
    }


def run(args, state: State) -> dict:
    todo = state.select(args.ids, args.limit, needs_transcription)
    log.info("transcribe: %d episode(s) to process with %s", len(todo), args.model)
    summary = {"done": 0, "empty": 0, "error": 0, "viaCaptions": 0}
    fails = 0
    for i, v in enumerate(todo):
        vid = v["videoId"]
        if i:
            # Transcription itself spaces YouTube requests by minutes; this just adds jitter.
            yt.polite_sleep(args.sleep_min, args.sleep_max, "between videos")
        try:
            res = process_one(vid, args)
            fails = 0
        except Exception as e:  # noqa: BLE001 - record and continue, like the other steps
            fails += 1
            blocked = yt.looks_like_block(e)
            log.error("transcribe %s failed: %s", vid, e)
            state.set_step(vid, "captions", status="error", error=f"transcribe: {str(e)[:480]}", blocked=blocked)
            summary["error"] += 1
            if fails >= config.MAX_CONSECUTIVE_FAILURES:
                log.error("stopping after %d consecutive failures", fails)
                break
            yt.backoff_after_failure(fails, blocked)
            continue

        meta_fields = ("title", "date", "durationSeconds")
        if v.get("backfill"):
            # Keep the tracker's existing title/date for old episodes; only remember yt-dlp's values.
            state.update_video(vid, **{f"youtube{k[0].upper()}{k[1:]}": res[k] for k in meta_fields if res.get(k)})
        else:
            state.update_video(vid, **{k: res[k] for k in meta_fields if res.get(k)})
        state.set_step(vid, "captions", **{k: x for k, x in res.items() if k not in meta_fields})
        summary["viaCaptions" if res.get("viaTranscribe") else res["status"]] += 1
        log.info("transcribe %s #%s: %s, %s entries, %s words, %sx realtime, %.0fs total", vid, v.get("episode"),
                 res["status"], res.get("entries"), res.get("words"), res.get("realtimeFactor"), res["seconds"])
    return summary
