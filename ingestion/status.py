"""Print a compact summary of state.json."""
from __future__ import annotations

from collections import Counter

from .state import State

STEPS = ("captions", "chunk", "import", "mark", "download")


def _summarize(label: str, vids: list[dict]) -> dict:
    numbered = [v["episode"] for v in vids if v.get("episode") is not None]
    span = f" (#{min(numbered)} .. #{max(numbered)})" if numbered else ""
    print(f"{len(vids)} {label}{span}")
    summary = {}
    for step in STEPS:
        c = Counter((v.get(step) or {}).get("status", "pending") for v in vids)
        summary[step] = dict(c)
        print(f"  {step:9s} " + ", ".join(f"{k}={n}" for k, n in sorted(c.items())))
    return summary


def run(args, state: State) -> dict:
    vids = state.ordered()
    new = [v for v in vids if not v.get("backfill")]
    backfill = [v for v in vids if v.get("backfill")]
    summary = {"new": _summarize("discovered new episodes", new)}
    if backfill:
        whisper = sum(1 for v in backfill if ((v.get("captions") or {}).get("source") or {}).get("kind") == "whisper")
        print()
        summary["backfill"] = _summarize(f"backfill episodes (empty 2025 transcripts; {whisper} transcribed by Whisper)", backfill)
    started = [v for v in new if any(v.get(s) for s in STEPS)]
    if started:
        print("\nnew episodes with progress:")
        for v in started:
            flags = " ".join(f"{s}={(v.get(s) or {}).get('status', '-')}" for s in STEPS)
            print(f"  #{v.get('episode', '-')} {v['videoId']}  {flags}  {v.get('title', '')[:60]}")
    return summary
