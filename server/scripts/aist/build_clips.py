"""Build assets/moves/aist_clips.json from the AIST++ keypoint pickles.

    cd server && uv run python -I scripts/aist/build_clips.py <keypoints_dir> <out_json> [--per-genre 25]
        [--previews DIR] [--no-png] [--report FILE]

keypoints_dir holds g*_s*_c*_d*_m*_ch*.pkl (downloaded by fetch_subset.py; gitignored). The pickles are
read with a restricted unpickler (numpy arrays only). Steps: tempo + phase from the motion, 4/8-beat
windows, quality filters, tags, a diverse well-connected selection per genre, export, contact sheets.
Run with -I (isolated): this file adds the server folder to sys.path itself.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[2]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import numpy as np  # noqa: E402

from scripts.aist.export import build_document, write_document  # noqa: E402
from scripts.aist.filters import RULE_NAMES, FilterConfig, apply_filters  # noqa: E402
from scripts.aist.project import prepare_sequence  # noqa: E402
from scripts.aist.render import write_sheet  # noqa: E402
from scripts.aist.safe_load import load_keypoints, parse_name  # noqa: E402
from scripts.aist.segment import Candidate, sequence_windows  # noqa: E402
from scripts.aist.selection import (  # noqa: E402
    SelectConfig,
    anchor_connectivity,
    by_genre,
    connectivity,
    diversity,
    endpoints,
    mirror_pose,
    mirror_root,
    nn_transition,
    select_genre,
    transition_distance,
)
from scripts.aist.tags import tag_all  # noqa: E402
from scripts.aist.tempo import digit_tempo, estimate_tempo  # noqa: E402

REPO_ROOT = SERVER_DIR.parent


def log(msg: str) -> None:
    print(msg, flush=True)


def process(kp_dir: Path) -> tuple[list[Candidate], list[dict[str, object]]]:
    files = sorted(p for p in kp_dir.glob("*.pkl") if p.is_file())
    if not files:
        raise SystemExit(f"no .pkl files in {kp_dir}")
    cands: list[Candidate] = []
    seq_rows: list[dict[str, object]] = []
    for path in files:
        info = parse_name(path.stem)
        seq = prepare_sequence(path.stem, load_keypoints(path), info=info)
        hint = digit_tempo(info["genre"], int(info["music"]))
        tempo = estimate_tempo(seq.raw / seq.torso_cm, seq.fps, hint)
        windows = sequence_windows(seq, tempo)
        cands.extend(windows)
        seq_rows.append(
            {"seq": path.stem, "genre": info["genre"], "sit": info["sit"], "bpm": tempo.bpm, "hint_bpm": hint,
             "hint": tempo.hint, "pulse": round(tempo.score, 3), "frames": seq.n, "windows": len(windows)}
        )  # fmt: skip
    return cands, seq_rows


def library_transitions() -> dict[str, float]:
    """Median nearest-neighbour transition distance of the classic library, and mixed AIST <-> classic."""
    from app.moves.library import load_library
    from app.skeleton import JOINTS

    lib = load_library(REPO_ROOT / "assets" / "moves")
    # classic (FK) moves only: the library also loads aist_clips.json once it exists
    moves = [m for m in lib.moves if m.lengthBeats in (2, 4, 8) and getattr(m, "source", "library") != "aist" and "aist" not in m.styles]
    sp = np.array([[m.startPose[j] for j in JOINTS] for m in moves])
    ep = np.array([[m.endPose[j] for j in JOINTS] for m in moves])
    sr = np.array([m.keyframes[0].root for m in moves])
    er = np.array([m.keyframes[-1].root for m in moves])
    d = transition_distance(ep[:, None], er[:, None], sp[None], sr[None])
    np.fill_diagonal(d, np.inf)
    return {"sp": sp, "sr": sr, "ep": ep, "er": er, "median_nn": float(np.median(d.min(axis=1))), "median_knn": _knn(d)}  # type: ignore[dict-item]


def _knn(d: np.ndarray, k: int = 10) -> float:
    """Median over rows of the mean of the k cheapest transitions (how many good continuations a clip has)."""
    return float(np.median(np.sort(d, axis=1)[:, :k].mean(axis=1)))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("keypoints_dir", type=Path)
    ap.add_argument("out_json", type=Path)
    ap.add_argument("--per-genre", type=int, default=25)
    ap.add_argument("--previews", type=Path, default=REPO_ROOT / "assets" / "cache" / "aist_previews")
    ap.add_argument("--no-png", action="store_true", help="skip the qlmanage PNG conversion of the contact sheets")
    ap.add_argument("--report", type=Path, default=None, help="also write the run report as JSON here")
    args = ap.parse_args()

    t0 = time.time()
    cands, seq_rows = process(args.keypoints_dir)
    log(f"{len(seq_rows)} sequences -> {len(cands)} candidate windows ({time.time() - t0:.0f}s)")

    kept, first, anyc = apply_filters(cands, FilterConfig())
    log("filters (windows dropped; first failing rule / any rule):")
    for name in RULE_NAMES:
        log(f"  {name:15s} {first[name]:5d} / {anyc[name]:5d}")
    log(f"  kept {len(kept)} of {len(cands)}")

    tag_all(kept)
    cfg = SelectConfig(per_genre=args.per_genre)
    conn_all = connectivity(kept, cfg.knn) + cfg.w_anchor_conn * anchor_connectivity(kept)
    conn_of = {id(c): v for c, v in zip(kept, conn_all)}
    selected: list[Candidate] = []
    genre_rows = {}
    seq_by_genre: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in seq_rows:
        seq_by_genre[str(row["genre"])].append(row)
    windows_by_genre = Counter(c.genre for c in cands)
    for genre, pool in by_genre(kept).items():
        picks = select_genre(pool, cfg, np.array([conn_of[id(c)] for c in pool]))
        selected.extend(picks)
        bpms = [float(r["bpm"]) for r in seq_by_genre[genre]]  # type: ignore[arg-type]
        genre_rows[genre] = {
            "sequences": len(seq_by_genre[genre]),
            "windows": windows_by_genre[genre],
            "kept": len(pool),
            "selected": len(picks),
            "selected_8": sum(1 for c in picks if c.length == 8),
            "selected_4": sum(1 for c in picks if c.length == 4),
            "bpm_min": min(bpms),
            "bpm_median": float(np.median(bpms)),
            "bpm_max": max(bpms),
            "hint_disagrees": sum(1 for r in seq_by_genre[genre] if r["hint"] == "disagrees"),
            "intensity": dict(sorted(Counter(int(c.tags["intensity"]) for c in picks).items())),  # type: ignore[call-overload]
            "difficulty": dict(Counter(str(c.tags["difficulty"]) for c in picks)),
        }
    for genre, row in genre_rows.items():
        log(
            f"  {genre}: seqs {row['sequences']:2d} windows {row['windows']:4d} kept {row['kept']:4d} "
            f"selected {row['selected']:2d} ({row['selected_8']}x8 + {row['selected_4']}x4) "
            f"bpm {row['bpm_min']:.0f}-{row['bpm_max']:.0f} (median {row['bpm_median']:.1f}) "
            f"tempo-unreliable {row['hint_disagrees']} int {row['intensity']} diff {row['difficulty']}"
        )

    doc = build_document(selected)
    size = write_document(doc, args.out_json)
    log(f"wrote {len(doc['clips'])} clips -> {args.out_json} ({size / 1024:.0f} KB)")

    # connectivity: median nearest-neighbour transition distance (end pose -> best next start pose)
    lib = library_transitions()
    aist_nn = float(np.median(nn_transition(selected)))
    sp, sr, ep, er = endpoints(selected)
    ep2, er2 = np.concatenate([ep, mirror_pose(ep)]), np.concatenate([er, mirror_root(er)])
    sp2, sr2 = np.concatenate([sp, mirror_pose(sp)]), np.concatenate([sr, mirror_root(sr)])
    da = transition_distance(ep2[:, None], er2[:, None], sp2[None], sr2[None])
    np.fill_diagonal(da, np.inf)
    a2c = transition_distance(ep2[:, None], er2[:, None], lib["sp"][None], lib["sr"][None]).min(axis=1)  # type: ignore[index]
    c2a = transition_distance(lib["ep"][:, None], lib["er"][:, None], sp2[None], sr2[None]).min(axis=1)  # type: ignore[index]
    mix = np.concatenate([ep2, lib["ep"]]), np.concatenate([er2, lib["er"]]), np.concatenate([sp2, lib["sp"]]), np.concatenate([sr2, lib["sr"]])  # type: ignore[list-item]
    dm = transition_distance(mix[0][:, None], mix[1][:, None], mix[2][None], mix[3][None])
    np.fill_diagonal(dm, np.inf)
    trans = {
        "classic_median_nn": round(float(lib["median_nn"]), 3),
        "aist_median_nn": round(aist_nn, 3),
        "classic_median_10nn": round(float(lib["median_knn"]), 3),
        "aist_median_10nn": round(_knn(da), 3),
        "aist_end_to_classic_start_median": round(float(np.median(a2c)), 3),
        "classic_end_to_aist_start_median": round(float(np.median(c2a)), 3),
        "mix_median_nn": round(float(np.median(dm.min(axis=1))), 3),
        "candidate_pool_conn_median": round(float(np.median(conn_all)), 3),
        "selected_diversity_median": round(float(np.median([diversity(p) for p in by_genre(selected).values()])), 3),
        "selected_conn_median": round(float(np.median([conn_of[id(c)] for c in selected])), 3),
    }
    log("median nearest-neighbour transition distance (mean joint dist + 0.5 * root): " + json.dumps(trans))

    # contact sheets: every selected clip, one sheet per genre (half-beat frames), plus rejected samples
    clips_by_genre: dict[str, list[dict[str, object]]] = defaultdict(list)
    for clip in doc["clips"]:
        clips_by_genre[clip["genre"]].append(clip)
    sheets = []
    for genre, clips in clips_by_genre.items():
        for page in range(0, len(clips), 13):
            chunk = clips[page : page + 13]
            sheets.append(
                write_sheet(args.previews / f"{genre}-{page // 13 + 1}.svg", chunk, f"AIST {genre} clips {page + 1}-{page + len(chunk)}",
                            png=not args.no_png, on_beat_only=False, half_beats_only=True)  # fmt: skip
            )
    log(f"contact sheets: {len(sheets)} in {args.previews}")

    if args.report:
        report = {
            "sequences": seq_rows,
            "filters_first": dict(first),
            "filters_any": dict(anyc),
            "kept": len(kept),
            "candidates": len(cands),
            "genres": genre_rows,
            "file_bytes": size,
            "clips": len(doc["clips"]),
            "transitions": trans,
        }
        args.report.write_text(json.dumps(report, indent=1))
    log(f"done in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
