"""Hall of Fame (shared/README.md, "Leaderboard endpoints"): per-song boards, top dancers, the song picker.

Public GETs; the ``df_session`` cookie, when present, marks your own row (and is required for scope=friends).
Each client IP gets LIMIT reads a minute (counted in the database, so shared by every instance).
Song titles come from the library or the server's own cached analysis, never from a posted round.
"""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status

from app.accounts.store import MIN, spend
from app.analysis_store import ID_RE, AnalysisStore, sha256_file
from app.api.limits import client_ip
from app.config import get_settings
from app.leaderboard import store
from app.leaderboard.store import BoardSong, SongBoard, SongScope, TopBoard, TopScope
from app.library import list_songs

LIMIT = (240, MIN)  # reads per client IP a minute; a venue shares one NAT address
UNKNOWN_SONG = "Unknown song"


def _now() -> int:
    return time.time_ns() // 1_000_000


def library_titles() -> dict[str, str]:
    """analysisId (sha256 of the file) -> title, for every library song, in library order."""
    return {sha256_file(e.path): e.title for e in list_songs(get_settings().songs_dir)}


def song_facts(analysis_id: str, library: dict[str, str]) -> tuple[str | None, int | None]:
    """(public title, beat count) from trusted sources only: the library's title, else the title the server cached
    when it analyzed the song; the beat count from that cached analysis. None for what the server doesn't know."""
    doc = AnalysisStore(get_settings().cache_dir).load(analysis_id) or {}
    title, beats = doc.get("title"), doc.get("beats")
    cached = title.strip() if isinstance(title, str) and title.strip() else None
    return library.get(analysis_id) or cached, len(beats) if isinstance(beats, list) else None


def rate_limit(request: Request) -> None:
    if not spend(f"leaderboard:{client_ip(request)}", LIMIT, _now()):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many leaderboard reads. Wait a moment.")


router = APIRouter(prefix="/leaderboard", tags=["leaderboard"], dependencies=[Depends(rate_limit)])
Limit = Annotated[int, Query(ge=1, le=50)]


@router.get("/song/{analysis_id}")
def song_board(
    analysis_id: Annotated[str, Path(pattern=ID_RE.pattern)], request: Request, scope: SongScope = "all", limit: Limit = 10
) -> SongBoard:
    title, _ = song_facts(analysis_id, library_titles())
    return store.song_board(request.cookies.get("df_session"), analysis_id, title, scope, limit, _now())


@router.get("/top")
def top(request: Request, scope: TopScope = "week", limit: Limit = 10) -> TopBoard:
    return store.top_board(request.cookies.get("df_session"), scope, limit, _now())


@router.get("/songs")
def songs(request: Request) -> list[BoardSong]:
    """Library songs first (dancers counted when they have rounds), then songs you have danced yourself (most
    dancers first). Other players' uploads are never listed."""
    library = library_titles()
    dancers = store.song_dancers(request.cookies.get("df_session"), list(library), _now())
    return [BoardSong(analysisId=aid, title=title, dancers=dancers.get(aid, 0)) for aid, title in library.items()] + [
        BoardSong(analysisId=aid, title=song_facts(aid, library)[0] or UNKNOWN_SONG, dancers=n)
        for aid, n in dancers.items()
        if aid not in library
    ]
