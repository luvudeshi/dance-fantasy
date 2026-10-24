"""Stage 1 HTTP API: /api/analyze, /api/songs/{file}/analysis, /api/analysis/{id}, /api/audio/{id}."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from helpers import SHARED_DIR, SHORT_LAYOUT, wav_bytes
from jsonschema import Draft202012Validator
from pydantic import BaseModel

from app.analysis import Analysis, AnalysisSection, AnalysisSource, OnsetEnvelope, song_from_analysis
from app.audio.analysis import ANALYSIS_VERSION
from app.config import get_settings
from app.main import app
from app.routine import Routine
from scripts.make_sample_song import render_song

SONG = "test_120bpm.wav"
SR = 22050
SCHEMA = json.loads((SHARED_DIR / "analysis.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA)
ROUTINE_VALIDATOR = Draft202012Validator(json.loads((SHARED_DIR / "routine.schema.json").read_text()))
SILENT_WAV = wav_bytes(np.zeros(2 * SR, dtype=np.float32), SR)


@pytest.fixture(scope="module")
def song_wav() -> bytes:
    y, sr, _ = render_song(120.0, seed=1, layout=SHORT_LAYOUT, sr=SR)
    return wav_bytes(y, sr)


@pytest.fixture
def assets_dir(tmp_path: Path, song_wav: bytes) -> Path:
    """A fresh assets dir (and so an empty cache) per test."""
    songs = tmp_path / "songs"
    songs.mkdir()
    (songs / SONG).write_bytes(song_wav)
    (songs / "test_120bpm.json").write_text(json.dumps({"title": "Test Song 120", "artist": "pytest"}))
    (songs / "no sidecar.wav").write_bytes(song_wav[:-2] + b"\x01\x00")  # different bytes, no artist
    (songs / "broken.mp3").write_bytes(b"\x00" * 2048)
    return tmp_path


@pytest.fixture
def client(assets_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("ASSETS_DIR", str(assets_dir))
    monkeypatch.delenv("MAX_UPLOAD_MB", raising=False)
    get_settings.cache_clear()
    yield TestClient(app)  # no `with`: skips the lifespan warmup thread
    get_settings.cache_clear()


def valid(body: dict) -> dict:
    errors = [e.message for e in VALIDATOR.iter_errors(body)]
    assert not errors, errors
    return body


def upload(client: TestClient, data: bytes, name: str = "my song.wav", **form: str) -> httpx.Response:
    return client.post("/api/analyze", files={"file": (name, data, "audio/wav")}, data=form or None)


@pytest.mark.parametrize(
    ("model", "node"),
    [
        (Analysis, SCHEMA),
        (AnalysisSection, SCHEMA["properties"]["sections"]["items"]),
        (AnalysisSource, SCHEMA["properties"]["source"]),
        (OnsetEnvelope, SCHEMA["properties"]["onsetEnvelope"]),
    ],
)
def test_models_match_schema(model: type[BaseModel], node: dict) -> None:
    assert set(model.model_fields) == set(node["properties"])
    assert {name for name, f in model.model_fields.items() if f.is_required()} == set(node["required"])


def test_library_song_analysis(client: TestClient, song_wav: bytes) -> None:
    r = client.get(f"/api/songs/{SONG}/analysis")
    assert r.status_code == 200, r.text
    body = valid(r.json())
    assert body["id"] == hashlib.sha256(song_wav).hexdigest()
    assert body["analysisVersion"] == ANALYSIS_VERSION
    assert (body["title"], body["artist"]) == ("Test Song 120", "pytest")
    assert body["source"] == {"kind": "library", "file": SONG}
    assert body["audioUrl"] == f"/api/songs/{SONG}"
    assert body["cached"] is False and body["elapsedMs"] > 0
    assert body["bpm"] == pytest.approx(120.0, rel=0.01)
    assert body["durationSec"] == pytest.approx(16.0, abs=0.01)
    assert body["sampleRate"] == SR and len(body["beats"]) >= 30


def test_library_song_without_sidecar(client: TestClient) -> None:
    r = client.get("/api/songs/no%20sidecar.wav/analysis")
    assert r.status_code == 200, r.text
    body = valid(r.json())
    assert body["title"] == "no sidecar" and "artist" not in body
    assert body["audioUrl"] == "/api/songs/no%20sidecar.wav"
    assert client.get(body["audioUrl"]).status_code == 200


def test_second_call_is_cached(client: TestClient, assets_dir: Path) -> None:
    first = client.get(f"/api/songs/{SONG}/analysis").json()
    second = client.get(f"/api/songs/{SONG}/analysis")
    assert second.status_code == 200
    body = valid(second.json())
    assert body["cached"] is True and body["elapsedMs"] < 50
    assert {**body, "cached": False, "elapsedMs": first["elapsedMs"]} == first
    cache_file = assets_dir / "cache" / "analysis" / f"{first['id']}.v{ANALYSIS_VERSION}.json"
    assert json.loads(cache_file.read_text())["beats"] == first["beats"]
    assert not [p for p in cache_file.parent.iterdir() if p.suffix == ".tmp"]  # no temp files left behind


def test_refresh_recomputes(client: TestClient) -> None:
    client.get(f"/api/songs/{SONG}/analysis")
    r = client.get(f"/api/songs/{SONG}/analysis", params={"refresh": "1"})
    assert r.status_code == 200
    assert r.json()["cached"] is False and r.json()["elapsedMs"] > 0
    r = upload(client, SILENT_WAV)
    r = client.post("/api/analyze?refresh=1", files={"file": ("x.wav", SILENT_WAV, "audio/wav")})
    assert r.status_code == 200 and r.json()["cached"] is False


def test_corrupt_cache_is_recomputed(client: TestClient, assets_dir: Path) -> None:
    first = client.get(f"/api/songs/{SONG}/analysis").json()
    cache_file = assets_dir / "cache" / "analysis" / f"{first['id']}.v{ANALYSIS_VERSION}.json"
    cache_file.write_text('{"truncated": ')
    r = client.get(f"/api/songs/{SONG}/analysis")
    assert r.status_code == 200 and r.json()["cached"] is False
    assert json.loads(cache_file.read_text())["id"] == first["id"]


def test_upload(client: TestClient, song_wav: bytes, assets_dir: Path) -> None:
    r = upload(client, song_wav, name="../../dir/My Song.WAV", title="  Midnight Mix ")
    assert r.status_code == 200, r.text
    body = valid(r.json())
    digest = hashlib.sha256(song_wav).hexdigest()
    assert body["id"] == digest and body["cached"] is False
    assert body["title"] == "Midnight Mix" and "artist" not in body
    assert body["source"] == {"kind": "upload", "file": "My Song.WAV"}
    assert body["audioUrl"] == f"/api/audio/{digest}"
    assert (assets_dir / "cache" / "audio" / f"{digest}.wav").read_bytes() == song_wav

    again = upload(client, song_wav, name="other name.wav")
    assert again.status_code == 200
    body2 = valid(again.json())
    assert body2["id"] == digest and body2["cached"] is True
    assert body2["title"] == "other name"  # title defaults to the file stem
    assert body2["beats"] == body["beats"]


def test_upload_of_a_library_song_shares_its_analysis_and_stores_audio(client: TestClient, song_wav: bytes) -> None:
    library = client.get(f"/api/songs/{SONG}/analysis").json()
    r = upload(client, song_wav)
    assert r.status_code == 200
    body = valid(r.json())
    assert body["id"] == library["id"] and body["cached"] is True
    assert body["source"]["kind"] == "upload" and body["audioUrl"] == f"/api/audio/{body['id']}"
    audio = client.get(body["audioUrl"])
    assert audio.status_code == 200 and audio.content == song_wav


def test_get_analysis_and_audio_by_id(client: TestClient, song_wav: bytes) -> None:
    uploaded = upload(client, song_wav, title="By Id").json()
    r = client.get(f"/api/analysis/{uploaded['id']}")
    assert r.status_code == 200
    body = valid(r.json())
    assert body["cached"] is True and body["title"] == "By Id"
    assert {**body, "cached": False, "elapsedMs": uploaded["elapsedMs"]} == uploaded

    audio = client.get(f"/api/audio/{uploaded['id']}")
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/wav" and audio.content == song_wav
    ranged = client.get(f"/api/audio/{uploaded['id']}", headers={"Range": "bytes=0-99"})
    assert ranged.status_code == 206 and ranged.content == song_wav[:100]


def test_unknown_id_is_404(client: TestClient) -> None:
    assert client.get(f"/api/analysis/{'0' * 64}").status_code == 404
    assert client.get(f"/api/audio/{'0' * 64}").status_code == 404
    library = client.get(f"/api/songs/{SONG}/analysis").json()  # analyzed, but never uploaded
    assert client.get(f"/api/audio/{library['id']}").status_code == 404


@pytest.mark.parametrize("bad", ["abc", "0" * 63, "0" * 65, "A" * 64, "g" * 64, "0" * 63 + "%2E"])
@pytest.mark.parametrize("route", ["/api/analysis/", "/api/audio/"])
def test_bad_id_is_400(client: TestClient, route: str, bad: str) -> None:
    r = client.get(route + bad)
    assert r.status_code == 400
    assert isinstance(r.json()["detail"], str)


def test_silent_upload_is_a_valid_empty_analysis(client: TestClient) -> None:
    r = upload(client, SILENT_WAV, name="quiet.wav")
    assert r.status_code == 200, r.text
    body = valid(r.json())
    assert body["beats"] == [] and body["bpm"] == 0
    section = {"start": 0.0, "end": 2.0, "label": "verse", "energy": 0.0, "group": "A"}
    assert body["sections"] == [{**section, "startBeat": 0, "endBeat": 0, "bars": 0}]


def test_bad_input_errors(client: TestClient, monkeypatch: pytest.MonkeyPatch, assets_dir: Path) -> None:
    assert upload(client, b"not audio at all" * 100, name="x.mp3").status_code == 400
    assert upload(client, b"", name="x.wav").status_code == 400
    assert client.post("/api/analyze").status_code == 400
    assert client.get("/api/songs/broken.mp3/analysis").status_code == 400
    assert client.get("/api/songs/nope.wav/analysis").status_code == 404
    assert client.get("/api/songs/notes.txt/analysis").status_code == 400
    assert not (assets_dir / "cache" / "audio").exists()  # undecodable uploads are not kept

    monkeypatch.setenv("MAX_UPLOAD_MB", "0.01")
    get_settings.cache_clear()
    assert upload(client, b"\x00" * 20_000).status_code == 413


def test_concurrent_requests_analyze_once(client: TestClient, song_wav: bytes) -> None:
    async def run() -> list[httpx.Response]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            return await asyncio.gather(
                *[c.get(f"/api/songs/{SONG}/analysis") for _ in range(3)],
                *[c.post("/api/analyze", files={"file": ("a.wav", song_wav, "audio/wav")}) for _ in range(2)],
            )

    responses = asyncio.run(run())
    assert all(r.status_code == 200 for r in responses)
    bodies = [valid(r.json()) for r in responses]
    assert [b["cached"] for b in bodies].count(False) == 1
    assert len({json.dumps(b["sections"]) for b in bodies}) == 1


def test_song_from_analysis_fits_a_routine(client: TestClient) -> None:
    body = client.get(f"/api/songs/{SONG}/analysis").json()
    song = song_from_analysis(Analysis.model_validate(body))
    assert (song.id, song.title, song.artist, song.bpm) == (body["id"], body["title"], body["artist"], body["bpm"])
    assert song.beats == body["beats"] and song.downbeats == body["downbeats"]
    assert [s.label for s in song.sections] == [s["label"] for s in body["sections"]]
    routine = Routine(song=song, difficulty="normal", mode="standing", seed=0, moves=[])
    ROUTINE_VALIDATOR.validate(routine.to_json_dict())

    silent = song_from_analysis(Analysis.model_validate(upload(client, SILENT_WAV).json()))
    ROUTINE_VALIDATOR.validate(Routine(song=silent, difficulty="easy", mode="seated", seed=1, moves=[]).to_json_dict())
