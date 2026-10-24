"""Decode audio files or uploaded bytes to mono float32 at a target sample rate.

Memory stays proportional to the *output* (duration x target rate), whatever the input's
sample rate, channel count or compression ratio: files are read in blocks, downmixed and
resampled as a stream. Audio longer than ``max_duration_sec`` is refused from its header
before decoding, and again while streaming in case the header lied. This matters because a
few hundred KB of FLAC silence, or a WAV that declares an 8 Hz sample rate, can otherwise
decode to hours of audio and gigabytes of RAM.

Synchronous and CPU-heavy: call it from a worker thread, never on the event loop.
"""

from __future__ import annotations

import io
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

import audioread
import numpy as np
import soundfile as sf
import soxr

DEFAULT_SR = 22050
DEFAULT_MAX_DURATION_SEC = 600.0
MIN_NATIVE_SR = 8000
MAX_NATIVE_SR = 384000
BLOCK_FRAMES = 65536
# Float formats can carry absurd sample values (1e20 overflows librosa's float32 spectra).
# Clip far above full scale before resampling, then scale the whole signal into [-1, 1].
_CLIP = 1e4
SUPPORTED_FORMATS_HINT = "Supported formats: wav, mp3, flac, ogg. m4a/aac need ffmpeg, which is not installed."


class AudioDecodeError(ValueError):
    """The input could not be decoded as audio, or is audio we refuse to analyze."""


class AudioTooLong(AudioDecodeError):
    """The audio is longer than the allowed duration."""


def load_audio(
    source: Path | bytes,
    sr: int = DEFAULT_SR,
    filename_hint: str | None = None,
    max_duration_sec: float | None = DEFAULT_MAX_DURATION_SEC,
) -> tuple[np.ndarray, int]:
    """Decode a file or in-memory bytes to mono float32 at ``sr``, finite and within [-1, 1].

    Tries soundfile first (wav/flac/ogg/mp3), then audioread (whatever the OS can decode).
    Raises ``AudioDecodeError`` if nothing can decode it, ``AudioTooLong`` past
    ``max_duration_sec`` (None = no limit), ``FileNotFoundError`` for a missing path.
    """
    if isinstance(source, (bytes, bytearray, memoryview)):
        y = _decode_bytes(bytes(source), sr, filename_hint, max_duration_sec)
    else:
        y = _decode_path(Path(source), sr, max_duration_sec)
    return y, sr


def _decode_path(path: Path, sr: int, max_duration_sec: float | None) -> np.ndarray:
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        return _read_soundfile(path, sr, max_duration_sec)
    except AudioDecodeError:
        raise
    except Exception:
        pass
    try:
        return _read_audioread(path, sr, max_duration_sec)
    except AudioDecodeError:
        raise
    except Exception as exc:
        raise _decode_error(path.name, exc) from exc


def _decode_bytes(data: bytes, sr: int, filename_hint: str | None, max_duration_sec: float | None) -> np.ndarray:
    if not data:
        raise AudioDecodeError("Empty audio data.")
    try:
        return _read_soundfile(io.BytesIO(data), sr, max_duration_sec)
    except AudioDecodeError:
        raise
    except Exception:
        pass
    try:
        with _temp_file(data, filename_hint) as path:
            return _read_audioread(path, sr, max_duration_sec)
    except AudioDecodeError:
        raise
    except Exception as exc:
        raise _decode_error(filename_hint, exc) from exc


def _read_soundfile(file: Path | BinaryIO, sr: int, max_duration_sec: float | None) -> np.ndarray:
    with sf.SoundFile(file) as f:
        sink = _MonoSink(f.samplerate, sr, max_duration_sec, declared_frames=f.frames)
        for block in f.blocks(blocksize=BLOCK_FRAMES, dtype="float32", always_2d=True):
            sink.add(block)
    return sink.finish()


