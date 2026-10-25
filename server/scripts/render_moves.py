"""Render the move library as SVG contact sheets for visual QA.

    uv run python scripts/render_moves.py [--moves-dir DIR] [--out DIR] [--only ID ...] [--png]

Writes one SVG per compiled move (every keyframe as a stick figure, root applied, floor line) plus
overview.svg (beat keyframes of every base move) into assets/cache/move_previews/. Mirrored view, as the
coach is drawn: the dancer's right is on the right of the screen. Left limbs blue, right limbs orange.
--png also converts each sheet with macOS ``qlmanage`` (PNG next to the SVG).
"""

from __future__ import annotations

import argparse
import html
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.moves.fk import LEG  # noqa: E402
from app.moves.library import load_library  # noqa: E402
from app.moves.types import CompiledMove, MoveKeyframe  # noqa: E402

PAGE = 6  # moves per overview page
LEFT, RIGHT, MID = "#2f6fdf", "#f0761e", "#555"
BONES = [
    ("l_shoulder", "l_elbow", LEFT), ("l_elbow", "l_wrist", LEFT),
    ("r_shoulder", "r_elbow", RIGHT), ("r_elbow", "r_wrist", RIGHT),
    ("l_hip", "l_knee", LEFT), ("l_knee", "l_ankle", LEFT),
    ("r_hip", "r_knee", RIGHT), ("r_knee", "r_ankle", RIGHT),
    ("l_shoulder", "r_shoulder", MID), ("l_hip", "r_hip", MID),
    ("l_shoulder", "l_hip", MID), ("r_shoulder", "r_hip", MID),
]  # fmt: skip


def figure(kf: MoveKeyframe, cx: float, floor_y: float, s: float, label: str, on_beat: bool, w: float) -> str:
    def pt(j: str) -> tuple[float, float]:
        x, y = kf.pose[j]
        return cx + (x + kf.root[0]) * s, floor_y + (y + kf.root[1] - LEG) * s

    top = floor_y - 3.6 * s
    out = [
        f'<rect x="{cx - w / 2 + 2:.1f}" y="{top:.1f}" width="{w - 4:.1f}" height="{floor_y - top + 0.5 * s:.1f}" '
        f'fill="{"#fff" if on_beat else "#f1f1f4"}" stroke="#ddd"/>',
        f'<line x1="{cx - w / 2 + 6:.1f}" y1="{floor_y:.1f}" x2="{cx + w / 2 - 6:.1f}" y2="{floor_y:.1f}" stroke="#999" stroke-width="2"/>',
        f'<line x1="{cx:.1f}" y1="{floor_y - 3 :.1f}" x2="{cx:.1f}" y2="{floor_y + 3:.1f}" stroke="#bbb"/>',
    ]
    sw = max(2.0, s * 0.07)
    for a, b, color in BONES:
        (x1, y1), (x2, y2) = pt(a), pt(b)
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{color}" stroke-width="{sw:.1f}" stroke-linecap="round"/>')
    for j in ("l_wrist", "r_wrist", "l_ankle", "r_ankle"):
        x, y = pt(j)
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{sw * 1.1:.1f}" fill="{LEFT if j[0] == "l" else RIGHT}"/>')
    (lx, ly), (rx, ry), (nx, ny) = pt("l_ear"), pt("r_ear"), pt("nose")
    hx, hy = (lx + rx + nx) / 3, (ly + ry + ny) / 3 - 0.05 * s
    out.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="{0.24 * s:.1f}" fill="none" stroke="{MID}" stroke-width="{sw:.1f}"/>')
    for j, color in (("l_eye", LEFT), ("r_eye", RIGHT), ("nose", MID)):
        x, y = pt(j)
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{sw * 0.6:.1f}" fill="{color}"/>')
    out.append(f'<text x="{cx:.1f}" y="{floor_y + 0.35 * s:.1f}" font-size="{max(9.0, s * 0.22):.0f}" text-anchor="middle" fill="#333">{label}</text>')
    return "\n".join(out)


