"""Shared test helpers (plain module; imported as `helpers`)."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import soundfile as sf

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED_DIR = REPO_ROOT / "shared"
SHORT_LAYOUT = [("verse", 4), ("chorus", 4)]


def wav_bytes(y: np.ndarray, sr: int, subtype: str = "PCM_16") -> bytes:
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype=subtype)
    return buf.getvalue()
