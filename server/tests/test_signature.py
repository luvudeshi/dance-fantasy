"""Signature dances (app.signature): table matching, SerpApi / Gemini parsing on saved payloads, fallbacks with
no keys, the signature move library, and pinned moves in the choreographer. No network."""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from aist_fixtures import clips_library
from choreo_fixtures import check_layout, fixture_library, make_analysis
from fastapi.testclient import TestClient
from helpers import SHARED_DIR
from jsonschema import Draft202012Validator

from app.analysis_store import AnalysisStore
from app.api.choreograph import get_move_library
from app.choreo import generate_routine
from app.config import get_settings
from app.main import app
from app.moves.library import MoveDefinitionError, load_library
from app.routine import Routine
from app.signature import lookup as lookup_mod
from app.signature import search as s
from app.signature.lookup import CACHE_TTL_SEC, lookup
from app.signature.moves import build_signature_library, load_signature_library
from app.signature.pins import PinnedMove, pinned_sections
from app.signature.table import TABLE, clean_title, match_table, normalize

FIXTURES = Path(__file__).parent / "fixtures" / "signature"
ROUTINE_VALIDATOR = Draft202012Validator(
    json.loads((SHARED_DIR / "routine.schema.json").read_text())
)
SIG = load_signature_library()
LIB = fixture_library()


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


def pin(move_id: str, placement: str = "chorus") -> PinnedMove:
    m = SIG.get(move_id)
    assert m is not None
    return PinnedMove(
        move=m.move, placement=placement, tag=m.tag(), version=SIG.version
    )


@pytest.fixture(autouse=True)
def _no_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SERPAPI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)


# ---- table -------------------------------------------------------------------------------------------------


def test_normalize_and_clean_title() -> None:
    assert normalize("Y.M.C.A.") == "ymca"
    assert normalize("Los del Río") == "los del rio"
    assert normalize("  Watch Me (Whip/Nae Nae) ") == "watch me whip nae nae"
    assert (
        clean_title("K CAMP - Lottery (Renegade) [Official Video].mp3")
        == "K CAMP - Lottery (Renegade)"
    )
    assert clean_title("Savage (feat. Beyoncé) (Lyrics).m4a") == "Savage"
    assert clean_title("Gangnam_Style.wav") == "Gangnam Style"


@pytest.mark.parametrize(
    ("title", "artist", "dance"),
    [
        ("Y.M.C.A.", "", "YMCA arms"),
        ("ymca", "", "YMCA arms"),
        ("YMCA.mp3", "Village People", "YMCA arms"),
        ("Lottery (Renegade)", "", "The Renegade"),
        ("Lottery", "K CAMP", "The Renegade"),
        ("Renegade", "", "The Renegade"),
        ("K CAMP - Lottery (Renegade) [Official Video].mp3", "", "The Renegade"),
        ("Savage", "Megan Thee Stallion", "the Savage dance"),
        ("macarena", "Los Del Rio", "Macarena"),
        ("PSY - GANGNAM STYLE (강남스타일) M/V", "", "the horse dance"),
        ("Crank That (Soulja Boy)", "", "Crank That"),
        ("Watch Me", "Silento", "the Whip and the Nae Nae"),
        ("Cha-Cha Slide", "", "the slides"),
    ],
)
def test_table_matches(title: str, artist: str, dance: str) -> None:
    entry = match_table(title, artist)
    assert entry is not None and entry.dance == dance


def test_table_rejects_other_songs_and_other_artists() -> None:
    assert match_table("Savage", "Some Other Band") is None
    assert match_table("Never Gonna Give You Up") is None
    assert match_table("") is None


def test_table_only_credits_listed_creators() -> None:
    creators = {e.title: e.creator for e in TABLE}
    assert creators == {
        "Lottery (Renegade)": "Jalaiah Harmon",
        "Savage": "Keara Wilson",
        "Macarena": "",
        "Y.M.C.A.": "",
        "Gangnam Style": "",
        "Crank That (Soulja Boy)": "",
        "Watch Me (Whip/Nae Nae)": "",
        "Cha Cha Slide": "",
    }


# ---- SerpApi / Gemini parsing ------------------------------------------------------------------------------


