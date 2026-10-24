"""CLI: python -m ingestion <step> [options]

Steps (each idempotent and resumable; state in F:\\jre-all-episodes\\ingestion\\state.json):
  discover   list the JRE playlist with yt-dlp, diff against the Firestore tracker
  captions   YouTube captions -> transcriptions\\transcript-{id}.json (existing Apify format)
  transcribe Whisper (CPU) fallback for episodes without YouTube captions, same output format
  chunk      local embeddings + exact C# chunking -> ingestion\\chunks\\{id}.ndjson
  import     upload a batch NDJSON + Discovery Engine documents:import (dry-run unless --apply)
  mark       update the Firestore jre-episodes tracker (dry-run unless --apply)
  download   480p mp4 -> gs://jre-all-episodes/{id}.mp4, verify, delete local
  status     summary of the state file
  calibrate  recalibrate the similarity threshold against the existing corpus
"""
from __future__ import annotations

import argparse
import json
import logging

from . import config
from .state import State, now_iso, setup_logging

log = logging.getLogger("ingestion")


def _add_selection(p: argparse.ArgumentParser) -> None:
    p.add_argument("--ids", help="comma-separated video ids (must be in state)")
    p.add_argument("--limit", type=int, help="process at most N pending episodes, oldest first")
    p.add_argument("--new-only", action="store_true",
                   help="skip backfill episodes (they sort first, so a plain run starts with them)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ingestion", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="step", required=True)

    p = sub.add_parser("discover", help="find new episodes")
    p.add_argument("--min-episode", type=int, help="override: only episodes with number > this (default: max tracked number)")
    p.add_argument("--include-tracked", action="store_true", help="also list ids already in the tracker (debug)")
    p.add_argument("--playlist-only", action="store_true", help="skip the channel /videos tab")
    p.add_argument("--backfill-empty", action="store_true",
                   help="instead: register tracked episodes whose transcript is empty (isEmptyTranscript) for transcribe")

    p = sub.add_parser("captions", help="fetch captions and write transcript JSON")
    _add_selection(p)
    p.add_argument("--force", action="store_true", help="refetch even if a transcript exists")
    p.add_argument("--sleep-min", type=float, default=config.CAPTION_SLEEP_RANGE[0])
    p.add_argument("--sleep-max", type=float, default=config.CAPTION_SLEEP_RANGE[1])
    p.add_argument("--calibration", action="store_true",
                   help="ids are OLD episodes: write to calibration\\caption_transcripts, don't touch state")
    p.add_argument("--cookies-from-browser", help="pass through to yt-dlp if YouTube asks to sign in (e.g. 'firefox')")

    p = sub.add_parser("transcribe", help="Whisper fallback for episodes without YouTube captions")
    _add_selection(p)
    p.add_argument("--model", default="base.en", help="faster-whisper model (base.en ~29x realtime, small.en ~11x)")
    p.add_argument("--threads", type=int, default=4, help="CPU threads for Whisper")
    p.add_argument("--sleep-min", type=float, default=5.0)
    p.add_argument("--sleep-max", type=float, default=20.0)
    p.add_argument("--keep-audio", action="store_true", help="keep the downloaded audio file")
    p.add_argument("--cookies-from-browser")

    p = sub.add_parser("chunk", help="embed + chunk transcripts into NDJSON")
    _add_selection(p)
    p.add_argument("--force", action="store_true")
    p.add_argument("--threshold", type=float, default=config.SIMILARITY_THRESHOLD)
    p.add_argument("--model", default=config.EMBED_MODEL)

    p = sub.add_parser("import", help="import chunked episodes into the Discovery Engine data store")
    _add_selection(p)
    p.add_argument("--apply", action="store_true", help="really upload + import (default: dry-run)")
    p.add_argument("--batch-name", help="override batch file name (default: <UTC date>.ndjson)")
    p.add_argument("--explicit-ids", action="store_true",
                   help="import with dataSchema=document and explicit ids instead of custom+autoGenerateIds")
    p.add_argument("--no-wait", action="store_true", help="don't poll the long-running operation")
    p.add_argument("--reimport", action="store_true", help="include episodes already imported")
    p.add_argument("--source-uri", help="backfill: import an existing custom-format NDJSON in GCS as-is "
                   "(e.g. the original jre-segments-all.ndjson) with the original config")

    p = sub.add_parser("mark", help="update the Firestore tracker")
    _add_selection(p)
    p.add_argument("--apply", action="store_true", help="really write to Firestore (default: dry-run)")
    p.add_argument("--allow-unimported", action="store_true",
                   help="also mark transcribed-but-not-imported episodes (isVectorized=false)")

    p = sub.add_parser("download", help="download 480p mp4, upload to GCS, verify, delete local")
    _add_selection(p)
    p.add_argument("--sleep-min", type=float, default=config.DOWNLOAD_SLEEP_RANGE[0])
    p.add_argument("--sleep-max", type=float, default=config.DOWNLOAD_SLEEP_RANGE[1])
    p.add_argument("--rate-limit", help="yt-dlp --limit-rate value, e.g. 5M")
    p.add_argument("--keep-local", action="store_true", help="don't delete the local file after verified upload")
    p.add_argument("--include-backfill", action="store_true",
                   help="also download old backfill episodes (default: only newly discovered episodes)")
    p.add_argument("--cookies-from-browser")

    sub.add_parser("status", help="print a summary of the state file")

    p = sub.add_parser("calibrate", help="recalibrate the similarity threshold")
    p.add_argument("--sample-bytes", type=int, default=50_000_000)
    p.add_argument("--refresh", action="store_true", help="re-stream the sample from GCS")
    p.add_argument("--episodes", type=int, default=40, help="episodes from the sample to calibrate on")
    p.add_argument("--ids", help="explicit calibration episode ids (must be complete in the sample)")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--model", default=config.EMBED_MODEL)
    p.add_argument("--t-min", type=float, default=0.60)
    p.add_argument("--t-max", type=float, default=0.95)
    p.add_argument("--t-step", type=float, default=0.005)
    p.add_argument("--compare", action="store_true",
                   help="pipeline check: chunk caption transcripts of --ids (old episodes) and compare to existing segments")
    p.add_argument("--existing", help="local copy of jre-segments-all.ndjson for --compare (default: the head sample)")
    p.add_argument("--threshold", type=float, default=config.SIMILARITY_THRESHOLD)

    args = ap.parse_args(argv)
    setup_logging(args.verbose)
    config.ensure_dirs()
    started = now_iso()
    state = State()
    state.new_only = getattr(args, "new_only", False)

    if args.step == "discover":
        from .discover import run
    elif args.step == "captions":
        from .captions import run
    elif args.step == "transcribe":
        from .transcribe import run
    elif args.step == "chunk":
        from .chunk_step import run
    elif args.step == "import":
        from .importer import run
    elif args.step == "mark":
        from .mark import run
    elif args.step == "download":
        from .download import run
    elif args.step == "status":
        from .status import run
    elif args.step == "calibrate":
        from . import calibrate

        result = calibrate.compare(args) if args.compare else calibrate.run(args)
        summary = {k: result[k] for k in ("chosen_threshold", "original_no_break_rate", "chosen") if k in result} or {
            "all_new": result.get("all_new"), "all_existing": result.get("all_existing")}
        print(json.dumps(summary, indent=1))
        return 0
    summary = run(args, state)
    if args.step != "status":
        state.record_run(args.step, {k: v for k, v in vars(args).items() if k != "step"}, summary or {}, started)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
