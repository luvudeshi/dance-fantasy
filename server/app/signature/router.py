"""GET /api/signature/lookup and GET /api/signature/moves."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.config import Settings, get_settings
from app.moves.library import MoveDefinitionError
from app.signature.lookup import lookup
from app.signature.moves import SignatureLibrary, load_signature_library
from app.signature.pins import PinnedMove

router = APIRouter(prefix="/signature", tags=["signature"])
SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_signature_library() -> SignatureLibrary:
    """The signature move library (a dependency, so tests can override it)."""
    try:
        return load_signature_library()
    except MoveDefinitionError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, f"Signature moves are invalid: {exc}"
        ) from None


SignatureLibraryDep = Annotated[SignatureLibrary, Depends(get_signature_library)]


@router.get("/lookup")
def get_lookup(
    settings: SettingsDep,
    library: SignatureLibraryDep,
    title: Annotated[str, Query(max_length=200)] = "",
    artist: Annotated[str, Query(max_length=200)] = "",
) -> dict[str, Any]:
    """The song's signature dance (table, else SerpApi + Gemini), creator credit, video links, and the signature
    move to pin (moveId) when the library has one."""
    if not title.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title is required")
    return lookup(title.strip(), artist.strip(), library, settings.cache_dir)


@router.get("/moves")
def get_moves(library: SignatureLibraryDep) -> dict[str, Any]:
    """Every signature move, in the GET /api/moves format plus signatureDance, songs and creator."""
    return library.to_json()


def resolve_pins(requested: Sequence[Any], mode: str) -> list[PinnedMove]:
    """ChoreographRequest.pinnedMoves -> PinnedMoves (400 for an unknown id or a standing-only move in seated mode)."""
    if not requested:
        return []
    library = get_signature_library()
    out: list[PinnedMove] = []
    for p in requested:
        sig = library.get(p.moveId)
        if sig is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Unknown signature move {p.moveId!r} (see /api/signature/moves).",
            )
        if mode == "seated" and not sig.move.upperBodyOnly:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Signature move {p.moveId!r} needs standing mode.",
            )
        out.append(
            PinnedMove(
                move=sig.move,
                placement=p.placement,
                tag=sig.tag(),
                version=library.version,
            )
        )
    return out