def test_google_and_youtube_hits_from_saved_payloads() -> None:
    g = s.google_hits(fixture("serpapi_google_lottery.json"))
    assert [h["url"] for h in g] == [
        "https://www.youtube.com/watch?v=EXAMPLE00001",
        "https://www.example-news.com/renegade-dance-creator",
        "https://www.tiktok.com/tag/renegade",
    ]
    assert [h["source"] for h in g] == ["YouTube", "Google", "TikTok"]
    y = s.youtube_hits(fixture("serpapi_youtube_lottery.json"))
    assert [h["url"] for h in y] == [
        "https://www.youtube.com/watch?v=EXAMPLE00002",
        "https://www.youtube.com/watch?v=EXAMPLE00001",
    ]
    assert (
        s.google_hits({"error": "Invalid API key"}) == [] and s.youtube_hits(None) == []
    )


def test_search_runs_four_queries_dedupes_and_never_leaks_the_key() -> None:
    urls: list[str] = []

    def fetch(url: str, timeout: float) -> object:
        urls.append(url)
        return fixture(
            "serpapi_youtube_lottery.json"
            if "engine=youtube" in url
            else "serpapi_google_lottery.json"
        )

    hits = s.search("Lottery (Renegade)", "secret-key", fetch=fetch)
    assert hits is not None
    assert len(urls) == 4 and all(
        u.startswith("https://serpapi.com/search.json?") for u in urls
    )
    assert (
        sum("engine=google" in u for u in urls) == 2
        and sum("TikTok+dance" in u for u in urls) == 2
    )
    links = [h["url"] for h in hits]
    assert len(links) == len(set(links)) == 4
    assert "secret-key" not in json.dumps(hits)


def test_search_fails_only_when_every_request_fails() -> None:
    def broken(url: str, timeout: float) -> object:
        raise OSError("offline")

    assert s.search("x", "k", fetch=broken) is None


def test_parse_gemini_validates_and_keeps_only_searched_links() -> None:
    allowed = {
        "https://www.youtube.com/watch?v=EXAMPLE00001",
        "https://www.youtube.com/watch?v=EXAMPLE00002",
    }
    out = s.parse_gemini(fixture("gemini_renegade.json"), allowed)
    assert out == {
        "danceName": "The Renegade",
        "creator": "Jalaiah Harmon",
        "year": 2019,
        "confidence": 0.93,
        "links": [
            "https://www.youtube.com/watch?v=EXAMPLE00002",
            "https://www.youtube.com/watch?v=EXAMPLE00001",
        ],
    }
    none = s.parse_gemini(fixture("gemini_none.json"), allowed)
    assert none is not None and none["danceName"] is None and none["links"] == []


def _gemini(text: str) -> dict[str, Any]:
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


def test_parse_gemini_rejects_garbage_and_low_confidence() -> None:
    assert s.parse_gemini({}, set()) is None
    assert s.parse_gemini(_gemini("I think it's the Renegade!"), set()) is None
    low = s.parse_gemini(
        _gemini('{"danceName": "Some Dance", "confidence": 0.1}'), set()
    )
    assert low is not None and low["danceName"] is None
    odd = s.parse_gemini(
        _gemini(
            '{"danceName": "X", "year": "2019", "confidence": 7, "creator": 5, "links": "nope"}'
        ),
        set(),
    )
    assert odd == {
        "danceName": "X",
        "creator": "",
        "year": None,
        "confidence": 1.0,
        "links": [],
    }


def test_gemini_extract_sends_text_only_with_a_5s_timeout() -> None:
    seen: dict[str, Any] = {}

    def post(
        url: str, body: dict[str, Any], headers: dict[str, str], timeout: float
    ) -> object:
        seen.update(url=url, body=body, headers=headers, timeout=timeout)
        return fixture("gemini_renegade.json")

    hits = s.youtube_hits(fixture("serpapi_youtube_lottery.json"))
    out = s.gemini_extract("Lottery (Renegade)", hits, "gkey", post=post)
    assert out is not None and out["danceName"] == "The Renegade"
    assert (
        seen["timeout"] == 5.0
        and seen["headers"]["x-goog-api-key"] == "gkey"
        and "gkey" not in seen["url"]
    )
    parts = seen["body"]["contents"][0]["parts"]
    assert (
        len(parts) == 1
        and set(parts[0]) == {"text"}
        and "Jalaiah Harmon does the Renegade" in parts[0]["text"]
    )

    def timeout(*args: Any) -> object:
        raise TimeoutError

    assert s.gemini_extract("x", hits, "gkey", post=timeout) is None


