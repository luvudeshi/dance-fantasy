"""GET /api/songs/signature?analysisId= (or ?file= for a library song): the song's well-known dance /
TikTok challenge (SerpApi + LLM).

Paid lookups, so only for songs this server knows: the title and artist come from the song's analysis (or
the library's metadata), never from the caller. Google and YouTube results from SerpApi, read by the LLM
(app.ai), which summarizes the signature moves and maps them onto move ids that exist in the library.
Results are cached per analysis at ``<cache_dir>/signature/<analysisId>.v<N>.json`` (mirrored to Blob on
deployments, like every cache file); move ids are re-checked against the current library on every read.
At most MAX_CONCURRENT lookups run at once and DAILY_CAP a day.

404 for an unknown song, or when SERPAPI_API_KEY or every LLM key is missing and nothing is cached; 502 when
both searches fail; 503 when no model gives a usable answer, the lookups are busy or the day's cap is used.
No error is cached, so a retry can succeed.
"""

from __future__ import annotations

import datetime
import http.client
import json
import logging
import threading
import urllib.request
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from itertools import zip_longest
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.ai.prompts import (
    SIGNATURE_SYSTEM,
    Hit,
    clip,
    filter_move_ids,
    move_id_lookup,
    parse_signature,
    signature_user,
    tidy,
)
from app.ai.provider import AIUnavailable, configured, env, generate_text
from app.analysis_store import ID_RE, AnalysisStore, _atomic_write, read_cached, sha256_file
from app.api.choreograph import LibraryDep
from app.api.deps import song_path
from app.config import Settings, get_settings
from app.library import song_artist, song_title
from app.moves.types import CompiledMove

log = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])
SettingsDep = Annotated[Settings, Depends(get_settings)]

SERPAPI_URL = "https://serpapi.com/search.json"
SEARCH_TIMEOUT_SEC = 8.0
LLM_DEADLINE_SEC = 15.0
CACHE_VERSION = 2  # bump when the prompt or response shape changes, so old entries are re-fetched
PER_ENGINE = 6
MAX_HITS = 10  # sent to the model
MAX_SOURCES = 6  # returned to the page
NOT_FOUND = "We couldn't find a well-known dance for this song online."
MAX_CONCURRENT = 2  # SerpApi + LLM lookups in flight, per instance
DAILY_CAP = 150  # paid lookups a day (UTC), counted in the shared cache
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


class Source(BaseModel):
    title: str
    link: str
    thumbnail: str | None = None
    source: str


class KeyMoment(BaseModel):
    label: str
    approxTimeSec: float | None = None


class Signature(BaseModel):
    found: bool
    summary: str
    keyMoments: list[KeyMoment]
    suggestedMoveIds: list[str]
    sources: list[Source]


# ---- SerpApi -------------------------------------------------------------------------------------


def _hit(title: object, link: object, snippet: object, source: object, thumbnail: object) -> Hit | None:
    """A clean search hit, or None without a title or an http(s) link. Thumbnails must be https URLs."""
    url = link if isinstance(link, str) and urlsplit(link).scheme in ("http", "https") else ""
    name = clip(tidy(title), 160)
    if not url or not name:
        return None
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    thumb = thumbnail if isinstance(thumbnail, str) and thumbnail.startswith("https://") else None
    return Hit(title=name, link=url, snippet=clip(tidy(snippet), 400), source=clip(tidy(source), 40) or host, thumbnail=thumb)


def _rows(doc: object, key: str) -> list[dict[str, Any]]:
    rows = doc.get(key) if isinstance(doc, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def google_hits(doc: object) -> list[Hit]:
    """Hits from a SerpApi Google response: video carousels first, then organic results."""
    rows = _rows(doc, "inline_videos") + _rows(doc, "short_videos") + _rows(doc, "organic_results")
    hits = (_hit(r.get("title"), r.get("link"), r.get("snippet"), r.get("source") or r.get("platform"), r.get("thumbnail")) for r in rows)  # fmt: skip
    return [h for h in hits if h][:PER_ENGINE]


def youtube_hits(doc: object) -> list[Hit]:
    """Hits from a SerpApi YouTube response."""
    out: list[Hit] = []
    for r in _rows(doc, "video_results"):
        thumb = r.get("thumbnail")
        if isinstance(thumb, dict):
            thumb = thumb.get("static")
        if hit := _hit(r.get("title"), r.get("link"), r.get("description"), "YouTube", thumb):
            out.append(hit)
    return out[:PER_ENGINE]


def _serpapi(params: dict[str, str], key: str) -> object:
    # SerpApi takes the key as a query parameter; this URL is never logged.
    with urllib.request.urlopen(f"{SERPAPI_URL}?{urlencode({**params, 'api_key': key})}", timeout=SEARCH_TIMEOUT_SEC) as res:
        return json.loads(res.read())


def search(title: str, artist: str, key: str) -> list[Hit]:
    """Google + YouTube hits, interleaved and de-duplicated by link. 502 when both searches fail."""
    query = f"{title} {artist}".strip()
    jobs = (
        ({"engine": "google", "q": f"{query} dance tiktok challenge"}, google_hits),
        ({"engine": "youtube", "search_query": f"{query} dance"}, youtube_hits),
    )
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = [(pool.submit(_serpapi, params, key), parse) for params, parse in jobs]
    per_engine: list[list[Hit]] = []
    for future, parse in futures:
        try:
            per_engine.append(parse(future.result()))
        except (OSError, http.client.HTTPException, ValueError) as exc:  # network, HTTP status, bad JSON
            log.warning("signature.search ok=false error=%s", type(exc).__name__)
    if not per_engine:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "The song search failed; try again in a moment.")
    seen: set[str] = set()
    hits: list[Hit] = []
    for hit in (h for group in zip_longest(*per_engine) for h in group if h):
        if hit["link"] not in seen:
            seen.add(hit["link"])
            hits.append(hit)
    return hits


