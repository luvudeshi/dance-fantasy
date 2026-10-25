"""GET /api/songs/signature?title=&artist=: the song's well-known dance / TikTok challenge (SerpApi + LLM).

Google and YouTube results from SerpApi, read by the LLM (app.ai), which summarizes the signature moves and
maps them onto move ids that exist in the library. Results are cached by title + artist at
``<cache_dir>/signature/<sha256>.json`` (mirrored to Blob on deployments, like every cache file); move ids
are re-checked against the current library on every read. 404 when SERPAPI_API_KEY or every LLM key is
missing and nothing is cached; 502 when both searches fail; 503 when no model gives a usable answer.
Neither error is cached, so a retry can succeed.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import logging
import threading
import time
import urllib.request
from collections import deque
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
from app.analysis_store import _atomic_write, read_cached
from app.api.choreograph import LibraryDep
from app.config import Settings, get_settings

log = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])
SettingsDep = Annotated[Settings, Depends(get_settings)]

SERPAPI_URL = "https://serpapi.com/search.json"
SEARCH_TIMEOUT_SEC = 8.0
LLM_DEADLINE_SEC = 15.0
CACHE_VERSION = 1  # bump when the prompt or response shape changes, so old entries are re-fetched
PER_ENGINE = 6
MAX_HITS = 10  # sent to the model
MAX_SOURCES = 6  # returned to the page
NOT_FOUND = "We couldn't find a well-known dance for this song online."
# The endpoint is public: cap the paid lookups (2 SerpApi searches + 1 model call each) so a script varying `title`
# can't drain the monthly search quota. Cached songs don't count.
# ponytail: per instance, in memory; a Vercel Firewall rate limit or a shared counter if it is abused anyway.
FRESH_PER_HOUR = 40
_fresh: deque[float] = deque()
_fresh_lock = threading.Lock()


def spend_lookup(now: float | None = None) -> None:
    """Counts one paid lookup; 429 once FRESH_PER_HOUR were spent on this instance in the last hour."""
    t = time.monotonic() if now is None else now
    with _fresh_lock:
        while _fresh and t - _fresh[0] >= 3600:
            _fresh.popleft()
        if len(_fresh) >= FRESH_PER_HOUR:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many new songs looked up this hour; try again later.")
        _fresh.append(t)


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


def _cache_path(cache_dir: Path, title: str, artist: str) -> Path:
    key = f"{CACHE_VERSION}\n{title.casefold()}\n{artist.casefold()}"
    return cache_dir / "signature" / f"{hashlib.sha256(key.encode('utf-8')).hexdigest()}.json"


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
    title: Annotated[str, Query(min_length=1, max_length=200)],
    settings: SettingsDep,
    library: LibraryDep,
    artist: Annotated[str, Query(max_length=200)] = "",
) -> Signature:
    """The song's signature dance: summary, key moments, matching move ids and the pages it came from."""
    title, artist = tidy(title), tidy(artist)
    if not title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title must not be blank.")
    lookup = move_id_lookup(library.moves)
    path = _cache_path(settings.cache_dir, title, artist)
    cached = _load(path)
    if cached is not None:
        return cached.model_copy(update={"suggestedMoveIds": filter_move_ids(cached.suggestedMoveIds, lookup)})

    serp_key = env("SERPAPI_API_KEY")
    if not serp_key or not configured():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Signature dances need SERPAPI_API_KEY and MUSE_API_KEY or GEMINI_API_KEY on the server.",
        )
    spend_lookup()
    hits = search(title, artist, serp_key)
    if not hits:
        result = Signature(found=False, summary=NOT_FOUND, keyMoments=[], suggestedMoveIds=[], sources=[])
    else:
        user = signature_user(title, artist, hits[:MAX_HITS], library.moves)
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
    _atomic_write(path, result.model_dump_json(exclude_none=True).encode("utf-8"))
    return result
