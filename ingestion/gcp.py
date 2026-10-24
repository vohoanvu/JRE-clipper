"""Thin GCP helpers that rely on the gcloud CLI login only.

Application Default Credentials are not configured on this machine, so instead
of the Google client libraries we shell out to `gcloud` for Storage and use
REST with `gcloud auth print-access-token` for Firestore / Discovery Engine.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import shutil
import subprocess
import time

import requests

from . import config

log = logging.getLogger(__name__)
_token: tuple[str, float] | None = None


def gcloud_cmd(*args: str) -> list[str]:
    exe = shutil.which("gcloud") or shutil.which("gcloud.cmd")
    if not exe:
        raise RuntimeError("gcloud CLI not found on PATH")
    return [exe, *args]


def gcloud(*args: str, check: bool = True, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    env = None
    if env_extra:
        env = {**os.environ, **env_extra}
    return subprocess.run(gcloud_cmd(*args), capture_output=True, text=True, check=check, env=env)


def access_token() -> str:
    global _token
    if _token and time.time() - _token[1] < 45 * 60:
        return _token[0]
    tok = gcloud("auth", "print-access-token").stdout.strip()
    _token = (tok, time.time())
    return tok


def headers() -> dict:
    return {
        "Authorization": f"Bearer {access_token()}",
        "x-goog-user-project": config.PROJECT_ID,
        "Content-Type": "application/json",
    }


def request(method: str, url: str, retries: int = 6, **kw) -> requests.Response:
    """REST call with backoff on 429/5xx."""
    for attempt in range(retries):
        r = requests.request(method, url, headers=headers(), timeout=60, **kw)
        if r.status_code in (429, 500, 502, 503, 504):
            wait = min(60, 5 * 2 ** attempt)
            log.warning("%s %s -> %d, retrying in %ds", method, url.split("?")[0][-80:], r.status_code, wait)
            time.sleep(wait)
            continue
        return r
    return r


# ------------------------------------------------------------ Cloud Storage
def gcs_exists(uri: str) -> bool:
    r = gcloud("storage", "ls", uri, check=False)
    return r.returncode == 0 and uri in r.stdout


def gcs_describe(uri: str) -> dict | None:
    r = gcloud("storage", "objects", "describe", uri, "--format=json", check=False)
    if r.returncode != 0:
        return None
    return json.loads(r.stdout)


def md5_b64(path) -> str:
    """MD5 in the base64 form GCS reports as md5_hash."""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return base64.b64encode(h.digest()).decode()


def gcs_upload(local: str, uri: str) -> None:
    # Owner's upload_to_gcs.sh disabled parallel composite uploads (composite
    # objects have no MD5); do the same for this process only.
    gcloud("storage", "cp", local, uri, env_extra={"CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED": "False"})


def gcs_list(prefix: str) -> list[str]:
    r = gcloud("storage", "ls", prefix, check=False)
    return [l.strip() for l in r.stdout.splitlines() if l.strip()]


# ------------------------------------------------------------ Firestore
def _fs_value(v):
    t, val = next(iter(v.items()))
    if t == "booleanValue":
        return bool(val)
    if t == "integerValue":
        return int(val)
    if t == "nullValue":
        return None
    return val


def firestore_list_tracker() -> dict[str, dict]:
    """All jre-episodes docs as {videoId: {field: value}}."""
    out: dict[str, dict] = {}
    token = None
    while True:
        params = {"pageSize": 1000}
        if token:
            params["pageToken"] = token
        r = request("GET", config.FIRESTORE_BASE, params=params)
        r.raise_for_status()
        data = r.json()
        for d in data.get("documents", []):
            vid = d["name"].rsplit("/", 1)[-1]
            out[vid] = {k: _fs_value(v) for k, v in d.get("fields", {}).items()}
        token = data.get("nextPageToken")
        if not token:
            return out


def firestore_value(v):
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if v is None:
        return {"nullValue": None}
    return {"stringValue": str(v)}


def firestore_patch(video_id: str, fields: dict) -> dict:
    params = [("updateMask.fieldPaths", k) for k in fields]
    body = {"fields": {k: firestore_value(v) for k, v in fields.items()}}
    r = request("PATCH", f"{config.FIRESTORE_BASE}/{video_id}", params=params, data=json.dumps(body))
    r.raise_for_status()
    return r.json()


# ------------------------------------------------------------ Discovery Engine
def de_url(path: str) -> str:
    return f"{config.DISCOVERY_HOST}/v1/{path}"


def de_get_document(doc_id: str) -> requests.Response:
    return request("GET", de_url(f"{config.BRANCH}/documents/{doc_id}"))


def de_import(body: dict) -> dict:
    r = request("POST", de_url(f"{config.BRANCH}/documents:import"), data=json.dumps(body))
    r.raise_for_status()
    return r.json()


def de_operation(name: str) -> dict:
    r = request("GET", de_url(name))
    r.raise_for_status()
    return r.json()


def de_delete_document(doc_id: str) -> int:
    return request("DELETE", de_url(f"{config.BRANCH}/documents/{doc_id}")).status_code