# ---- lookup ------------------------------------------------------------------------------------------------


def test_lookup_without_keys_uses_the_table(tmp_path: Path) -> None:
    out = lookup("Lottery (Renegade)", "", SIG, tmp_path)
    assert out["found"] and out["source"] == "table"
    assert (out["danceName"], out["creator"]) == ("The Renegade", "Jalaiah Harmon")
    assert (
        out["moveId"] is None
    )  # no signature move for the Renegade: "Learn the real dance" only
    assert [link["source"] for link in out["links"]] == ["YouTube", "TikTok"]
    assert all(link["url"].startswith("https://") for link in out["links"])

    ymca = lookup("Y.M.C.A.", "", SIG, tmp_path)
    assert (ymca["danceName"], ymca["creator"], ymca["moveId"]) == (
        "YMCA arms",
        "",
        "sig_ymca_arms",
    )

    unknown = lookup("Some Unknown Song", "", SIG, tmp_path)
    assert (
        not unknown["found"] and unknown["source"] == "none" and unknown["links"] == []
    )
    assert not (tmp_path / "signature").exists()  # nothing to cache without a search


def test_lookup_with_serpapi_and_gemini_is_cached_for_24h(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SERPAPI_API_KEY", "serp")
    monkeypatch.setenv("GEMINI_API_KEY", "gem")
    hits = s.google_hits(fixture("serpapi_google_lottery.json")) + s.youtube_hits(
        fixture("serpapi_youtube_lottery.json")
    )
    calls = {"search": 0, "gemini": 0}

    def fake_search(song: str, key: str) -> list[s.Hit]:
        calls["search"] += 1
        assert key == "serp"
        return hits

    def fake_gemini(song: str, h: list[s.Hit], key: str) -> s.Extracted | None:
        calls["gemini"] += 1
        return s.parse_gemini(
            _gemini('{"danceName": "The Floss", "confidence": 0.8, "year": 2016}'),
            set(),
        )

    monkeypatch.setattr(lookup_mod.s, "search", fake_search)
    monkeypatch.setattr(lookup_mod.s, "gemini_extract", fake_gemini)
    out = lookup("Swish Swish", "Katy Perry", SIG, tmp_path, now=1000.0, online_key="k1")
    assert (
        out["found"] and out["source"] == "gemini" and out["danceName"] == "The Floss"
    )
    assert out["creator"] == "" and out["moveId"] == "sig_floss"
    assert (
        lookup("Swish Swish", "Katy Perry", SIG, tmp_path, now=1000.0 + CACHE_TTL_SEC - 1, online_key="k1")
        == out
    )
    assert calls == {"search": 1, "gemini": 1}
    lookup("Swish Swish", "Katy Perry", SIG, tmp_path, now=1000.0 + CACHE_TTL_SEC + 1, online_key="k1")
    assert calls == {"search": 2, "gemini": 2}


def test_lookup_serpapi_only_returns_raw_links(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SERPAPI_API_KEY", "serp")
    hits = s.youtube_hits(fixture("serpapi_youtube_lottery.json"))
    monkeypatch.setattr(lookup_mod.s, "search", lambda song, key: hits)
    out = lookup("Some Song", "", SIG, tmp_path, now=0.0, online_key="k1")
    assert out["source"] == "serpapi" and not out["found"] and out["danceName"] is None
    assert [link["url"] for link in out["links"]] == [h["url"] for h in hits]
    table = lookup("Lottery (Renegade)", "", SIG, tmp_path, now=0.0, online_key="k1")  # table credit + real video links
    assert table["creator"] == "Jalaiah Harmon" and [
        link["url"] for link in table["links"]
    ] == [h["url"] for h in hits]


def test_lookup_survives_a_failed_search(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SERPAPI_API_KEY", "serp")
    monkeypatch.setattr(lookup_mod.s, "search", lambda song, key: None)
    out = lookup("Y.M.C.A.", "", SIG, tmp_path, online_key="k1")
    assert out["found"] and out["moveId"] == "sig_ymca_arms" and len(out["links"]) == 2


# ---- signature move library --------------------------------------------------------------------------------


def test_signature_moves_load_and_validate() -> None:
    ids = {m.move.id: m for m in SIG.moves}
    assert set(ids) == {
        "sig_ymca_arms",
        "sig_macarena",
        "sig_whip",
        "sig_horse_dance",
        "sig_floss",
    }
    for m in SIG.moves:
        assert (
            m.dance
            and m.move.lengthBeats in (4, 8)
            and m.move.upperBodyOnly
            and m.move.scoredJoints
        )
        assert len(m.move.keyframes) >= m.move.lengthBeats + 1
    assert SIG.for_song("Y.M.C.A.") is ids["sig_ymca_arms"]
    assert SIG.for_song("Macarena") is ids["sig_macarena"]
    assert SIG.for_song("Gangnam Style") is ids["sig_horse_dance"]
    assert SIG.for_song("Watch Me (Whip/Nae Nae)") is ids["sig_whip"]
    assert (
        SIG.for_dance("the floss") is ids["sig_floss"]
        and SIG.for_dance("Floss dance") is ids["sig_floss"]
    )
    assert SIG.for_dance("The Renegade") is None


def test_signature_moves_stay_out_of_the_main_library() -> None:
    assert not [m.id for m in load_library().moves if m.id.startswith("sig_")]


@pytest.mark.parametrize(
    ("patch", "error"),
    [
        ({"signatureDance": ""}, "signatureDance"),
        ({"songs": "Y.M.C.A."}, "songs"),
        ({"id": "ymca"}, "sig_"),
        ({"lengthBeats": 2}, "4 or 8"),
        ({"extra": 1}, "unknown fields"),
    ],
)
def test_bad_signature_moves_are_rejected(patch: dict[str, Any], error: str) -> None:
    doc = json.loads((SIG_DIR / "signature.json").read_text())
    doc["moves"] = [{**doc["moves"][0], **patch}]
    with pytest.raises(MoveDefinitionError, match=error):
        build_signature_library([("bad.json", json.dumps(doc).encode())])


SIG_DIR = Path(__file__).resolve().parents[2] / "assets" / "moves" / "signature"


# ---- pinned placement --------------------------------------------------------------------------------------

LAYOUT = (
    make_analysis()
)  # intro A, verse B, chorus C, verse B (short), chorus C, bridge D, outro E


def first_downbeats(routine: Routine, label: str) -> list[int]:
    out = []
    for row, sec in zip(routine.meta["sectionPlan"], LAYOUT.sections):
        if row["label"] == label and row["bars"]:
            out.append(
                sec.startBeat
                if sec.startBeat in DOWNS
                else min(d for d in DOWNS if d > sec.startBeat)
            )
    return out


DOWNS = [LAYOUT.beats.index(d) for d in LAYOUT.downbeats]


@pytest.mark.parametrize("difficulty", ["easy", "normal", "hard"])
@pytest.mark.parametrize("mode", ["standing", "seated"])
def test_pinned_move_on_every_chorus_downbeat(difficulty: str, mode: str) -> None:
    r = generate_routine(
        LAYOUT, LIB, difficulty, mode, seed=7, pinned=[pin("sig_ymca_arms")]
    )
    check_layout(r)
    assert not [e.message for e in ROUTINE_VALIDATOR.iter_errors(r.to_json_dict())]
    tagged = [(m.id, m.startBeat) for m in r.moves if m.signatureDance]
    assert tagged == [("sig_ymca_arms", b) for b in first_downbeats(r, "chorus")]
    assert all(b in DOWNS for _, b in tagged) and len(tagged) == 2
    assert (
        r.moves[[m.startBeat for m in r.moves].index(tagged[0][1])].signatureDance.name
        == "YMCA arms"
    )
    assert r.meta["pinnedMoves"] == [{"moveId": "sig_ymca_arms", "placement": "chorus"}]
    others = [m.id for m in r.moves if not m.signatureDance]
    assert (
        "sig_ymca_arms" not in others
    )  # the beam search never picks a signature move by itself


def test_routine_unchanged_without_pins() -> None:
    for seed in (0, 3, 11):
        base = generate_routine(LAYOUT, LIB, "normal", "standing", seed)
        assert (
            generate_routine(
                LAYOUT, LIB, "normal", "standing", seed, pinned=()
            ).to_json_dict()
            == base.to_json_dict()
        )
        assert (
            not any(m.signatureDance for m in base.moves)
            and "pinnedMoves" not in base.meta
        )
        assert "signatureDance" not in json.dumps(base.to_json_dict())


def test_pins_change_the_routine_id_and_only_the_pinned_sections() -> None:
    base = generate_routine(LAYOUT, LIB, "normal", "standing", 3)
    pinned = generate_routine(
        LAYOUT, LIB, "normal", "standing", 3, pinned=[pin("sig_whip")]
    )
    assert base.meta["routineId"] != pinned.meta["routineId"]
    for row_b, row_p in zip(base.meta["sectionPlan"], pinned.meta["sectionPlan"]):
        if (
            row_b["label"] != "chorus"
            and row_b["firstMove"] is not None
            and row_b["section"] < 2
        ):
            a = base.moves[row_b["firstMove"] : row_b["lastMove"] + 1]
            b = pinned.moves[row_p["firstMove"] : row_p["lastMove"] + 1]
            assert [m.id for m in a] == [
                m.id for m in b
            ]  # sections before the first chorus are untouched


def test_choruses_still_match_each_other_with_pins() -> None:
    r = generate_routine(
        LAYOUT, LIB, "hard", "standing", 1, pinned=[pin("sig_macarena")]
    )
    plans = [row for row in r.meta["sectionPlan"] if row["label"] == "chorus"]
    a, b = ([m.id for m in r.moves[p["firstMove"] : p["lastMove"] + 1]] for p in plans)
    assert a == b and a[0] == "sig_macarena"


def test_chorus_fallback_without_a_labeled_chorus() -> None:
    layout = [("intro", "A", 2, 0.2), ("verse", "B", 4, 0.5), ("bridge", "C", 4, 0.9), ("verse", "B", 4, 0.5), ("bridge", "C", 4, 0.9), ("outro", "D", 2, 0.1)]  # fmt: skip
    a = make_analysis(layout)
    r = generate_routine(
        a, LIB, "normal", "standing", 2, pinned=[pin("sig_horse_dance")]
    )
    check_layout(r)
    starts = [m.startBeat for m in r.moves if m.signatureDance]
    expected = [sec.startBeat for sec in a.sections if sec.group == "C"]
    assert starts == expected


def test_pinned_sections_rules() -> None:
    secs = [("intro", "A", 0.2, 2), ("verse", "B", 0.5, 4), ("verse", "B", 0.5, 4), ("bridge", "C", 0.95, 2), ("outro", "D", 0.1, 0)]  # fmt: skip
    assert pinned_sections(secs, "chorus") == [1, 2]  # highest-energy *repeated* group
    assert pinned_sections(secs, "drop") == [3]
    assert pinned_sections(secs, "finale") == [3]  # last section with bars
    assert pinned_sections(
        [("intro", "A", 0.3, 2), ("verse", "B", 0.6, 4)], "chorus"
    ) == [1]  # nothing repeats
    assert pinned_sections(
        [("chorus", "A", 0.1, 2), ("verse", "B", 0.9, 2), ("chorus", "A", 0.1, 2)],
        "chorus",
    ) == [0, 2]
    assert pinned_sections([("intro", "A", 0.3, 0)], "chorus") == []


def test_finale_and_two_pins_in_one_section() -> None:
    r = generate_routine(
        LAYOUT,
        LIB,
        "normal",
        "standing",
        4,
        pinned=[pin("sig_whip"), pin("sig_floss"), pin("sig_ymca_arms", "finale")],
    )
    check_layout(r)
    tagged = [(m.id, m.startBeat) for m in r.moves if m.signatureDance]
    c1, c2 = first_downbeats(r, "chorus")
    outro = LAYOUT.sections[-1].startBeat
    assert tagged == [
        ("sig_whip", c1),
        ("sig_floss", c1 + 4),
        ("sig_whip", c2),
        ("sig_floss", c2 + 4),
        ("sig_ymca_arms", outro),
    ]


# ---- HTTP --------------------------------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    cache = tmp_path / "cache"
    AnalysisStore(cache).save(LAYOUT.id, LAYOUT.to_json_dict())
    shutil.copytree(SIG_DIR, tmp_path / "moves" / "signature")
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))
    get_settings.cache_clear()
    app.dependency_overrides[get_move_library] = lambda: LIB
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_move_library, None)
        get_settings.cache_clear()


