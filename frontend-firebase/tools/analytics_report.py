"""Funnel report from analyticsEvents in jre-clipper-db (written by the trackEvents function).

Usage, from the repo root (needs a gcloud CLI login; standard library only):
  python frontend-firebase/tools/analytics_report.py              # last 30 days
  python frontend-firebase/tools/analytics_report.py --days 7
  python frontend-firebase/tools/analytics_report.py --include-internal

Internal traffic is excluded by default: any visitor that sent even one internal event (the admin
account, or a browser that opened the site with ?internal=1) is dropped entirely, so your own
anonymous searches from before you signed in don't leak in.

Activation: a session that opened at least 2 moments (played one, or opened it on YouTube) or
copied a citation / results link. Measured against visitors who searched.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

PROJECT = "gen-lang-client-demo"
DATABASE = "jre-clipper-db"
COLLECTION = "analyticsEvents"
RUN_QUERY_URL = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/{DATABASE}/documents:runQuery"
PAGE_SIZE = 1000

MOMENT_OPENS = {"moment_play", "youtube_open"}
SHARES = {"citation_copy", "search_link_copy"}


def access_token() -> str:
    exe = shutil.which("gcloud") or shutil.which("gcloud.cmd")
    if not exe:
        sys.exit("gcloud CLI not found on PATH")
    return subprocess.run([exe, "auth", "print-access-token"], capture_output=True, text=True, check=True).stdout.strip()


def decode(value: dict):
    """Firestore REST value -> Python value."""
    if "stringValue" in value:
        return value["stringValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "booleanValue" in value:
        return value["booleanValue"]
    if "timestampValue" in value:
        return value["timestampValue"]
    if "mapValue" in value:
        return {k: decode(v) for k, v in value["mapValue"].get("fields", {}).items()}
    if "arrayValue" in value:
        return [decode(v) for v in value["arrayValue"].get("values", [])]
    return None


def fetch_events(since: datetime) -> list[dict]:
    token = access_token()
    events, cursor = [], None
    while True:
        query = {
            "from": [{"collectionId": COLLECTION}],
            "where": {"fieldFilter": {
                "field": {"fieldPath": "createdAt"}, "op": "GREATER_THAN_OR_EQUAL",
                "value": {"timestampValue": since.isoformat().replace("+00:00", "Z")},
            }},
            "orderBy": [{"field": {"fieldPath": "createdAt"}}, {"field": {"fieldPath": "__name__"}}],
            "limit": PAGE_SIZE,
        }
        if cursor:
            query["startAt"] = {"values": cursor, "before": False}
        request = urllib.request.Request(
            RUN_QUERY_URL,
            data=json.dumps({"structuredQuery": query}).encode(),
            headers={"Authorization": f"Bearer {token}", "x-goog-user-project": PROJECT,
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            rows = [row["document"] for row in json.load(response) if "document" in row]
        for doc in rows:
            events.append({k: decode(v) for k, v in doc.get("fields", {}).items()})
        if len(rows) < PAGE_SIZE:
            return events
        last = rows[-1]
        cursor = [last["fields"]["createdAt"], {"referenceValue": last["name"]}]


def pct(part: int, whole: int) -> str:
    return f"{100 * part / whole:.0f}%" if whole else "-"


def report(events: list[dict], include_internal: bool, days: int) -> None:
    internal_visitors = {e["visitorId"] for e in events if e.get("internal")}
    if not include_internal:
        events = [e for e in events if e.get("visitorId") not in internal_visitors]

    print(f"JRE Clipper funnel, last {days} days"
          f" ({'including' if include_internal else 'excluding'} {len(internal_visitors)} internal visitor(s))")
    if not events:
        print("No events.")
        return

    by_name = defaultdict(list)
    sessions = defaultdict(list)
    visitor_dates = defaultdict(set)
    for e in events:
        by_name[e["name"]].append(e)
        sessions[(e.get("visitorId"), e.get("sessionId"))].append(e)
        visitor_dates[e.get("visitorId")].add(e.get("date"))

    visitors = set(visitor_dates)
    returning = {v for v, dates in visitor_dates.items() if len(dates) > 1}
    print(f"\nVisitors {len(visitors)}  sessions {len(sessions)}  returning visitors {len(returning)}"
          f"  page views {len(by_name['page_view'])}")
    devices = Counter(e.get("device") for e in by_name["page_view"])
    print("Devices: " + ", ".join(f"{k} {v}" for k, v in devices.most_common()))

    # Where sessions came from: the first page view of each session.
    sources = Counter()
    for session_events in sessions.values():
        views = sorted((e for e in session_events if e["name"] == "page_view"), key=lambda e: e.get("createdAt") or "")
        if views:
            props = views[0].get("props") or {}
            sources[props.get("utm_source") or props.get("ref") or "(direct)"] += 1
    print("\nSessions by source")
    for source, count in sources.most_common(15):
        print(f"  {count:5}  {source}")

    searches = by_name["search"]
    ok = [e for e in searches if "error" not in (e.get("props") or {})]
    zero = [e for e in ok if (e.get("props") or {}).get("results") == 0]
    searchers = {e["visitorId"] for e in searches}
    print(f"\nSearches {len(searches)}  by {len(searchers)} visitors ({pct(len(searchers), len(visitors))} of visitors)"
          f"  zero results {len(zero)}  errors {len(searches) - len(ok)}")
    print("By source: " + ", ".join(f"{k} {v}" for k, v in
                                    Counter((e.get("props") or {}).get("source") for e in searches).most_common()))
    print("Top queries: " + ", ".join(f"{q} ({n})" for q, n in Counter(
        ((e.get("props") or {}).get("query") or "").lower() for e in ok).most_common(15)))
    if zero:
        print("Zero-result queries: " + ", ".join(f"{q} ({n})" for q, n in Counter(
            ((e.get("props") or {}).get("query") or "").lower() for e in zero).most_common(15)))

    activated = set()
    for (visitor, _), session_events in sessions.items():
        names = [e["name"] for e in session_events]
        if sum(n in MOMENT_OPENS for n in names) >= 2 or any(n in SHARES for n in names):
            activated.add(visitor)
    activated &= searchers
    print(f"\nActivated visitors {len(activated)} = {pct(len(activated), len(searchers))} of searchers"
          f"  (target >= 40%; < 20% means fix relevance first)")
    answers = by_name["answer_shown"]
    answered = sum(1 for e in answers if (e.get("props") or {}).get("ok"))
    print(f"AI summaries shown {answered}/{len(answers)}")

    def distinct_visitors(name: str) -> int:
        return len({e["visitorId"] for e in by_name[name]})

    print("\nVisitors reaching each step (any order)")
    for name in ["moment_play", "youtube_open", "citation_copy", "search_link_copy", "compile_click",
                 "signin_prompt", "signin_complete", "job_created", "job_complete", "video_download"]:
        print(f"  {distinct_visitors(name):5}  {name}")
    completed_jobs = {(e.get("props") or {}).get("jobId") for e in by_name["job_complete"]}
    print(f"Distinct completed jobs seen: {len(completed_jobs - {None})}")

    print("\nDaily     visitors searchers activated")
    daily = defaultdict(lambda: [set(), set(), set()])
    for e in events:
        daily[e.get("date")][0].add(e["visitorId"])
        if e["name"] == "search":
            daily[e.get("date")][1].add(e["visitorId"])
    for visitor in activated:
        first_day = min(visitor_dates[visitor])
        daily[first_day][2].add(visitor)
    for date in sorted(d for d in daily if d):
        v, s, a = daily[date]
        print(f"{date}  {len(v):8} {len(s):9} {len(a):9}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--include-internal", action="store_true")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    report(fetch_events(since), args.include_internal, args.days)


if __name__ == "__main__":
    main()
