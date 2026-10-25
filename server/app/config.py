"""Runtime settings, read from the environment (and the repo-root .env, if present).

Call ``get_settings()`` wherever settings are needed; it is cached. Tests change env vars
and then call ``get_settings.cache_clear()``.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

SERVER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVER_ROOT.parent
DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
DEFAULT_MAX_UPLOAD_MB = 50.0
DEFAULT_MAX_DURATION_SEC = 600.0


@dataclass(frozen=True)
class Settings:
    assets_dir: Path
    songs_dir: Path
    cache_dir: Path  # created lazily by whoever writes to it
    cors_origins: tuple[str, ...]
    max_upload_mb: float
    max_duration_sec: float  # longest decoded audio we analyze; bounds memory, not just upload size

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)


def _resolve_dir(value: str | None, default: Path) -> Path:
    if not value:
        return default
    path = Path(value).expanduser()
    return path if path.is_absolute() else REPO_ROOT / path


def _parse_origins(value: str) -> tuple[str, ...]:
    return tuple(o.strip().rstrip("/") for o in value.split(",") if o.strip())


def _positive_number(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    try:
        number = float(value)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {value!r}") from None
    if not number > 0 or number == float("inf"):
        raise ValueError(f"{name} must be > 0, got {value!r}")
    return number


@lru_cache
def get_settings() -> Settings:
    """Build settings from the environment. Values already in the environment win over .env."""
    load_dotenv(REPO_ROOT / ".env", override=False)
    # On Vercel the function holds only server/, so its build copies assets/{songs,moves} into server/assets
    # (vercel.json). Its code directory is read-only; /tmp is writable but per instance (app.blob shares it).
    on_vercel = bool(os.environ.get("VERCEL"))
    default_assets = SERVER_ROOT / "assets" if on_vercel else REPO_ROOT / "assets"
    assets_dir = _resolve_dir(os.environ.get("ASSETS_DIR"), default_assets).resolve()
    return Settings(
        assets_dir=assets_dir,
        songs_dir=assets_dir / "songs",
        cache_dir=Path(tempfile.gettempdir()) / "midnight-ball-cache" if on_vercel else assets_dir / "cache",
        cors_origins=_parse_origins(os.environ.get("CORS_ORIGINS", DEFAULT_CORS_ORIGINS)),
        max_upload_mb=_positive_number("MAX_UPLOAD_MB", DEFAULT_MAX_UPLOAD_MB),
        max_duration_sec=_positive_number("MAX_DURATION_SEC", DEFAULT_MAX_DURATION_SEC),
    )
