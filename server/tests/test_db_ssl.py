"""DATABASE_URL sslmode -> TLS context, as libpq reads it (Tiger Cloud's URLs say sslmode=require)."""

from __future__ import annotations

import ssl

import pytest

from app.rooms.db import ssl_context


def test_disable_is_plain_tcp() -> None:
    assert ssl_context("sslmode=disable") is None


@pytest.mark.parametrize("query", ["sslmode=require", "sslmode=prefer", "sslmode=no-verify", ""])
def test_require_encrypts_without_verifying(query: str) -> None:
    ctx = ssl_context(query)
    assert ctx is not None
    assert ctx.verify_mode == ssl.CERT_NONE
    assert not ctx.check_hostname


def test_verify_full_checks_chain_and_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_CA_CERT", raising=False)
    ctx = ssl_context("sslmode=verify-full")
    assert ctx is not None
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname


def test_verify_ca_checks_chain_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_CA_CERT", raising=False)
    ctx = ssl_context("sslmode=verify-ca")
    assert ctx is not None
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert not ctx.check_hostname
