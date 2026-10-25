"""Settings come from the environment and are re-read after cache_clear()."""

from __future__ import annotations

import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.config import REPO_ROOT, SERVER_ROOT, get_settings


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for var in ("ASSETS_DIR", "CORS_ORIGINS", "MAX_UPLOAD_MB"):
        monkeypatch.delenv(var, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_defaults() -> None:
    s = get_settings()
    assert s.assets_dir == (REPO_ROOT / "assets").resolve()
    assert s.songs_dir == s.assets_dir / "songs"
    assert s.cache_dir == s.assets_dir / "cache"
    assert s.cors_origins == ("http://localhost:5173", "http://127.0.0.1:5173")
    assert s.max_upload_mb == 50
    assert s.max_upload_bytes == 50 * 1024 * 1024


def test_vercel_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """On Vercel: assets copied into server/assets by the build, cache in writable /tmp."""
    monkeypatch.setenv("VERCEL", "1")
    s = get_settings()
    assert s.assets_dir == (SERVER_ROOT / "assets").resolve()
    assert s.cache_dir == Path(tempfile.gettempdir()) / "midnight-ball-cache"


def test_env_overrides(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))
    monkeypatch.setenv("CORS_ORIGINS", " http://a.test , http://b.test/ ,")
    monkeypatch.setenv("MAX_UPLOAD_MB", "2.5")
    s = get_settings()
    assert s.assets_dir == tmp_path.resolve()
    assert s.songs_dir == tmp_path.resolve() / "songs"
    assert s.cors_origins == ("http://a.test", "http://b.test")
    assert s.max_upload_bytes == int(2.5 * 1024 * 1024)


def test_relative_assets_dir_resolves_against_repo_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASSETS_DIR", "some/where")
    assert get_settings().assets_dir == (REPO_ROOT / "some" / "where").resolve()


@pytest.mark.parametrize("value", ["lots", "0", "-3"])
def test_bad_upload_limit_fails_loudly(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("MAX_UPLOAD_MB", value)
    with pytest.raises(ValueError, match="MAX_UPLOAD_MB"):
        get_settings()