def _read_audioread(path: Path, sr: int, max_duration_sec: float | None) -> np.ndarray:
    with audioread.audio_open(str(path)) as f:
        channels = max(1, int(f.channels))
        declared = int(f.duration * f.samplerate) if f.duration else None
        sink = _MonoSink(int(f.samplerate), sr, max_duration_sec, declared_frames=declared)
        for buf in f:  # 16-bit signed little-endian PCM, interleaved
            pcm = np.frombuffer(buf, dtype="<i2", count=len(buf) // 2)
            pcm = pcm[: len(pcm) - len(pcm) % channels].reshape(-1, channels)
            sink.add(pcm.astype(np.float32) / 32768.0)
    return sink.finish()


class _MonoSink:
    """Collects (frames, channels) blocks as mono float32 at ``sr``, refusing too much audio."""

    def __init__(self, native_sr: int, sr: int, max_duration_sec: float | None, declared_frames: int | None) -> None:
        if not MIN_NATIVE_SR <= native_sr <= MAX_NATIVE_SR:
            raise AudioDecodeError(
                f"Unsupported sample rate {native_sr} Hz (expected {MIN_NATIVE_SR}-{MAX_NATIVE_SR} Hz)."
            )
        self._max_duration_sec = max_duration_sec
        if max_duration_sec is not None and declared_frames and declared_frames / native_sr > max_duration_sec:
            raise self._too_long(declared_frames / native_sr)
        self._sr = sr
        self._stream = None if native_sr == sr else soxr.ResampleStream(native_sr, sr, 1, dtype="float32")
        # One second of slack: the header check above is exact, this only catches lying headers.
        self._max_samples = None if max_duration_sec is None else int((max_duration_sec + 1.0) * sr)
        self._parts: list[np.ndarray] = []
        self._samples = 0

    def add(self, block: np.ndarray) -> None:
        mono = block.mean(axis=1, dtype=np.float32) if block.ndim == 2 else block.astype(np.float32)
        np.nan_to_num(mono, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
        np.clip(mono, -_CLIP, _CLIP, out=mono)
        self._push(self._stream.resample_chunk(mono) if self._stream else mono)

    def finish(self) -> np.ndarray:
        if self._stream:
            self._push(self._stream.resample_chunk(np.zeros(0, dtype=np.float32), last=True))
        y = np.concatenate(self._parts) if self._parts else np.zeros(0, dtype=np.float32)
        self._parts.clear()
        peak = float(np.max(np.abs(y))) if y.size else 0.0
        if peak > 1.0:
            y /= peak
        return np.ascontiguousarray(y, dtype=np.float32)

    def _push(self, chunk: np.ndarray) -> None:
        if not chunk.size:
            return
        self._samples += chunk.size
        if self._max_samples is not None and self._samples > self._max_samples:
            raise self._too_long(None)
        self._parts.append(chunk)

    def _too_long(self, duration_sec: float | None) -> AudioTooLong:
        limit = _minutes(self._max_duration_sec or 0.0)
        length = f"{_minutes(duration_sec)} long" if duration_sec is not None else "too long"
        return AudioTooLong(f"Audio is {length}; the limit is {limit}.")


@contextmanager
def _temp_file(data: bytes, filename_hint: str | None) -> Iterator[Path]:
    """The bytes in a real temp file (audioread needs a path), with the original suffix kept."""
    suffix = Path(filename_hint).suffix.lower() if filename_hint else ""
    if not (1 < len(suffix) <= 8 and suffix[1:].isalnum()):
        suffix = ""
    tmp = tempfile.NamedTemporaryFile(prefix="mb-upload-", suffix=suffix, delete=False)
    try:
        with tmp:
            tmp.write(data)
        yield Path(tmp.name)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _decode_error(name: str | None, exc: BaseException) -> AudioDecodeError:
    what = f"'{name}'" if name else "the uploaded data"
    reason = str(exc).strip().splitlines()[0][:200] if str(exc).strip() else type(exc).__name__
    return AudioDecodeError(f"Could not decode {what} as audio ({reason}). {SUPPORTED_FORMATS_HINT}")


def _minutes(seconds: float) -> str:
    return f"{seconds / 60:.1f} min" if seconds >= 60 else f"{seconds:.0f} s"
