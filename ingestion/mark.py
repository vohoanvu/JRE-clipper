"""mark step: publish transcripts + update the Firestore jre-episodes tracker (dry-run unless --apply).

Per episode it writes the same fields the tracker already uses:
  videoId, title, date (ISO, UTC), Url, description, isTranscripted, isVectorized, isEmptyTranscript
and (with --apply) copies transcript-{id}.json to gs://jre-content/transcriptions/
if it isn't there yet, so the canonical transcript store stays complete.
"""
from __future__ import annotations

import json
import logging

from . import config, gcp
from .state import State, now_iso

log = logging.getLogger(__name__)


def tracker_fields(v: dict) -> dict:
    vid = v["videoId"]
    cap = (v.get("captions") or {}).get("status")
    imported = (v.get("import") or {}).get("status") == "done"
    flags = {
        "isTranscripted": cap in ("done", "empty", "no_captions"),
        "isVectorized": imported,
        "isEmptyTranscript": cap in ("empty", "no_captions"),
    }
    if v.get("backfill"):
        # Already-tracked episode: keep its title/date/description, only update the flags.
        return flags
    meta_path = config.CAPTIONS_RAW_DIR / f"{vid}.meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    return {
        "videoId": vid,
        "title": v.get("title") or meta.get("title") or "",
        "date": v.get("date") or "",
        "Url": f"https://www.youtube.com/watch?v={vid}",
        "description": meta.get("description") or "",
        **flags,
    }


def run(args, state: State) -> dict:
    def pending(v):
        cap = (v.get("captions") or {}).get("status")
        if cap not in ("done", "empty", "no_captions"):
            return False
        if (v.get("import") or {}).get("status") != "done" and not args.allow_unimported:
            return False
        m = v.get("mark") or {}
        return m.get("status") != "done" or m.get("fields") != tracker_fields(v)

    todo = state.select(args.ids, args.limit, pending)
    summary = {"dryRun": not args.apply, "episodes": len(todo), "patched": 0, "transcriptsUploaded": 0}
    for v in todo:
        vid = v["videoId"]
        fields = tracker_fields(v)
        local = config.TRANSCRIPTS_DIR / f"transcript-{vid}.json"
        gcs_uri = f"{config.TRANSCRIPTS_BUCKET_PREFIX}/transcript-{vid}.json"
        # Backfill episodes already have an EMPTY transcript in GCS that must be replaced.
        overwrite = bool(v.get("backfill"))
        if not args.apply:
            desc = fields.get("description", "")
            shown = {**fields, **({"description": desc[:80] + "..."} if len(desc) > 80 else {})}
            log.info("DRY-RUN PATCH %s/%s %s", config.FIRESTORE_BASE, vid, json.dumps(shown, ensure_ascii=False))
            if local.exists():
                log.info("DRY-RUN would copy %s -> %s (%s)", local, gcs_uri, "overwrite" if overwrite else "if absent")
            continue
        if local.exists() and (overwrite or not gcp.gcs_exists(gcs_uri)):
            gcp.gcs_upload(str(local), gcs_uri)
            summary["transcriptsUploaded"] += 1
        gcp.firestore_patch(vid, fields)
        state.set_step(vid, "mark", status="done", fields=fields, markedAt=now_iso())
        summary["patched"] += 1
        log.info("marked %s #%s %s", vid, v.get("episode"), {k: fields[k] for k in ("isTranscripted", "isVectorized", "isEmptyTranscript")})
    return summary
