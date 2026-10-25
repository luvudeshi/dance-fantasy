"""Move library: GET /api/moves (shared/moves.ts MoveLibraryResponse)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.moves.library import MoveDefinitionError, library_to_json, load_library

router = APIRouter(tags=["moves"])
SettingsDep = Annotated[Settings, Depends(get_settings)]
_payloads: dict[str, dict[str, Any]] = {}  # library version -> serialized response


@router.get("/moves")
def get_moves(settings: SettingsDep) -> JSONResponse:
    """Every compiled move (mirrored variants included), with the library version."""
    try:
        lib = load_library(settings.assets_dir / "moves")
    except MoveDefinitionError as exc:
        raise HTTPException(status_code=500, detail=f"Move library is invalid: {exc}") from None
    payload = _payloads.get(lib.version)
    if payload is None:
        _payloads.clear()
        payload = _payloads[lib.version] = library_to_json(lib)
    return JSONResponse(payload)
