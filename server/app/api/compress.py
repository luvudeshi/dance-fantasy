"""gzip for the big JSON responses (the move listing, routines).

Vercel caps a function's response body at 4.5 MB. The move listing is ~2.7 MB and a long real-dancer routine
1-3 MB of keyframe JSON, which gzip shrinks ~5x; browsers always accept it. Only these endpoints compress
(no global middleware: audio files must keep their byte ranges).
"""

from __future__ import annotations

import gzip
from collections.abc import Mapping

from fastapi import Request, Response

GZIP_LEVEL = 6
MIN_GZIP_BYTES = 1024  # smaller bodies go out as they are


def accepts_gzip(header: str | None) -> bool:
    """Whether an Accept-Encoding header allows gzip: ``gzip`` (or else ``*``) with a non-zero q."""
    q_of: dict[str, float] = {}
    for part in (header or "").lower().split(","):
        coding, _, params = part.strip().partition(";")
        q = 1.0
        for param in params.split(";"):
            name, _, value = param.strip().partition("=")
            if name == "q":
                try:
                    q = float(value)
                except ValueError:
                    q = 0.0
        q_of.setdefault(coding.strip(), q)
    q = q_of.get("gzip", q_of.get("*", 0.0))
    return q > 0


def compress(data: bytes) -> bytes:
    """Deterministic gzip (no timestamp)."""
    return gzip.compress(data, compresslevel=GZIP_LEVEL, mtime=0)


def json_response(
    request: Request, data: bytes, headers: Mapping[str, str] | None = None, gzipped: bytes | None = None
) -> Response:
    """``data`` (JSON bytes) as a response, gzip-encoded when the client accepts it; ``gzipped`` is a
    precompressed copy of ``data`` to use instead of compressing it now."""
    out = {**(headers or {}), "Vary": "Accept-Encoding"}
    if len(data) >= MIN_GZIP_BYTES and accepts_gzip(request.headers.get("accept-encoding")):
        body = gzipped if gzipped is not None else compress(data)
        return Response(body, media_type="application/json", headers={**out, "Content-Encoding": "gzip"})
    return Response(data, media_type="application/json", headers=out)
