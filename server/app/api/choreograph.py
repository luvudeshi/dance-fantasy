"""Stage 2: POST /api/choreograph (analysis id -> routine.json) and GET /api/routines/{routineId}.

Routines are cached by routineId (hash of analysis id/version, library version, generator,
difficulty, mode, seed, move source), so the same request always returns byte-identical JSON (sent
gzip-compressed to clients that accept it: a long real-dancer routine is a few MB, app.api.compress).
"""

from __future__ import annotations

import json
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi import Path as PathParam
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from app.analysis import ID_PATTERN, Analysis
from app.analysis_store import AnalysisStore
from app.api.compress import json_response
from app.choreo import DEFAULT_MOVE_SOURCE, NoEligibleMoves, generate_routine, routine_id
from app.config import Settings, get_settings
from app.moves.types import MoveLibrary
from app.routine_store import ROUTINE_ID_PATTERN, RoutineStore

router = APIRouter(tags=["choreography"])
SettingsDep = Annotated[Settings, Depends(get_settings)]
MAX_SEED = 2**53 - 1  # JS-safe integers


class ChoreographRequest(BaseModel):
    """Matches shared/moves.ts ChoreographRequest."""

    model_config = ConfigDict(extra="forbid")

    analysisId: str = Field(pattern=ID_PATTERN)
    difficulty: Literal["easy", "normal", "hard"] = "normal"
    mode: Literal["standing", "seated"] = "standing"
    seed: StrictInt = Field(default=0, ge=-MAX_SEED, le=MAX_SEED)
    # classic = library moves, aist = real-dancer clips (AIST++), mix = both. Without clips, aist/mix = classic.
    moveSource: Literal["classic", "aist", "mix"] = DEFAULT_MOVE_SOURCE


def get_move_library() -> MoveLibrary:
    """The compiled move library (a dependency, so tests can override it)."""
    try:
        from app.moves.library import MoveDefinitionError, load_library
    except ImportError as exc:  # pragma: no cover - only while the move library is missing
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The move library is not available.") from exc
    try:
        library = load_library()
    except MoveDefinitionError as exc:  # a broken move file while authoring: say which one (like GET /api/moves)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Move library is invalid: {exc}") from None
    if not library.moves:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The move library is empty (assets/moves).")
    return library


LibraryDep = Annotated[MoveLibrary, Depends(get_move_library)]


def _json_response(request: Request, data: bytes, cache: str) -> Response:
    return json_response(request, data, {"X-Routine-Cache": cache})


# Plain `def` endpoints: FastAPI runs them in the threadpool, so disk I/O and generation never block the loop.
@router.post("/choreograph")
def choreograph(req: ChoreographRequest, request: Request, settings: SettingsDep, library: LibraryDep) -> Response:
    """A routine.json for an analyzed song (404 if the analysis isn't cached yet)."""
    doc = AnalysisStore(settings.cache_dir).load(req.analysisId)
    try:
        analysis = Analysis.model_validate(doc) if doc is not None else None
    except ValueError:  # pydantic.ValidationError: stale cache entry
        analysis = None
    if analysis is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No analysis with this id; analyze the song first.")

    rid = routine_id(
        analysis.id, analysis.analysisVersion, library.version, req.difficulty, req.mode, req.seed, req.moveSource
    )
    store = RoutineStore(settings.cache_dir)
    cached = store.load_bytes(rid)
    if cached is not None:
        return _json_response(request, cached, "hit")
    try:
        routine = generate_routine(analysis, library, req.difficulty, req.mode, req.seed, move_source=req.moveSource)
    except NoEligibleMoves as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    data = json.dumps(routine.to_json_dict(), separators=(",", ":")).encode("utf-8")
    store.save_bytes(rid, data)
    return _json_response(request, data, "miss")


@router.get("/routines/{routineId}")
def get_routine(
    routineId: Annotated[str, PathParam(pattern=ROUTINE_ID_PATTERN, description="meta.routineId of a routine")],
    request: Request,
    settings: SettingsDep,
) -> Response:
    """A previously generated routine (404 if unknown)."""
    data = RoutineStore(settings.cache_dir).load_bytes(routineId)
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No routine with this id.")
    return _json_response(request, data, "hit")
