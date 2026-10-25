"""Voice every fixed canned announcer line into the voice cache, so the common lines play instantly.

Lines already cached (for the current voice, any TTS model) are skipped, so a re-run only voices what is new.
Writes go through the app's cache, so with BLOB_READ_WRITE_TOKEN set they also fill Vercel Blob for the
deployment. Needs GEMINI_API_KEY (GEMINI_TTS_VOICE picks the voice).

    cd server && uv run python -m scripts.pregen_voice [--jobs 2]
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from itertools import zip_longest
from pathlib import Path

from app.ai.prompts import CANNED, CANNED_BY_ID, RESULTS_BY_TIER, line_id
from app.ai.voice import VoiceUnavailable, cached_wav, synthesize, voice_name
from app.config import get_settings


def _voice(cache_dir: Path, lid: str, text: str, voice: str) -> bool:
    if cached_wav(cache_dir, lid, voice) is not None:
        return False
    synthesize(cache_dir, lid, text, voice)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--jobs", type=int, default=2, help="concurrent TTS calls (default 2, like the server)")
    parser.add_argument("--passes", type=int, default=30, help="retry rounds for lines that failed (default 30)")
    parser.add_argument("--pause", type=float, default=30.0, help="seconds between rounds (default 30)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")

    cache_dir = get_settings().cache_dir
    voice = voice_name()
    made = cached = 0
    # Round-robin over the banks (first fixed line of every event, then the second, ...), so a small quota
    # still leaves every event with voiced lines; the count-only combo lines come last.
    banks = [[t for t in bank if line_id(t) in CANNED_BY_ID] for bank in (*CANNED.values(), *RESULTS_BY_TIER.values())]
    order = [t for row in zip_longest(*banks) for t in row if t is not None]
    todo = {line_id(t): t for t in order} | CANNED_BY_ID
    # TTS quotas are per minute and small: lines that fail (429) are retried in later passes after a pause.
    for attempt in range(args.passes):
        if attempt:
            print(f"{len(todo)} lines left, retrying in {args.pause:g}s", file=sys.stderr, flush=True)
            time.sleep(args.pause)
        failed: dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            jobs = {pool.submit(_voice, cache_dir, lid, text, voice): lid for lid, text in todo.items()}
            for job, lid in jobs.items():
                try:
                    if job.result():
                        made += 1
                    else:
                        cached += 1
                except VoiceUnavailable:
                    failed[lid] = todo[lid]
        todo = failed
        if not todo:
            break
    print(f"voice={voice} lines={len(CANNED_BY_ID)} voiced={made} already_cached={cached} failed={len(todo)} -> {cache_dir / 'voice'}")
    return 1 if todo else 0


if __name__ == "__main__":
    sys.exit(main())
