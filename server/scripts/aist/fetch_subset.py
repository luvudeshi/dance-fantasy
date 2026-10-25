"""Download a balanced subset of AIST++ 3D keypoints without fetching the whole 876 MB zip.

The release zip supports HTTP range requests, so zipfile reads its central directory and only the
members we pick through a small seekable HTTP reader. Picks round-robin across the 10 genres
(alternating basic/advanced dances, varying music and choreography) until --budget-mb of
compressed data, skipping the sequences in the dataset's ignore_list.txt.

Data: AIST++ annotations, (c) Google LLC, CC BY 4.0 (https://google.github.io/aistplusplus_dataset/),
derived from the AIST Dance Video Database (https://aistdancedb.ongaaccel.jp/). Raw files stay in a
gitignored folder; only processed 2D clips are committed.

Usage (stdlib only; run isolated):  uv run python -I scripts/aist/fetch_subset.py <out_dir> [--budget-mb 200]
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ZIP_URL = "https://github.com/google/aistplusplus_dataset/releases/download/v1.0/keypoints3d.zip"
IGNORE_URL = "https://github.com/google/aistplusplus_dataset/releases/download/v1.0/ignore_list.txt"
NAME_RE = re.compile(r"(?P<seq>g(?P<genre>[A-Z]{2})_s(?P<sit>[A-Z]{2})_c\w+?_d(?P<dancer>\d+)_m(?P<music>[A-Z]{2}\d)_ch(?P<ch>\d+))\.pkl$")
BLOCK = 512 * 1024


class HttpRangeFile(io.RawIOBase):
    """Read-only, seekable view of a remote file via Range requests (block-cached)."""

    def __init__(self, url: str) -> None:
        self.url = url
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
            self.size = int(r.headers["Content-Length"])
        self.pos = 0
        self.cache: dict[int, bytes] = {}
        self.fetched = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.pos, io.SEEK_END: self.size}[whence]
        self.pos = max(0, base + offset)
        return self.pos

    def _block(self, i: int) -> bytes:
        if i not in self.cache:
            start, end = i * BLOCK, min(self.size, (i + 1) * BLOCK) - 1
            req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req) as r:
                if r.status != 206:
                    raise OSError(f"server ignored the Range request (HTTP {r.status})")
                data = r.read()
            self.fetched += len(data)
            if len(self.cache) > 64:
                self.cache.clear()
            self.cache[i] = data
        return self.cache[i]

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        out = bytearray()
        while n > 0:
            b, off = divmod(self.pos, BLOCK)
            chunk = self._block(b)[off : off + n]
            if not chunk:
                break
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, buf) -> int:  # type: ignore[no-untyped-def]
        data = self.read(len(buf))
        buf[: len(data)] = data
        return len(data)


def pick(members: list[zipfile.ZipInfo], ignore: set[str], budget: int) -> list[zipfile.ZipInfo]:
    """Round-robin over genres; within a genre alternate basic (BM) / advanced (FM), new music/choreo first."""
    by_genre: dict[str, list[tuple[zipfile.ZipInfo, re.Match[str]]]] = defaultdict(list)
    for zi in members:
        m = NAME_RE.search(zi.filename)
        if m and m["seq"] not in ignore:
            by_genre[m["genre"]].append((zi, m))
    queues: dict[str, list[zipfile.ZipInfo]] = {}
    for genre, items in by_genre.items():
        seen: set[tuple[str, str, str]] = set()
        first, rest = [], []
        for zi, m in sorted(items, key=lambda x: (x[1]["ch"], x[1]["music"], x[1]["sit"], x[1]["dancer"])):
            key = (m["sit"], m["music"], m["ch"])
            (rest if key in seen else first).append((zi, m))
            seen.add(key)
        # interleave basic and advanced so both kinds make it under the budget
        bm = [zi for zi, m in first if m["sit"] == "BM"]
        fm = [zi for zi, m in first if m["sit"] != "BM"]
        mixed = [z for pair in zip(bm, fm) for z in pair] + bm[len(fm) :] + fm[len(bm) :]
        queues[genre] = mixed + [zi for zi, _ in rest]
    chosen: list[zipfile.ZipInfo] = []
    total = 0
    while any(queues.values()):
        for genre in sorted(queues):
            if queues[genre]:
                zi = queues[genre].pop(0)
                if total + zi.compress_size > budget:
                    return chosen
                chosen.append(zi)
                total += zi.compress_size
    return chosen


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--budget-mb", type=float, default=200.0)
    args = ap.parse_args()
    out = args.out_dir / "keypoints3d"
    out.mkdir(parents=True, exist_ok=True)

    with urllib.request.urlopen(IGNORE_URL) as r:
        ignore = {line.strip() for line in r.read().decode().splitlines() if line.strip()}
    remote = HttpRangeFile(ZIP_URL)
    with zipfile.ZipFile(remote) as zf:
        members = [zi for zi in zf.infolist() if zi.filename.endswith(".pkl")]
        chosen = pick(members, ignore, int(args.budget_mb * 1024 * 1024))
        print(f"{len(members)} sequences in the zip, {len(ignore)} ignored; downloading {len(chosen)} "
              f"({sum(z.compress_size for z in chosen) / 2**20:.0f} MB compressed)", flush=True)
        for i, zi in enumerate(chosen, 1):
            dest = out / Path(zi.filename).name
            if dest.exists() and dest.stat().st_size == zi.file_size:
                continue
            dest.write_bytes(zf.read(zi))
            if i % 25 == 0:
                print(f"  {i}/{len(chosen)}  ({remote.fetched / 2**20:.0f} MB fetched)", flush=True)
    manifest = {
        "source": ZIP_URL,
        "license": "AIST++ annotations (c) Google LLC, CC BY 4.0; derived from the AIST Dance Video Database",
        "files": sorted(Path(z.filename).name for z in chosen),
    }
    (args.out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"done: {len(chosen)} files, {remote.fetched / 2**20:.0f} MB fetched -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
