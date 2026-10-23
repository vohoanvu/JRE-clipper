"""download step: 480p mp4 -> gs://jre-all-episodes/{id}.mp4 -> verify -> delete local.

Mirrors the owner's batch_download.sh / upload_to_gcs.sh conventions:
format bestvideo[height<=480]+bestaudio merged to mp4, file name {id}.mp4,
parallel composite uploads disabled, local copy deleted only after the
uploaded object's size and MD5 match. Resumable: objects already in the
bucket are skipped, a finished local mp4 is uploaded without re-downloading,
and interrupted downloads continue from yt-dlp's .part files.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import time

from . import config, gcp, yt
from .state import State, now_iso

log = logging.getLogger(__name__)


def probe_duration(path) -> float | None:
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    r = subprocess.run([exe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def _progress_hook():
    last = {"pct": -25}

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                pct = int(d.get("downloaded_bytes", 0) * 100 / total)
                if pct >= last["pct"] + 25:
                    last["pct"] = pct - pct % 25
                    log.info("  %s: %d%% of %.0f MB at %s", d.get("info_dict", {}).get("format_id"), pct, total / 1e6,
                             d.get("_speed_str", "?").strip())
        elif d.get("status") == "finished":
            last["pct"] = -25
            log.info("  finished %s", d.get("filename"))

    return hook


def download_mp4(vid: str, rate_limit: str | None, cookies: str | None) -> dict:
    import yt_dlp
    from yt_dlp.utils import parse_bytes

    opts = {
        **yt.base_opts(cookies),
        "format": config.VIDEO_FORMAT,
        "merge_output_format": "mp4",
        "outtmpl": {"default": str(config.VIDEO_DIR / "%(id)s.%(ext)s")},
        "noplaylist": True,
        "continuedl": True,
        "fragment_retries": 10,
        "concurrent_fragment_downloads": 1,
        "progress_hooks": [_progress_hook()],
    }
    if rate_limit:
        opts["ratelimit"] = parse_bytes(rate_limit)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=True)
    fmts = info.get("requested_formats") or [info]
    return {
        "formats": "+".join(f.get("format_id", "?") for f in fmts),
        "vcodec": next((f.get("vcodec") for f in fmts if f.get("vcodec") not in (None, "none")), None),
        "acodec": next((f.get("acodec") for f in fmts if f.get("acodec") not in (None, "none")), None),
        "height": info.get("height"),
        "duration": info.get("duration"),
    }


def run(args, state: State) -> dict:
    pending = lambda v: (v.get("download") or {}).get("status") != "done" and (
        args.include_backfill or not v.get("backfill"))
    todo = state.select(args.ids, args.limit, pending)
    log.info("download: %d episode(s)", len(todo))
    summary = {"done": 0, "skipped_in_bucket": 0, "error": 0}
    fails = 0
    downloaded_before = False
    for v in todo:
        vid = v["videoId"]
        uri = f"{config.VIDEO_BUCKET}/{vid}.mp4"
        local = config.VIDEO_DIR / f"{vid}.mp4"
        desc = gcp.gcs_describe(uri)
        if desc:
            log.info("%s already in bucket (%d bytes), skipping", vid, int(desc["size"]))
            if local.exists() and local.stat().st_size == int(desc["size"]) and not args.keep_local:
                local.unlink()
            state.set_step(vid, "download", status="done", gcs=uri, size=int(desc["size"]), skipped="already_in_bucket")
            summary["skipped_in_bucket"] += 1
            continue
        try:
            rec: dict = {}
            if not local.exists():
                if downloaded_before:
                    yt.polite_sleep(args.sleep_min, args.sleep_max, "between downloads")
                t0 = time.perf_counter()
                log.info("downloading %s #%s", vid, v.get("episode"))
                rec.update(download_mp4(vid, args.rate_limit, args.cookies_from_browser))
                downloaded_before = True
                rec["downloadSeconds"] = round(time.perf_counter() - t0, 1)
            if not local.exists():
                raise RuntimeError(f"yt-dlp finished but {local} is missing")
            size = local.stat().st_size
            dur = probe_duration(local)
            expected = v.get("durationSeconds") or rec.get("duration")
            if dur is None or (expected and abs(dur - expected) > max(10, 0.01 * expected)):
                raise RuntimeError(f"{local} looks incomplete: probed {dur}s, expected {expected}s")
            md5 = gcp.md5_b64(local)
            t1 = time.perf_counter()
            log.info("uploading %s (%.0f MB) -> %s", local.name, size / 1e6, uri)
            gcp.gcs_upload(str(local), uri)
            rec["uploadSeconds"] = round(time.perf_counter() - t1, 1)
            desc = gcp.gcs_describe(uri)
            if not desc or int(desc["size"]) != size or desc.get("md5_hash") != md5:
                raise RuntimeError(f"upload verification failed for {uri}: {desc and (desc.get('size'), desc.get('md5_hash'))} vs {(size, md5)}")
            if not args.keep_local:
                local.unlink()
            state.set_step(vid, "download", status="done", gcs=uri, size=size, md5=md5, probedDuration=dur,
                           localDeleted=not args.keep_local, uploadedAt=now_iso(), **rec)
            summary["done"] += 1
            fails = 0
            log.info("download %s done: %s", vid, {k: rec.get(k) for k in ("formats", "vcodec", "acodec", "downloadSeconds", "uploadSeconds")})
        except Exception as e:  # noqa: BLE001
            fails += 1
            blocked = yt.looks_like_block(e)
            log.error("download %s failed: %s", vid, e)
            state.set_step(vid, "download", status="error", error=str(e)[:500], blocked=blocked)
            summary["error"] += 1
            if fails >= config.MAX_CONSECUTIVE_FAILURES:
                log.error("stopping after %d consecutive failures", fails)
                break
            yt.backoff_after_failure(fails, blocked)
    return summary
