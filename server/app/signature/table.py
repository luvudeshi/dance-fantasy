"""Bundled song -> signature dance table and title normalization. Creator is "" where it isn't known."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class TableEntry:
    title: str
    artist: str
    dance: str
    creator: str = ""
    aliases: tuple[
        str, ...
    ] = ()  # extra title forms that also match (normalized on use)


TABLE: tuple[TableEntry, ...] = (
    TableEntry(
        "Lottery (Renegade)",
        "K CAMP",
        "The Renegade",
        "Jalaiah Harmon",
        ("Lottery", "Renegade"),
    ),
    TableEntry("Savage", "Megan Thee Stallion", "the Savage dance", "Keara Wilson"),
    TableEntry("Macarena", "Los del Río", "Macarena"),
    TableEntry("Y.M.C.A.", "Village People", "YMCA arms"),
    TableEntry("Gangnam Style", "PSY", "the horse dance"),
    TableEntry(
        "Crank That (Soulja Boy)", "Soulja Boy", "Crank That", aliases=("Crank That",)
    ),
    TableEntry(
        "Watch Me (Whip/Nae Nae)",
        "Silentó",
        "the Whip and the Nae Nae",
        aliases=("Watch Me",),
    ),
    TableEntry("Cha Cha Slide", "DJ Casper", "the slides"),
)

# Parenthesized / bracketed noise in file names and video titles: "(Official Video)", "[Lyrics]", "(feat. X)".
_NOISE = re.compile(
    r"[\(\[][^\)\]]*\b(official|lyrics?|audio|video|visuali[sz]er|remaster(ed)?|hd|hq|explicit|clean|feat\.?|ft\.?)\b[^\)\]]*[\)\]]",
    re.IGNORECASE,
)
_FEAT = re.compile(r"\s+(feat\.?|ft\.?|featuring)\s+.*$", re.IGNORECASE)


def normalize(text: str) -> str:
    """Case-, accent- and punctuation-insensitive form: "Y.M.C.A." -> "ymca", "Los del Río" -> "los del rio"."""
    text = unicodedata.normalize("NFKD", text)
    text = (
        "".join(c for c in text if not unicodedata.combining(c))
        .casefold()
        .replace("&", " and ")
    )
    text = re.sub(r"(?<=\w)\.(?=\w)", "", text)  # dotted acronyms: y.m.c.a -> ymca
    text = re.sub(r"[^\w\s]", " ", text).replace("_", " ")
    return " ".join(text.split())


def clean_title(raw: str) -> str:
    """A song title from a typed title, a file name or a video title: drops the extension and the noise."""
    title = re.sub(
        r"\.(mp3|wav|flac|ogg|m4a|aac|opus|webm)$", "", raw.strip(), flags=re.IGNORECASE
    )
    title = _NOISE.sub(" ", title)
    title = _FEAT.sub("", title)
    title = re.sub(
        r"\s+(M/V|MV|Official (Music )?Video)$", "", title, flags=re.IGNORECASE
    )
    return " ".join(title.replace("_", " ").split())


def title_keys(raw: str) -> set[str]:
    """Normalized forms a title may match on: the whole title, without parentheses, and each side of
    "Artist - Title"."""
    title = clean_title(raw)
    parts = [title] + (
        [p for p in re.split(r"\s+[-–—]\s+", title) if p]
        if re.search(r"\s[-–—]\s", title)
        else []
    )
    keys: set[str] = set()
    for part in parts:
        keys.add(normalize(part))
        keys.add(normalize(re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", part)))
    return {k for k in keys if k}


def _entry_keys(e: TableEntry) -> set[str]:
    keys = title_keys(e.title)
    for a in e.aliases:
        keys |= title_keys(a)
    return keys


def _artist_ok(entry: TableEntry, artist: str) -> bool:
    a, b = normalize(artist), normalize(entry.artist)
    return not a or a in b or b in a


def match_table(title: str, artist: str = "") -> TableEntry | None:
    """The bundled entry for a song, or None. When an artist is given it must agree (so "Savage" by someone
    else isn't Megan Thee Stallion's), unless it's empty. "Artist - Title" file names also match."""
    keys = title_keys(title)
    for e in TABLE:
        if keys & _entry_keys(e):
            fused = normalize(clean_title(title))
            artist_in_title = normalize(e.artist) in fused
            if _artist_ok(e, artist) or artist_in_title:
                return e
    return None


def find_dance(name: str) -> TableEntry | None:
    """The table entry for a dance name ("The Renegade", "renegade"), for creator credit."""
    key = _dance_key(name)
    return next((e for e in TABLE if _dance_key(e.dance) == key), None) if key else None


def _dance_key(name: str) -> str:
    words = [w for w in normalize(name).split() if w not in {"the", "dance", "a"}]
    return " ".join(words)
