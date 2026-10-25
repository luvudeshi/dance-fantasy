"""GET /api/signature/lookup and GET /api/signature/moves.

The lookup is public but the paid part (SerpApi + Gemini) only runs for a song this server knows (a library
file or an analysis id; the title and artist come from it, never from the caller), at most MAX_CONCURRENT at
once, PER_CLIENT_PER_HOUR fresh lookups per client and DAILY_CAP a day. A caller-typed title only reaches the
bundled table and the signature move library (free).
"""

from __future__ import annotations

import datetime
import json
import logging
import threading
import time
from collections import defaultdict, deque
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from app.analysis_store import ID_RE, AnalysisStore, _atomic_write, read_cached, sha256_file
from app.api.deps import song_path
from app.api.limits import client_ip
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
DAILY_CAP = 150  # paid lookups a day (UTC), counted in the shared cache
PER_CLIENT_PER_HOUR = 10  # fresh (uncached) paid lookups per client IP
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
# ponytail: per instance, in memory; a Vercel Firewall rate limit or a shared counter if it is abused anyway.
_per_client: defaultdict[str, deque[float]] = defaultdict(deque)
_per_client_lock = threading.Lock()


def spend_client_quota(ip: str, now: float | None = None) -> None:
    """Counts one fresh lookup for ``ip``; 429 once it spent PER_CLIENT_PER_HOUR in the last hour."""
    t = time.monotonic() if now is None else now
    with _per_client_lock:
        if len(_per_client) > 10_000:  # bound the memory a spray of addresses can take
            _per_client.clear()
        q = _per_client[ip]
        while q and t - q[0] >= 3600:
            q.popleft()
        if len(q) >= PER_CLIENT_PER_HOUR:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many new songs looked up this hour; try again later.")
        q.append(t)


def spend_daily_budget(cache_dir: Path) -> None:
    """Count one paid lookup against today's cap; 503 once it is used up.

    ponytail: read-modify-write of a cache file, so parallel instances can overshoot by a few; a DB
    counter if the cap has to be exact.
    """
    path = cache_dir / "signature" / f"budget-{datetime.datetime.now(datetime.UTC).date().isoformat()}.json"
    try:
        used = int(json.loads(read_cached(path)).get("n", 0))
    except FileNotFoundError:
        used = 0
    except (OSError, ValueError, AttributeError) as exc:
        log.warning("signature.budget unreadable error=%s", type(exc).__name__)
        used = 0
    if used >= DAILY_CAP:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Signature lookups are resting until tomorrow.")
    _atomic_write(path, json.dumps({"n": used + 1}).encode("utf-8"))


def known_song(settings: Settings, analysis_id: str | None, file: str | None) -> tuple[str, str, str]:
    """(analysis id, title, artist) of a library file or an analyzed song; 404 for anything else."""
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
            online_key, title, artist = key, song, artist.strip() or song_by
    if not title.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title is required")
    ip = client_ip(request)

    @contextmanager
    def paid() -> Iterator[None]:
        if not _slots.acquire(blocking=False):
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Lookups are busy; try again in a moment.", {"Retry-After": "5"})
        try:
            spend_client_quota(ip)
            spend_daily_budget(settings.cache_dir)
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