# ---- route ---------------------------------------------------------------------------------------


def _cache_path(cache_dir: Path, analysis_id: str) -> Path:
    return cache_dir / "signature" / f"{analysis_id}.v{CACHE_VERSION}.json"


def _song(settings: Settings, analysis_id: str | None, file: str | None) -> tuple[str, str, str]:
    """(analysis id, title, artist) of a known song: an analysis, or a library file. 404 for anything else."""
    fallback: tuple[str, str] | None = None
    if file is not None:
        path = song_path(settings.songs_dir, file)
        analysis_id = sha256_file(path)  # the id its analysis has (or will have)
        fallback = (song_title(path), song_artist(path) or "")
    if analysis_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pass analysisId (or file for a library song).")
    doc = AnalysisStore(settings.cache_dir).load(analysis_id)
    if doc is not None and isinstance(doc.get("title"), str):
        artist = doc.get("artist")
        return analysis_id, tidy(doc["title"]), tidy(artist) if isinstance(artist, str) else ""
    if fallback is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No analysis with that id.")
    return analysis_id, tidy(fallback[0]), tidy(fallback[1])


def _spend_daily_budget(cache_dir: Path) -> None:
    """Count one paid lookup against today's cap; 503 once it is used up.

    ponytail: read-modify-write of a cache file, so parallel instances can overshoot by a few; a DB
    counter if the cap has to be exact.
    """
    path = cache_dir / "signature" / f"budget-{datetime.datetime.now(datetime.UTC).date().isoformat()}.json"
    try:
        used = int(json.loads(read_cached(path)).get("n", 0))
    except FileNotFoundError:
        used = 0
    except (OSError, ValueError, AttributeError) as exc:
        log.warning("signature.budget unreadable error=%s", type(exc).__name__)
        used = 0
    if used >= DAILY_CAP:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Signature lookups are resting until tomorrow.")
    _atomic_write(path, json.dumps({"n": used + 1}).encode("utf-8"))


def _load(path: Path) -> Signature | None:
    try:
        return Signature.model_validate_json(read_cached(path))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:  # pydantic.ValidationError is a ValueError
        log.warning("ignoring unreadable signature cache %s: %s", path.name, type(exc).__name__)
        return None


# Registered before the songs router: otherwise GET /songs/{file} would claim "signature" as a file name.
@router.get("/songs/signature", response_model_exclude_none=True)
def get_signature(
    settings: SettingsDep,
    library: LibraryDep,
    analysis_id: Annotated[str | None, Query(alias="analysisId", pattern=ID_RE.pattern)] = None,
    file: Annotated[str | None, Query(max_length=200)] = None,
) -> Signature:
    """The song's signature dance: summary, key moments, matching move ids and the pages it came from."""
    analysis_id, title, artist = _song(settings, analysis_id, file)
    if not title:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This song has no title to look up.")
    lookup = move_id_lookup(library.moves)
    path = _cache_path(settings.cache_dir, analysis_id)
    cached = _load(path)
    if cached is not None:
        return cached.model_copy(update={"suggestedMoveIds": filter_move_ids(cached.suggestedMoveIds, lookup)})

    serp_key = env("SERPAPI_API_KEY")
    if not serp_key or not configured():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Signature dances need SERPAPI_API_KEY and MUSE_API_KEY or GEMINI_API_KEY on the server.",
        )
    if not _slots.acquire(blocking=False):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The scribes are busy; try again in a moment.", {"Retry-After": "5"}
        )
    try:
        cached = _load(path)  # a lookup that just finished may have cached this song
        if cached is not None:
            return cached.model_copy(update={"suggestedMoveIds": filter_move_ids(cached.suggestedMoveIds, lookup)})
        _spend_daily_budget(settings.cache_dir)
        result = _look_up(title, artist, serp_key, library.moves, lookup)
        _atomic_write(path, result.model_dump_json(exclude_none=True).encode("utf-8"))
        return result
    finally:
        _slots.release()


def _look_up(title: str, artist: str, serp_key: str, moves: Sequence[CompiledMove], lookup: dict[str, str]) -> Signature:
    """SerpApi + LLM: the paid part."""
    hits = search(title, artist, serp_key)
    if not hits:
        result = Signature(found=False, summary=NOT_FOUND, keyMoments=[], suggestedMoveIds=[], sources=[])
    else:
        user = signature_user(title, artist, hits[:MAX_HITS], moves)
        try:
            raw, _ = generate_text(SIGNATURE_SYSTEM, user, deadline_sec=LLM_DEADLINE_SEC, json_mode=True, temperature=0.3)
            parsed = parse_signature(raw, lookup)
        except AIUnavailable:
            parsed = None
        if parsed is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The AI couldn't read the results; try again.")
        if not parsed["summary"]:
            parsed["summary"] = NOT_FOUND
        sources = [Source(title=h["title"], link=h["link"], thumbnail=h["thumbnail"], source=h["source"]) for h in hits[:MAX_SOURCES]]
        result = Signature.model_validate({**parsed, "sources": sources})
    return result
