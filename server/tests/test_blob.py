"""Vercel Blob glue (app.blob): upload tokens, upload URL checks, and the routes' behavior with Blob off.

Nothing here talks to Blob: tokens are pure HMAC, and every URL below is rejected before any request.
The Blob round trip itself (upload, analyze, audio redirect) is exercised on a preview deployment.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import blob
from app.main import app

TOKEN = "vercel_blob_rw_AbC123storeid_secretpart"
HOST = "abc123storeid.public.blob.vercel-storage.com"


@pytest.fixture
def blob_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", TOKEN)


def test_off_without_token() -> None:
    assert not blob.enabled()
    assert blob.pull("analysis/x.json") is None
    assert blob.find_url("audio/x.") is None
    blob.push("analysis/x.json", b"{}")  # no-op, no error


def test_store_id_and_host() -> None:
    assert blob.store_id(TOKEN) == "AbC123storeid"
    assert blob.public_host(TOKEN) == HOST
    with pytest.raises(ValueError):
        blob.store_id("not_a_token")


@pytest.mark.usefixtures("blob_on")
def test_client_token_is_signed_like_vercel_blob() -> None:
    token = blob.client_token("uploads/song.mp3", 1234)
    prefix = "vercel_blob_client_AbC123storeid_"
    assert token.startswith(prefix)
    signature, payload = base64.b64decode(token[len(prefix) :]).decode().split(".", 1)
    assert signature == hmac.new(TOKEN.encode(), payload.encode(), hashlib.sha256).hexdigest()
    claims = json.loads(base64.b64decode(payload))
    assert claims["pathname"] == "uploads/song.mp3"
    assert claims["maximumSizeInBytes"] == 1234
    assert claims["allowedContentTypes"] == ["audio/*"]
    assert claims["addRandomSuffix"] is True
    assert time.time() * 1000 < claims["validUntil"] <= (time.time() + blob.CLIENT_TOKEN_TTL_SEC) * 1000


@pytest.mark.usefixtures("blob_on")
@pytest.mark.parametrize(
    "pathname",
    ["song.mp3", "audio/x.mp3", "uploads/../audio/x.mp3", "uploads/a\nb.mp3", "uploads/..", "uploads/a/b.mp3"],
)
def test_client_token_only_for_uploads(pathname: str) -> None:
    with pytest.raises(blob.NotOurUpload):
        blob.client_token(pathname, 1234)


@pytest.mark.usefixtures("blob_on")
@pytest.mark.parametrize(
    "url",
    [
        f"http://{HOST}/uploads/a.mp3",  # not https
        "https://evil.example/uploads/a.mp3",  # another host
        "https://other.public.blob.vercel-storage.com/uploads/a.mp3",  # another store
        f"https://{HOST}:8443/uploads/a.mp3",
        f"https://{HOST}/audio/{'a' * 64}.mp3",  # not an upload
        f"https://{HOST}/uploads/a.mp3?x=1",
        f"https://user@{HOST}/uploads/a.mp3",
        # each of these could resolve outside uploads/ and get a cache blob read and then deleted
        f"https://{HOST}/uploads/../audio/{'a' * 64}.mp3",
        f"https://{HOST}/uploads/%2e%2e/audio/x.mp3",
        f"https://{HOST}/uploads/..%2faudio%2fx.mp3",
        f"https://{HOST}/uploads/..",
        f"https://{HOST}/uploads/a\\..\\b.mp3",
        f"https://{HOST}/uploads//x.mp3",
    ],
)
def test_upload_url_must_be_ours(url: str) -> None:
    with pytest.raises(blob.NotOurUpload):
        blob.upload_url(url)


@pytest.mark.usefixtures("blob_on")
def test_upload_url_accepts_our_uploads() -> None:
    url = f"https://{HOST}/uploads/song-Xy12.mp3"
    assert blob.upload_url(url) == url


def test_routes_404_with_blob_off() -> None:
    with TestClient(app) as client:
        res = client.post(
            "/api/blob/upload", json={"type": "blob.generate-client-token", "payload": {"pathname": "uploads/a.mp3"}}
        )
        assert res.status_code == 404
        res = client.post("/api/analyze/blob", json={"url": f"https://{HOST}/uploads/a.mp3"})
        assert res.status_code == 404


@pytest.mark.usefixtures("blob_on")
def test_token_route(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.api import analyze as analyze_api
    from app.config import get_settings

    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))  # a fresh database for the per-client upload count
    monkeypatch.setattr(analyze_api, "BLOB_UPLOADS_PER_HOUR", 2)
    get_settings.cache_clear()
    with TestClient(app) as client:
        event = {"type": "blob.generate-client-token", "payload": {"pathname": "uploads/a.mp3", "multipart": False}}
        res = client.post("/api/blob/upload", json=event)
        assert res.status_code == 200
        assert res.json()["type"] == "blob.generate-client-token"
        assert res.json()["clientToken"].startswith("vercel_blob_client_AbC123storeid_")
        event["payload"] = {"pathname": "audio/a.mp3"}
        assert client.post("/api/blob/upload", json=event).status_code == 400
        res = client.post("/api/blob/upload", json=event)  # third token request this hour
        assert res.status_code == 429
    get_settings.cache_clear()


@pytest.mark.usefixtures("blob_on")
def test_analyze_blob_rejects_foreign_urls() -> None:
    with TestClient(app) as client:
        res = client.post("/api/analyze/blob", json={"url": "https://evil.example/uploads/a.mp3"})
        assert res.status_code == 400
        assert "Blob store" in res.json()["detail"]
