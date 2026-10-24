"""Deterministic synthetic test songs (numpy + soundfile only).

Electronic pop in A minor, 4/4, beat grid starting at t = 0 with a kick on the very first
sample. Default layout (bars): intro 4 (hats + soft pad), verse 8 (kick on 1 and 3, snare on
2 and 4, 8th hats, bass, pad; Am-F-C-G), chorus 8 (kick on every beat, brighter pad, lead,
crash each bar; F-G-Em-Am), verse 8, chorus 8, outro 4 (pad fading out). Each WAV gets a
sidecar ``<stem>.json`` with the ground-truth tempo and sections (for tests and as reference
data for section detection).

    uv run python scripts/make_sample_song.py --all
    uv run python scripts/make_sample_song.py --bpm 128 --seed 3 --out /tmp/x.wav
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

REPO_ROOT = Path(__file__).resolve().parents[2]
SONGS_DIR = REPO_ROOT / "assets" / "songs"

BEATS_PER_BAR = 4
PEAK_DBFS = -1.0
FILE_SR = 22050  # same rate the analyzer uses; keeps the committed WAVs small (~3.5-4.4 MB)
DEFAULT_LAYOUT: list[tuple[str, int]] = [
    ("intro", 4),
    ("verse", 8),
    ("chorus", 8),
    ("verse", 8),
    ("chorus", 8),
    ("outro", 4),
]
DEFAULT_SONGS = [  # (file name, bpm, seed, title)
    ("synth_120bpm.wav", 120.0, 1, "Synth Ball 120"),
    ("synth_96bpm.wav", 96.0, 2, "Synth Ball 96"),
]

# Pad voicing (MIDI notes) and bass root (MIDI) per chord.
CHORDS: dict[str, tuple[tuple[int, ...], int]] = {
    "Am": ((57, 60, 64), 45),
    "F": ((57, 60, 65), 41),
    "C": ((55, 60, 64), 48),
    "G": ((55, 59, 62), 43),
    "Em": ((55, 59, 64), 40),
}
PROGRESSIONS: dict[str, list[str]] = {
    "intro": ["Am", "F", "C", "G"],
    "verse": ["Am", "F", "C", "G"],
    "chorus": ["F", "G", "Em", "Am"],
    "outro": ["F", "G", "Am", "Am"],
}
LEAD_RANGE = [64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81]  # A natural minor, E4..A5
LEAD_RHYTHMS = [  # (start beat, length in beats), alternating per bar
    [(0.0, 1.0), (1.0, 0.5), (1.5, 0.5), (2.0, 1.5), (3.5, 0.5)],
    [(0.0, 1.5), (1.5, 0.5), (2.0, 1.0), (3.0, 1.0)],
]


@dataclass(frozen=True)
class _Style:
    kick_beats: tuple[int, ...]
    snare: bool
    hat_gain: float
    bass: str  # "", "quarter" or "eighth"
    bass_gain: float
    pad_gain: float
    bright: bool
    lead: bool
    crash: bool
    fade_out: bool = False


STYLES: dict[str, _Style] = {
    "intro": _Style((), False, 0.12, "", 0.0, 0.24, False, False, False),
    "verse": _Style((0, 2), True, 0.14, "quarter", 0.24, 0.24, False, False, False),
    "chorus": _Style((0, 1, 2, 3), True, 0.19, "eighth", 0.30, 0.24, True, True, True),
    "outro": _Style((), False, 0.0, "", 0.0, 0.26, False, False, False, fade_out=True),
}
KICK_GAIN, SNARE_GAIN, LEAD_GAIN, CRASH_GAIN = 0.8, 0.5, 0.3, 0.2


# --- small DSP helpers --------------------------------------------------------------------


def _midi_hz(note: float) -> float:
    return 440.0 * 2.0 ** ((note - 69.0) / 12.0)


def _times(n: int, sr: int) -> np.ndarray:
    return np.arange(n, dtype=np.float64) / sr


def _ramp(n: int) -> np.ndarray:
    """Raised-cosine ramp 0 -> 1 over n samples."""
    if n <= 0:
        return np.ones(0)
    return 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)


def _envelope(
    n: int, sr: int, attack: float, release: float, decay_tau: float | None = None, floor: float = 1.0
) -> np.ndarray:
    """Attack ramp, optional exponential decay towards ``floor``, release ramp at the end."""
    env = np.ones(n)
    if decay_tau is not None:
        env = floor + (1.0 - floor) * np.exp(-_times(n, sr) / decay_tau)
    a = min(int(attack * sr), n)
    r = min(int(release * sr), n - a)
    env[:a] *= _ramp(a)
    if r > 0:
        env[n - r :] *= _ramp(r)[::-1]
    return env


def _harmonic_tone(freq: float, n: int, sr: int, harmonics: list[tuple[int, float]], phase: float = 0.0) -> np.ndarray:
    """Sum of sine partials, skipping any above 0.45 * sr (no aliasing)."""
    t = _times(n, sr)
    out = np.zeros(n)
    for k, amp in harmonics:
        if k * freq < 0.45 * sr:
            out += amp * np.sin(2 * np.pi * k * freq * t + k * phase)
    return out


def _band_noise(n: int, sr: int, lo: float, hi: float, rng: np.random.Generator) -> np.ndarray:
    """White noise shaped in the frequency domain by 2nd-order high/low-pass magnitudes."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1.0 / sr)
    hi = min(hi, 0.45 * sr)
    lo_ratio = np.divide(lo, f, out=np.full_like(f, np.inf), where=f > 0)
    hp = 1.0 / np.sqrt(1.0 + lo_ratio**4)
    lp = 1.0 / np.sqrt(1.0 + (f / hi) ** 4)
    x = np.fft.irfft(spec * hp * lp, n)
    return x / (np.max(np.abs(x)) + 1e-12)


