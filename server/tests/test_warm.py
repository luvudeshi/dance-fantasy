"""Startup cache warming of library song analyses."""

from __future__ import annotations

from pathlib import Path

import pytest
from helpers import SHORT_LAYOUT, wav_bytes

from app.analysis_store import AnalysisStore, sha256_file
from app.config import get_settings
from app.warm import warm_library_analyses
from scripts.make_sample_song import render_song


@pytest.fixture
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    songs = tmp_path / "songs"
    songs.mkdir()
    y, sr, _ = render_song(120.0, seed=1, layout=SHORT_LAYOUT, sr=22050)
    (songs / "demo.wav").write_bytes(wav_bytes(y, sr))
    (songs / "broken.wav").write_bytes(b"not audio at all")
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield get_settings()
    get_settings.cache_clear()


def test_analyzes_uncached_library_songs_once(settings) -> None:
    assert warm_library_analyses(settings) == 1  # broken.wav is logged and skipped, not raised
    doc = AnalysisStore(settings.cache_dir).load(sha256_file(settings.songs_dir / "demo.wav"))
    assert doc is not None
    assert doc["source"] == {"kind": "library", "file": "demo.wav"}
    assert doc["audioUrl"] == "/api/songs/demo.wav"
    assert warm_library_analyses(settings) == 0  # already cached
