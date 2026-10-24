"""The song library on disk (``assets/songs/``): safe name resolution, listing, titles.

Every path served or analyzed by the API goes through ``resolve_song``, which only accepts
plain file names with an audio extension that resolve to a file directly inside songs_dir.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

MEDIA_TYPES: dict[str, str] = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".webm": "audio/webm",
}
AUDIO_EXTENSIONS = frozenset(MEDIA_TYPES)
MAX_NAME_LENGTH = 255


class InvalidSongName(ValueError):
    """The name is not a plain audio file name inside the song library."""


class SongNotFound(LookupError):
    """No such song in the library."""


@dataclass(frozen=True)
class SongEntry:
    file: str
    title: str
    size_bytes: int
    path: Path


def check_song_name(name: str) -> str:
    """Return ``name`` if it is a plain audio file name, else raise InvalidSongName.

    Containment does not rely on this alone: ``resolve_song`` also checks the resolved parent.
    "..." inside a name is fine ("...Baby One More Time.mp3"); only whole "." / ".." are paths.
    """
    if not name or len(name) > MAX_NAME_LENGTH:
        raise InvalidSongName("Song name must be 1-255 characters.")
    if name in (".", "..") or "/" in name or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise InvalidSongName("Song name must be a plain file name (no paths or control characters).")
    if _is_hidden(name):
        raise InvalidSongName("Hidden files (e.g. '.x.wav', macOS '._x.wav') are not songs.")
    if Path(name).suffix.lower() not in AUDIO_EXTENSIONS:
        raise InvalidSongName(f"Unsupported file type; expected one of {', '.join(sorted(AUDIO_EXTENSIONS))}.")
    return name


def _is_hidden(name: str) -> bool:
    """A dotfile: '.' followed by something other than another '.'."""
    return len(name) > 1 and name[0] == "." and name[1] != "."


def resolve_song(songs_dir: Path, name: str) -> Path:
    """Absolute path of library song ``name``. Raises InvalidSongName or SongNotFound."""
    check_song_name(name)
    root = songs_dir.resolve()
    path = (root / name).resolve()
    if path.parent != root:  # e.g. a symlink pointing outside the library
        raise InvalidSongName("Song name must refer to a file inside the song library.")
    if not path.is_file():
        raise SongNotFound(f"No song named '{name}'.")
    return path


def read_sidecar(path: Path) -> dict:
    """The optional ``<stem>.json`` next to a song as a dict ({} if missing or unreadable)."""
    sidecar = path.with_suffix(".json")
    if not sidecar.is_file():
        return {}
    try:
        meta = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("ignoring unreadable sidecar %s: %s", sidecar, exc)
        return {}
    return meta if isinstance(meta, dict) else {}


def _sidecar_text(meta: dict, key: str) -> str | None:
    value = meta.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def song_title(path: Path) -> str:
    """Title from the optional ``<stem>.json`` sidecar, else the file stem with _ and - as spaces."""
    title = _sidecar_text(read_sidecar(path), "title")
    if title:
        return title
    return " ".join(path.stem.replace("_", " ").replace("-", " ").split()) or path.stem


def song_artist(path: Path) -> str | None:
    """Artist from the optional ``<stem>.json`` sidecar."""
    return _sidecar_text(read_sidecar(path), "artist")


def list_songs(songs_dir: Path) -> list[SongEntry]:
    """All servable audio files directly in ``songs_dir``, sorted by file name."""
    if not songs_dir.is_dir():
        return []
    entries = []
    for child in sorted(songs_dir.iterdir(), key=lambda p: p.name):
        try:
            path = resolve_song(songs_dir, child.name)
        except (InvalidSongName, SongNotFound) as exc:
            if child.suffix.lower() in AUDIO_EXTENSIONS and not _is_hidden(child.name):
                log.warning("not listing %r: %s", child.name, exc)  # e.g. a symlink out of the library
            continue
        entries.append(SongEntry(file=child.name, title=song_title(child), size_bytes=path.stat().st_size, path=path))
    return entries