def _add(buf: np.ndarray, start: int, sig: np.ndarray, gain: float = 1.0) -> None:
    if start >= len(buf):
        return
    end = min(len(buf), start + len(sig))
    buf[start:end] += gain * sig[: end - start]


# --- instruments (one-shots are rendered once per song and reused) ----------------------


def _kick(sr: int) -> np.ndarray:
    n = int(0.42 * sr)
    t = _times(n, sr)
    f_hi, f_lo, tau = 150.0, 50.0, 0.035
    phase = 2 * np.pi * (f_lo * t + (f_hi - f_lo) * tau * (1 - np.exp(-t / tau)))
    body = np.sin(phase) * np.exp(-t / 0.16)
    click = 0.15 * np.sin(2 * np.pi * 1100.0 * t) * np.exp(-t / 0.004)
    return (body + click) * _envelope(n, sr, attack=0.001, release=0.03)


def _snare(sr: int, rng: np.random.Generator) -> np.ndarray:
    n = int(0.26 * sr)
    t = _times(n, sr)
    noise = _band_noise(n, sr, 1200.0, 7000.0, rng) * np.exp(-t / 0.075)
    tone = (np.sin(2 * np.pi * 200.0 * t) + 0.35 * np.sin(2 * np.pi * 330.0 * t)) * np.exp(-t / 0.05)
    return (0.75 * noise + 0.55 * tone) * _envelope(n, sr, attack=0.001, release=0.03)


def _hat(sr: int, rng: np.random.Generator) -> np.ndarray:
    n = int(0.09 * sr)
    t = _times(n, sr)
    return _band_noise(n, sr, 6500.0, 12000.0, rng) * np.exp(-t / 0.022) * _envelope(n, sr, 0.0005, 0.01)


def _crash(sr: int, rng: np.random.Generator) -> np.ndarray:
    n = int(2.2 * sr)
    t = _times(n, sr)
    return _band_noise(n, sr, 3000.0, 11000.0, rng) * np.exp(-t / 0.8) * _envelope(n, sr, 0.002, 0.2)


