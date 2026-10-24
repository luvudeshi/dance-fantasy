"""HTTP API against a temporary assets dir holding one short rendered song."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from helpers import wav_bytes
from starlette.responses import PlainTextResponse
from starlette.types import Receive, Scope, Send

from app import __version__
from app.api.limits import BodySizeLimitMiddleware
from app.config import get_settings
from app.main import app
from scripts.make_sample_song import render_song

SONG = "test_120bpm.wav"
SR = 22050
QUIET_WAV = wav_bytes(np.zeros(SR // 2, dtype=np.float32), SR)


@pytest.fixture(scope="module")
def song_wav() -> bytes:
    y, sr, _ = render_song(120.0, seed=1, layout=[("verse", 2), ("chorus", 2)], sr=SR)
    return wav_bytes(y, sr)


@pytest.fixture(scope="module")
def assets_dir(tmp_path_factory: pytest.TempPathFactory, song_wav: bytes) -> Path:
    assets = tmp_path_factory.mktemp("assets")
    songs = assets / "songs"
    songs.mkdir()
    (songs / SONG).write_bytes(song_wav)
    (songs / "test_120bpm.json").write_text(json.dumps({"title": "Test Song 120", "artist": "pytest"}))
    (songs / "quiet_take-two.wav").write_bytes(QUIET_WAV)
    (songs / "notes.txt").write_text("not audio")
    (songs / ".hidden.wav").write_bytes(song_wav)
    (songs / "broken.mp3").write_bytes(b"\x00" * 2048)
    (assets / "secret.wav").write_bytes(song_wav)  # outside songs/: must never be served
    (assets / "pyproject.toml").write_text("[secret]\n")
    (songs / "escape.wav").symlink_to(assets / "secret.wav")
    return assets


@pytest.fixture
def client(assets_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("ASSETS_DIR", str(assets_dir))
    monkeypatch.delenv("MAX_UPLOAD_MB", raising=False)
    get_settings.cache_clear()
    yield TestClient(app)  # no `with`: skips the lifespan warmup thread
    get_settings.cache_clear()


def test_health(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "version": __version__}


def test_songs_list(client: TestClient, song_wav: bytes) -> None:
    r = client.get("/api/songs")
    assert r.status_code == 200
    assert r.json() == [
        {"file": "broken.mp3", "title": "broken", "sizeBytes": 2048},
        {"file": "quiet_take-two.wav", "title": "quiet take two", "sizeBytes": len(QUIET_WAV)},
        {"file": SONG, "title": "Test Song 120", "sizeBytes": len(song_wav)},
    ]


def test_song_download(client: TestClient, song_wav: bytes) -> None:
    r = client.get(f"/api/songs/{SONG}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == song_wav


def test_song_download_range(client: TestClient, song_wav: bytes) -> None:
    r = client.get(f"/api/songs/{SONG}", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.content == song_wav[:100]


def test_beats_for_library_song(client: TestClient) -> None:
    r = client.get("/api/spike/beats", params={"song": SONG})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"song", "durationSec", "sampleRate", "tempo", "bpmFromBeats", "beats", "elapsedMs"}
    assert body["song"] == SONG
    assert body["sampleRate"] == SR
    assert body["durationSec"] == pytest.approx(8.0, abs=0.01)
    assert body["bpmFromBeats"] == pytest.approx(120.0, rel=0.02)
    assert len(body["beats"]) >= 12
    assert body["elapsedMs"] > 0


def test_beats_for_silent_song(client: TestClient) -> None:
    r = client.get("/api/spike/beats", params={"song": "quiet_take-two.wav"})
    assert r.status_code == 200
    assert r.json()["beats"] == [] and r.json()["tempo"] == 0.0


def test_beats_for_upload(client: TestClient, song_wav: bytes) -> None:
    r = client.post("/api/spike/beats", files={"file": ("my song.wav", song_wav, "audio/wav")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["song"] == "my song.wav"
    assert body["bpmFromBeats"] == pytest.approx(120.0, rel=0.02)


def test_upload_name_is_reduced_to_basename(client: TestClient, song_wav: bytes) -> None:
    r = client.post("/api/spike/beats", files={"file": ("../../etc/evil.wav", song_wav, "audio/wav")})
    assert r.status_code == 200
    assert r.json()["song"] == "evil.wav"


@pytest.mark.parametrize(
    "path",
    [
        "/api/songs/../pyproject.toml",
        "/api/songs/..%2Fpyproject.toml",
        "/api/songs/%2e%2e%2fpyproject.toml",
        "/api/songs/%2e%2e%2f%2e%2e%2fpyproject.toml",
        "/api/songs/..%2Fsecret.wav",
        "/api/songs/%2Fetc%2Fpasswd",
        "/api/songs//etc/passwd",
        "/api/songs/nested/dir.wav",
        "/api/songs/..%5Csecret.wav",
        "/api/songs/escape.wav",
        "/api/songs/.hidden.wav",
        "/api/spike/beats?song=../secret.wav",
        "/api/spike/beats?song=..%2Fsecret.wav",
        "/api/spike/beats?song=%2Fetc%2Fpasswd",
        "/api/spike/beats?song=/etc/passwd",
        "/api/spike/beats?song=nested/dir.wav",
        "/api/spike/beats?song=escape.wav",
        "/api/spike/beats?song=test_120bpm.wav%00.txt",
    ],
)
def test_traversal_is_never_served(client: TestClient, path: str) -> None:
    r = client.get(path)
    assert r.status_code in (400, 404), f"{path} -> {r.status_code}"
    assert b"[secret]" not in r.content
    assert not r.content.startswith(b"RIFF")


@pytest.mark.parametrize(
    "song",
    ["../secret.wav", "..\\secret.wav", "/etc/passwd", "/tmp/x.wav", "nested/dir.wav", ".hidden.wav"],
)
def test_bad_song_name_in_query_is_400(client: TestClient, song: str) -> None:
    r = client.get("/api/spike/beats", params={"song": song})
    assert r.status_code == 400
    assert isinstance(r.json()["detail"], str)


def test_dots_inside_a_name_are_not_traversal(client: TestClient) -> None:
    # "a..b.wav" is a legal file name; it is simply missing here.
    assert client.get("/api/spike/beats", params={"song": "a..b.wav"}).status_code == 404


def test_symlink_out_of_library_is_rejected(client: TestClient) -> None:
    assert client.get("/api/songs/escape.wav").status_code == 400
    assert "escape.wav" not in [s["file"] for s in client.get("/api/songs").json()]


def test_unknown_song_is_404(client: TestClient) -> None:
    assert client.get("/api/songs/nope.wav").status_code == 404
    r = client.get("/api/spike/beats", params={"song": "nope.wav"})
    assert r.status_code == 404
    assert isinstance(r.json()["detail"], str)


@pytest.mark.parametrize("name", ["notes.txt", "song.exe", "noext"])
def test_bad_extension_is_400(client: TestClient, name: str) -> None:
    assert client.get(f"/api/songs/{name}").status_code == 400
    assert client.get("/api/spike/beats", params={"song": name}).status_code == 400


def test_missing_query_param_is_400_with_string_detail(client: TestClient) -> None:
    r = client.get("/api/spike/beats")
    assert r.status_code == 400
    assert isinstance(r.json()["detail"], str) and "song" in r.json()["detail"]


def test_undecodable_library_song_is_400(client: TestClient) -> None:
    r = client.get("/api/spike/beats", params={"song": "broken.mp3"})
    assert r.status_code == 400
    assert "Supported formats" in r.json()["detail"]


def test_garbage_upload_is_400(client: TestClient) -> None:
    r = client.post("/api/spike/beats", files={"file": ("x.wav", b"this is not audio" * 200, "audio/wav")})
    assert r.status_code == 400
    assert "Could not decode" in r.json()["detail"]


def test_empty_upload_is_400(client: TestClient) -> None:
    r = client.post("/api/spike/beats", files={"file": ("x.wav", b"", "audio/wav")})
    assert r.status_code == 400
    assert "empty" in r.json()["detail"]


def test_upload_without_file_field_is_400(client: TestClient) -> None:
    r = client.post("/api/spike/beats", files={"other": ("x.wav", b"abc", "audio/wav")})
    assert r.status_code == 400
    assert isinstance(r.json()["detail"], str)


def test_oversized_upload_is_413(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()
    r = client.post("/api/spike/beats", files={"file": ("big.wav", b"\x00" * (2 * 1024 * 1024), "audio/wav")})
    assert r.status_code == 413
    assert "1 MB" in r.json()["detail"]


def test_upload_just_over_file_limit_is_413(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Body fits the middleware's multipart headroom, so the per-file check must catch it."""
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()
    r = client.post("/api/spike/beats", files={"file": ("big.wav", b"\x00" * (1024 * 1024 + 10), "audio/wav")})
    assert r.status_code == 413


