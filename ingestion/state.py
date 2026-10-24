"""Resumable JSON state + logging under F:\\jre-all-episodes\\ingestion.

state.json layout:
{
  "videos": {
    "<videoId>": {
      "videoId", "episode", "title", "url", "discoveredAt", "playlistIndex",
      "captions": {"status": "done|empty|no_captions|unavailable|error", ...},  # unavailable: reason age_restricted|blocked
      "chunk":    {"status": "done|empty|error", "segments", "threshold", "model", "file", ...},
      "import":   {"status": "done", "docIds": [...], "batch": "...", ...},
      "mark":     {"status": "done", ...},
      "download": {"status": "done|unavailable|error", "gcs", "size", ...}
    }
  },
  "runs": [ {step, startedAt, finishedAt, args, summary} ]
}
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config


@contextmanager
def _file_lock(path, timeout: float = 30.0, stale_after: float = 120.0):
    """Exclusive lock via O_EXCL file creation (works on Windows and POSIX).
    A lock older than `stale_after` seconds is assumed abandoned by a killed process."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(path) > stale_after:
                    os.remove(path)
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() > deadline:
                raise TimeoutError(f"could not lock {path}")
            time.sleep(0.05)
    try:
        yield
    finally:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def setup_logging(verbose: bool = False) -> None:
    config.WORK_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    fh = logging.FileHandler(config.LOG_FILE, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    root.handlers[:] = [fh, sh]
    for noisy in ("urllib3", "httpx", "huggingface_hub", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class State:
    def __init__(self, path=config.STATE_FILE):
        self.path = path
        if path.exists():
            self.data = json.loads(path.read_text(encoding="utf-8"))
        else:
            self.data = {"videos": {}, "runs": []}
        self.data.setdefault("videos", {})
        self.data.setdefault("runs", [])
        self._touched: set[tuple[str, str]] = set()
        self._new_runs: list[dict] = []
        self.new_only = False  # select() skips backfill episodes (--new-only)

    # -------------------------------------------------------------- persistence
    def save(self) -> None:
        """Merge-save: re-read the file and write back only the keys this process
        changed, so two steps running at the same time (e.g. captions and
        download) don't overwrite each other's progress. The read-merge-write is
        serialized across processes with a lock file."""
        with _file_lock(self.path.with_suffix(".lock")):
            self._merge_save()

    def _merge_save(self) -> None:
        disk = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
        disk.setdefault("videos", {})
        disk.setdefault("runs", [])
        for vid, key in self._touched:
            mine = self.data["videos"].get(vid, {})
            target = disk["videos"].setdefault(vid, {"videoId": vid})
            if key in mine:
                target[key] = mine[key]
            else:
                target.pop(key, None)
        disk["runs"] += self._new_runs
        self._new_runs = []
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(disk, indent=1, ensure_ascii=False), encoding="utf-8")
        for attempt in range(5):
            try:
                os.replace(tmp, self.path)
                return
            except PermissionError:  # Windows: file briefly locked by an editor/AV scanner
                time.sleep(0.5 * (attempt + 1))
        os.replace(tmp, self.path)

    # -------------------------------------------------------------- videos
    @property
    def videos(self) -> dict:
        return self.data["videos"]

    def video(self, vid: str) -> dict:
        return self.videos.setdefault(vid, {"videoId": vid})

    def step(self, vid: str, step: str) -> dict:
        return self.video(vid).get(step) or {}

    def update_video(self, vid: str, **fields) -> None:
        """Set top-level fields of a video (title, date, ...); persisted on save()."""
        v = self.video(vid)
        for k, val in fields.items():
            v[k] = val
            self._touched.add((vid, k))
        self._touched.add((vid, "videoId"))

    def remove_field(self, vid: str, key: str) -> None:
        self.video(vid).pop(key, None)
        self._touched.add((vid, key))

    def set_step(self, vid: str, step: str, **fields) -> None:
        self.video(vid)[step] = {**fields, "updatedAt": now_iso()}
        self._touched.add((vid, step))
        self.save()

    def ordered(self) -> list[dict]:
        """Discovered and backfill episodes, oldest episode number first
        (unnumbered backfill shows like Fight Companions sort first)."""
        vs = [v for v in self.videos.values() if v.get("episode") is not None or v.get("backfill")]
        return sorted(vs, key=lambda v: (v.get("episode") or 0, v["videoId"]))

    def select(self, ids: str | None, limit: int | None, pending: callable) -> list[dict]:
        if ids:
            out = []
            for vid in ids.split(","):
                vid = vid.strip()
                if vid not in self.videos:
                    raise SystemExit(f"{vid} is not in state; run discover first (or check the id)")
                out.append(self.videos[vid])
            return out
        out = [v for v in self.ordered() if pending(v) and not (self.new_only and v.get("backfill"))]
        return out[:limit] if limit is not None else out

    # -------------------------------------------------------------- runs
    def record_run(self, step: str, args: dict, summary: dict, started: str) -> None:
        run = {"step": step, "startedAt": started, "finishedAt": now_iso(), "args": args, "summary": summary}
        self.data["runs"].append(run)
        self._new_runs.append(run)
        self.save()
