"""GET /api/moves payload: AIST twins left out (hasMirror), ?source / ?mirrors, 3-decimal coordinates, gzip,
and the size budget (Vercel caps a function response at 4.5 MB). Uses the shipped library incl. the real clips."""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from aist_fixtures import REAL_CLIPS
from choreo_fixtures import make_analysis
from fastapi.testclient import TestClient
from helpers import REPO_ROOT

from app.analysis_store import AnalysisStore
from app.api.compress import accepts_gzip
from app.config import get_settings
from app.moves.library import load_library
from app.skeleton import JOINTS, MIRROR

LIB = load_library(REPO_ROOT / "assets" / "moves")
VERCEL_CAP = 4.5 * 1024 * 1024
pytestmark = pytest.mark.skipif(not REAL_CLIPS.exists(), reason="assets/moves/aist_clips.json not present")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("ASSETS_DIR", str(REPO_ROOT / "assets"))
    get_settings.cache_clear()
    from app.main import app

    yield TestClient(app)  # no lifespan: skips the beat-tracker warmup thread
    get_settings.cache_clear()


def listing(client: TestClient, **params: Any) -> list[dict[str, Any]]:
    res = client.get("/api/moves", params=params)
    assert res.status_code == 200, res.text
    return res.json()["moves"]


def is_twin(m: Any) -> bool:
    source, mirror_of = (m["source"], m["mirrorOf"]) if isinstance(m, dict) else (m.source, m.mirrorOf)
    return source == "aist" and mirror_of is not None


def twin_of(clip: dict[str, Any]) -> dict[str, Any]:
    """The mirrored twin of a listed clip, by the rule in shared/README.md (what a move browser would do)."""
    out = {k: v for k, v in clip.items() if k != "hasMirror"}
    out.update(
        id=clip["id"] + "_m",
        name=clip["name"] + " (mirrored)",
        mirrorOf=clip["id"],
        side={"L": "R", "R": "L"}.get(clip["side"], clip["side"]),
        scoredJoints=[j for j in JOINTS if MIRROR[j] in clip["scoredJoints"]],
        keyframes=[
            {
                "t": k["t"],
                "pose": {j: [-k["pose"][MIRROR[j]][0] + 0.0, k["pose"][MIRROR[j]][1]] for j in JOINTS},
                "root": [-k["root"][0] + 0.0, k["root"][1]],
            }
            for k in clip["keyframes"]
        ],
    )
    return out


def test_default_listing_leaves_out_the_clip_twins(client: TestClient) -> None:
    moves = listing(client)
    assert [m["id"] for m in moves] == [m.id for m in LIB.moves if not is_twin(m)]
    twins = {m.mirrorOf for m in LIB.moves if is_twin(m)}
    assert twins and {m["id"] for m in moves if m.get("hasMirror")} == twins
    assert all(m["hasMirror"] is True for m in moves if "hasMirror" in m)
    assert any(m["source"] == "library" and m["mirrorOf"] for m in moves)  # classic _L / _R variants stay
    assert len(moves) == len(LIB.moves) - len(twins)


def test_twins_rebuild_exactly_from_has_mirror(client: TestClient) -> None:
    every = {m["id"]: m for m in listing(client, mirrors=1)}
    assert [m.id for m in LIB.moves] == list(every)
    clips = [m for m in listing(client) if m.get("hasMirror")]
    for clip in clips:
        assert twin_of(clip) == every[clip["id"] + "_m"], clip["id"]
        assert clip == every[clip["id"]]


@pytest.mark.parametrize("source", ["classic", "library", "aist"])
@pytest.mark.parametrize("mirrors", [0, 1])
def test_source_filter(client: TestClient, source: str, mirrors: int) -> None:
    want = "aist" if source == "aist" else "library"
    moves = listing(client, source=source, mirrors=mirrors)
    expected = [m.id for m in LIB.moves if m.source == want and (mirrors or not is_twin(m))]
    assert [m["id"] for m in moves] == expected and expected


