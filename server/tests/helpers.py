"""Shared test helpers (plain module; imported as `helpers`)."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import soundfile as sf

from app.analysis_store import AnalysisStore

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED_DIR = REPO_ROOT / "shared"
SHORT_LAYOUT = [("verse", 4), ("chorus", 4)]


def wav_bytes(y: np.ndarray, sr: int, subtype: str = "PCM_16") -> bytes:
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype=subtype)
    return buf.getvalue()


def seed_analysis(cache_dir: Path, analysis_id: str, title: str = "Vibe Ace", beats: int = 400) -> None:
    """A song the server has analyzed: its cached analysis on disk (the fields the leaderboard and rounds read)."""
    AnalysisStore(cache_dir).save(analysis_id, {"id": analysis_id, "title": title, "beats": [i * 0.5 for i in range(beats)]})