def test_streamed_upload_without_content_length_is_413(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Chunked body (no Content-Length): the middleware must stop it while it streams in."""
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()

    def body() -> Iterator[bytes]:
        yield b'--xyz\r\nContent-Disposition: form-data; name="file"; filename="big.wav"\r\n\r\n'
        for _ in range(64):
            yield b"\x00" * (64 * 1024)
        yield b"\r\n--xyz--\r\n"

    r = client.post(
        "/api/spike/beats", content=body(), headers={"Content-Type": "multipart/form-data; boundary=xyz"}
    )
    assert r.status_code == 413
    assert "1 MB" in r.json()["detail"]


async def _count_body(scope: Scope, receive: Receive, send: Send) -> None:
    size = 0
    while True:
        message = await receive()
        size += len(message.get("body", b""))
        if not message.get("more_body"):
            break
    await PlainTextResponse(str(size))(scope, receive, send)


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (b"x" * 900, 200),
        (b"x" * 1500, 413),  # Content-Length check
        (iter([b"x" * 600, b"x" * 600]), 413),  # streamed, no Content-Length
        (iter([b"x" * 400, b"x" * 400]), 200),
    ],
)
def test_body_size_middleware(content: bytes | Iterator[bytes], expected: int) -> None:
    limited = TestClient(BodySizeLimitMiddleware(_count_body, max_bytes=lambda: 1000))
    r = limited.post("/", content=content)
    assert r.status_code == expected
    if expected == 413:
        assert r.json() == {"detail": f"Upload too large (limit {1000 / 1024 / 1024:g} MB)."}


def test_cors_preflight_allows_vite_origin(client: TestClient) -> None:
    r = client.options(
        "/api/spike/beats",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