def test_lookup_endpoint(client: TestClient) -> None:
    r = client.get(
        "/api/signature/lookup",
        params={"title": "Y.M.C.A.", "artist": "Village People"},
    )
    assert r.status_code == 200 and r.json()["moveId"] == "sig_ymca_arms"
    assert client.get("/api/signature/lookup").status_code == 400
    assert (
        client.get("/api/signature/lookup", params={"title": "  "}).status_code == 400
    )
    moves = client.get("/api/signature/moves").json()
    assert {m["id"] for m in moves["moves"]} == {m.move.id for m in SIG.moves}
    assert all(m["signatureDance"] and "keyframes" in m for m in moves["moves"])


def test_choreograph_with_and_without_pins(client: TestClient) -> None:
    body = {
        "analysisId": LAYOUT.id,
        "difficulty": "normal",
        "mode": "standing",
        "seed": 9,
    }
    plain = client.post("/api/choreograph", json=body)
    assert plain.status_code == 200
    assert (
        plain.json()
        == generate_routine(LAYOUT, LIB, "normal", "standing", 9).to_json_dict()
    )
    pinned = client.post(
        "/api/choreograph",
        json={
            **body,
            "pinnedMoves": [{"moveId": "sig_ymca_arms", "placement": "chorus"}],
        },
    )
    assert pinned.status_code == 200 and pinned.headers["x-routine-cache"] == "miss"
    doc = pinned.json()
    assert not [e.message for e in ROUTINE_VALIDATOR.iter_errors(doc)]
    assert [m["signatureDance"] for m in doc["moves"] if "signatureDance" in m] == [
        {"name": "YMCA arms"}
    ] * 2
    again = client.post(
        "/api/choreograph",
        json={
            **body,
            "pinnedMoves": [{"moveId": "sig_ymca_arms", "placement": "chorus"}],
        },
    )
    assert again.headers["x-routine-cache"] == "hit" and again.content == pinned.content
    assert (
        client.post("/api/choreograph", json=body).content == plain.content
    )  # pins don't touch the plain cache
    bad = client.post(
        "/api/choreograph",
        json={**body, "pinnedMoves": [{"moveId": "arm_wave_L", "placement": "chorus"}]},
    )
    assert bad.status_code == 400
    bad = client.post(
        "/api/choreograph",
        json={**body, "pinnedMoves": [{"moveId": "sig_whip", "placement": "verse"}]},
    )
    assert bad.status_code == 400  # validation errors are 400 in this API


