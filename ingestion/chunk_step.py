"""chunk step: transcript-{id}.json -> chunks/{id}.ndjson (same records as jre-segments-all.ndjson)."""
from __future__ import annotations

import json
import logging
import time

from . import chunking, config
from .calibrate import duration_stats
from .embed import embedder
from .state import State

log = logging.getLogger(__name__)


def chunk_file(vid: str):
    return config.CHUNKS_DIR / f"{vid}.ndjson"


def run(args, state: State) -> dict:
    def pending(v):
        if (v.get("captions") or {}).get("status") != "done":
            return False
        c = v.get("chunk") or {}
        return args.force or c.get("status") != "done" or c.get("threshold") != args.threshold or c.get("model") != args.model

    todo = state.select(args.ids, args.limit, pending)
    log.info("chunk: %d episode(s), model=%s threshold=%.3f", len(todo), args.model, args.threshold)
    embed_fn = embedder(args.model)
    summary = {"done": 0, "empty": 0, "error": 0, "segments": 0}
    for v in todo:
        vid = v["videoId"]
        src = config.TRANSCRIPTS_DIR / f"transcript-{vid}.json"
        try:
            transcript = json.loads(src.read_text(encoding="utf-8"))[0]
            t0 = time.perf_counter()
            segs, sims = chunking.chunk_transcript(transcript, vid, embed_fn, args.threshold)
            secs = time.perf_counter() - t0
        except Exception as e:  # noqa: BLE001
            log.exception("chunk %s failed", vid)
            state.set_step(vid, "chunk", status="error", error=str(e)[:500])
            summary["error"] += 1
            continue
        if not segs:
            state.set_step(vid, "chunk", status="empty", model=args.model, threshold=args.threshold)
            summary["empty"] += 1
            continue
        lines = [chunking.record_line(chunking.segment_record(s)) for s in segs]
        ids = [s.segment_id for s in segs]
        if len(set(ids)) != len(ids):
            log.warning("%s: %d duplicate segment ids (same start/end)", vid, len(ids) - len(set(ids)))
        out = chunk_file(vid)
        tmp = out.with_suffix(".ndjson.tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
        tmp.replace(out)
        stats = duration_stats([s.end - s.start for s in segs])
        state.set_step(
            vid, "chunk", status="done", model=args.model, threshold=args.threshold,
            segments=len(segs), utterances=len(sims) + 1, seconds=round(secs, 1), file=str(out),
            durationMean=stats["mean"], durationP50=stats["p50"], durationP99=stats["p99"],
        )
        summary["done"] += 1
        summary["segments"] += len(segs)
        log.info("chunk %s #%s: %d segments from %d utterances in %.1fs (mean %.1fs)", vid, v.get("episode"),
                 len(segs), len(sims) + 1, secs, stats["mean"])
    return summary
