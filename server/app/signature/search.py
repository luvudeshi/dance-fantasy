"""SerpApi (Google + YouTube) search and Gemini extraction. Standard library HTTP only (urllib).

Keys come only from the environment (SERPAPI_API_KEY, GEMINI_API_KEY) and are never logged or returned.
Parsing is pure (``*_hits``, ``parse_gemini``) so it is tested on saved payloads in tests/fixtures/signature/.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, NotRequired, TypedDict
from urllib.parse import urlencode, urlsplit

log = logging.getLogger(__name__)

SERPAPI_URL = "https://serpapi.com/search.json"
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
SEARCH_TIMEOUT_SEC = 8.0
GEMINI_TIMEOUT_SEC = 5.0
PER_ENGINE = 5
MAX_LINKS = 6
MIN_CONFIDENCE = 0.4  # below this a Gemini answer counts as "no well-known dance"


class Hit(TypedDict):
    title: str
    url: str
    snippet: str
    source: str  # "YouTube", "TikTok", "Google"
    thumbnail: NotRequired[str]  # https only


def env_key(name: str) -> str:
    return os.environ.get(name, "").strip()


def _text(v: object, limit: int) -> str:
    return " ".join(v.split())[:limit] if isinstance(v, str) else ""


def _hit(title: object, url: object, snippet: object, source: str, thumbnail: object = None) -> Hit | None:
    if (
        not isinstance(url, str)
        or urlsplit(url).scheme != "https"
        or not urlsplit(url).hostname
    ):
        return None
    name = _text(title, 160)
    if not name:
        return None
    host = (urlsplit(url).hostname or "").removeprefix("www.").removeprefix("m.")
    site = (
        "YouTube"
        if "youtube.com" in host or host == "youtu.be"
        else "TikTok"
        if "tiktok.com" in host
        else source
    )
    hit = Hit(title=name, url=url, snippet=_text(snippet, 300), source=site)
    if isinstance(thumbnail, dict):  # YouTube: {"static": url, "rich": url}
        thumbnail = thumbnail.get("static")
    if isinstance(thumbnail, str) and thumbnail.startswith("https://"):
        hit["thumbnail"] = thumbnail[:500]
    return hit


def _rows(doc: object, key: str) -> list[dict[str, Any]]:
    rows = doc.get(key) if isinstance(doc, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def google_hits(doc: object) -> list[Hit]:
    """SerpApi engine=google: video carousels first (inline_videos, short_videos), then organic_results."""
    rows = (
        _rows(doc, "inline_videos")
        + _rows(doc, "short_videos")
        + _rows(doc, "organic_results")
    )
    hits = (
        _hit(r.get("title"), r.get("link"), r.get("snippet"), "Google", r.get("thumbnail")) for r in rows
    )
    return [h for h in hits if h][:PER_ENGINE]


def youtube_hits(doc: object) -> list[Hit]:
    """SerpApi engine=youtube: video_results."""
    hits = (
        _hit(r.get("title"), r.get("link"), r.get("description"), "YouTube", r.get("thumbnail"))
        for r in _rows(doc, "video_results")
    )
    return [h for h in hits if h][:PER_ENGINE]


def _get_json(url: str, timeout: float) -> object:
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return json.loads(res.read())


def serpapi_queries(song: str) -> list[tuple[dict[str, str], Any]]:
    """Google and YouTube, each for "<song> dance" and "<song> TikTok dance"."""
    out: list[tuple[dict[str, str], Any]] = []
    for q in (f"{song} dance", f"{song} TikTok dance"):
        out.append(({"engine": "google", "q": q}, google_hits))
        out.append(({"engine": "youtube", "search_query": q}, youtube_hits))
    return out


def search(song: str, key: str, fetch: Any = _get_json) -> list[Hit] | None:
    """De-duplicated hits from every query, interleaved; None when every request failed."""
    jobs = serpapi_queries(song)

    def run(params: dict[str, str]) -> object:
        # The key is a query parameter (SerpApi's API); this URL is never logged.
        return fetch(
            f"{SERPAPI_URL}?{urlencode({**params, 'api_key': key})}", SEARCH_TIMEOUT_SEC
        )

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = [(pool.submit(run, params), parse) for params, parse in jobs]
    groups: list[list[Hit]] = []
    for future, parse in futures:
        try:
            groups.append(parse(future.result()))
        except (
            OSError,
            ValueError,
            http.client.HTTPException,
        ) as exc:  # network, HTTP status, bad JSON: one engine failing is fine
            log.warning("signature.serpapi ok=false error=%s", type(exc).__name__)
    if not groups:
        return None
    seen: set[str] = set()
    hits: list[Hit] = []
    for i in range(max(map(len, groups), default=0)):
        for g in groups:
            if i < len(g) and g[i]["url"] not in seen:
                seen.add(g[i]["url"])
                hits.append(g[i])
    return hits


# ---- Gemini ------------------------------------------------------------------------------------------------

GEMINI_PROMPT = """You identify famous viral or signature dances for songs. Below are web and video search results \
(titles and snippets only) for the song "{song}". Decide whether the song has a well-known signature dance \
(for example the Renegade for "Lottery" by K CAMP). Answer with JSON only, exactly this shape:
{{"danceName": string or null, "creator": string or null, "year": integer or null, "confidence": number 0-1, \
"links": [urls copied from the results that show the dance]}}
Use {{"danceName": null}} when there is no well-known signature dance. Only name a creator when the results \
credit a specific person; never guess. Copy links exactly from the results.

