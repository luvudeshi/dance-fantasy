"""DATABASE_URL sslmode -> TLS context. Tiger Cloud's URLs say sslmode=require and its certificate is publicly
trusted, so require verifies; verify-ca skips only the host name; no-verify is the explicit opt-out."""

from __future__ import annotations

import ssl

import certifi
import pytest

from app.rooms.db import ssl_context_for

URL = "postgres://u:p@db.example.com:5432/x"


def test_disable_is_plain_tcp() -> None:
    assert ssl_context_for(f"{URL}?sslmode=disable") is None


@pytest.mark.parametrize("query", ["?sslmode=require", "?sslmode=prefer", "?sslmode=verify-full", ""])
def test_require_verifies_chain_and_host(query: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_CA_CERT", raising=False)
    ctx = ssl_context_for(URL + query)
    assert ctx is not None and ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname


def test_verify_ca_checks_chain_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_CA_CERT", raising=False)
    ctx = ssl_context_for(f"{URL}?sslmode=verify-ca")
    assert ctx is not None and ctx.verify_mode == ssl.CERT_REQUIRED and not ctx.check_hostname


def test_no_verify_opts_out() -> None:
    ctx = ssl_context_for(f"{URL}?sslmode=no-verify")
    assert ctx is not None and ctx.verify_mode == ssl.CERT_NONE and not ctx.check_hostname


def test_database_ca_cert_is_loaded(monkeypatch: pytest.MonkeyPatch) -> None:
    pem = open(certifi.where()).read().split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
    monkeypatch.setenv("DATABASE_CA_CERT", pem)
    ctx = ssl_context_for(URL)
    assert ctx is not None and ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    monkeypatch.setenv("DATABASE_CA_CERT", "not a certificate")
    with pytest.raises(ssl.SSLError):
        ssl_context_for(URL)
