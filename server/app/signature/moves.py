"""Signature move library: assets/moves/signature/*.json, compiled like the main library (app.moves.library).

The files use the normal move format plus two per-move fields, stripped before compiling:
``signatureDance`` (the dance's name, required) and ``songs`` (titles it belongs to). These moves are never in
the main library (GET /api/moves, the beam search): they only enter a routine as pinned moves.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.moves.library import MoveDefinitionError, build_library, default_moves_dir, move_to_json
from app.moves.types import CompiledMove, MoveLibrary
from app.signature.table import find_dance, normalize, title_keys

ID_PREFIX = "sig_"


@dataclass(frozen=True)
class SignatureMove:
    move: CompiledMove
    dance: str  # "YMCA arms"
    songs: tuple[str, ...]

    @property
    def creator(self) -> str:
        entry = find_dance(self.dance)
        return entry.creator if entry else ""

    def tag(self) -> dict[str, Any]:
        """routine move.signatureDance."""
        return {"name": self.dance, **({"creator": self.creator} if self.creator else {})}


@dataclass(frozen=True)
class SignatureLibrary:
    moves: tuple[SignatureMove, ...]
    version: str

    def get(self, move_id: str) -> SignatureMove | None:
        return next((m for m in self.moves if m.move.id == move_id), None)

    def for_song(self, title: str) -> SignatureMove | None:
        keys = title_keys(title)
        return next((m for m in self.moves if any(keys & title_keys(s) for s in m.songs)), None)

    def for_dance(self, dance: str) -> SignatureMove | None:
        entry = find_dance(dance)
        names = {normalize(dance)} | ({normalize(entry.dance)} if entry else set())
        strip = lambda n: " ".join(w for w in n.split() if w not in {"the", "dance", "a"})  # noqa: E731
        names = {strip(n) for n in names}
        return next((m for m in self.moves if strip(normalize(m.dance)) in names), None)

    def to_json(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "moves": [
                {**move_to_json(m.move), "signatureDance": m.dance, "songs": list(m.songs), "creator": m.creator}
                for m in self.moves
            ],
        }


def default_dir() -> Path:
    return default_moves_dir() / "signature"


def _split(name: str, content: bytes) -> tuple[bytes, dict[str, tuple[str, tuple[str, ...]]]]:
    """(file content without the signature fields, base id -> (dance, songs))."""
    try:
        doc = json.loads(content)
    except json.JSONDecodeError as exc:
        raise MoveDefinitionError(f"signature/{name}: invalid JSON ({exc})") from None
    meta: dict[str, tuple[str, tuple[str, ...]]] = {}
    for raw in doc.get("moves", []) if isinstance(doc, dict) else []:
        if not isinstance(raw, dict):
            continue
        where = f"signature/{name}: move {raw.get('id')!r}"
        dance, songs = raw.pop("signatureDance", None), raw.pop("songs", [])
        if not isinstance(dance, str) or not dance.strip():
            raise MoveDefinitionError(f"{where}: signatureDance must be a non-empty string")
        if not isinstance(songs, list) or not all(isinstance(s, str) and s.strip() for s in songs):
            raise MoveDefinitionError(f"{where}: songs must be a list of titles")
        if not str(raw.get("id", "")).startswith(ID_PREFIX):
            raise MoveDefinitionError(f"{where}: signature move ids start with {ID_PREFIX!r}")
        if raw.get("lengthBeats") not in (4, 8):
            raise MoveDefinitionError(f"{where}: signature moves last 4 or 8 beats (whole bars)")
        meta[str(raw["id"])] = (dance.strip(), tuple(s.strip() for s in songs))
    return json.dumps(doc, sort_keys=True).encode(), meta


def build_signature_library(files: list[tuple[str, bytes]]) -> SignatureLibrary:
    cleaned, meta = [], {}
    for name, content in files:
        data, m = _split(name, content)
        cleaned.append((name, data))
        meta.update(m)
    lib: MoveLibrary = build_library(cleaned)
    moves = tuple(SignatureMove(move=mv, dance=meta[mv.baseId][0], songs=meta[mv.baseId][1]) for mv in lib.moves)
    return SignatureLibrary(moves=moves, version=lib.version)


_cache: dict[tuple[Any, ...], SignatureLibrary] = {}
_lock = threading.Lock()


def load_signature_library(directory: Path | None = None) -> SignatureLibrary:
    """Every ``*.json`` in assets/moves/signature/ (empty library if the folder is missing). Cached per mtimes."""
    directory = (directory or default_dir()).resolve()
    paths = sorted(p for p in directory.glob("*.json") if p.is_file() and not p.name.startswith(".")) if directory.is_dir() else []
    key = (str(directory), tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in paths))
    with _lock:
        if key in _cache:
            return _cache[key]
    lib = build_signature_library([(p.name, p.read_bytes()) for p in paths])
    with _lock:
        _cache.clear()
        _cache[key] = lib
    return lib
