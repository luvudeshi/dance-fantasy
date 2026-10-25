"""Startup cache warming: analyze every library song ahead of time so demo songs start instantly.

Runs in a background thread after the beat tracker's JIT warmup. Songs whose analysis is already
cached (same audio bytes, same ANALYSIS_VERSION) are skipped; failures are logged, never raised.
Routines aren't pre-generated: with a cached analysis, choreography takes only tens of ms.
"""

from __future__ import annotations

import logging
import time

from app.analysis_store import AnalysisStore, sha256_file
from app.api.analyze import analyze_and_store, library_meta
from app.audio import warmup
from app.config import Settings, get_settings
from app.library import list_songs

log = logging.getLogger(__name__)


def warm_library_analyses(settings: Settings) -> int:
    """Analyze library songs that have no cached analysis yet; returns how many were analyzed."""
    store = AnalysisStore(settings.cache_dir)
    analyzed = 0
    for song in list_songs(settings.songs_dir):
        try:
            digest = sha256_file(song.path)
            if store.load(digest) is not None:
                continue
            start = time.perf_counter()
            analyze_and_store(
                store, digest, song.path, library_meta(song.file, song.path), song.file, settings.max_duration_sec
            )
            analyzed += 1
            log.info("pre-analyzed %s in %.2f s", song.file, time.perf_counter() - start)
        except Exception:  # best effort: the song is analyzed on first request instead
            log.exception("could not pre-analyze %s", song.file)
    return analyzed


def warm_caches() -> None:
    """Thread target for the app lifespan: numba warmup, then library analyses."""
    warmup()
    warm_library_analyses(get_settings())
