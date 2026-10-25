"""GET /api/signature/lookup and GET /api/signature/moves.

The lookup is public but the paid part (SerpApi + Gemini) only runs for a song this server knows (a library
file or an analysis id; the title and artist come from it, never from the caller), at most MAX_CONCURRENT at
once per instance, PER_CLIENT_PER_HOUR fresh lookups per client and DAILY_CAP a day (both counted in the
database, so shared by every instance). A caller-typed title or artist only reaches the bundled table and the
signature move library (free).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from app.accounts.store import spend
from app.analysis_store import ID_RE, AnalysisStore, sha256_file
from app.config import Settings, get_settings
from app.library import song_artist, song_title
from app.moves.library import MoveDefinitionError
from app.signature.lookup import lookup
from app.signature.table import normalize
from app.signature.moves import SignatureLibrary, load_signature_library
from app.signature.pins import PinnedMove

log = logging.getLogger(__name__)
router = APIRouter(prefix="/signature", tags=["signature"])
SettingsDep = Annotated[Settings, Depends(get_settings)]

MAX_CONCURRENT = 2  # paid lookups in flight, per instance
DAILY_CAP = 150  # paid lookups per rolling 24 h, all instances
PER_CLIENT_PER_HOUR = 10  # fresh (uncached) paid lookups per client IP, all instances
HOUR_MS, DAY_MS = 3_600_000, 86_400_000
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


def spend_quotas(ip: str) -> None:
    """Count one paid lookup: 429 once ``ip`` spent PER_CLIENT_PER_HOUR this hour, 503 once DAILY_CAP is used."""
    now = int(time.time() * 1000)
    if not spend(f"signature-ip:{ip}", (PER_CLIENT_PER_HOUR, HOUR_MS), now):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many new songs looked up this hour; try again later.")
    if not spend("signature-day", (DAILY_CAP, DAY_MS), now):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Signature lookups are resting until tomorrow.")


def known_song(settings: Settings, analysis_id: str | None, file: str | None) -> tuple[str, str, str]:
    """(analysis id, title, artist) of a library file or an analyzed song; 404 for anything else."""
    from app.api.deps import song_path  # lazy: app.api imports this module (choreograph, the router list)

    fallback: tuple[str, str] | None = None
    if file is not None:
        path = song_path(settings.songs_dir, file)
        analysis_id = sha256_file(path)  # the id its analysis has (or will have)
        fallback = (song_title(path), song_artist(path) or "")
    assert analysis_id is not None
    doc = AnalysisStore(settings.cache_dir).load(analysis_id)
    if doc is not None and isinstance(doc.get("title"), str):
        artist = doc.get("artist")
        return analysis_id, doc["title"].strip(), artist.strip() if isinstance(artist, str) else ""
    if fallback is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No analysis with that id.")
    return analysis_id, fallback[0].strip(), fallback[1].strip()


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
    request: Request,
    settings: SettingsDep,
    library: SignatureLibraryDep,
    title: Annotated[str, Query(max_length=200)] = "",
    artist: Annotated[str, Query(max_length=200)] = "",
    analysis_id: Annotated[str | None, Query(alias="analysisId", pattern=ID_RE.pattern)] = None,
    file: Annotated[str | None, Query(max_length=200)] = None,
) -> dict[str, Any]:
    """The song's signature dance (table, else SerpApi + Gemini for a known song), creator credit, video links,
    and the signature move to pin (moveId) when the library has one."""
    online_key: str | None = None
    if analysis_id is not None or file is not None:
        key, song, song_by = known_song(settings, analysis_id, file)
        typed = title.strip()
        if not typed or normalize(typed) == normalize(song):  # the song's own title: online search allowed
            # The song's own artist, never the typed one: the result is cached for everyone by analysis id.
            online_key, title, artist = key, song, song_by
    if not title.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title is required")
    from app.api.limits import client_ip  # lazy, see known_song

    ip = client_ip(request)

    @contextmanager
    def paid() -> Iterator[None]:
        if not _slots.acquire(blocking=False):
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Lookups are busy; try again in a moment.", {"Retry-After": "5"})
        try:
            spend_quotas(ip)
            yield
        finally:
            _slots.release()

    return lookup(title.strip(), artist.strip(), library, settings.cache_dir, online_key=online_key, guard=paid)


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
