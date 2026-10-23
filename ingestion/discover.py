"""Find JRE episodes on YouTube that the Firestore tracker doesn't know yet.

Lists the JRE playlist AND the channel's /videos tab flat with yt-dlp (no API
key; some episodes, e.g. #2469 and #2564, are missing from the playlist but are
public uploads), keeps titles matching
"Joe Rogan Experience #NNNN" with NNNN above the highest tracked episode
number and a videoId not in the tracker. Private/deleted playlist entries
(no title) are counted and skipped.
"""
from __future__ import annotations

import json
import logging
import re
from collections import Counter
from datetime import datetime, timezone

from . import config, gcp, yt
from .state import State, now_iso

log = logging.getLogger(__name__)
EPISODE_RE = re.compile(config.EPISODE_TITLE_RE, re.IGNORECASE)


def episode_number(title: str | None) -> int | None:
    m = EPISODE_RE.match(title or "")
    return int(m.group(1)) if m else None


def _flat(url: str, source: str) -> list[dict]:
    import yt_dlp

    opts = {**yt.base_opts(), "extract_flat": "in_playlist", "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return [
        {"id": e.get("id"), "title": e.get("title"), "duration": e.get("duration"), "playlistIndex": i, "source": source}
        for i, e in enumerate(info.get("entries") or [], start=1)
    ]


def list_playlist(include_channel: bool = True) -> list[dict]:
    entries = _flat(config.PLAYLIST_URL, "playlist")
    log.info("playlist: %d entries", len(entries))
    if include_channel:
        seen = {e["id"] for e in entries}
        chan = _flat(f"https://www.youtube.com/channel/{config.CHANNEL_ID}/videos", "channel")
        extra = [e for e in chan if e["id"] not in seen]
        log.info("channel uploads: %d entries, %d not in the playlist", len(chan), len(extra))
        entries += extra
    return entries


def backfill_empty(state: State) -> dict:
    """Register tracked episodes whose 2025 transcript came back empty.

    YouTube has no captions for them (checked 2026-10-23), so they go to the
    `transcribe` step. They keep the tracker's title/date; `mark` only flips flags.
    """
    tracker = gcp.firestore_list_tracker()
    empty = {vid: t for vid, t in tracker.items() if t.get("isEmptyTranscript") is True}
    added = 0
    for vid, t in empty.items():
        v = state.video(vid)
        if "discoveredAt" not in v:
            added += 1
            state.update_video(vid, discoveredAt=now_iso())
        state.update_video(vid, backfill="emptyTranscript", episode=episode_number(t.get("title")),
                           title=t.get("title") or "", date=t.get("date") or "",
                           url=f"https://www.youtube.com/watch?v={vid}")
    state.save()
    report = {"emptyTranscriptEpisodes": len(empty), "newlyAddedToState": added,
              "numbered": sum(1 for t in empty.values() if episode_number(t.get("title")) is not None)}
    log.info("discover --backfill-empty: %s", json.dumps(report))
    return report


def run(args, state: State) -> dict:
    if args.backfill_empty:
        return backfill_empty(state)
    entries = list_playlist(include_channel=not args.playlist_only)
    tracker = gcp.firestore_list_tracker()
    tracked_numbers = [n for n in (episode_number(t.get("title")) for t in tracker.values()) if n is not None]
    max_tracked = max(tracked_numbers) if tracked_numbers else 0
    floor = args.min_episode if args.min_episode is not None else max_tracked
    log.info("tracker: %d docs, highest tracked episode #%d; selecting episodes > #%d", len(tracker), max_tracked, floor)

    kinds = Counter()
    new, by_number, old_untracked = [], {}, []
    for e in entries:
        if not e["title"]:
            kinds["private_or_deleted"] += 1
            continue
        n = episode_number(e["title"])
        if n is None:
            kinds["not_numbered_jre_episode"] += 1  # MMA shows, fight companions, clips...
            continue
        if e["id"] in tracker and not args.include_tracked:
            kinds["already_tracked"] += 1
            continue
        if n <= floor:
            kinds["numbered_but_old_untracked"] += 1
            old_untracked.append({"id": e["id"], "title": e["title"]})
            continue
        kinds["new"] += 1
        new.append({**e, "episode": n})
        by_number.setdefault(n, []).append(e["id"])

    dupes = {n: ids for n, ids in by_number.items() if len(ids) > 1}
    numbers = sorted(by_number)
    gaps = [n for n in range(floor + 1, (numbers[-1] if numbers else floor) + 1) if n not in by_number]

    added = 0
    for e in new:
        v = state.video(e["id"])
        if "discoveredAt" not in v:
            added += 1
            state.update_video(e["id"], discoveredAt=now_iso())
        state.update_video(e["id"], episode=e["episode"], url=f"https://www.youtube.com/watch?v={e['id']}", listedIn=e["source"])
        if not (v.get("captions") or {}).get("status"):
            state.update_video(e["id"], title=e["title"])  # captions step refreshes it from full metadata
        if "playlistIndex" in v:
            state.remove_field(e["id"], "playlistIndex")
        if e.get("duration"):
            state.update_video(e["id"], durationSeconds=e["duration"])
    state.save()

    report = {
        "ranAt": now_iso(),
        "listedEntries": len(entries),
        "fromChannelOnly": sum(1 for e in new if e["source"] == "channel"),
        "trackerDocs": len(tracker),
        "maxTrackedEpisode": max_tracked,
        "selectingAbove": floor,
        "counts": dict(kinds),
        "newEpisodes": len(new),
        "newlyAddedToState": added,
        "episodeRange": [numbers[0], numbers[-1]] if numbers else None,
        "missingNumbersInRange": gaps,
        "duplicateNumbers": dupes,
        "oldNumberedNotInTracker": old_untracked,
        "totalDurationHours": round(sum(e.get("duration") or 0 for e in new) / 3600, 1),
    }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = config.WORK_DIR / f"discover-{stamp}.json"
    path.write_text(json.dumps({**report, "episodes": new}, indent=1, ensure_ascii=False), encoding="utf-8")
    log.info("discover: %s (details in %s)", json.dumps(report), path)
    return report
