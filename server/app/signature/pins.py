"""Pinned moves for the choreographer: which sections get them, and the library they are added to."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from app.moves.types import CompiledMove, MoveLibrary

Placement = Literal["chorus", "drop", "finale"]
PLACEMENTS: tuple[str, ...] = ("chorus", "drop", "finale")


@dataclass(frozen=True)
class PinnedMove:
    move: CompiledMove  # lengthBeats a multiple of 4, so the rest of the section still starts on a downbeat
    placement: str
    tag: dict[str, Any] = field(
        default_factory=dict
    )  # routine move.signatureDance: {name, creator?}
    version: str = ""  # signature library version (part of the routine id, so edited moves aren't served stale)


def pin_key(pinned: Sequence[PinnedMove]) -> list[list[str]]:
    """What the pins add to the routine id (generator.routine_id ``pins``); [] without pins."""
    return [[p.move.id, p.placement, p.version] for p in pinned]


def with_pinned_moves(
    library: MoveLibrary, pinned: Sequence[PinnedMove]
) -> MoveLibrary:
    """``library`` plus the pinned moves (appended, once each). The version is unchanged: pins are part of the
    routine id on their own (generator.routine_id)."""
    ids = {m.id for m in library.moves}
    extra: list[CompiledMove] = []
    for p in pinned:
        if p.move.lengthBeats % 4:
            raise ValueError(
                f"pinned move {p.move.id} must last a whole number of bars"
            )
        if p.placement not in PLACEMENTS:
            raise ValueError(f"placement must be one of {list(PLACEMENTS)}")
        if p.move.id in ids:
            continue
        ids.add(p.move.id)
        extra.append(p.move)
    return MoveLibrary(moves=library.moves + tuple(extra), version=library.version)


def pinned_sections(
    sections: Sequence[tuple[str, str, float, int]], placement: str
) -> list[int]:
    """Indices of the sections a pin goes to. ``sections``: (label, group, energy, full bars) per section.

    chorus  every section labeled "chorus"; without one, every occurrence of the highest-energy repeated group
            (then: the single highest-energy section)
    drop    every section labeled "drop"; without one, the first highest-energy section
    finale  the last section with bars
    """
    with_bars = [i for i, s in enumerate(sections) if s[3] > 0]
    if not with_bars:
        return []
    labeled = [i for i in with_bars if sections[i][0] == placement]
    if placement == "finale":
        return [with_bars[-1]]
    if labeled:
        return labeled
    loudest = max(with_bars, key=lambda i: (sections[i][2], -i))
    if placement == "drop":
        return [loudest]
    groups: dict[str, list[int]] = {}
    for i in with_bars:
        groups.setdefault(sections[i][1], []).append(i)
    repeated = [occ for occ in groups.values() if len(occ) >= 2]
    if not repeated:
        return [loudest]
    best = max(
        repeated, key=lambda occ: (sum(sections[i][2] for i in occ) / len(occ), -occ[0])
    )
    return best
