"""DATABASE_URL sslmode -> TLS context: verify by default (Tiger Cloud's require URLs included)."""

from __future__ import annotations

import ssl

import pytest

from app.rooms.db import ssl_context


def test_disable_is_plain_tcp() -> None:
    assert ssl_context("sslmode=disable") is None


@pytest.mark.parametrize("query", ["sslmode=require", "sslmode=prefer", "sslmode=verify-full", ""])
def test_verifies_chain_and_host_by_default(query: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_CA_CERT", raising=False)
    ctx = ssl_context(query)
    assert ctx is not None
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname


def test_verify_ca_skips_only_the_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_CA_CERT", raising=False)
    ctx = ssl_context("sslmode=verify-ca")
    assert ctx is not None
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert not ctx.check_hostname


def test_no_verify_is_the_explicit_opt_out() -> None:
    ctx = ssl_context("sslmode=no-verify")
    assert ctx is not None
    assert ctx.verify_mode == ssl.CERT_NONE
