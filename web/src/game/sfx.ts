// Tiny synthesized sound effects on the game's AudioContext (no audio files): a sparkle for
// PERFECT, a chime for GOOD, a soft tick for OK, a muted thud for a (seen) MISS, a twinkle
// every 10 combo, a falling "aww" when a long combo breaks, count-in ticks + a "go" chime,
// and a results fanfare. Everything goes through one quiet bus so the music stays on top.
//
// Pure parts (unit-tested): the note recipes, which sounds a batch of judgments makes, and
// which count-in cues to schedule from a start position. The Sfx class only plays them.

import { defaultStorage, readJson, writeJson, type StorageLike } from '../lib/storage'
import { getSettings } from '../settings'
import type { CountdownPlan } from './cues'
import type { CheckpointResult, Judgment } from './scoring'

export type SfxName = 'perfect' | 'good' | 'ok' | 'miss' | 'combo' | 'comboBreak' | 'tick' | 'go' | 'fanfare'

export interface SfxNote {
  /** Seconds after the sound's start. */
  at: number
  freq: number
  dur: number
  type: OscillatorType
  /** Peak gain of this note (before the bus volume). */
  gain: number
  /** Glide to this frequency over the note. */
  slideTo?: number
}

/** Bus gain: the loudest note peaks well under the music (which plays at gain 1). */
export const SFX_VOLUME = 0.22

/** Combo milestones (a twinkle) every this many hits. */
export const COMBO_MILESTONE = 10
/** A broken combo of at least this many gets the "aww". */
export const COMBO_BREAK_MIN = 5

const arp = (freqs: readonly number[], step: number, dur: number, type: OscillatorType, gain: number, from = 0): SfxNote[] =>
  freqs.map((freq, i) => ({ at: from + i * step, freq, dur, type, gain }))

export const SFX_NOTES: Readonly<Record<SfxName, readonly SfxNote[]>> = {
  // E6 G#6 B6 E7: a quick bright sparkle.
  perfect: arp([1318.5, 1661.2, 1975.5, 2637], 0.035, 0.16, 'sine', 0.5),
  // A5 + E6: a two-note chime.
  good: arp([880, 1318.5], 0.05, 0.18, 'triangle', 0.42),
  ok: [{ at: 0, freq: 660, dur: 0.07, type: 'sine', gain: 0.3 }],
  miss: [{ at: 0, freq: 150, dur: 0.14, type: 'sine', gain: 0.45, slideTo: 80 }],
  combo: arp([1568, 2093, 2637, 3136, 2637], 0.045, 0.14, 'sine', 0.32),
  comboBreak: [
    { at: 0, freq: 440, dur: 0.16, type: 'triangle', gain: 0.32, slideTo: 330 },
    { at: 0.15, freq: 330, dur: 0.28, type: 'triangle', gain: 0.3, slideTo: 220 },
  ],
  tick: [{ at: 0, freq: 1046.5, dur: 0.06, type: 'triangle', gain: 0.38 }],
  go: arp([1046.5, 1568, 2093], 0.04, 0.24, 'triangle', 0.42),
  // C5 E5 G5 C6, then a held major chord.
  fanfare: [
    ...arp([523.3, 659.3, 784, 1046.5], 0.11, 0.2, 'triangle', 0.42),
    ...arp([523.3, 659.3, 784, 1046.5], 0, 0.9, 'triangle', 0.22, 0.48),
    ...arp([2093, 2637], 0.06, 0.3, 'sine', 0.18, 0.5),
  ],
}

/** Length (s) of a sound (its last note's end). */
export const sfxDuration = (name: SfxName): number => Math.max(0, ...SFX_NOTES[name].map((n) => n.at + n.dur))

/**
 * The sounds for a batch of judgments (usually one): the best judgment's sound, a twinkle when
 * the combo reaches a multiple of COMBO_MILESTONE, the "aww" when a combo of COMBO_BREAK_MIN+
 * breaks. Unseen misses (nobody in front of the camera) stay silent: the toast covers them.
 * `comboBefore` is the combo before the batch.
 */
