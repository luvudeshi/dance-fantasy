"""SVG contact sheets of real-dancer clips (contract dicts) for visual QA.

One row per clip: every keyframe as a stick figure (on-beat cells white, in-between cells grey), root
applied, floor line; drawn mirrored like the coach (the dancer's right on the right of the screen), left
limbs blue, right limbs orange. Reuses the figure drawing of scripts/render_moves.py.
"""

from __future__ import annotations

import html
import subprocess
from pathlib import Path
from typing import Any

from app.moves.types import MoveKeyframe
from scripts.render_moves import figure


def _kf(k: dict[str, Any]) -> MoveKeyframe:
    return MoveKeyframe(t=k["t"], pose={j: (v[0], v[1]) for j, v in k["pose"].items()}, root=(k["root"][0], k["root"][1]))


def _shown(c: dict[str, Any], t: float, on_beat_only: bool, half_beats_only: bool) -> bool:
    if on_beat_only:
        return _on_beat(c, t)
    if half_beats_only:
        h = t * 2 * c["lengthBeats"]
        return abs(h - round(h)) < 0.02
    return True


def clip_rows(
    clips: list[dict[str, Any]], title: str, s: float = 17.0, w: float = 46.0, on_beat_only: bool = False, half_beats_only: bool = False
) -> str:
    label_w = 250.0
    row_h = 4.5 * s + 22
    max_k = max((sum(1 for k in c["keyframes"] if _shown(c, k["t"], on_beat_only, half_beats_only)) for c in clips), default=1)
    width = label_w + w * max_k + 10
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{40 + row_h * len(clips):.0f}" font-family="Helvetica, Arial, sans-serif">',
        '<rect width="100%" height="100%" fill="#fafafa"/>',
        f'<text x="8" y="24" font-size="16" fill="#111">{html.escape(title)}</text>',
    ]
    for r, c in enumerate(clips):
        y0 = 40 + r * row_h
        parts.append(f'<text x="6" y="{y0 + 22:.0f}" font-size="12" fill="#111">{html.escape(c["id"])} · {html.escape(c["name"])}</text>')
        parts.append(
            f'<text x="6" y="{y0 + 38:.0f}" font-size="10" fill="#555">{c["lengthBeats"]}b i{c["intensity"]} {c["difficulty"]}'
            f'{" seated" if c["upperBodyOnly"] else ""} · {c["bpm"]:.0f} bpm · {html.escape(c["sourceSeq"][:26])} @{c["sourceStartSec"]:.1f}s</text>'
        )
        parts.append(f'<text x="6" y="{y0 + 52:.0f}" font-size="9" fill="#777">{html.escape(",".join(c["scoredJoints"]))}</text>')
        col = 0
        for k in c["keyframes"]:
            on = _on_beat(c, k["t"])
            if not _shown(c, k["t"], on_beat_only, half_beats_only):
                continue
            b = k["t"] * c["lengthBeats"]
            label = f"{round(b)}" if on else ""
            parts.append(figure(_kf(k), label_w + w * col + w / 2, y0 + 3.9 * s, s, label, on, w))
            col += 1
    parts.append("</svg>")
    return "\n".join(parts)


def _on_beat(c: dict[str, Any], t: float) -> bool:
    b = t * c["lengthBeats"]
    return abs(b - round(b)) < 1e-6


def write_sheet(path: Path, clips: list[dict[str, Any]], title: str, png: bool = True, **kw: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(clip_rows(clips, title, **kw))
    if png:
        subprocess.run(["qlmanage", "-t", "-s", "1600", "-o", str(path.parent), str(path)], check=False, capture_output=True)
    return path
