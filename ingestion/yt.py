"""yt-dlp helpers shared by discover / captions / download.

yt-dlp needs an external JS runtime for YouTube (signature / n challenges).
Deno is installed via `winget install DenoLand.Deno` and found on PATH; the
challenge solver scripts come from the `yt-dlp-ejs` package (yt-dlp[default]).
"""
from __future__ import annotations

import logging
import random
import time

log = logging.getLogger("ingestion.yt")

BOT_MARKERS = ("Sign in to confirm", "HTTP Error 429", "Too Many Requests", "not a bot", "rate-limit", "rate limit")


class _YtLogger:
    def debug(self, msg):
        if msg.startswith("[debug] "):
            return
        log.debug(msg)

    def info(self, msg):
        log.debug(msg)

    def warning(self, msg):
        log.warning(msg)

    def error(self, msg):
        log.error(msg)


def base_opts(cookies_from_browser: str | None = None) -> dict:
    opts = {
        "logger": _YtLogger(),
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "retries": 10,
        "extractor_retries": 3,
        "sleep_interval_requests": 1.0,   # polite: 1 s between API requests of one extraction
        "socket_timeout": 60,
    }
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)
    return opts


def looks_like_block(err: BaseException | str) -> bool:
    s = str(err)
    return any(m.lower() in s.lower() for m in BOT_MARKERS)


def polite_sleep(lo: float, hi: float, why: str = "") -> None:
    if hi <= 0:
        return
    t = random.uniform(lo, hi)
    log.info("sleeping %.0f s%s", t, f" ({why})" if why else "")
    time.sleep(t)


def backoff_after_failure(n_consecutive: int, blocked: bool) -> None:
    base = 600 if blocked else 60
    t = min(3600, base * (2 ** (n_consecutive - 1)))
    log.warning("backing off %d s after %d consecutive failure(s)%s", t, n_consecutive, " (YouTube throttling?)" if blocked else "")
    time.sleep(t)
