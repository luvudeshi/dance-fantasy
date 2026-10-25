"""Quality filters for candidate windows. Each rule names the first reason a window is dropped.

Thresholds are in torso units (3D mid-shoulder -> mid-hip) unless noted; they were calibrated on the
metric distributions of the ~6400 windows of our AIST++ subset (see build_clips.py --stats).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from scripts.aist.segment import Candidate


@dataclass(frozen=True)
class FilterConfig:
    floor_head: float = 0.6  # nose within this of the floor -> floor work
    floor_hip: float = 0.6  # mid-hip within this of the floor -> floor work / sitting
    facing_max: float = 50.0  # degrees from the window's mean facing in any frame (turns, back to camera)
    jitter_max: float = 0.03  # RMS high-frequency residual of the raw keypoints
    limb_dev_max: float = 0.10  # 95th-percentile relative deviation of a 3D limb length from its sequence median
    energy_min: float = 0.6  # mean joint speed (torso units / s): below = too static
    energy2d_min: float = 0.45  # ... as seen in the projected picture
    energy_max: float = 3.8  # above = chaotic
    peak_speed_max: float = 17.0
    travel_max: float = 1.5  # lateral root travel
    airborne_max: float = 0.6  # lowest ankle above the floor
    root_rise_max: float = 0.6  # root y above standing (jumps that leave the frame)
    bent_torso_min: float = 0.6  # 2D torso / 3D torso: below = bent over (the frame normalization blows up)
    arm_collapse_max: float = 0.35  # fraction of frames with BOTH arms pointing at / away from the camera
    arm_collapse_any_max: float = 0.6  # fraction of frames with at least one collapsed arm


RULES: tuple[tuple[str, Callable[[Candidate, FilterConfig], bool]], ...] = (
    ("tempo", lambda c, f: c.m.get("tempo_ok", 1.0) < 0.5),
    ("nan", lambda c, f: c.m.get("nan", 0.0) > 0),
    ("floor", lambda c, f: c.m["min_head"] < f.floor_head or c.m["min_hip"] < f.floor_hip or c.m["inverted"] > 0),
    ("facing", lambda c, f: c.m["facing_dev"] > f.facing_max),
    ("jitter", lambda c, f: c.m["jitter"] > f.jitter_max),
    ("limb_length", lambda c, f: c.m["limb_dev"] > f.limb_dev_max),
    ("bent", lambda c, f: c.m["torso2d_min"] < f.bent_torso_min),
    ("static", lambda c, f: c.m["energy"] < f.energy_min or c.m["energy2d"] < f.energy2d_min),
    ("chaotic", lambda c, f: c.m["energy"] > f.energy_max or c.m["peak_speed"] > f.peak_speed_max),
    ("travel", lambda c, f: c.m["travel"] > f.travel_max),
    ("jump", lambda c, f: c.m["airborne"] > f.airborne_max or -c.m["root_y_min"] > f.root_rise_max),
    ("arms_collapsed", lambda c, f: c.m["arm_collapse"] > f.arm_collapse_max or c.m["arm_collapse_any"] > f.arm_collapse_any_max),
)
RULE_NAMES = tuple(name for name, _ in RULES)


def reasons(c: Candidate, cfg: FilterConfig) -> list[str]:
    """Every rule the window fails (empty = keep)."""
    if c.m.get("nan", 0.0) > 0:
        return ["nan"]
    return [name for name, rule in RULES if rule(c, cfg)]


def apply_filters(cands: Iterable[Candidate], cfg: FilterConfig | None = None) -> tuple[list[Candidate], Counter[str], Counter[str]]:
    """(kept, first-failing-rule counts, any-failing-rule counts). Sets ``c.reject`` on dropped windows."""
    cfg = cfg or FilterConfig()
    kept: list[Candidate] = []
    first: Counter[str] = Counter()
    anyc: Counter[str] = Counter()
    for c in cands:
        rs = reasons(c, cfg)
        anyc.update(rs)
        if rs:
            c.reject = rs[0]
            first[rs[0]] += 1
        else:
            c.reject = None
            kept.append(c)
    return kept, first, anyc
