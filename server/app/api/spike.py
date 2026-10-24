"""Stage 0 spike: beat tracking for a library song or an uploaded file."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Annotated

import anyio
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from librosa.util.exceptions import ParameterError
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.api.deps import read_upload, song_path, upload_display_name
from app.audio import AudioDecodeError, load_audio, track_beats
from app.config import Settings, get_settings

router = APIRouter(prefix="/spike", tags=["spike"])
SettingsDep = Annotated[Settings, Depends(get_settings)]

MAX_CONCURRENT_ANALYSES = 2
# Requests wait for a slot on the event loop, not inside a worker thread: the threadpool also
# serves audio downloads and every sync endpoint/dependency, so queued analyses must not hold it.
ANALYSIS_SLOTS = anyio.CapacityLimiter(MAX_CONCURRENT_ANALYSES)


class BeatResult(BaseModel):
    song: str
    durationSec: float
    sampleRate: int
    tempo: float  # librosa's global tempo estimate (BPM)
    bpmFromBeats: float  # 60 / median inter-beat interval
    beats: list[float]  # seconds
    elapsedMs: float  # server-side decode + analysis time


@router.get("/beats")
async def beats_for_song(
    settings: SettingsDep, song: Annotated[str, Query(description="File name in assets/songs/")]
) -> BeatResult:
    path = song_path(settings.songs_dir, song)
    async with ANALYSIS_SLOTS:
        return await run_in_threadpool(_analyze, path, song, song, settings.max_duration_sec)


@router.post("/beats")
async def beats_for_upload(settings: SettingsDep, file: Annotated[UploadFile, File()]) -> BeatResult:
    async with ANALYSIS_SLOTS:  # read inside the slot: queued uploads stay spooled on disk, not in RAM
        data = await read_upload(file, settings.max_upload_bytes)
        name = upload_display_name(file.filename)
        return await run_in_threadpool(_analyze, data, name, file.filename, settings.max_duration_sec)


def _analyze(source: Path | bytes, song: str, filename_hint: str | None, max_duration_sec: float) -> BeatResult:
    """Decode + beat-track (blocking; runs in a worker thread). Bad audio is a 400."""
    start = time.perf_counter()
    try:
        y, sr = load_audio(source, filename_hint=filename_hint, max_duration_sec=max_duration_sec)
        track = track_beats(y, sr)
    except AudioDecodeError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except ParameterError as exc:  # librosa rejecting the signal itself
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Could not analyze this audio ({exc}).") from exc
    elapsed_ms = (time.perf_counter() - start) * 1000
    return BeatResult(song=song, elapsedMs=round(elapsed_ms, 1), **track)