def _pad_chord(chord: str, bright: bool, length: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Detuned sines with a slow attack; ``length`` includes the release tail."""
    notes = list(CHORDS[chord][0])
    if bright:
        notes += [m + 12 for m in notes]
    harmonics = [(1, 1.0), (2, 0.4), (3, 0.18), (4, 0.08)] if bright else [(1, 1.0), (2, 0.3), (3, 0.1)]
    n = int(length * sr)
    out = np.zeros(n)
    for m in notes:
        for cents in (-7.0, 0.0, 7.0):
            freq = _midi_hz(m) * 2.0 ** (cents / 1200.0)
            out += _harmonic_tone(freq, n, sr, harmonics, phase=rng.uniform(0, 2 * np.pi))
    out /= np.sqrt(3 * len(notes)) * 2.0
    return out * _envelope(n, sr, attack=0.45, release=0.7)


def _bass_note(note: int, dur: float, sr: int) -> np.ndarray:
    n = int(dur * sr)
    tone = _harmonic_tone(_midi_hz(note), n, sr, [(1, 1.0), (2, 0.4), (3, 0.18), (4, 0.06)])
    return tone * _envelope(n, sr, attack=0.004, release=0.02, decay_tau=0.25, floor=0.6)


def _lead_note(note: int, dur: float, sr: int) -> np.ndarray:
    n = int(dur * sr)
    t = _times(n, sr)
    vibrato = 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.clip(t / 0.3, 0, 1)
    freq = _midi_hz(note)
    phase = 2 * np.pi * freq * (t + np.cumsum(vibrato) / sr)
    tri = np.sin(phase) - np.sin(3 * phase) / 9 + np.sin(5 * phase) / 25  # band-limited triangle
    return tri * _envelope(n, sr, attack=0.008, release=0.04, decay_tau=0.3, floor=0.65)


def _lead_bar(
    chord: str, prev: int, rhythm_idx: int, rng: np.random.Generator
) -> tuple[list[tuple[float, float, int]], int]:
    """One bar of melody: chord tones on strong beats, scale steps in between."""
    chord_pcs = {m % 12 for m in CHORDS[chord][0]}
    chord_tones = [m for m in LEAD_RANGE if m % 12 in chord_pcs]
    notes = []
    for start, length in LEAD_RHYTHMS[rhythm_idx % len(LEAD_RHYTHMS)]:
        if start in (0.0, 2.0):
            nearest = sorted(chord_tones, key=lambda m: (abs(m - prev), m))[:2]
            note = int(nearest[int(rng.integers(len(nearest)))])
        else:
            idx = LEAD_RANGE.index(prev) if prev in LEAD_RANGE else len(LEAD_RANGE) // 2
            step = int(rng.choice([-2, -1, 1, 2], p=[0.2, 0.3, 0.3, 0.2]))
            note = LEAD_RANGE[int(np.clip(idx + step, 0, len(LEAD_RANGE) - 1))]
        notes.append((start, length, note))
        prev = note
    return notes, prev


# --- song rendering -----------------------------------------------------------------------


def render_song(
    bpm: float, seed: int = 0, layout: list[tuple[str, int]] | None = None, sr: int = 22050
) -> tuple[np.ndarray, int, dict]:
    """Render a song. Returns (mono float32 audio peaking at -1 dBFS, sr, ground-truth info).

    ``layout`` is a list of (section label, bars); labels: intro, verse, chorus, outro.
    Info: bpm, beatsPerBar, firstBeatSec, durationSec, sections[{label, startBar, bars,
    startSec, endSec}].
    """
    if bpm <= 0:
        raise ValueError("bpm must be > 0")
    layout = list(DEFAULT_LAYOUT if layout is None else layout)
    for label, bars in layout:
        if label not in STYLES:
            raise ValueError(f"unknown section label {label!r}; use one of {sorted(STYLES)}")
        if bars < 1:
            raise ValueError(f"section {label!r} must have at least one bar")

    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    bar = BEATS_PER_BAR * beat
    total_bars = sum(bars for _, bars in layout)
    n = int(round(total_bars * bar * sr))
    tail = int(3.0 * sr)  # room for release tails; cut off at the end

    def at(sec: float) -> int:
        return int(round(sec * sr))

    drums, bass, pad, lead = (np.zeros(n + tail) for _ in range(4))
    duck = np.ones(n + tail)  # sidechain gain for the pad, dipped by each kick
    master = np.ones(n + tail)
    kick, snare, hat, crash = _kick(sr), _snare(sr, rng), _hat(sr, rng), _crash(sr, rng)
    duck_curve = 1.0 - 0.45 * np.exp(-_times(int(0.5 * sr), sr) / 0.12)

    def hit_kick(sec: float) -> None:
        start = at(sec)
        _add(drums, start, kick, KICK_GAIN)
        seg = duck[start : start + len(duck_curve)]
        np.minimum(seg, duck_curve[: len(seg)], out=seg)

    sections = []
    bar_idx = 0
    lead_prev = 72
    for label, bars in layout:
        style = STYLES[label]
        prog = PROGRESSIONS[label]
        start_sec = bar_idx * bar
        for b in range(bars):
            t0 = (bar_idx + b) * bar
            chord = prog[b % len(prog)]
            root = CHORDS[chord][1]

            _add(pad, at(t0), _pad_chord(chord, style.bright, bar + 0.7, sr, rng), style.pad_gain)
            if style.crash:
                _add(drums, at(t0), crash, CRASH_GAIN)
            for k in range(BEATS_PER_BAR):
                tb = t0 + k * beat
                if k in style.kick_beats:
                    hit_kick(tb)
                if style.snare and k in (1, 3):
                    _add(drums, at(tb), snare, SNARE_GAIN * (1.15 if style.bright else 1.0))
                if style.hat_gain > 0:
                    _add(drums, at(tb), hat, style.hat_gain)
                    _add(drums, at(tb + beat / 2), hat, style.hat_gain * 0.6)
            if style.bass == "quarter":
                for k in range(BEATS_PER_BAR):
                    _add(bass, at(t0 + k * beat), _bass_note(root, 0.85 * beat, sr), style.bass_gain)
            elif style.bass == "eighth":
                for k, offset in enumerate([0, 0, 12, 0, 0, 12, 0, 7]):
                    _add(bass, at(t0 + k * beat / 2), _bass_note(root + offset, 0.42 * beat, sr), style.bass_gain)
            if style.lead:
                notes, lead_prev = _lead_bar(chord, lead_prev, b, rng)
                for nb, nl, note in notes:
                    _add(lead, at(t0 + nb * beat), _lead_note(note, 0.92 * nl * beat, sr), LEAD_GAIN)

        end_sec = (bar_idx + bars) * bar
        if style.fade_out:
            a, z = at(start_sec), at(end_sec)
            master[a:z] = _ramp(z - a)[::-1]
        sections.append(
            {
                "label": label,
                "startBar": bar_idx,
                "bars": bars,
                "startSec": round(start_sec, 4),
                "endSec": round(end_sec, 4),
            }
        )
        bar_idx += bars

    if 0 not in STYLES[layout[0][0]].kick_beats:
        hit_kick(0.0)  # the grid always starts with a kick at t = 0, even in a drum-less intro

    y = _remove_dc(((drums + bass + pad * duck + lead) * master)[:n], sr)
    fade_in, fade_out = min(n, int(0.002 * sr)), min(n, int(0.03 * sr))  # no clicks at either end
    y[:fade_in] *= _ramp(fade_in)
    y[n - fade_out :] *= _ramp(fade_out)[::-1]
    y *= 10 ** (PEAK_DBFS / 20) / (np.max(np.abs(y)) + 1e-12)

    info = {
        "bpm": float(bpm),
        "beatsPerBar": BEATS_PER_BAR,
        "firstBeatSec": 0.0,
        "durationSec": round(n / sr, 4),
        "sections": sections,
    }
    return y.astype(np.float32), sr, info


def _remove_dc(y: np.ndarray, sr: int, cutoff: float = 25.0) -> np.ndarray:
    """Zero-phase high-pass (smooth FFT taper below ``cutoff`` Hz); removes DC and sub-rumble.

    Zero-padded by 1 s so the filter's ringing doesn't wrap around between the two ends.
    """
    size = len(y) + sr
    spec = np.fft.rfft(y, size)
    spec *= np.clip(np.fft.rfftfreq(size, 1.0 / sr) / cutoff, 0.0, 1.0) ** 2
    return np.fft.irfft(spec, size)[: len(y)]


def write_song(path: Path, y: np.ndarray, sr: int, info: dict, title: str) -> None:
    """Write a 16-bit mono WAV plus its ``<stem>.json`` sidecar."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, y, sr, subtype="PCM_16")
    sidecar = {
        "title": title,
        "artist": "Midnight Ball test synth",
        "license": "CC0 (generated)",
        "source": "server/scripts/make_sample_song.py",
        **info,
    }
    path.with_suffix(".json").write_text(json.dumps(sidecar, indent=2) + "\n")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bpm", type=float, default=120.0)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", type=Path, help="output .wav (default: assets/songs/synth_<bpm>bpm.wav)")
    parser.add_argument("--title", help="title for the sidecar (default: 'Synth Ball <bpm>')")
    parser.add_argument("--sr", type=int, default=FILE_SR, help=f"sample rate (default {FILE_SR})")
    parser.add_argument("--all", action="store_true", help="write both default songs into assets/songs/")
    args = parser.parse_args(argv)

    jobs = (
        [(SONGS_DIR / name, bpm, seed, title) for name, bpm, seed, title in DEFAULT_SONGS]
        if args.all
        else [
            (
                args.out or SONGS_DIR / f"synth_{args.bpm:g}bpm.wav",
                args.bpm,
                args.seed,
                args.title or f"Synth Ball {args.bpm:g}",
            )
        ]
    )
    for path, bpm, seed, title in jobs:
        y, sr, info = render_song(bpm, seed=seed, sr=args.sr)
        write_song(path, y, sr, info, title)
        print(f"wrote {path} ({info['durationSec']:.1f} s, {bpm:g} BPM, seed {seed})")


if __name__ == "__main__":
    main()
