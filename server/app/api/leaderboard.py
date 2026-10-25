"""Hall of Fame (shared/README.md, "Leaderboard endpoints"): per-song boards, top dancers, the song picker.

Public GETs; the ``df_session`` cookie, when present, marks your own row (and is required for scope=friends).
Each client IP gets LIMIT reads a minute (counted in the database, so shared by every instance).
"""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status

from app.accounts.store import MIN, spend
from app.analysis_store import ID_RE, sha256_file
from app.api.limits import client_ip
from app.config import get_settings
from app.leaderboard import store
from app.leaderboard.store import BoardSong, SongBoard, SongScope, TopBoard, TopScope
from app.library import list_songs

LIMIT = (240, MIN)  # reads per client IP a minute; a venue shares one NAT address


def _now() -> int:
    return time.time_ns() // 1_000_000


def rate_limit(request: Request) -> None:
    if not spend(f"leaderboard:{client_ip(request)}", LIMIT, _now()):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many leaderboard reads. Wait a moment.")


router = APIRouter(prefix="/leaderboard", tags=["leaderboard"], dependencies=[Depends(rate_limit)])
Limit = Annotated[int, Query(ge=1, le=50)]


@router.get("/song/{analysis_id}")
def song_board(
    analysis_id: Annotated[str, Path(pattern=ID_RE.pattern)], request: Request, scope: SongScope = "all", limit: Limit = 10
) -> SongBoard:
    return store.song_board(request.cookies.get("df_session"), analysis_id, scope, limit, _now())


@router.get("/top")
def top(request: Request, scope: TopScope = "week", limit: Limit = 10) -> TopBoard:
    return store.top_board(request.cookies.get("df_session"), scope, limit, _now())


@router.get("/songs")
def songs() -> list[BoardSong]:
    """Library songs first (dancers counted when they have rounds), then other songs with the most dancers."""
    played = {s.analysisId: s for s in store.songs_with_rounds()}
    library = [
        BoardSong(analysisId=aid, title=e.title, dancers=played.pop(aid).dancers if aid in played else 0)
        for e in list_songs(get_settings().songs_dir)
        for aid in [sha256_file(e.path)]
    ]
    return library + list(played.values())
