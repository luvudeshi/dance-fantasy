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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.ai.prompts import CANNED_BY_ID
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
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")

    cache_dir = get_settings().cache_dir
    voice = voice_name()
    made = cached = failed = 0
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        jobs = {pool.submit(_voice, cache_dir, lid, text, voice): lid for lid, text in CANNED_BY_ID.items()}
        for job in jobs:
            try:
                if job.result():
                    made += 1
                else:
                    cached += 1
            except VoiceUnavailable as exc:
                failed += 1
                print(f"line {jobs[job][:12]}: {exc}", file=sys.stderr)
    print(f"voice={voice} lines={len(CANNED_BY_ID)} voiced={made} already_cached={cached} failed={failed} -> {cache_dir / 'voice'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
