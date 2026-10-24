"""Recalibrate the semantic-break threshold for the local embedding model.

Method
1. Stream the head of the existing corpus (gs://.../jre-segments-all.ndjson,
   default first 50 MB) -> target segment-duration distribution.
2. For episodes fully contained in that sample, download their original
   transcripts from gs://jre-content/transcriptions and rebuild utterances with
   the exact C# port. Align the existing chunks to those utterances and count,
   at every "eligible" decision point (chunk already >= MIN_CHUNK_SECONDS), how
   often the original pipeline did NOT break (text-embedding-005 similarity
   >= 0.82). That rate is the quantity the threshold controls.
3. Embed the same utterances with the local model and pick the threshold whose
   no-break rate matches the original one (tie-break: most byte-identical
   segments vs the existing corpus). Report duration stats for both.
"""
from __future__ import annotations

import json
import logging
import random
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from . import chunking, config, gcp
from .embed import embed

log = logging.getLogger(__name__)


def duration_stats(durs: list[float]) -> dict:
    if not durs:
        return {}
    s = sorted(durs)
    pct = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    hist = Counter(int(d // 5) * 5 for d in s)
    return {
        "n": len(s),
        "mean": round(float(np.mean(s)), 2),
        "std": round(float(np.std(s)), 2),
        "p05": pct(0.05), "p10": pct(0.10), "p25": pct(0.25), "p50": pct(0.50),
        "p75": pct(0.75), "p90": pct(0.90), "p95": pct(0.95), "p99": pct(0.99),
        "max": s[-1],
        "share_30_35s": round(sum(1 for d in s if 30 <= d < 35) / len(s), 4),
        "share_ge_40s": round(sum(1 for d in s if d >= 40) / len(s), 4),
        "hist_5s": {str(k): hist[k] for k in sorted(hist)},
    }


def load_sample(sample_bytes: int, refresh: bool = False) -> Path:
    path = config.CALIBRATION_DIR / f"existing_head_{sample_bytes // 1_000_000}mb.ndjson"
    if refresh or not path.exists():
        log.info("streaming first %d bytes of %s", sample_bytes, config.EXISTING_SEGMENTS_URI)
        with open(path, "wb") as f:
            subprocess.run(
                gcp.gcloud_cmd("storage", "cat", "-r", f"0-{sample_bytes}", config.EXISTING_SEGMENTS_URI),
                stdout=f, check=True,
            )
    return path


def read_records(path: Path) -> list[dict]:
    recs = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # truncated last line of the byte-range sample
    return recs


def original_transcript(video_id: str) -> dict | None:
    dest = config.CALIBRATION_DIR / "old_transcripts" / f"transcript-{video_id}.json"
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        uri = f"{config.TRANSCRIPTS_BUCKET_PREFIX}/transcript-{video_id}.json"
        r = subprocess.run(gcp.gcloud_cmd("storage", "cp", uri, str(dest)), capture_output=True, text=True)
        if r.returncode != 0:
            return None
    data = json.loads(dest.read_text(encoding="utf-8"))
    return data[0] if isinstance(data, list) and data else None


def original_decisions(utts: list[chunking.Utterance], chunks: list[tuple[int, int]]) -> tuple[int, int, int]:
    """Return (eligible_points, no_break_points, unmapped_chunks) for the original run."""
    starts, ends = {}, {}
    for i, u in enumerate(utts):
        starts.setdefault(u.start, i)
        ends[u.end] = i
    eligible = no_break = unmapped = 0
    for s, e in chunks:
        i, j = starts.get(s), ends.get(e)
        if i is None or j is None:
            unmapped += 1
            continue
        k = next((k for k in range(i, len(utts)) if utts[k].end - utts[i].start >= config.MIN_CHUNK_SECONDS), len(utts) - 1)
        if j < k:
            continue  # last chunk of the episode, never eligible
        eligible += (j - k) + 1
        no_break += j - k
    return eligible, no_break, unmapped


def new_decisions(utts, sims, threshold) -> tuple[list[chunking.Segment], int, int]:
    segs = chunking.create_semantic_chunks(utts, "x", "", "", threshold, sims)
    # count eligible decisions in a replay of the same state machine
    eligible = no_break = 0
    current: list[int] = []
    n = len(utts)
    for i in range(n):
        current.append(i)
        dur = utts[current[-1]].end - utts[current[0]].start
        sim = sims[i] if i < n - 1 else 1.0
        brk = sim < threshold
        if dur >= config.MIN_CHUNK_SECONDS and i < n - 1:
            eligible += 1
            no_break += 0 if brk else 1
        if (brk and dur >= config.MIN_CHUNK_SECONDS) or dur >= config.MAX_CHUNK_SECONDS or i == n - 1:
            current = current[max(0, len(current) - config.OVERLAP_UTTERANCES):] if brk else []
    return segs, eligible, no_break


def run(args) -> dict:
    config.ensure_dirs()
    sample = load_sample(args.sample_bytes, refresh=args.refresh)
    recs = read_records(sample)
    by_video: dict[str, list[dict]] = defaultdict(list)
    for r in recs:
        by_video[r["structData"]["videoId"]].append(r)
    videos = list(by_video)[:-1]  # last one may be cut by the byte range
    target = duration_stats([r["structData"]["endTime"] - r["structData"]["startTime"] for r in recs])
    log.info("sample: %d records, %d videos; target mean %.2f s", len(recs), len(by_video), target["mean"])

    rng = random.Random(args.seed)
    pick = args.ids.split(",") if args.ids else rng.sample(videos, min(args.episodes, len(videos)))
    thresholds = [round(x, 3) for x in np.arange(args.t_min, args.t_max + 1e-9, args.t_step)]
    per_t = {t: {"eligible": 0, "no_break": 0, "identical": 0, "durs": []} for t in thresholds}
    orig_eligible = orig_no_break = total_existing = 0
    existing_durs: list[float] = []
    all_sims: list[float] = []
    t_embed = 0.0
    n_utts = 0
    used = []
    for vid in pick:
        tr = original_transcript(vid)
        if not tr or vid not in by_video:
            log.warning("skip %s (no transcript or not in sample)", vid)
            continue
        utts = chunking.group_into_utterances(tr.get("transcriptWithTimestamps") or [])
        if len(utts) < 10:
            continue
        existing = by_video[vid]
        existing_lines = {chunking.record_line(r) for r in existing}
        e, nb, unmapped = original_decisions(utts, [(int(r["structData"]["startTime"]), int(r["structData"]["endTime"])) for r in existing])
        if unmapped > len(existing) * 0.05:
            log.warning("skip %s: %d/%d existing chunks do not align with its transcript", vid, unmapped, len(existing))
            continue
        orig_eligible += e
        orig_no_break += nb
        total_existing += len(existing)
        existing_durs += [r["structData"]["endTime"] - r["structData"]["startTime"] for r in existing]
        cache = config.CALIBRATION_DIR / "emb_cache" / args.model.replace("/", "__") / f"{vid}.npy"
        if cache.exists():
            vecs = np.load(cache)
        else:
            t0 = time.perf_counter()
            vecs = embed([u.text for u in utts], args.model)
            t_embed += time.perf_counter() - t0
            n_utts += len(utts)
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.save(cache, vecs)
        for u, v in zip(utts, vecs):
            u.embedding = v
        sims = chunking.consecutive_similarities(utts)
        all_sims += sims
        for t in thresholds:
            segs, el, nbk = new_decisions(utts, sims, t)
            for s in segs:
                s.video_id, s.video_title, s.channel_name = vid, tr.get("videoTitle") or "", tr.get("channelName") or ""
            lines = {chunking.record_line(chunking.segment_record(s)) for s in segs}
            st = per_t[t]
            st["eligible"] += el
            st["no_break"] += nbk
            st["identical"] += len(lines & existing_lines)
            st["durs"] += [s.end - s.start for s in segs]
        used.append(vid)
        log.info("calibrated on %s (%d utterances, original no-break %d/%d)", vid, len(utts), nb, e)

    orig_rate = orig_no_break / max(1, orig_eligible)
    rows = []
    for t in thresholds:
        st = per_t[t]
        rate = st["no_break"] / max(1, st["eligible"])
        rows.append({
            "threshold": t,
            "no_break_rate": round(rate, 5),
            "identical_segments": st["identical"],
            "identical_share": round(st["identical"] / max(1, total_existing), 4),
            "mean_duration": round(float(np.mean(st["durs"])), 2) if st["durs"] else None,
        })
    best = min(rows, key=lambda r: (abs(r["no_break_rate"] - orig_rate), -r["identical_segments"]))
    sims_arr = np.asarray(all_sims)
    report = {
        "model": args.model,
        "sample_uri": config.EXISTING_SEGMENTS_URI,
        "sample_bytes": args.sample_bytes,
        "episodes_used": used,
        "existing_segments_in_episodes": total_existing,
        "original_no_break_rate": round(orig_rate, 5),
        "original_eligible_points": orig_eligible,
        "chosen_threshold": best["threshold"],
        "chosen": best,
        "similarity_percentiles": {str(p): round(float(np.percentile(sims_arr, p)), 4) for p in (50, 90, 95, 99, 99.5, 99.7, 99.9)} if len(sims_arr) else {},
        "embedding_seconds": round(t_embed, 1),
        "utterances_embedded_this_run": n_utts,
        "embedding_throughput_utt_per_s": round(n_utts / t_embed, 1) if t_embed else None,
        "target_duration_stats_sample": target,
        "existing_duration_stats_same_episodes": duration_stats(existing_durs),
        "new_duration_stats_at_chosen": duration_stats(per_t[best["threshold"]]["durs"]),
        "sweep": rows,
    }
    out = config.CALIBRATION_DIR / "report.json"
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    log.info("calibration written to %s; chosen threshold %.3f (original no-break rate %.4f)", out, best["threshold"], orig_rate)
    return report


def compare(args) -> dict:
    """Pipeline check: chunk caption-derived transcripts of OLD episodes (made by
    `captions --ids ... --calibration`) and compare their stats to the existing
    segments of the same episodes (from the full corpus file or the sample)."""
    from .embed import embedder

    src = Path(args.existing) if args.existing else load_sample(args.sample_bytes)
    ids = args.ids.split(",")
    existing: dict[str, list[float]] = defaultdict(list)
    with open(src, encoding="utf-8") as f:
        for line in f:
            if not any(f'"videoId":"{v}"' in line for v in ids):
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            existing[r["structData"]["videoId"]].append(r["structData"]["endTime"] - r["structData"]["startTime"])
    out = {"threshold": args.threshold, "episodes": {}}
    all_new, all_old = [], []
    for vid in ids:
        path = config.CALIBRATION_DIR / "caption_transcripts" / f"transcript-{vid}.json"
        tr = json.loads(path.read_text(encoding="utf-8"))[0]
        segs, _ = chunking.chunk_transcript(tr, vid, embedder(args.model), args.threshold)
        new = [s.end - s.start for s in segs]
        all_new += new
        all_old += existing.get(vid, [])
        out["episodes"][vid] = {
            "caption_entries": len(tr["transcriptWithTimestamps"]),
            "new": duration_stats(new),
            "existing": duration_stats(existing.get(vid, [])),
        }
    out["all_new"] = duration_stats(all_new)
    out["all_existing"] = duration_stats(all_old)
    path = config.CALIBRATION_DIR / "pipeline_check.json"
    path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    log.info("pipeline check written to %s", path)
    return out
