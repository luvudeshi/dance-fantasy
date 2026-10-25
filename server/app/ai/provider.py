"""Text generation: Meta Muse (OpenAI-compatible chat completions) first, Google Gemini as fallback.

Same pattern as Body Double's lib/ai/provider.ts, in stdlib HTTP (no vendor SDKs: the function bundle is
near its size cap). A provider without a key is skipped; when none answers within the deadline,
``generate_text`` raises ``AIUnavailable`` and the caller picks its own fallback.

Env: MUSE_API_KEY, MUSE_BASE_URL (default https://api.meta.ai/v1), MUSE_TEXT_MODEL, GEMINI_API_KEY,
GEMINI_TEXT_MODEL, AI_PROVIDER (``gemini`` puts Gemini first).

Privacy: never log prompts or model output. Logs carry the provider, ok/fail, latency and the error's
type or HTTP status only (keys travel in headers, never in a logged string). Blocking I/O: call from a
worker thread.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any, Literal

log = logging.getLogger(__name__)

Provider = Literal["muse", "gemini"]
GEMINI_BASE = "https://generativelanguage.googleapis.com"
# With two keys the first provider gets this share of the deadline, so the fallback still has time to answer.
FIRST_SHARE = 0.6
MIN_BUDGET_SEC = 0.2  # not worth starting a call with less time than this
KEY_ENV: dict[Provider, str] = {"muse": "MUSE_API_KEY", "gemini": "GEMINI_API_KEY"}


class AIUnavailable(RuntimeError):
    """No provider has a key, or every one failed or ran out of time."""


def env(name: str, default: str = "") -> str:
    # ponytail: `or` on purpose, so the blank `KEY=` lines from .env.example fall back to the default.
    return os.environ.get(name) or default


def configured() -> bool:
    return any(env(name) for name in KEY_ENV.values())


def _post(url: str, headers: dict[str, str], body: dict[str, Any], timeout: float) -> Any:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "accept": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def _text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("empty completion")
    return value


def _muse(key: str, system: str, user: str, json_mode: bool, temperature: float, timeout: float) -> str:
    body: dict[str, Any] = {
        "model": env("MUSE_TEXT_MODEL", "muse-spark-1.3"),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temperature,
        "reasoning_effort": "low",  # Muse always reasons and rejects "none"; "low" is the fastest it goes
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    base = env("MUSE_BASE_URL", "https://api.meta.ai/v1").rstrip("/")
    doc = _post(f"{base}/chat/completions", {"authorization": f"Bearer {key}"}, body, timeout)
    return _text(doc["choices"][0]["message"]["content"])


def _gemini(key: str, system: str, user: str, json_mode: bool, temperature: float, timeout: float) -> str:
    """Gemini's native generateContent (the OpenAI-compatible endpoint rejects "AQ." keys as Bearer tokens)."""
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": temperature,
            "responseMimeType": "application/json" if json_mode else "text/plain",
            "thinkingConfig": {"thinkingBudget": 0},  # short jobs: no thinking keeps them fast
        },
    }
    model = env("GEMINI_TEXT_MODEL", "gemini-2.5-flash")
    doc = _post(f"{GEMINI_BASE}/v1beta/models/{model}:generateContent", {"x-goog-api-key": key}, body, timeout)
    parts = doc["candidates"][0]["content"]["parts"]
    return _text("".join(p["text"] for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str)))


CALLS: dict[Provider, Callable[[str, str, str, bool, float, float], str]] = {"muse": _muse, "gemini": _gemini}


def _describe(exc: Exception) -> str:
    return f"HTTP {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__


def generate_text(
    system: str, user: str, *, deadline_sec: float, json_mode: bool = False, temperature: float = 0.8
) -> tuple[str, Provider]:
    """(completion, provider) from the first provider that answers before the deadline."""
    order: list[Provider] = ["gemini", "muse"] if env("AI_PROVIDER") == "gemini" else ["muse", "gemini"]
    keyed = [(p, key) for p in order if (key := env(KEY_ENV[p]))]
    end = time.monotonic() + deadline_sec
    for i, (provider, key) in enumerate(keyed):
        remaining = end - time.monotonic()
        budget = remaining * FIRST_SHARE if i < len(keyed) - 1 else remaining
        if budget < MIN_BUDGET_SEC:
            break
        started = time.monotonic()
        try:
            text = CALLS[provider](key, system, user, json_mode, temperature, budget)
        except (OSError, http.client.HTTPException, ValueError, LookupError, TypeError) as exc:  # net, HTTP, JSON, shape
            ms = (time.monotonic() - started) * 1000
            log.warning("ai.call provider=%s ok=false ms=%.0f error=%s", provider, ms, _describe(exc))
            continue
        log.info("ai.call provider=%s ok=true ms=%.0f", provider, (time.monotonic() - started) * 1000)
        return text, provider
    raise AIUnavailable("no AI provider answered" if keyed else "no AI provider key is set")
