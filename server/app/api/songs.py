"""Song library: list songs and serve audio files for playback."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.deps import song_path
from app.config import Settings, get_settings
from app.library import MEDIA_TYPES, list_songs

router = APIRouter(prefix="/songs", tags=["songs"])
SettingsDep = Annotated[Settings, Depends(get_settings)]


class SongInfo(BaseModel):
    file: str
    title: str
    sizeBytes: int


# Plain `def` endpoints: FastAPI runs them in the threadpool, so disk access never blocks the loop.
@router.get("")
def get_songs(settings: SettingsDep) -> list[SongInfo]:
    """Audio files in assets/songs/, sorted by file name."""
    return [SongInfo(file=e.file, title=e.title, sizeBytes=e.size_bytes) for e in list_songs(settings.songs_dir)]


@router.get("/{file}", response_class=FileResponse)
def get_song_file(file: str, settings: SettingsDep) -> FileResponse:
    """The audio file itself (supports Range requests, for seeking)."""
    path = song_path(settings.songs_dir, file)
    return FileResponse(path, media_type=MEDIA_TYPES[Path(file).suffix.lower()])
