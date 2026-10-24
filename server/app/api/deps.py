"""Request helpers shared by the routers: library song lookup, bounded upload reads, audio errors."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException, UploadFile, status
from librosa.util.exceptions import ParameterError

from app.api.limits import UploadTooLarge
from app.audio import AudioDecodeError
from app.library import InvalidSongName, SongNotFound, resolve_song

UPLOAD_CHUNK_BYTES = 1024 * 1024


def song_path(songs_dir: Path, name: str) -> Path:
    """Resolve a library song name, mapping bad names to 400 and missing songs to 404."""
    try:
        return resolve_song(songs_dir, name)
    except InvalidSongName as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except SongNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc


async def read_upload(file: UploadFile, max_bytes: int) -> bytes:
    """Read an uploaded file in chunks: 413 as soon as it exceeds ``max_bytes``, 400 if empty."""
    if file.size is not None and file.size > max_bytes:
        raise UploadTooLarge(max_bytes)
    buf = bytearray()
    while chunk := await file.read(UPLOAD_CHUNK_BYTES):
        buf += chunk
        if len(buf) > max_bytes:
            raise UploadTooLarge(max_bytes)
    if not buf:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uploaded file is empty.")
    return bytes(buf)


def upload_display_name(filename: str | None) -> str:
    """Base name of the client's file name, safe to echo back (never used as a path)."""
    name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(c for c in name if ord(c) >= 32).strip()[:255]
    return name or "upload"


async def hash_upload(file: UploadFile, max_bytes: int) -> tuple[str, int]:
    """(sha256 hex, size) of an upload, streamed in chunks (413/400 like ``read_upload``), rewound after."""
    if file.size is not None and file.size > max_bytes:
        raise UploadTooLarge(max_bytes)
    h = hashlib.sha256()
    size = 0
    while chunk := await file.read(UPLOAD_CHUNK_BYTES):
        h.update(chunk)
        size += len(chunk)
        if size > max_bytes:
            raise UploadTooLarge(max_bytes)
    if not size:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uploaded file is empty.")
    await file.seek(0)
    return h.hexdigest(), size


@contextmanager
def bad_audio_is_400() -> Iterator[None]:
    """Undecodable or unanalyzable audio becomes a 400 with a readable ``detail``."""
    try:
        yield
    except AudioDecodeError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except ParameterError as exc:  # librosa rejecting the signal itself
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Could not analyze this audio ({exc}).") from exc
