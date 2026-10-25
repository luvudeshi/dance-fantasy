"""Vercel Blob: shared storage for deployments, where the local disk is per-instance and temporary.

On only when ``BLOB_READ_WRITE_TOKEN`` is set (Vercel injects it once a Blob store is connected to
the project). Locally and in tests it is unset: every function here is then a no-op and the caches
stay on disk.

Two jobs:
- mirror the on-disk cache (analysis/, audio/, routines/) so every instance sees every entry;
- let the browser upload songs straight to Blob, since Vercel caps request bodies at 4.5 MB.
  ``client_token`` signs a short-lived upload token exactly like ``@vercel/blob``'s
  ``generateClientTokenFromReadWriteToken`` (the Python SDK has no equivalent).

Blobs are public (the browser plays uploaded audio straight from its Blob URL). Blocking I/O: call
from a worker thread.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from urllib.parse import urlsplit

from vercel.blob import BlobNotFoundError
from vercel.blob.sync import delete_blob, get_blob, head_blob, put_blob, query_blobs

from app.library import MEDIA_TYPES

UPLOAD_PREFIX = "uploads/"
MAX_UPLOAD_PATHNAME = 300
CLIENT_TOKEN_TTL_SEC = 10 * 60
# One plain file name under uploads/: no further "/", no "%" escapes, must start alphanumeric (so no "..").
UPLOAD_PATHNAME_RE = re.compile(r"^uploads/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")


class NotOurUpload(ValueError):
    """The URL is not a browser upload in this app's Blob store."""


def read_write_token() -> str | None:
    return os.environ.get("BLOB_READ_WRITE_TOKEN") or None


def enabled() -> bool:
    return read_write_token() is not None


def _require_token() -> str:
    token = read_write_token()
    if token is None:
        raise RuntimeError("BLOB_READ_WRITE_TOKEN is not set")
    return token


def store_id(token: str) -> str:
    """``vercel_blob_rw_<storeId>_<secret>`` -> ``<storeId>`` (same split as @vercel/blob)."""
    parts = token.split("_")
    if len(parts) < 5 or not token.startswith("vercel_blob_rw_") or not parts[3]:
        raise ValueError("BLOB_READ_WRITE_TOKEN has an unexpected format")
    return parts[3]


def public_host(token: str) -> str:
    return f"{store_id(token).lower()}.public.blob.vercel-storage.com"


# --- cache mirror -------------------------------------------------------------------------


def pull(key: str) -> bytes | None:
    """The blob at ``key`` (e.g. ``analysis/<id>.v2.json``), or None if Blob is off or it doesn't exist."""
    if not enabled():
        return None
    try:
        return get_blob(key, access="public").body
    except BlobNotFoundError:
        return None


def push(key: str, data: bytes) -> None:
    """Store ``data`` at ``key`` (overwriting). No-op when Blob is off."""
    if not enabled():
        return
    ext = os.path.splitext(key)[1].lower()
    content_type = "application/json" if ext == ".json" else MEDIA_TYPES.get(ext, "application/octet-stream")
    put_blob(key, data, access="public", content_type=content_type, allow_overwrite=True)


def find_url(prefix: str) -> str | None:
    """Public URL of the first blob whose pathname starts with ``prefix``, or None (also when Blob is off)."""
    if not enabled():
        return None
    for blob in query_blobs(prefix=prefix, page_size=1):
        return blob.url
    return None


# --- browser uploads ----------------------------------------------------------------------


def client_token(pathname: str, max_bytes: int) -> str:
    """A token that lets the browser PUT one audio file of at most ``max_bytes`` under uploads/."""
    if not UPLOAD_PATHNAME_RE.match(pathname):
        raise NotOurUpload(f"Upload pathname must be '{UPLOAD_PREFIX}' plus a plain file name.")
    token = _require_token()
    payload = base64.b64encode(
        json.dumps(
            {
                "pathname": pathname,
                "allowedContentTypes": ["audio/*"],
                "maximumSizeInBytes": max_bytes,
                "addRandomSuffix": True,
                "validUntil": int((time.time() + CLIENT_TOKEN_TTL_SEC) * 1000),
            },
            separators=(",", ":"),
        ).encode()
    ).decode()
    signature = hmac.new(token.encode(), payload.encode(), hashlib.sha256).hexdigest()
    signed = base64.b64encode(f"{signature}.{payload}".encode()).decode()
    return f"vercel_blob_client_{store_id(token)}_{signed}"


def upload_url(url: str) -> str:
    """The canonical URL of an uploads/ blob in this app's store, rebuilt from checked parts.

    Raises NotOurUpload for anything else: other hosts (no SSRF), and paths that could resolve outside
    uploads/ ("..", "%2e%2e", extra "/"), since callers read and then delete what this returns.
    """
    parts = urlsplit(url)
    host = public_host(_require_token())
    if (
        parts.scheme != "https"
        or parts.netloc != host
        or parts.query
        or parts.fragment
        or not UPLOAD_PATHNAME_RE.match(parts.path.removeprefix("/"))
    ):
        raise NotOurUpload("Not an upload in this app's Blob store.")
    return f"https://{host}{parts.path}"


def upload_size(url: str) -> int:
    """Size in bytes of an upload blob (checked before downloading it)."""
    return head_blob(upload_url(url)).size


def read_upload(url: str) -> bytes:
    return get_blob(upload_url(url), access="public").body


def delete_upload(url: str) -> None:
    delete_blob(upload_url(url))
