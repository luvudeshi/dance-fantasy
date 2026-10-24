"""Copy real, redistributable music from librosa's example data into assets/songs/.

Uses ``librosa.ex`` (downloads from librosa's official data repository into its cache) and
reads each track's license with ``librosa.util.example_info`` *before* downloading the audio.
Only CC0 / CC BY / public-domain tracks are copied; NC, ND or unrecognized licenses are
skipped. Each copied file gets a ``<stem>.json`` sidecar with title, artist, license, source
and the attribution line CC BY requires.

    uv run python scripts/fetch_example_songs.py
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import re
import shutil
from pathlib import Path

import librosa

REPO_ROOT = Path(__file__).resolve().parents[2]
SONGS_DIR = REPO_ROOT / "assets" / "songs"
MAX_BYTES = 15 * 1024 * 1024

EXAMPLES = [  # (librosa key, output stem, title, artist)
    ("vibeace", "vibe_ace", "Vibe Ace", "Kevin MacLeod"),
    ("fishin", "lets_go_fishin", "Let's Go Fishin'", "Karissa Hobbs"),
    ("choice", "choice", "Choice", "Admiral Bob"),
]


def example_info_text(key: str) -> str:
    """``librosa.util.example_info`` prints the license text instead of returning it."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        librosa.util.example_info(key)
    return buf.getvalue()


def classify_license(text: str) -> tuple[str | None, str | None, str]:
    """(license name or None if not redistributable, license URL, reason)."""
    lower = text.lower()
    urls = re.findall(r"https?://creativecommons\.org/\S+", text)
    if re.search(r"licenses/by-(nc|nd)", lower) or "noncommercial" in lower or "no derivatives" in lower:
        return None, urls[0] if urls else None, "non-commercial / no-derivatives license"
    for url in urls:
        m = re.search(r"licenses/by/(\d\.\d)", url)
        if m:
            return f"CC BY {m.group(1)}", url.rstrip("."), "attribution license"
        if "publicdomain/zero" in url:
            return "CC0 1.0", url.rstrip("."), "public domain dedication"
    if "public domain" in lower:
        return "Public domain", None, "public domain"
    return None, None, "license not recognized"


def first_url(text: str, host: str) -> str | None:
    m = re.search(rf"https?://[^\s]*{re.escape(host)}[^\s]*", text)
    return m.group(0).rstrip(".") if m else None


def fetch(key: str, stem: str, title: str, artist: str, force: bool) -> str:
    info = example_info_text(key)
    license_name, license_url, reason = classify_license(info)
    if license_name is None:
        return f"SKIP {key}: {reason} ({license_url or 'no URL'})"

    src = Path(librosa.ex(key))  # .ogg, cached by librosa
    size = src.stat().st_size
    if size > MAX_BYTES:
        return f"SKIP {key}: {size / 1e6:.1f} MB is over the {MAX_BYTES / 2**20:.0f} MB limit"
    dest = SONGS_DIR / f"{stem}{src.suffix.lower()}"
    if dest.exists() and not force:
        return f"KEEP {dest.name} (exists; --force to overwrite)"

    origin = first_url(info, "freemusicarchive.org") or first_url(info, "ccmixter.org")
    attribution = f"“{title}” by {artist}, licensed under {license_name}"
    attribution += f" ({license_url})." if license_url else "."
    if origin:
        attribution += f" Source: {origin}."
    sidecar = {
        "title": title,
        "artist": artist,
        "license": license_name,
        "licenseUrl": license_url,
        "source": origin or f"librosa example '{key}'",
        "attribution": attribution + f" Distributed with librosa's example data (librosa.ex('{key}')).",
    }
    SONGS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    dest.with_suffix(".json").write_text(json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return f"OK   {dest.name} ({size / 1e6:.1f} MB, {license_name})"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--force", action="store_true", help="overwrite files already in assets/songs/")
    args = parser.parse_args(argv)
    for key, stem, title, artist in EXAMPLES:
        print(fetch(key, stem, title, artist, args.force))


if __name__ == "__main__":
    main()
