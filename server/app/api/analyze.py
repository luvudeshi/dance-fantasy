"""Stage 1: song analysis (beats, downbeats, sections) for uploads and library songs, cached on disk."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

import anyio
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from app.analysis import ID_PATTERN, Analysis
from app.analysis_store import AnalysisStore, audio_extension, sha256_file
from app.api.deps import bad_audio_is_400, hash_upload, read_upload, song_path, upload_display_name
from app.api.limits import ANALYSIS_SLOTS
from app.audio import load_audio
from app.audio.analysis import ANALYSIS_VERSION, analyze_audio
from app.config import Settings, get_settings
from app.library import MEDIA_TYPES, song_artist, song_title

router = APIRouter(tags=["analysis"])
SettingsDep = Annotated[Settings, Depends(get_settings)]
AnalysisId = Annotated[str, PathParam(pattern=ID_PATTERN, description="sha256 hex of the audio bytes")]
Refresh = Annotated[bool, Query(description="Recompute even if a cached analysis exists")]
ANALYSIS_RESPONSE: dict[str, Any] = {"response_model": Analysis, "response_model_exclude_none": True}


@router.post("/analyze", **ANALYSIS_RESPONSE)
async def analyze_upload(
    settings: SettingsDep,
    file: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form()] = None,
    refresh: Refresh = False,
) -> Analysis:
    """Analyze an uploaded song; the audio is kept by content hash for GET /api/audio/{id}."""
    digest, _ = await hash_upload(file, settings.max_upload_bytes)  # streamed; nothing held in RAM yet
    name = upload_display_name(file.filename)
    meta = {
        "title": (title or "").strip() or Path(name).stem or name,
        "artist": None,
        "source": {"kind": "upload", "file": name},
        "audioUrl": f"/api/audio/{digest}",
    }
    store = AnalysisStore(settings.cache_dir)
    async with _one_at_a_time(digest):
        if not refresh:
            cached = await _load_cached(store, digest, meta)
            if cached is not None:
                if await run_in_threadpool(store.audio_path, digest) is None:  # cached from a library copy
                    data = await read_upload(file, settings.max_upload_bytes)
                    await run_in_threadpool(store.save_audio, digest, data, audio_extension(name, data))
                return cached
        async with ANALYSIS_SLOTS:  # read inside the slot: queued uploads stay spooled on disk, not in RAM
            data = await read_upload(file, settings.max_upload_bytes)
            return await run_in_threadpool(
                analyze_and_store, store, digest, data, meta, file.filename, settings.max_duration_sec
            )


@router.get("/songs/{file}/analysis", **ANALYSIS_RESPONSE)
async def analyze_library_song(file: str, settings: SettingsDep, refresh: Refresh = False) -> Analysis:
    """Analyze a song in assets/songs/ (title and artist from its sidecar)."""
    path = song_path(settings.songs_dir, file)
    digest = await run_in_threadpool(sha256_file, path)
    meta = library_meta(file, path)
    store = AnalysisStore(settings.cache_dir)
    async with _one_at_a_time(digest):
        if not refresh:
            cached = await _load_cached(store, digest, meta)
            if cached is not None:
                return cached
        async with ANALYSIS_SLOTS:
            return await run_in_threadpool(
                analyze_and_store, store, digest, path, meta, file, settings.max_duration_sec
            )


@router.get("/analysis/{id}", **ANALYSIS_RESPONSE)
async def get_analysis(id: AnalysisId, settings: SettingsDep) -> Analysis:
    """A previously computed analysis (404 if this audio was never analyzed)."""
    cached = await _load_cached(AnalysisStore(settings.cache_dir), id, {})
    if cached is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No analysis with this id; analyze the song first.")
    return cached


@router.get("/audio/{id}", response_class=FileResponse)
def get_uploaded_audio(id: AnalysisId, settings: SettingsDep) -> FileResponse:
    """An uploaded song's audio by content hash (supports Range requests)."""
    path = AnalysisStore(settings.cache_dir).audio_path(id)
    if path is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No uploaded audio with this id.")
    return FileResponse(path, media_type=MEDIA_TYPES.get(path.suffix, "application/octet-stream"))


async def _load_cached(store: AnalysisStore, digest: str, meta: dict[str, Any]) -> Analysis | None:
    """The cached analysis with this request's title/source/audioUrl, or None (missing/stale/invalid)."""
    start = time.perf_counter()
    doc = await run_in_threadpool(store.load, digest)
    if doc is None:
        return None
    try:
        doc.update(meta, cached=True, elapsedMs=round((time.perf_counter() - start) * 1000, 1))
        return Analysis.model_validate(doc)
    except ValueError:  # pydantic.ValidationError: e.g. written by an older, incompatible build
        return None


def library_meta(file: str, path: Path) -> dict[str, Any]:
    """Request-specific fields of a library song's analysis (title/artist from its sidecar)."""
    return {
        "title": song_title(path),
        "artist": song_artist(path),
        "source": {"kind": "library", "file": file},
        "audioUrl": f"/api/songs/{quote(file, safe='')}",
    }


def analyze_and_store(
    store: AnalysisStore,
    digest: str,
    source: Path | bytes,
    meta: dict[str, Any],
    filename_hint: str | None,
    max_duration_sec: float,
) -> Analysis:
    """Decode + analyze (blocking; runs in a worker thread), then cache. Bad audio is a 400."""
    start = time.perf_counter()
    with bad_audio_is_400():
        y, sr = load_audio(source, filename_hint=filename_hint, max_duration_sec=max_duration_sec)
        fields = analyze_audio(y, sr)
    analysis = Analysis.model_validate(
        {
            "id": digest,
            "analysisVersion": ANALYSIS_VERSION,
            **meta,
            **fields,
            "elapsedMs": round((time.perf_counter() - start) * 1000, 1),
            "cached": False,
        }
    )
    if isinstance(source, bytes):
        store.save_audio(digest, source, audio_extension(filename_hint, source))
    store.save(digest, analysis.to_json_dict())
    return analysis


# One analysis per audio file at a time: a second request for the same bytes waits, then reads
# the cache instead of analyzing again. (Event-loop only, so a plain dict is safe.)
_inflight: dict[str, tuple[anyio.Lock, int]] = {}


@asynccontextmanager
async def _one_at_a_time(digest: str) -> AsyncIterator[None]:
    lock, users = _inflight.get(digest, (None, 0))
    if lock is None:
        lock = anyio.Lock()
    _inflight[digest] = (lock, users + 1)
    try:
        async with lock:
            yield
    finally:
        lock, users = _inflight[digest]
        if users <= 1:
            del _inflight[digest]
        else:
            _inflight[digest] = (lock, users - 1)
