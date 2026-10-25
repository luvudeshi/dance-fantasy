"""Move library: GET /api/moves (shared/moves.ts MoveLibraryResponse) and GET /api/moves/sources.

The listing is megabytes of keyframe JSON and Vercel caps a function's response at 4.5 MB: by default the
mirrored twins of the real-dancer clips are left out (their base clips say ``hasMirror``), coordinates are
rounded to 3 decimals, and the body goes out gzip-compressed to clients that accept it (app.api.compress).
Each (library version, query) is serialized and compressed once.
"""

from __future__ import annotations

import json
import threading
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

from app.api.compress import compress, json_response
from app.config import Settings, get_settings
from app.moves.library import MoveDefinitionError, library_to_json, load_library, source_counts
from app.moves.types import MoveLibrary

router = APIRouter(tags=["moves"])
SettingsDep = Annotated[Settings, Depends(get_settings)]
# (library version, source, mirrors) -> (JSON bytes, gzip bytes); entries of older versions are dropped
_payloads: dict[tuple[str, str | None, bool], tuple[bytes, bytes]] = {}
_payloads_lock = threading.Lock()


def _library(settings: Settings) -> MoveLibrary:
    try:
        return load_library(settings.assets_dir / "moves")
    except MoveDefinitionError as exc:
        raise HTTPException(status_code=500, detail=f"Move library is invalid: {exc}") from None


def _payload(lib: MoveLibrary, source: str | None, mirrors: bool) -> tuple[bytes, bytes]:
    key = (lib.version, source, mirrors)
    with _payloads_lock:
        hit = _payloads.get(key)
    if hit is not None:
        return hit
    raw = json.dumps(library_to_json(lib, source, mirrors), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    entry = (raw, compress(raw))
    with _payloads_lock:
        for k in [k for k in _payloads if k[0] != lib.version]:
            del _payloads[k]
        _payloads[key] = entry
    return entry


@router.get("/moves")
def get_moves(
    request: Request,
    settings: SettingsDep,
    source: Annotated[
        Literal["classic", "library", "aist"] | None,
        Query(description="Only the classic library moves (classic = library) or only the real-dancer clips."),
    ] = None,
    mirrors: Annotated[
        bool, Query(description="Also list the mirrored twins <id>_m of the real-dancer clips (left out by default).")
    ] = False,
) -> Response:
    """The compiled move library with its version: the classic moves (with their L/R variants) and the
    real-dancer clips; the clips' mirrored twins only with ``?mirrors=1`` (their base clips say ``hasMirror``)."""
    raw, gzipped = _payload(_library(settings), "classic" if source == "library" else source, mirrors)
    return json_response(request, raw, gzipped=gzipped)


@router.get("/moves/sources")
def get_move_sources(settings: SettingsDep) -> JSONResponse:
    """Move counts per source (classic library / real-dancer clips): small, for the lobby's "Moves from"."""
    return JSONResponse(source_counts(_library(settings)))