def beat_label(m: CompiledMove, t: float) -> tuple[str, bool]:
    b = t * m.lengthBeats
    on = abs(b - round(b)) < 1e-6
    return (f"beat {round(b)}" if on else f"b{b:.2f}".rstrip("0").rstrip(".")), on


def move_sheet(m: CompiledMove, cols: int = 3) -> str:
    s, w = 46.0, 210.0
    n = len(m.keyframes)
    rows = (n + cols - 1) // cols
    cell_h = 4.2 * s + 12
    width, height = w * min(n, cols), 60 + rows * cell_h
    title = (
        f"{m.id} | {m.name} | {m.lengthBeats}b | int {m.intensity} | {m.difficulty} | "
        f"{'/'.join(m.styles)} | {'SEATED-OK' if m.upperBodyOnly else 'standing'} | {m.startAnchor} -> {m.endAnchor}"
    )
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{max(width, 640):.0f}" height="{height:.0f}" font-family="Helvetica, Arial, sans-serif">',
        '<rect width="100%" height="100%" fill="#fafafa"/>',
        f'<text x="10" y="22" font-size="15" fill="#111">{html.escape(title)}</text>',
        f'<text x="10" y="42" font-size="11" fill="#666">scored: {", ".join(m.scoredJoints) or "-"} | parts: {", ".join(m.bodyParts)}</text>',
    ]
    for i, kf in enumerate(m.keyframes):
        label, on = beat_label(m, kf.t)
        r, c = divmod(i, cols)
        parts.append(figure(kf, w * c + w / 2, 60 + r * cell_h + 3.6 * s, s, label, on, w))
    parts.append("</svg>")
    return "\n".join(parts)


def overview(moves: list[CompiledMove]) -> str:
    s, w, row_h = 22.0, 92.0, 22.0 * 4.4 + 18
    max_beats = max(m.lengthBeats for m in moves) + 1
    width = 230 + w * max_beats
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{row_h * len(moves) + 10:.0f}" font-family="Helvetica, Arial, sans-serif">',
        '<rect width="100%" height="100%" fill="#fafafa"/>',
    ]
    for r, m in enumerate(moves):
        y0 = r * row_h + 10
        parts.append(f'<text x="6" y="{y0 + 30:.0f}" font-size="13" fill="#111">{html.escape(m.id)}</text>')
        parts.append(
            f'<text x="6" y="{y0 + 48:.0f}" font-size="11" fill="#666">{m.lengthBeats}b i{m.intensity} {m.difficulty}'
            f'{" seated" if m.upperBodyOnly else ""}</text>'
        )
        beat_frames = [k for k in m.keyframes if beat_label(m, k.t)[1]]
        for i, kf in enumerate(beat_frames):
            parts.append(figure(kf, 230 + w * i + w / 2, y0 + 3.7 * s, s, str(i), True, w))
    parts.append("</svg>")
    return "\n".join(parts)


def to_png(svg: Path, size: int = 1600) -> None:
    subprocess.run(["qlmanage", "-t", "-s", str(size), "-o", str(svg.parent), str(svg)], check=True, capture_output=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--moves-dir", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--only", nargs="*", default=None, help="move ids or base ids to render")
    ap.add_argument("--png", action="store_true", help="convert each SVG to PNG with qlmanage (macOS)")
    args = ap.parse_args()
    lib = load_library(args.moves_dir)
    out = args.out or (get_settings().cache_dir / "move_previews")
    out.mkdir(parents=True, exist_ok=True)
    moves = [m for m in lib.moves if not args.only or m.id in args.only or m.baseId in args.only]
    written = []
    for m in moves:
        path = out / f"{m.id}.svg"
        path.write_text(move_sheet(m))
        written.append(path)
    base = [m for m in moves if m.mirrorOf is None]
    if base:
        path = out / "overview.svg"
        path.write_text(overview(base))
        written.append(path)
        for page in range(0, len(base), PAGE):  # PNG-sized pages of the overview
            path = out / f"overview-{page // PAGE + 1}.svg"
            path.write_text(overview(base[page : page + PAGE]))
            written.append(path)
    if args.png:
        for path in written:
            to_png(path)
    print(f"library {lib.version}: wrote {len(written)} sheets to {out}")


if __name__ == "__main__":
    main()