def test_bad_query_is_400(client: TestClient) -> None:
    res = client.get("/api/moves", params={"source": "robots"})
    assert res.status_code == 400 and "source" in res.json()["detail"]
    assert client.get("/api/moves", params={"mirrors": "maybe"}).status_code == 400


def test_coordinates_have_3_decimals_and_t_is_exact(client: TestClient) -> None:
    by_id = LIB.by_id()
    for m in listing(client, mirrors=1):
        compiled = by_id[m["id"]]
        assert [k["t"] for k in m["keyframes"]] == [k.t for k in compiled.keyframes], m["id"]
        for k, ck in zip(m["keyframes"], compiled.keyframes):
            coords = [c for p in k["pose"].values() for c in p] + k["root"]
            assert all(round(c, 3) == c for c in coords), m["id"]
            assert all(abs(k["pose"][j][a] - ck.pose[j][a]) <= 5e-4 + 1e-12 for j in JOINTS for a in (0, 1)), m["id"]


def test_payload_fits_the_vercel_cap(client: TestClient) -> None:
    sizes = {}
    for name, params in {"default": {}, "mirrors": {"mirrors": 1}, "aist": {"source": "aist"}}.items():
        raw = client.get("/api/moves", params=params, headers={"Accept-Encoding": "identity"})
        assert "content-encoding" not in raw.headers and raw.headers["vary"].startswith("Accept-Encoding")
        packed = client.get("/api/moves", params=params, headers={"Accept-Encoding": "gzip"})
        assert packed.headers["content-encoding"] == "gzip" and packed.json() == raw.json()
        sizes[name] = (len(raw.content), int(packed.headers["content-length"]))
    raw_default, gz_default = sizes["default"]
    assert raw_default < 3.0e6 and raw_default < 0.55 * sizes["mirrors"][0]  # the twins were half of it
    assert gz_default < 0.8e6
    assert all(gz < VERCEL_CAP / 4 for _, gz in sizes.values())  # what a browser gets, even with every twin
    assert raw_default < VERCEL_CAP * 0.7  # a client without gzip still fits with room to spare


@pytest.mark.parametrize(
    ("header", "ok"),
    [
        ("gzip", True),
        ("gzip, deflate, br", True),
        ("br;q=1.0, gzip;q=0.8, *;q=0.1", True),
        ("*", True),
        ("identity", False),
        ("", False),
        (None, False),
        ("gzip;q=0", False),
        ("gzip;q=0, *", False),
        ("deflate, *;q=0", False),
        ("gzip;q=nope", False),
    ],
)
def test_accepts_gzip(header: str | None, ok: bool) -> None:
    assert accepts_gzip(header) is ok


def test_routine_responses_are_gzipped(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assets = tmp_path / "assets"
    shutil.copytree(REPO_ROOT / "assets" / "moves", assets / "moves")
    analysis = make_analysis()
    AnalysisStore(assets / "cache").save(analysis.id, analysis.to_json_dict())
    monkeypatch.setenv("ASSETS_DIR", str(assets))
    get_settings.cache_clear()
    body = {"analysisId": analysis.id, "moveSource": "aist", "difficulty": "hard"}
    first = client.post("/api/choreograph", json=body, headers={"Accept-Encoding": "gzip"})
    assert first.status_code == 200, first.text
    assert first.headers["content-encoding"] == "gzip" and first.headers["x-routine-cache"] == "miss"
    assert first.json()["meta"]["aistMoves"] > 0
    stored = (assets / "cache" / "routines" / f"{first.json()['meta']['routineId']}.json").read_bytes()
    assert first.content == stored and int(first.headers["content-length"]) < len(stored) / 3
    rid = first.json()["meta"]["routineId"]
    plain = client.get(f"/api/routines/{rid}", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.content == stored
    again = client.post("/api/choreograph", json=body, headers={"Accept-Encoding": "gzip, deflate"})
    assert again.headers["content-encoding"] == "gzip" and again.headers["x-routine-cache"] == "hit"
    assert again.content == stored