def test_choreograph_with_pins_and_a_move_source(client: TestClient) -> None:
    """Both request fields together: real-dancer clips around the pinned signature move, one cache entry per
    (move source, pins)."""
    clips = clips_library()
    app.dependency_overrides[get_move_library] = lambda: clips
    body = {
        "analysisId": LAYOUT.id,
        "seed": 2,
        "moveSource": "aist",
        "pinnedMoves": [{"moveId": "sig_whip", "placement": "chorus"}],
    }
    r = client.post("/api/choreograph", json=body)
    assert r.status_code == 200 and r.headers["x-routine-cache"] == "miss"
    doc = r.json()
    assert not [e.message for e in ROUTINE_VALIDATOR.iter_errors(doc)]
    assert doc["meta"]["moveSource"] == "aist" and doc["meta"]["pinnedMoves"] == body["pinnedMoves"]
    assert doc["meta"]["aistMoves"] > 0
    assert [m["id"] for m in doc["moves"] if "signatureDance" in m] == ["sig_whip"] * 2
    expected = generate_routine(LAYOUT, clips, "normal", "standing", 2, move_source="aist", pinned=[pin("sig_whip")])
    assert doc == expected.to_json_dict()
    ids = {doc["meta"]["routineId"]}
    for other in (
        {**body, "moveSource": "mix"},
        {**body, "moveSource": "classic"},
        {k: v for k, v in body.items() if k != "pinnedMoves"},
        {k: v for k, v in body.items() if k != "moveSource"},  # classic by default
    ):
        o = client.post("/api/choreograph", json=other)
        assert o.status_code == 200 and o.json()["meta"]["moveSource"] == other.get("moveSource", "classic")
        ids.add(o.json()["meta"]["routineId"])
    assert len(ids) == 4  # without moveSource = classic, the same routine as asking for classic
    again = client.post("/api/choreograph", json=body)
    assert again.headers["x-routine-cache"] == "hit" and again.content == r.content
    bad = client.post("/api/choreograph", json={**body, "moveSource": "robots"})
    assert bad.status_code == 400


