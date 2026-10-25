"""Song -> signature dance: bundled table, then SerpApi (+ Gemini when its key is set). Cached on disk for 24 h.

Videos are returned as links only; nothing is ever downloaded.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

from app.signature import search as s
from app.signature.moves import SignatureLibrary
from app.signature.table import clean_title, find_dance, match_table

log = logging.getLogger(__name__)

CACHE_TTL_SEC = 24 * 3600
CACHE_VERSION = 1


def _search_links(song: str) -> list[dict[str, str]]:
    """Plain search pages (no key needed): always valid, never a guessed video URL."""
    q = quote_plus(f"{song} dance")
    return [
        {
            "title": f"Search YouTube for “{song} dance”",
            "url": f"https://www.youtube.com/results?search_query={q}",
            "source": "YouTube",
        },
        {
            "title": f"Search TikTok for “{song} dance”",
            "url": f"https://www.tiktok.com/search?q={q}",
            "source": "TikTok",
        },
    ]


def _video_links(
    hits: list[s.Hit], only: list[str] | None = None
) -> list[dict[str, str]]:
    chosen = [h for h in hits if only is None or h["url"] in only]
    if only:
        chosen.sort(key=lambda h: only.index(h["url"]))
    return [
        {"title": h["title"], "url": h["url"], "source": h["source"]}
        for h in chosen[: s.MAX_LINKS]
    ]


def _cache_path(cache_dir: Path, song: str) -> Path:
    digest = hashlib.sha256(f"{CACHE_VERSION}\n{song.casefold()}".encode()).hexdigest()
    return cache_dir / "signature" / f"lookup-{digest[:32]}.json"


def _cache_get(path: Path, now: float) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if (
        not isinstance(doc, dict)
        or not isinstance(doc.get("savedAt"), (int, float))
        or now - doc["savedAt"] > CACHE_TTL_SEC
    ):
        return None
    return doc.get("data") if isinstance(doc.get("data"), dict) else None


def _cache_put(path: Path, data: dict[str, Any], now: float) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"savedAt": now, "data": data}))
        tmp.replace(path)
    except OSError as exc:  # read-only disk: still answer
        log.warning("signature.cache write failed: %s", type(exc).__name__)


def _online(
    song: str, cache_dir: Path, serp_key: str, gemini_key: str, now: float
) -> dict[str, Any] | None:
    """{hits, extracted} from SerpApi (+ Gemini), cached 24 h. None when the search failed (not cached)."""
    path = _cache_path(cache_dir, f"{song}\n{'gemini' if gemini_key else 'serp'}")
    cached = _cache_get(path, now)
    if cached is not None:
        return cached
    hits = s.search(song, serp_key)
    if hits is None:
        return None
    extracted = (
        s.gemini_extract(song, hits, gemini_key) if gemini_key and hits else None
    )
    data = {"hits": hits, "extracted": extracted, "gemini": bool(gemini_key)}
    if (
        not gemini_key or extracted is not None
    ):  # a failed Gemini call is retried next time
        _cache_put(path, data, now)
    return data


def lookup(
    title: str,
    artist: str,
    library: SignatureLibrary,
    cache_dir: Path,
    now: float | None = None,
) -> dict[str, Any]:
    """The /api/signature/lookup response (shared/README.md "Signature dances")."""
    now = time.time() if now is None else now
    song = clean_title(title)
    query = (
        f"{song} {artist}".strip()
        if artist and artist.casefold() not in song.casefold()
        else song
    )
    serp_key, gemini_key = s.env_key("SERPAPI_API_KEY"), s.env_key("GEMINI_API_KEY")
    out: dict[str, Any] = {
        "title": song,
        "artist": artist,
        "found": False,
        "danceName": None,
        "creator": "",
        "year": None,
        "confidence": None,
        "links": [],
        "source": "none",
        "moveId": None,
        "moveName": None,
    }

    entry = match_table(title, artist)
    online = _online(query, cache_dir, serp_key, gemini_key, now) if serp_key else None
    hits: list[s.Hit] = online["hits"] if online else []

    if entry is not None:
        out.update(
            found=True,
            danceName=entry.dance,
            creator=entry.creator,
            confidence=1.0,
            source="table",
        )
        out["links"] = _video_links(hits) or _search_links(entry.title)
    elif online is not None:
        ex = online.get("extracted")
        if ex and ex.get("danceName"):
            known = find_dance(ex["danceName"])
            out.update(
                found=True,
                danceName=ex["danceName"],
                creator=ex.get("creator") or (known.creator if known else ""),
                year=ex.get("year"),
                confidence=ex.get("confidence"),
                source="gemini",
            )
            out["links"] = _video_links(hits, ex.get("links") or None)
        elif ex is not None:  # Gemini: no well-known dance
            out.update(source="gemini", confidence=ex.get("confidence"))
        else:  # no Gemini: the raw SerpApi links, no dance name
            out.update(source="serpapi")
            out["links"] = _video_links(hits)

    move = (library.for_song(title) if entry is not None else None) or (
        library.for_dance(out["danceName"]) if out["danceName"] else None
    )
    if move is not None:
        out.update(moveId=move.move.id, moveName=move.move.name)
        if not out["found"]:  # the song is in a signature move's song list
            out.update(
                found=True, danceName=move.dance, creator=move.creator, source="library"
            )
    return out