export function judgmentSfx(
  results: readonly Pick<CheckpointResult, 'judgment' | 'unseen' | 'combo'>[],
  comboBefore: number,
): SfxName[] {
  if (results.length === 0) return []
  const order: readonly Judgment[] = ['perfect', 'good', 'ok', 'miss']
  let best: Judgment | null = null
  let milestone = false
  let broke = false
  let combo = comboBefore
  for (const r of results) {
    const next = r.combo ?? (r.judgment === 'miss' ? 0 : combo + 1)
    if (r.judgment === 'miss' && combo >= COMBO_BREAK_MIN) broke = true
    if (next > combo && next % COMBO_MILESTONE === 0) milestone = true
    combo = next
    if (r.judgment === 'miss' && r.unseen) continue
    if (best === null || order.indexOf(r.judgment) < order.indexOf(best)) best = r.judgment
  }
  const out: SfxName[] = []
  if (broke) out.push('comboBreak')
  else if (best) out.push(best)
  if (milestone) out.push('combo')
  return out
}

export interface SfxCue {
  /** Song time (s). */
  t: number
  name: SfxName
}

/**
 * Count-in cues from song time `fromT` on: a tick on each "3 · 2 · 1" beat the clock doesn't
 * already click (the clock clicks count-in beats before song time 0), and "go" on "Dance!".
 */
export function countdownSfx(plan: Pick<CountdownPlan, 'times'>, clockClicks: readonly number[], fromT: number): SfxCue[] {
  const { times } = plan
  if (times.length === 0) return []
  const clicked = (t: number): boolean => clockClicks.some((c) => Math.abs(c - t) < 1e-3)
  const out: SfxCue[] = []
  times.forEach((t, i) => {
    if (t < fromT - 1e-6) return
    const go = i === times.length - 1
    if (go) out.push({ t, name: 'go' })
    else if (!clicked(t)) out.push({ t, name: 'tick' })
  })
  return out
}

// --- preference ------------------------------------------------------------------------------

export const SFX_KEY = 'midnight-ball.sfx.v1'

/** Sound effects on (default) or off, remembered on this device. */
export function loadSfxEnabled(storage: StorageLike | null = defaultStorage()): boolean {
  return readJson(SFX_KEY, storage) !== false
}

export function saveSfxEnabled(on: boolean, storage: StorageLike | null = defaultStorage()): void {
  writeJson(SFX_KEY, on, storage)
}

// --- playback ---------------------------------------------------------------------------------

/** Plays SFX on whatever AudioContext the game clock has right now (none: silent). */
export class Sfx {
  private bus: { ctx: AudioContext; gain: GainNode } | null = null
  private scheduled: OscillatorNode[] = []
  private readonly getContext: () => AudioContext | null

  constructor(getContext: () => AudioContext | null) {
    this.getContext = getContext
  }

  private output(): { ctx: AudioContext; gain: GainNode } | null {
    const ctx = this.getContext()
    if (!ctx || ctx.state === 'closed') return null
    if (this.bus?.ctx !== ctx) {
      const gain = ctx.createGain()
      gain.gain.value = SFX_VOLUME
      gain.connect(ctx.destination)
      this.bus = { ctx, gain }
      this.scheduled = []
    }
    return this.bus
  }

  /** Plays `name` at context time `when` (default: now). Returns the oscillators started. */
  play(name: SfxName, when?: number): OscillatorNode[] {
    const out = this.output()
    if (!out) return []
    const { ctx, gain: bus } = out
    bus.gain.value = SFX_VOLUME * getSettings().sfxVolume
    const t0 = Math.max(ctx.currentTime, when ?? ctx.currentTime)
    const started: OscillatorNode[] = []
    for (const n of SFX_NOTES[name]) {
      const at = t0 + n.at
      const osc = ctx.createOscillator()
      osc.type = n.type
      osc.frequency.setValueAtTime(n.freq, at)
      if (n.slideTo) osc.frequency.exponentialRampToValueAtTime(n.slideTo, at + n.dur)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0, at)
      env.gain.linearRampToValueAtTime(n.gain, at + 0.006)
      env.gain.exponentialRampToValueAtTime(0.001, at + n.dur)
      osc.connect(env)
      env.connect(bus)
      osc.start(at)
      osc.stop(at + n.dur + 0.02)
      osc.onended = () => env.disconnect()
      started.push(osc)
    }
    return started
  }

  /** Schedules song-time cues for a run whose song time 0 is at context time `startAt`. */
  schedule(cues: readonly SfxCue[], startAt: number | null): void {
    if (startAt === null) return
    for (const c of cues) this.scheduled.push(...this.play(c.name, startAt + c.t))
  }

  /** Cancels every scheduled (not yet finished) cue: pause, seek, restart, exit. */
  cancelScheduled(): void {
    for (const osc of this.scheduled) {
      try {
        osc.stop()
      } catch {
        // not started / already stopped
      }
      osc.disconnect()
    }
    this.scheduled = []
  }
}
