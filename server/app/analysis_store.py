"""On-disk cache of analyses and uploaded audio, keyed by sha256 of the audio bytes.

    <cache_dir>/analysis/<id>.v<ANALYSIS_VERSION>.json
    <cache_dir>/audio/<id><ext>

Every write goes to a unique temp file in the same directory and is moved into place with
``os.replace``, so concurrent writers of the same id never leave a partial file: readers see
the old file, the new one, or none. Blocking I/O: call from a worker thread.

On deployments (app.blob enabled) every write is also mirrored to Vercel Blob and a read that
misses the local disk falls back to it, so all instances share one cache.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

import soundfile as sf

from app import blob
from app.audio.analysis import ANALYSIS_VERSION
from app.library import AUDIO_EXTENSIONS

log = logging.getLogger(__name__)

ID_RE = re.compile(r"^[0-9a-f]{64}$")
HASH_CHUNK_BYTES = 1024 * 1024
_SNIFFED_EXTENSIONS = {"WAV": ".wav", "FLAC": ".flac", "OGG": ".ogg", "MP3": ".mp3"}

_digest_lock = threading.Lock()
_file_digests: dict[tuple[str, int, int], str] = {}  # (path, mtime_ns, size) -> sha256


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    """sha256 of a file's bytes, remembered while its mtime and size stay the same."""
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    with _digest_lock:
        if key in _file_digests:
            return _file_digests[key]
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(HASH_CHUNK_BYTES):
            h.update(chunk)
    digest = h.hexdigest()
    with _digest_lock:
        _file_digests[key] = digest
    return digest


def audio_extension(filename: str | None, data: bytes) -> str:
    """The upload's lowercase extension if it is a known audio type, else sniffed, else '.bin'."""
    suffix = Path(filename or "").suffix.lower()
    if suffix in AUDIO_EXTENSIONS:
        return suffix
    try:
        return _SNIFFED_EXTENSIONS.get(sf.info(io.BytesIO(data)).format, ".bin")
    except Exception:
        return ".bin"


class AnalysisStore:
    def __init__(self, cache_dir: Path) -> None:
        self.analysis_dir = cache_dir / "analysis"
        self.audio_dir = cache_dir / "audio"

    def analysis_path(self, digest: str) -> Path:
        _check_id(digest)
        return self.analysis_dir / f"{digest}.v{ANALYSIS_VERSION}.json"

    def load(self, digest: str) -> dict[str, Any] | None:
        """The cached analysis, or None if missing or unreadable (it is then recomputed)."""
        path = self.analysis_path(digest)
        try:
            doc = json.loads(read_cached(path).decode("utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            log.warning("ignoring unreadable analysis cache %s: %s", path.name, exc)
            return None
        return doc if isinstance(doc, dict) else None

    def save(self, digest: str, doc: dict[str, Any]) -> None:
        _atomic_write(self.analysis_path(digest), json.dumps(doc, separators=(",", ":")).encode("utf-8"))

    def audio_path(self, digest: str) -> Path | None:
        _check_id(digest)
        if not self.audio_dir.is_dir():
            return None
        for path in sorted(self.audio_dir.glob(f"{digest}.*")):
            if path.is_file() and path.stem == digest:
                return path
        return None

    def audio_url(self, digest: str) -> str | None:
        """Blob URL of uploaded audio that isn't on this instance's disk (None when Blob is off)."""
        _check_id(digest)
        return blob.find_url(f"{self.audio_dir.name}/{digest}.")

    def has_audio(self, digest: str) -> bool:
        return self.audio_path(digest) is not None or self.audio_url(digest) is not None

    def save_audio(self, digest: str, data: bytes, ext: str) -> Path:
        existing = self.audio_path(digest)
        if existing is not None:
            return existing
        path = self.audio_dir / f"{digest}{ext}"
        _atomic_write(path, data)
        return path


def _check_id(digest: str) -> None:
    if not ID_RE.match(digest):
        raise ValueError("analysis id must be 64 lowercase hex characters")


def _blob_key(path: Path) -> str:
    # ponytail: every cache file sits one level under cache_dir (analysis/, audio/, routines/), so
    # "<dir>/<file>" is its Blob key; a deeper layout would need cache_dir passed in here.
    return f"{path.parent.name}/{path.name}"


def read_cached(path: Path) -> bytes:
    """A cache file's bytes: local disk, else its Blob mirror (copied to disk). FileNotFoundError if neither."""
    try:
        return path.read_bytes()
    except FileNotFoundError:
        data = blob.pull(_blob_key(path))
        if data is None:
            raise
        _write_local(path, data)
        return data


def _atomic_write(path: Path, data: bytes) -> None:
    """Write a cache file locally (atomically) and to its Blob mirror."""
    _write_local(path, data)
    blob.push(_blob_key(path), data)


def _write_local(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