Results:
{results}"""


def gemini_prompt(song: str, hits: list[Hit]) -> str:
    lines = [
        f"- [{h['source']}] {h['title']} | {h['url']} | {h['snippet']}"
        for h in hits[:12]
    ]
    return GEMINI_PROMPT.format(
        song=song.replace('"', "'"), results="\n".join(lines) or "(none)"
    )


def _json_object(text: str) -> dict[str, Any] | None:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        doc = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return doc if isinstance(doc, dict) else None


class Extracted(TypedDict):
    danceName: str | None
    creator: str
    year: int | None
    confidence: float
    links: list[str]


def parse_gemini(response: object, allowed_links: set[str]) -> Extracted | None:
    """Validated {danceName, creator, year, confidence, links} from a generateContent response, or None when it
    is unusable. Links not among the search results are dropped (no invented URLs); low confidence -> no dance."""
    try:
        parts = response["candidates"][0]["content"]["parts"]  # type: ignore[index]
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    except (KeyError, IndexError, TypeError):
        return None
    doc = _json_object(text)
    if doc is None:
        return None
    name = _text(doc.get("danceName"), 80) or None
    conf = doc.get("confidence")
    confidence = (
        float(conf)
        if isinstance(conf, (int, float)) and not isinstance(conf, bool)
        else (0.0 if name is None else 0.5)
    )
    confidence = min(1.0, max(0.0, confidence))
    if name is None or confidence < MIN_CONFIDENCE:
        return Extracted(
            danceName=None, creator="", year=None, confidence=confidence, links=[]
        )
    year = doc.get("year")
    year = (
        year
        if isinstance(year, int) and not isinstance(year, bool) and 1900 <= year <= 2100
        else None
    )
    links = doc.get("links") if isinstance(doc.get("links"), list) else []
    kept = [
        u for u in dict.fromkeys(links) if isinstance(u, str) and u in allowed_links
    ][:MAX_LINKS]
    return Extracted(
        danceName=name,
        creator=_text(doc.get("creator"), 80),
        year=year,
        confidence=confidence,
        links=kept,
    )


def _post_json(
    url: str, body: dict[str, Any], headers: dict[str, str], timeout: float
) -> object:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def gemini_extract(
    song: str, hits: list[Hit], key: str, post: Any = _post_json
) -> Extracted | None:
    """Gemini reads the result titles and snippets (text only, 5 s timeout). None on any failure."""
    body = {
        "contents": [{"role": "user", "parts": [{"text": gemini_prompt(song, hits)}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.1,
            "maxOutputTokens": 400,
            "thinkingConfig": {
                "thinkingBudget": 0
            },  # a short extraction; keep it inside the 5 s budget
        },
    }
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    try:
        response = post(GEMINI_URL, body, headers, GEMINI_TIMEOUT_SEC)
    except (
        OSError,
        ValueError,
        http.client.HTTPException,
    ) as exc:  # timeout, HTTP error, bad JSON
        log.warning("signature.gemini ok=false error=%s", type(exc).__name__)
        return None
    return parse_gemini(response, {h["url"] for h in hits})
