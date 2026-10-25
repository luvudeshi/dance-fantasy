"""Real-dancer clip fixtures (plain module): the small synthetic clip file and libraries built with it.

tests/fixtures/aist_clips_small.json follows the aist_clips.json contract (README "AIST++ motion clips"):
synthetic FK poses, keyframes every half beat, nine clips (some upper-body only), all mirrored.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from helpers import REPO_ROOT

from app.moves.clips import CLIPS_FILE
from app.moves.library import build_library
from app.moves.types import MoveLibrary

MOVES_DIR = REPO_ROOT / "assets" / "moves"
FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "aist_clips_small.json"
FIXTURE_BYTES = FIXTURE_PATH.read_bytes()
REAL_CLIPS = MOVES_DIR / CLIPS_FILE


def classic_files() -> list[tuple[str, bytes]]:
    """The shipped angle-based move files (never the real clip file)."""
    return [(p.name, p.read_bytes()) for p in sorted(MOVES_DIR.glob("*.json")) if p.name != CLIPS_FILE]


def fixture_doc() -> dict:
    return json.loads(FIXTURE_BYTES)


def clips_library(clips: bytes | None = FIXTURE_BYTES) -> MoveLibrary:
    """Shipped classic moves + the given clip file (default: the small fixture)."""
    return build_library(classic_files(), clips)


def big_clip_bytes(copies: int, seed: int = 0) -> bytes:
    """``copies`` jittered copies of every fixture clip with distinct ids (performance tests)."""
    doc = fixture_doc()
    rng = np.random.default_rng(seed)
    clips = []
    for c in range(copies):
        for clip in doc["clips"]:
            shift = rng.normal(0.0, 0.08, size=(17, 2))
            new = {**clip, "id": f"{clip['id']}_c{c}", "keyframes": []}
            for kf in clip["keyframes"]:
                pose = {j: [round(x + float(shift[i, 0]), 3), round(y + float(shift[i, 1]), 3)] for i, (j, (x, y)) in enumerate(kf["pose"].items())}
                new["keyframes"].append({**kf, "pose": pose})
            clips.append(new)
    return json.dumps({**doc, "clips": clips}).encode()
