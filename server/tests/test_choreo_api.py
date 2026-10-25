"""Stage 2 HTTP API: POST /api/choreograph and GET /api/routines/{routineId} (fixture move library)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from choreo_fixtures import check_layout, fixture_library, make_analysis
from fastapi.testclient import TestClient
from helpers import SHARED_DIR
from jsonschema import Draft202012Validator

from app.analysis_store import AnalysisStore
from app.api.choreograph import get_move_library
from app.config import get_settings
from app.main import app
from app.routine import Routine

ROUTINE_VALIDATOR = Draft202012Validator(json.loads((SHARED_DIR / "routine.schema.json").read_text()))
ANALYSIS = make_analysis()
LIB = fixture_library()


@pytest.fixture
def cache_dir(tmp_path: Path) -> Path:
    cache = tmp_path / "cache"
    AnalysisStore(cache).save(ANALYSIS.id, ANALYSIS.to_json_dict())
    return cache


@pytest.fixture
def client(cache_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("ASSETS_DIR", str(cache_dir.parent))
    get_settings.cache_clear()
    app.dependency_overrides[get_move_library] = lambda: LIB
    try:
        yield TestClient(app)  # no `with`: skips the lifespan warmup thread
    finally:
        app.dependency_overrides.pop(get_move_library, None)
        get_settings.cache_clear()


def test_choreograph_then_cache_hit_and_get(client: TestClient, cache_dir: Path) -> None:
    body = {"analysisId": ANALYSIS.id, "difficulty": "hard", "mode": "seated", "seed": 5}
    first = client.post("/api/choreograph", json=body)
    assert first.status_code == 200, first.text
    assert first.headers["content-type"] == "application/json"
    assert first.headers["x-routine-cache"] == "miss"
    doc = first.json()
    assert not [e.message for e in ROUTINE_VALIDATOR.iter_errors(doc)]
    routine = Routine.model_validate(doc)
    check_layout(routine)
    assert (routine.difficulty, routine.mode, routine.seed) == ("hard", "seated", 5)
    rid = doc["meta"]["routineId"]
    assert (cache_dir / "routines" / f"{rid}.json").read_bytes() == first.content

    second = client.post("/api/choreograph", json=body)
    assert second.status_code == 200 and second.headers["x-routine-cache"] == "hit"
    assert second.content == first.content

    got = client.get(f"/api/routines/{rid}")
    assert got.status_code == 200 and got.content == first.content


def test_defaults_and_new_seed(client: TestClient) -> None:
    doc = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id}).json()
    assert (doc["difficulty"], doc["mode"], doc["seed"]) == ("normal", "standing", 0)
    other = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id, "seed": 1}).json()
    assert other["meta"]["routineId"] != doc["meta"]["routineId"]
    assert [m["id"] for m in other["moves"]] != [m["id"] for m in doc["moves"]]


def test_unreadable_routine_cache_is_regenerated(client: TestClient, cache_dir: Path) -> None:
    first = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id})
    path = cache_dir / "routines" / f"{first.json()['meta']['routineId']}.json"
    path.write_text("{truncated")
    again = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id})
    assert again.status_code == 200 and again.headers["x-routine-cache"] == "miss"
    assert again.content == first.content and path.read_bytes() == first.content


def test_unknown_analysis_is_404(client: TestClient) -> None:
    r = client.post("/api/choreograph", json={"analysisId": "0" * 64})
    assert r.status_code == 404
    assert "analyze the song first" in r.json()["detail"]
    assert client.get("/api/routines/0123456789abcdef").status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"analysisId": "xyz"},
        {"analysisId": "AB" * 32},
        {"analysisId": "ab" * 31},
        {"analysisId": "ab" * 32, "difficulty": "insane"},
        {"analysisId": "ab" * 32, "mode": "lying"},
        {"analysisId": "ab" * 32, "seed": "1"},
        {"analysisId": "ab" * 32, "seed": 1.5},
        {"analysisId": "ab" * 32, "seed": True},
        {"analysisId": "ab" * 32, "seed": 2**60},
        {"analysisId": "ab" * 32, "extra": 1},
        {"analysisId": "ab" * 32, "moveSource": "robots"},
        {"analysisId": "ab" * 32, "moveSource": "AIST"},
        {"analysisId": "ab" * 32, "moveSource": None},
        {"analysisId": "ab" * 32, "moveSource": 1},
    ],
)
def test_bad_requests_are_400(client: TestClient, body: dict) -> None:
    r = client.post("/api/choreograph", json=body)
    assert r.status_code == 400, r.text
    assert isinstance(r.json()["detail"], str)


@pytest.mark.parametrize("rid", ["xyz", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0"])
def test_bad_routine_ids_are_400(client: TestClient, rid: str) -> None:
    assert client.get(f"/api/routines/{rid}").status_code == 400


def test_no_eligible_moves_is_400(client: TestClient) -> None:
    legs_only = fixture_library(without=[m.baseId for m in LIB.moves if m.upperBodyOnly])
    app.dependency_overrides[get_move_library] = lambda: legs_only
    r = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id, "mode": "seated"})
    assert r.status_code == 400 and "seated" in r.json()["detail"]


def test_empty_move_library_is_503(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.moves.library as library_module
    from app.moves.types import MoveLibrary

    app.dependency_overrides.pop(get_move_library, None)
    monkeypatch.setattr(library_module, "load_library", lambda: MoveLibrary(moves=(), version="empty"))
    r = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id})
    assert r.status_code == 503 and "empty" in r.json()["detail"]


def test_invalid_move_library_is_500_with_reason(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: a broken move file used to surface as a bare 'Internal Server Error' here."""
    import app.moves.library as library_module

    def broken() -> None:
        raise library_module.MoveDefinitionError("arms.json 'wave': keyframes must be a list")

    app.dependency_overrides.pop(get_move_library, None)
    monkeypatch.setattr(library_module, "load_library", broken)
    r = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id})
    assert r.status_code == 500 and "arms.json" in r.json()["detail"]


def test_move_sources(client: TestClient) -> None:
    """moveSource picks classic / real-dancer clips / both; it is part of the routine id and the meta."""
    from aist_fixtures import clips_library

    clips = clips_library()
    app.dependency_overrides[get_move_library] = lambda: clips
    docs = {}
    for source in ("classic", "aist", "mix"):
        r = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id, "seed": 3, "moveSource": source})
        assert r.status_code == 200 and r.headers["x-routine-cache"] == "miss", r.text
        docs[source] = r.json()
        assert not [e.message for e in ROUTINE_VALIDATOR.iter_errors(docs[source])]
        assert docs[source]["meta"]["moveSource"] == source
    assert len({d["meta"]["routineId"] for d in docs.values()}) == 3
    assert docs["classic"]["meta"]["aistMoves"] == 0 and docs["aist"]["meta"]["aistMoves"] > 0
    assert "AIST++" in docs["aist"]["meta"]["credit"]
    default = client.post("/api/choreograph", json={"analysisId": ANALYSIS.id, "seed": 3})
    assert default.headers["x-routine-cache"] == "hit" and default.content == client.post(
        "/api/choreograph", json={"analysisId": ANALYSIS.id, "seed": 3, "moveSource": "classic"}
    ).content
