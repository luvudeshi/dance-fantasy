"""Optional: hand song analysis to an always-warm worker on a Vultr VM (deploy/vultr/).

On Vercel a fresh serverless instance spends 20-30 s compiling librosa's numba code before its first analysis.
A Vultr Cloud Compute instance running this same FastAPI app stays warm, so an uploaded song is analyzed in about
a second. With ANALYSIS_WORKER_URL set (e.g. https://worker.dancefantasy.tech), POST /api/analyze/blob forwards
the request to the worker's identical endpoint: the worker reads the upload from the shared Vercel Blob store,
analyzes it, caches the result in Blob (so every Vercel instance sees it) and deletes the upload.

Off by default: with ANALYSIS_WORKER_URL unset nothing here runs and Vercel analyzes as before. The worker must not
set ANALYSIS_WORKER_URL itself (it would forward to itself).
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any

WORKER_TIMEOUT_SEC = 120.0  # a 10-minute song analyzes in well under this on a warm 2-vCPU instance


def worker_url() -> str | None:
    """The worker's base URL, or None when the Vultr worker is not configured (the default)."""
    url = os.environ.get("ANALYSIS_WORKER_URL", "").strip().rstrip("/")
    return url or None


def forward_analysis(base: str, body: dict[str, Any], refresh: bool, timeout: float = WORKER_TIMEOUT_SEC) -> Any:
    """POST the upload to the worker's /api/analyze/blob and return its analysis JSON.

    Raises urllib.error.HTTPError with the worker's status (400 bad audio, 413 too large...) or OSError when the
    worker is unreachable.
    """
    url = f"{base}/api/analyze/blob" + ("?refresh=true" if refresh else "")
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())
