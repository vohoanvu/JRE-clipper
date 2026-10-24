"""YouTube captions -> transcript-{id}.json in the existing (Apify) format.

Output: a JSON list with one object
  {channelName, channelSubscription, videoTitle, url, views, videoPostDate,
   transcript, transcriptWithTimestamps: [{"timestamp": "m:ss"|"h:mm:ss", "text"}]}

Captions are fetched with yt-dlp (--skip-download, manual subs preferred, else
ASR "en-orig"), as json3. json3 has one event per caption line with no rolling
duplication (the duplication only exists in the VTT rendering, handled by
lines_from_vtt as a fallback). Lines are grouped into transcript-panel-sized
entries (TRANSCRIPT_GROUP_SECONDS) and timestamps are floored to whole seconds,
like the old files. On a 2020 episode whose captions are unchanged this
reproduces the old Apify entry boundaries for 100% of timestamps; on 2025
episodes (YouTube has since re-run ASR with punctuation) entry counts match
within 1%.
"""
from __future__ import annotations

import gzip
import html
import json
import logging
import math
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, yt
from .state import State, now_iso

log = logging.getLogger(__name__)


# ------------------------------------------------------------------ parsing
def lines_from_json3(path: Path) -> list[tuple[float, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs or ev.get("aAppend"):
            continue  # window-definition events and the "\n" append events of rolling ASR
        text = "".join(s.get("utf8", "") for s in segs)
        text = re.sub(r"\s+", " ", text.replace("\n", " ")).strip()
        if text:
            out.append((ev.get("tStartMs", 0) / 1000.0, text))
    return out


_VTT_TIME = re.compile(r"(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})")


def _vtt_secs(h, m, s, ms) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def lines_from_vtt(path: Path) -> list[tuple[float, str]]:
    """Fallback parser that de-duplicates YouTube's rolling auto-caption cues.

    In ASR VTT every real cue shows [previous line, new line] and is followed by
    a 10 ms "freeze" cue repeating the text. Keep the last line of each cue that
    lasts >= 50 ms, skipping single-line cues that only repeat the last line.
    (Cue bodies can start with a whitespace-only line, so cues are split on the
    timing lines, not on blank lines.)"""
    cues: list[tuple[float, float, list[str]]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        m = _VTT_TIME.search(raw)
        if m:
            cues.append((_vtt_secs(*m.groups()[:4]), _vtt_secs(*m.groups()[4:]), []))
        elif cues:
            text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", raw))).strip()
            if text:
                cues[-1][2].append(text)
    out: list[tuple[float, str]] = []
    for start, end, body in cues:
        if end - start < 0.05 or not body:
            continue
        if len(body) == 1 and out and body[0] == out[-1][1]:
            continue
        out.append((start, body[-1]))
    return out


def format_ts(seconds: float) -> str:
    s = int(math.floor(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def group_lines(lines: list[tuple[float, str]], group_seconds: float = config.TRANSCRIPT_GROUP_SECONDS) -> list[dict]:
    entries: list[dict] = []
    cur_start: float | None = None
    cur_text: list[str] = []
    for start, text in sorted(lines, key=lambda x: x[0]):
        if cur_start is None or start - cur_start >= group_seconds:
            if cur_text:
                entries.append({"timestamp": format_ts(cur_start), "text": " ".join(cur_text)})
            cur_start, cur_text = start, [text]
        else:
            cur_text.append(text)
    if cur_text:
        entries.append({"timestamp": format_ts(cur_start), "text": " ".join(cur_text)})
    return entries


def _short_count(n: int | None) -> str:
    if not n:
        return ""
    for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if n >= div:
            v = f"{n / div:.1f}".rstrip("0").rstrip(".")
            return f"{v}{suf}"
    return str(n)


def build_transcript(info: dict, entries: list[dict]) -> list[dict]:
    ts = info.get("timestamp") or info.get("release_timestamp")
    post_date = ""
    if ts:
        d = datetime.fromtimestamp(ts, tz=timezone.utc)
        post_date = f"{d:%b} {d.day}, {d.year}"
    elif info.get("upload_date"):
        d = datetime.strptime(info["upload_date"], "%Y%m%d")
        post_date = f"{d:%b} {d.day}, {d.year}"
    subs = info.get("channel_follower_count")
    views = info.get("view_count")
    return [{
        "channelName": info.get("channel") or info.get("uploader") or config.CHANNEL_NAME,
        "channelSubscription": f"{_short_count(subs)} subscribers" if subs else "",
        "videoTitle": info.get("title") or "",
        "url": f"https://www.youtube.com/watch?v={info['id']}",
        "views": f"{views:,} views" if views is not None else "",
        "videoPostDate": post_date,
        "transcript": " ".join(e["text"] for e in entries),
        "transcriptWithTimestamps": entries,
    }]


def trimmed_meta(info: dict, sub_source: dict | None) -> dict:
    keys = ("id", "title", "description", "timestamp", "release_timestamp", "upload_date", "duration",
            "view_count", "channel", "channel_id", "channel_follower_count", "availability", "live_status",
            "was_live", "age_limit")
    meta = {k: info.get(k) for k in keys}
    meta["manual_subtitle_langs"] = sorted((info.get("subtitles") or {}).keys())
    meta["auto_caption_langs_en"] = sorted(k for k in (info.get("automatic_captions") or {}) if k.startswith("en"))
    meta["subtitle_source"] = sub_source
    meta["fetchedAt"] = now_iso()
    return meta


def iso_date(info: dict) -> str | None:
    ts = info.get("timestamp") or info.get("release_timestamp")
    if ts:
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if info.get("upload_date"):
        return datetime.strptime(info["upload_date"], "%Y%m%d").strftime("%Y-%m-%dT00:00:00Z")
    return None


# ------------------------------------------------------------------ fetching
def fetch_captions(video_id: str, work: Path, cookies: str | None = None) -> tuple[dict, Path | None, dict | None]:
    """Download metadata + English captions into `work`. Returns (info, caption_path, source)."""
    import yt_dlp

    work.mkdir(parents=True, exist_ok=True)
    opts = {
        **yt.base_opts(cookies),
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "json3/vtt/best",
        "outtmpl": {"default": str(work / "%(id)s.%(ext)s")},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        # Pick one track first, then download only that one. Requesting every English variant
        # at once fails the whole video when an unused track is throttled (HTTP 429 on the
        # machine-translated "en" ASR track while "en-orig" downloads fine).
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        manual = set((info.get("subtitles") or {}).keys())
        auto = set((info.get("automatic_captions") or {}).keys())
        # 1) human subtitles in any English variant, 2) original-language ASR, 3) other English ASR
        choice = next(((lang, "manual") for lang in config.CAPTION_LANGS if lang in manual), None) or \
            next(((lang, "auto") for lang in config.CAPTION_LANGS if lang in auto), None)
        if choice is None:
            return ydl.sanitize_info(info), None, None
        lang, kind = choice
        ydl.params["subtitleslangs"] = [lang]
        ydl.params["writeautomaticsub"] = kind == "auto"
        info = ydl.process_ie_result(info, download=True)
    info = ydl.sanitize_info(info)

    sub = (info.get("requested_subtitles") or {}).get(lang)
    if sub:
        p = Path(sub.get("filepath") or work / f"{video_id}.{lang}.{sub.get('ext')}")
        if p.exists() and p.stat().st_size > 0:
            return info, p, {"lang": lang, "kind": kind, "ext": p.suffix.lstrip(".")}
    return info, None, None


def transcript_from_caption_file(info: dict, path: Path) -> list[dict]:
    lines = lines_from_json3(path) if path.suffix == ".json3" else lines_from_vtt(path)
    return build_transcript(info, group_lines(lines))


# ------------------------------------------------------------------ step
def process_one(vid: str, out_dir: Path, cookies: str | None, raw_dir: Path = config.CAPTIONS_RAW_DIR) -> dict:
    t0 = time.perf_counter()
    raw_dir.mkdir(parents=True, exist_ok=True)
    work = raw_dir / vid
    info, cap, source = fetch_captions(vid, work, cookies)
    meta = trimmed_meta(info, source)
    (raw_dir / f"{vid}.meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    result = {
        "title": info.get("title"),
        "date": iso_date(info),
        "durationSeconds": info.get("duration"),
        "seconds": None,
    }
    if cap is None:
        result.update(status="no_captions", seconds=round(time.perf_counter() - t0, 1))
        return result
    transcript = transcript_from_caption_file(info, cap)
    out = out_dir / f"transcript-{vid}.json"
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(out)
    # keep the raw caption (gzipped, ~10x smaller) next to the metadata for provenance
    with open(cap, "rb") as src, gzip.open(raw_dir / f"{vid}.{source['lang']}.{source['ext']}.gz", "wb") as dst:
        shutil.copyfileobj(src, dst)
    shutil.rmtree(work, ignore_errors=True)
    entries = transcript[0]["transcriptWithTimestamps"]
    result.update(
        status="done" if entries else "empty",
        source=source,
        entries=len(entries),
        words=len(transcript[0]["transcript"].split()),
        file=str(out),
        seconds=round(time.perf_counter() - t0, 1),
    )
    return result


def run(args, state: State) -> dict:
    if args.calibration:
        out_dir = config.CALIBRATION_DIR / "caption_transcripts"
        out_dir.mkdir(parents=True, exist_ok=True)
        ids = [v.strip() for v in (args.ids or "").split(",") if v.strip()]
        done = {}
        for i, vid in enumerate(ids):
            if i:
                yt.polite_sleep(args.sleep_min, args.sleep_max, "between videos")
            done[vid] = process_one(vid, out_dir, args.cookies_from_browser, config.CALIBRATION_DIR / "captions_raw")
            log.info("calibration captions %s: %s", vid, done[vid])
        return {"calibration": done}

    # `unavailable` is only retried when named with --ids (e.g. age-restricted ones with --cookies-from-browser)
    pending = lambda v: args.force or v.get("captions", {}).get("status") not in ("done", "empty", "no_captions", "unavailable")
    todo = state.select(args.ids, args.limit, pending)
    log.info("captions: %d episode(s) to process", len(todo))
    summary = {"done": 0, "empty": 0, "no_captions": 0, "unavailable": 0, "error": 0}
    fails = 0
    for i, v in enumerate(todo):
        vid = v["videoId"]
        if i:
            yt.polite_sleep(args.sleep_min, args.sleep_max, "between videos")
        try:
            res = process_one(vid, config.TRANSCRIPTS_DIR, args.cookies_from_browser)
            fails = 0
        except Exception as e:  # noqa: BLE001 - keep going, record the failure
            if reason := yt.unavailable_reason(e):
                log.warning("captions %s #%s unavailable (%s), skipping: %s", vid, v.get("episode"), reason, e)
                state.set_step(vid, "captions", status="unavailable", reason=reason, error=str(e)[:500])
                summary["unavailable"] += 1
                continue
            fails += 1
            blocked = yt.looks_like_block(e)
            log.error("captions %s failed: %s", vid, e)
            state.set_step(vid, "captions", status="error", error=str(e)[:500], blocked=blocked)
            summary["error"] += 1
            if fails >= config.MAX_CONSECUTIVE_FAILURES:
                log.error("stopping after %d consecutive failures", fails)
                break
            yt.backoff_after_failure(fails, blocked)
            continue
        state.update_video(vid, **{k: res[k] for k in ("title", "date", "durationSeconds") if res.get(k)})
        state.set_step(vid, "captions", **{k: v2 for k, v2 in res.items() if k not in ("title", "date", "durationSeconds")})
        summary[res["status"]] += 1
        log.info("captions %s #%s: %s, %s entries, %s words, source=%s, %.1fs", vid, v.get("episode"), res["status"],
                 res.get("entries"), res.get("words"), res.get("source"), res["seconds"])
    return summary
