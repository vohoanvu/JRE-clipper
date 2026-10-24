"""import step: chunked episodes -> Discovery Engine data store (dry-run unless --apply).

How the June 2025 import was configured (determined from the live data store):
  * documents:import from GCS, dataSchema "custom", autoGenerateIds=true.
    Each NDJSON line becomes Document.structData verbatim, so a stored document
    is {"id": <hash>, "schemaId": "default_schema",
        "structData": {"id": "<videoId>_<start>_<end>", "content": ..., "structData": {...}}}
  * The generated document id is sha256(<exact line bytes>)[:32] (verified on
    sampled live documents), so the ids are deterministic: importing an
    identical line again with INCREMENTAL reconciliation is an upsert, not a
    duplicate.
This step reproduces that exactly. --explicit-ids is an equivalent alternative
(dataSchema "document" with the same ids precomputed), useful if Google ever
changes the auto-id hashing.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from . import chunking, config, gcp
from .chunk_step import chunk_file
from .state import State, now_iso

log = logging.getLogger(__name__)


def import_body(gcs_uri: str, explicit_ids: bool) -> dict:
    body = {
        "gcsSource": {"inputUris": [gcs_uri], "dataSchema": "document" if explicit_ids else "custom"},
        "reconciliationMode": "INCREMENTAL",
        "errorConfig": {"gcsPrefix": f"{config.INCREMENTAL_GCS_PREFIX}/errors/"},
    }
    if not explicit_ids:
        body["autoGenerateIds"] = True
    return body


def _check_existing(doc_ids: list[str], n: int = 10) -> dict:
    """Read-only: how many of a sample of the expected ids already exist in the data store."""
    sample = doc_ids[:: max(1, len(doc_ids) // n)][:n]
    found = 0
    for d in sample:
        if gcp.de_get_document(d).status_code == 200:
            found += 1
    return {"sampled": len(sample), "alreadyPresent": found}


def _verify(expected: list[tuple[str, dict]], n: int = 20) -> dict:
    sample = expected[:: max(1, len(expected) // n)][:n]
    ok = bad = missing = 0
    for doc_id, rec in sample:
        r = gcp.de_get_document(doc_id)
        if r.status_code == 404:
            missing += 1
            continue
        sd = r.json().get("structData", {})
        if sd.get("id") == rec["id"] and sd.get("content") == rec["content"] and sd.get("structData", {}).get("videoId") == rec["structData"]["videoId"]:
            ok += 1
        else:
            bad += 1
    return {"sampled": len(sample), "ok": ok, "mismatch": bad, "missing": missing}


def wait_for(op: dict) -> dict:
    deadline = time.time() + 3 * 3600
    while not op.get("done") and time.time() < deadline:
        time.sleep(30)
        op = gcp.de_operation(op["name"])
        log.info("import progress: %s", op.get("metadata"))
    if not op.get("done"):
        raise SystemExit(f"import still running after 3 h: {op.get('name')}")
    if op.get("error"):
        raise SystemExit(f"import failed: {op['error']}")
    log.info("import finished: metadata=%s errorSamples=%s", op.get("metadata"), op.get("response", {}).get("errorSamples"))
    return op


def backfill(args) -> dict:
    """Re-import an existing custom-format NDJSON already in GCS (e.g. the original
    jre-segments-all.ndjson, ~17% of whose lines never made it into the data store).
    Same config as the original import, so present documents get the same ids
    (upsert, no duplicates) and missing ones are added."""
    body = import_body(args.source_uri, explicit_ids=False)
    api = gcp.de_url(f"{config.BRANCH}/documents:import")
    if not args.apply:
        log.info("import DRY-RUN backfill: POST %s\n%s", api, json.dumps(body, indent=1))
        return {"dryRun": True, "source": args.source_uri}
    op = wait_for(gcp.de_import(body)) if not args.no_wait else gcp.de_import(body)
    return {"operation": op.get("name"), "metadata": op.get("metadata")}


def run(args, state: State) -> dict:
    if args.source_uri:
        return backfill(args)

    def pending(v):
        if (v.get("chunk") or {}).get("status") != "done":
            return False
        return args.reimport or (v.get("import") or {}).get("status") != "done"

    todo = state.select(args.ids, args.limit, pending)
    if not todo:
        log.info("import: nothing to do")
        return {"episodes": 0}

    lines: list[str] = []
    per_video: dict[str, list[str]] = {}
    expected: list[tuple[str, dict]] = []
    for v in todo:
        vid = v["videoId"]
        ls = [l for l in chunk_file(vid).read_text(encoding="utf-8").split("\n") if l.strip()]
        per_video[vid] = [chunking.discovery_doc_id(l) for l in ls]
        expected += [(chunking.discovery_doc_id(l), json.loads(l)) for l in ls]
        lines += ls
    seg_ids = [rec["id"] for _, rec in expected]
    if len(set(seg_ids)) != len(seg_ids):
        log.warning("batch contains %d duplicate segment ids", len(seg_ids) - len(set(seg_ids)))

    staging = config.NDJSON_DIR / "_staging.ndjson"
    with open(staging, "w", encoding="utf-8", newline="\n") as f:
        if args.explicit_ids:
            for doc_id, rec in expected:
                f.write(json.dumps({"id": doc_id, "structData": rec}, ensure_ascii=False, separators=(",", ":")) + "\n")
        else:
            f.write("\n".join(lines) + "\n")
    md5 = gcp.md5_b64(staging)
    # <UTC date>.ndjson, or <date>-2.ndjson ... if that name already holds a different
    # batch (never overwrite a batch that may already have been imported)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    names = [args.batch_name] if args.batch_name else [f"{stamp}.ndjson"] + [f"{stamp}-{n}.ndjson" for n in range(2, 100)]
    remote = None
    for batch_name in names:
        remote = gcp.gcs_describe(f"{config.INCREMENTAL_GCS_PREFIX}/{batch_name}")
        if remote is None or remote.get("md5_hash") == md5:
            break
    else:
        raise SystemExit(f"{config.INCREMENTAL_GCS_PREFIX}/{names[-1]} already exists with different content")
    local = config.NDJSON_DIR / batch_name
    staging.replace(local)
    gcs_uri = f"{config.INCREMENTAL_GCS_PREFIX}/{batch_name}"
    body = import_body(gcs_uri, args.explicit_ids)
    api = gcp.de_url(f"{config.BRANCH}/documents:import")

    stale: dict[str, list[str]] = {}
    prev_ids: dict[str, list[str]] = {}
    for vid, new_ids in per_video.items():
        imp = state.videos[vid].get("import") or {}
        prev = set(imp.get("docIds") or []) | set(imp.get("previousDocIds") or [])
        gone = sorted(prev - set(new_ids))
        prev_ids[vid] = sorted(prev)
        if gone:
            stale[vid] = gone

    plan = {
        "dryRun": not args.apply,
        "episodes": [{"videoId": v["videoId"], "episode": v.get("episode"), "segments": len(per_video[v["videoId"]])} for v in todo],
        "documents": len(lines),
        "localBatch": str(local),
        "localBatchMd5": md5,
        "alreadyUploaded": remote is not None,
        "uploadTo": gcs_uri,
        "importApi": f"POST {api}",
        "importBody": body,
        "expectedDocIdsSample": [d for d, _ in expected[:3]],
        "staleDocIdsToDelete": {k: len(v) for k, v in stale.items()},
        "preflight": _check_existing([d for d, _ in expected]),
    }
    (config.NDJSON_DIR / f"{batch_name}.plan.json").write_text(json.dumps(plan, indent=1), encoding="utf-8")
    if not args.apply:
        log.info("import DRY-RUN (nothing uploaded or imported). Plan:\n%s", json.dumps(plan, indent=1))
        return {"dryRun": True, "documents": len(lines), "episodes": len(todo), "batch": str(local)}

    # ------------------------------------------------------------- apply
    if remote is not None:
        log.info("%s already uploaded (same content)", gcs_uri)
    else:
        log.info("uploading %s -> %s", local, gcs_uri)
        gcp.gcs_upload(str(local), gcs_uri)
    op = gcp.de_import(body)
    log.info("import operation started: %s", op.get("name"))
    for v in todo:
        state.set_step(v["videoId"], "import", status="submitted", operation=op.get("name"), batch=gcs_uri,
                       docIds=per_video[v["videoId"]], previousDocIds=prev_ids.get(v["videoId"]) or None)
    if args.no_wait:
        return {"submitted": op.get("name"), "documents": len(lines)}

    op = wait_for(op)
    meta = op.get("metadata", {})

    verify = _verify(expected)
    log.info("verification of sampled ids: %s", verify)
    deleted = 0
    if verify["missing"] == 0 and verify["mismatch"] == 0:
        for vid, gone in stale.items():
            for d in gone:
                if gcp.de_delete_document(d) in (200, 404):
                    deleted += 1
    elif stale:
        log.warning("not deleting %d stale ids because verification failed", sum(map(len, stale.values())))
    status = "done" if verify["missing"] == 0 and verify["mismatch"] == 0 else "verify_failed"
    for v in todo:
        state.set_step(v["videoId"], "import", status=status, operation=op.get("name"), batch=gcs_uri,
                       docIds=per_video[v["videoId"]], successCount=meta.get("successCount"),
                       failureCount=meta.get("failureCount"), verify=verify, importedAt=now_iso())
    return {"status": status, "documents": len(lines), "metadata": meta, "verify": verify, "staleDeleted": deleted}
