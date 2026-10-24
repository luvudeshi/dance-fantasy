"""Test-wide fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _ignore_dotenv(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep tests hermetic: a developer's repo-root .env must not leak into settings."""
    monkeypatch.setattr("app.config.load_dotenv", lambda *args, **kwargs: False)