def test_lookup_endpoint_online_only_for_known_songs(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.signature import router as sig_router

    monkeypatch.setenv("SERPAPI_API_KEY", "serp")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    asked: list[str] = []

    def fake_search(song: str, key: str) -> list[s.Hit]:
        asked.append(song)
        return []

    monkeypatch.setattr(lookup_mod.s, "search", fake_search)
    monkeypatch.setattr(sig_router, "_per_client", sig_router.defaultdict(sig_router.deque))
    # a typed title without a known song: table only, never a paid search
    r = client.get("/api/signature/lookup", params={"title": "Some Unknown Song"})
    assert r.status_code == 200 and r.json()["configured"] is True and asked == []
    # an unknown analysis id or library file: 404, nothing spent
    assert client.get("/api/signature/lookup", params={"analysisId": "d1" * 32}).status_code == 404
    assert client.get("/api/signature/lookup", params={"file": "nope.wav"}).status_code == 404
    assert client.get("/api/signature/lookup", params={"analysisId": "free text"}).status_code == 400
    ids = [f"{i:064x}" for i in range(1, sig_router.PER_CLIENT_PER_HOUR + 2)]
    store = AnalysisStore(get_settings().cache_dir)
    for i, aid in enumerate(ids):
        store.save(aid, {"id": aid, "title": f"Song {i}", "artist": "Band"})
    # a known song with a different typed title: still table only
    assert client.get("/api/signature/lookup", params={"analysisId": ids[0], "title": "Y.M.C.A."}).json()["moveId"] == "sig_ymca_arms"
    assert asked == []
    # the song's own title (from the analysis) is searched once, then cached per analysis
    for _ in range(2):
        assert client.get("/api/signature/lookup", params={"analysisId": ids[0]}).status_code == 200
    assert asked == ["Song 0 Band"]
    for aid in ids[1:-1]:
        assert client.get("/api/signature/lookup", params={"analysisId": aid}).status_code == 200
    capped = client.get("/api/signature/lookup", params={"analysisId": ids[-1]})
    assert capped.status_code == 429  # this client's hourly quota
    assert client.get("/api/signature/lookup", params={"analysisId": ids[0]}).status_code == 200  # cached: free


def test_lookup_daily_cap_and_concurrency(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.signature import router as sig_router

    monkeypatch.setenv("SERPAPI_API_KEY", "serp")
    monkeypatch.setattr(lookup_mod.s, "search", lambda song, key: [])
    monkeypatch.setattr(sig_router, "_per_client", sig_router.defaultdict(sig_router.deque))
    store = AnalysisStore(get_settings().cache_dir)
    store.save("b1" * 32, {"id": "b1" * 32, "title": "Other Song", "artist": ""})
    monkeypatch.setattr(sig_router, "DAILY_CAP", 0)
    r = client.get("/api/signature/lookup", params={"analysisId": "b1" * 32})
    assert r.status_code == 503 and "tomorrow" in r.json()["detail"]
    monkeypatch.setattr(sig_router, "DAILY_CAP", 150)
    held = [sig_router._slots.acquire(blocking=False) for _ in range(sig_router.MAX_CONCURRENT)]
    try:
        assert all(held)
        assert client.get("/api/signature/lookup", params={"analysisId": "b1" * 32}).status_code == 503
    finally:
        for _ in held:
            sig_router._slots.release()
    assert client.get("/api/signature/lookup", params={"analysisId": "b1" * 32}).status_code == 200
