import { describe, expect, it } from 'vitest'
import { JOINTS, MEDIAPIPE_INDEX, type JointName, type Pose2D, type Vec2 } from '@shared/skeleton'
import { landmarksToPlayerPose, type LandmarkLike } from '../pose/normalize'
import {
  CALIBRATION_STORAGE_KEY,
  checkFraming,
  ClapCalibrator,
  clapSchedule,
  DEFAULT_CALIBRATION,
  detectClaps,
  estimateLatency,
  HINTS,
  isStarPose,
  loadCalibration,
  parabolicMinimum,
  ReadyDetector,
  saveCalibration,
  wristDistance,
  type Calibration,
  type StorageLike,
} from './calibration'
import type { PlayerFrame } from './poseSource'

// --- helpers -----------------------------------------------------------------------------

const VW = 640
const VH = 480

/** A centred standing player in RAW camera coordinates (0..1): their right is image-left. */
const STANDING_UV: Record<JointName, Vec2> = {
  nose: [0.5, 0.14],
  l_eye: [0.51, 0.13],
  r_eye: [0.49, 0.13],
  l_ear: [0.52, 0.14],
  r_ear: [0.48, 0.14],
  l_shoulder: [0.56, 0.25],
  r_shoulder: [0.44, 0.25],
  l_elbow: [0.6, 0.38],
  r_elbow: [0.4, 0.38],
  l_wrist: [0.61, 0.5],
  r_wrist: [0.39, 0.5],
  l_hip: [0.53, 0.52],
  r_hip: [0.47, 0.52],
  l_knee: [0.53, 0.7],
  r_knee: [0.47, 0.7],
  l_ankle: [0.53, 0.88],
  r_ankle: [0.47, 0.88],
}

interface FrameOpts {
  /** Shift (fraction of the frame) applied to every joint. */
  du?: number
  dv?: number
  /** Scale around the frame centre. */
  scale?: number
  vis?: Partial<Record<JointName, number>>
  uv?: Partial<Record<JointName, Vec2>>
}

/** Runs synthetic landmarks through the real normalization, like the webcam source does. */
function cameraFrame(opts: FrameOpts = {}): PlayerFrame {
  const { du = 0, dv = 0, scale = 1, vis = {}, uv = {} } = opts
  const lms: LandmarkLike[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }))
  for (const j of JOINTS) {
    const [u, v] = uv[j] ?? STANDING_UV[j]
    lms[MEDIAPIPE_INDEX[j]] = { x: 0.5 + (u - 0.5) * scale + du, y: 0.5 + (v - 0.5) * scale + dv, visibility: vis[j] ?? 0.95 }
  }
  const p = landmarksToPlayerPose(lms, VW, VH)
  return {
    songTime: 0,
    pose: p.pose,
    visibility: p.visibility,
    valid: p.valid,
    image: p.image,
    videoWidth: VW,
    videoHeight: VH,
  }
}

const NEUTRAL: Pose2D = {
  nose: [0, -1.45],
  l_shoulder: [-0.45, -1],
  r_shoulder: [0.45, -1],
  l_elbow: [-0.55, -0.5],
  r_elbow: [0.55, -0.5],
  l_wrist: [-0.6, 0],
  r_wrist: [0.6, 0],
  l_hip: [-0.22, 0],
  r_hip: [0.22, 0],
  l_knee: [-0.22, 0.95],
  r_knee: [0.22, 0.95],
  l_ankle: [-0.22, 1.85],
  r_ankle: [0.22, 1.85],
}

function bodyFrame(pose: Pose2D, vis = 0.95, valid = true): PlayerFrame {
  const visibility: Partial<Record<JointName, number>> = {}
  for (const j of JOINTS) visibility[j] = vis
  return { songTime: 0, pose: { ...NEUTRAL, ...pose }, visibility, valid }
}

const STAR = bodyFrame({ l_wrist: [-1.3, -1.9], r_wrist: [1.3, -1.9], l_elbow: [-0.9, -1.45], r_elbow: [0.9, -1.45] })
const NOT_STAR = bodyFrame({})

/** Deterministic RNG (mulberry32) + Box-Muller normal. */
function rng(seed: number): { uniform: () => number; normal: () => number } {
  let a = seed >>> 0
  const uniform = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform())
  return { uniform, normal }
}

/**
 * Wrist distance of a player clapping at `claps` (s), sampled at `fps` from `t0`: wide open
 * (1.05) between claps, a smooth dip to 0.12 at each clap.
 */
function clapSignal(claps: readonly number[], opts: { fps?: number; t0?: number; t1?: number; noise?: number; seed?: number } = {}) {
  const { fps = 30, t0 = 0.013, t1 = 7.6, noise = 0, seed = 1 } = opts
  const r = rng(seed)
  const out: Array<[number, number]> = []
  for (let t = t0; t < t1; t += 1 / fps) {
    let near = Infinity
    for (const c of claps) if (Math.abs(t - c) < Math.abs(near)) near = t - c
    const dt = Math.min(Math.abs(near), 0.3)
    const d = 0.12 + 0.93 * (1 - Math.cos((2 * Math.PI * dt) / 0.6)) * 0.5
    out.push([t, Math.max(0, d + noise * r.normal())])
  }
  return out
}

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
}

// --- framing -----------------------------------------------------------------------------

describe('checkFraming', () => {
  it('asks the player to step into the light when nobody is there', () => {
    expect(checkFraming(null, 'standing')).toMatchObject({ ok: false, hint: HINTS.noPerson, issue: 'no-person' })
    const invalid: PlayerFrame = { songTime: 0, pose: {}, visibility: {}, valid: false }
    const c = checkFraming(invalid, 'seated')
    expect(c.hint).toBe('Step into the light')
    expect(c.missing).toContain('nose')
  })

  it('is happy with a centred, fully visible player', () => {
    expect(checkFraming(cameraFrame(), 'standing')).toEqual({ ok: true, missing: [], hint: 'Perfect — stay right there!', issue: 'ok' })
  })

  it('asks to step back when the feet are hidden or cut off', () => {
    const hidden = checkFraming(cameraFrame({ vis: { l_ankle: 0.2, r_ankle: 0.3 } }), 'standing')
    expect(hidden).toMatchObject({ ok: false, hint: 'Step back so the mirror can see your feet', issue: 'step-back' })
    expect(hidden.missing).toEqual(['l_ankle', 'r_ankle'])
    // Too close: ankles below the bottom edge (MediaPipe still estimates them).
    const close = checkFraming(cameraFrame({ scale: 1.4 }), 'standing')
    expect(close.hint).toBe(HINTS.feet)
  })

  it('tells the player which way to move, from their side of the mirror', () => {
    // Raw image left = the player's right: they stand too far to their right -> move left.
    expect(checkFraming(cameraFrame({ du: -0.3 }), 'standing')).toMatchObject({ hint: 'Move a little to your left', issue: 'move-left' })
    expect(checkFraming(cameraFrame({ du: 0.3 }), 'standing')).toMatchObject({ hint: 'Move a little to your right', issue: 'move-right' })
    // Right hand cut off at the raw-left edge (their right side is out of the mirror).
    const cut = cameraFrame({ uv: { r_wrist: [-0.02, 0.5], r_elbow: [0.1, 0.38] }, vis: { r_wrist: 0.1 } })
    expect(checkFraming(cut, 'standing')).toMatchObject({ hint: HINTS.left, missing: ['r_wrist'] })
  })

  it('infers the side from hidden joints when there are no image coordinates', () => {
    const f = bodyFrame({})
    f.visibility.r_wrist = 0.1
    f.visibility.r_elbow = 0.2
    expect(checkFraming(f, 'standing')).toMatchObject({ hint: HINTS.left, missing: ['r_elbow', 'r_wrist'] })
    const g = bodyFrame({})
    g.visibility.l_wrist = 0.1
    expect(checkFraming(g, 'standing').hint).toBe(HINTS.right)
  })

  it('asks a far-away player to come closer', () => {
    expect(checkFraming(cameraFrame({ scale: 0.35 }), 'standing')).toMatchObject({ hint: 'Come a little closer', issue: 'closer' })
  })

  it('asks to show both hands when they are hidden but the body is framed', () => {
    const f = cameraFrame({ vis: { l_wrist: 0.1, r_wrist: 0.2 } })
    expect(checkFraming(f, 'standing')).toMatchObject({ hint: HINTS.hands, missing: ['l_wrist', 'r_wrist'] })
  })

  it('ignores the legs in seated mode but needs the nose and arms', () => {
    const legsHidden = cameraFrame({ vis: { l_knee: 0, r_knee: 0, l_ankle: 0, r_ankle: 0, l_hip: 0.2, r_hip: 0.2 } })
    expect(checkFraming(legsHidden, 'seated').ok).toBe(true)
    expect(checkFraming(legsHidden, 'standing').hint).toBe(HINTS.feet)
    const handsHidden = cameraFrame({ vis: { l_wrist: 0.1, r_wrist: 0.1 } })
    expect(checkFraming(handsHidden, 'seated')).toMatchObject({ ok: false, hint: HINTS.seatedBack })
  })

  it('treats a frame without shoulders as nobody', () => {
    expect(checkFraming(cameraFrame({ vis: { l_shoulder: 0.1, r_shoulder: 0.1 } }), 'standing').issue).toBe('no-person')
  })
})

// --- ready gesture -----------------------------------------------------------------------

describe('ReadyDetector', () => {
  it('recognises the star pose and rejects look-alikes', () => {
    expect(isStarPose(STAR)).toBe(true)
    expect(isStarPose(NOT_STAR)).toBe(false)
    expect(isStarPose(null)).toBe(false)
    // Arms straight up: above the shoulders but not spread.
    expect(isStarPose(bodyFrame({ l_wrist: [-0.5, -2.1], r_wrist: [0.5, -2.1] }))).toBe(false)
    // One arm only.
    expect(isStarPose(bodyFrame({ r_wrist: [1.3, -1.9] }))).toBe(false)
    // Low visibility.
    expect(isStarPose({ ...STAR, visibility: { ...STAR.visibility, l_wrist: 0.2 } })).toBe(false)
    expect(isStarPose({ ...STAR, valid: false })).toBe(false)
  })

  it('fires after the star is held for 1 s, not before', () => {
    const d = new ReadyDetector()
    let t = 10
    for (; t < 10.9; t += 1 / 30) expect(d.update(STAR, t).ready).toBe(false)
    expect(d.update(STAR, 10.95).progress).toBeCloseTo(0.95, 5)
    expect(d.update(STAR, 10.95).ready).toBe(false)
    expect(d.update(STAR, 11.0)).toEqual({ ready: true, progress: 1, star: true })
    // Latched until reset.
    expect(d.update(NOT_STAR, 11.5).ready).toBe(true)
    d.reset()
    expect(d.update(NOT_STAR, 12).ready).toBe(false)
  })

  it('restarts the hold after a real interruption', () => {
    const d = new ReadyDetector()
    for (let t = 0; t <= 0.6; t += 1 / 30) d.update(STAR, t)
    for (let t = 0.62; t < 0.95; t += 1 / 30) d.update(NOT_STAR, t)
    expect(d.update(NOT_STAR, 0.95).progress).toBe(0) // 0.35 s without the star: hold lost
    d.update(STAR, 1.0)
    expect(d.update(STAR, 1.9).ready).toBe(false)
    expect(d.update(STAR, 2.0).ready).toBe(true)
  })

  it('forgives a one-frame tracking glitch', () => {
    const d = new ReadyDetector()
    for (let t = 0; t <= 0.5; t += 1 / 30) d.update(STAR, t)
    expect(d.update(null, 0.53).ready).toBe(false)
    expect(d.update(STAR, 0.57).progress).toBeGreaterThan(0.5)
    expect(d.update(STAR, 1.0).ready).toBe(true)
  })

  it('does not latch on a glitch frame even when the hold time has passed', () => {
    const d = new ReadyDetector()
    d.update(STAR, 0)
    d.update(STAR, 0.95)
    expect(d.update(NOT_STAR, 1.02).ready).toBe(false)
    expect(d.update(STAR, 1.05).ready).toBe(true)
  })

  it('resets when time jumps backwards', () => {
    const d = new ReadyDetector()
    d.update(STAR, 5)
    d.update(STAR, 5.8)
    expect(d.update(STAR, 1).progress).toBe(0)
  })
})

// --- clap sync -----------------------------------------------------------------------------

describe('clap detection + latency', () => {
  const sched = clapSchedule()
  const LAT = 0.137

  it('schedules 8 clicks at 100 BPM after a 4-click count-in', () => {
    expect(sched.countIn).toEqual([0, 0.6, 1.2, 1.8].map((x) => expect.closeTo(x, 9)))
    expect(sched.clicks).toHaveLength(8)
    expect(sched.clicks[0]).toBeCloseTo(2.4, 9)
    expect(sched.clicks[7]).toBeCloseTo(6.6, 9)
    expect(sched.endSec).toBeGreaterThan(6.6 + 0.4)
  })

  it('parabolicMinimum finds the vertex with uneven spacing', () => {
    const f = (x: number): number => 3 * (x - 1.234) ** 2 + 0.2
    expect(parabolicMinimum([1.2, 1.24, 1.29].map((x) => [x, f(x)]))).toBeCloseTo(1.234, 9)
    expect(parabolicMinimum([1.17, 1.2, 1.24, 1.29, 1.3].map((x) => [x, f(x)]))).toBeCloseTo(1.234, 9)
    // Not a minimum -> middle point.
    expect(parabolicMinimum([[0, 0], [1, 1], [2, 2]])).toBe(1)
    expect(parabolicMinimum([[0, 0], [1, 1]])).toBe(1)
  })

  it('recovers a known latency from clean claps within 15 ms', () => {
    const claps = sched.clicks.map((c) => c + LAT)
    const found = detectClaps(clapSignal(claps))
    expect(found).toHaveLength(8)
    for (let i = 0; i < 8; i++) expect(Math.abs(found[i].t - claps[i])).toBeLessThan(0.005)
    const est = estimateLatency(
      found.map((c) => c.t),
      sched.clicks,
      0.12,
    )
    expect(est.ok).toBe(true)
    expect(est.matched).toBe(8)
    expect(Math.abs(est.latencySec - LAT)).toBeLessThan(0.015)
    expect(est.message).toMatch(/137 ms/)
  })

  it('handles noise, human jitter, missed claps and tracking dropouts', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(100 + seed)
      // Claps 1 and 5 never happen; the rest wobble by ~15 ms (the player's own timing).
      const clicks = sched.clicks.filter((_, i) => i !== 1 && i !== 5)
      const offsets = clicks.map(() => LAT + 0.015 * r.normal())
      const claps = clicks.map((c, i) => c + offsets[i])
      const sorted = [...offsets].sort((a, b) => a - b)
      const truth = (sorted[2] + sorted[3]) / 2 // what the player actually did (median offset)
      const samples: Array<[number, number | null]> = clapSignal(claps, { noise: 0.03, seed, t0: 0.004 * seed })
      for (let i = 40; i < 46; i++) samples[i] = [samples[i][0], null] // lost tracking for 0.2 s
      const cal = new ClapCalibrator(sched.clicks)
      for (const [t, d] of samples) cal.addSample(t, d)
      const { estimate, calibration } = cal.finish(DEFAULT_CALIBRATION, new Date('2026-10-24T12:00:00Z'))
      expect(estimate.matched).toBe(6)
      expect(estimate.ok).toBe(true)
      expect(Math.abs(estimate.latencySec - truth)).toBeLessThan(0.015)
      expect(Math.abs(estimate.latencySec - LAT)).toBeLessThan(0.03)
      expect(calibration).toEqual({ latencySec: estimate.latencySec, source: 'measured', measuredAt: '2026-10-24T12:00:00.000Z' })
    }
  })

  it('does not double-count jitter around the clap threshold', () => {
    const samples: Array<[number, number]> = [
      [0, 1.0],
      [0.03, 0.6],
      [0.06, 0.34],
      [0.09, 0.37],
      [0.12, 0.2],
      [0.15, 0.36],
      [0.18, 0.33],
      [0.21, 0.7],
      [0.24, 0.6],
      [0.27, 0.3],
      [0.3, 0.9],
    ]
    const claps = detectClaps(samples)
    // One clap (the dip around 0.12); the second dip at 0.27 isn't armed (hands never opened past 0.8).
    expect(claps).toHaveLength(1)
    expect(claps[0].t).toBeGreaterThan(0.09)
    expect(claps[0].t).toBeLessThan(0.15)
  })

  it('keeps the previous value and explains when too few claps match', () => {
    const claps = [2.4, 3.0, 3.6].map((c) => c + LAT)
    const prev: Calibration = { latencySec: 0.09, source: 'measured', measuredAt: 'x' }
    const cal = new ClapCalibrator(sched.clicks)
    for (const [t, d] of clapSignal(claps)) cal.addSample(t, d)
    const { estimate, calibration } = cal.finish(prev)
    expect(estimate.ok).toBe(false)
    expect(estimate.matched).toBe(3)
    expect(estimate.latencySec).toBe(0.09)
    expect(estimate.message).toMatch(/3 of 8/)
    expect(calibration).toEqual(prev)
  })

  it('rejects scattered claps (MAD >= 60 ms)', () => {
    const claps = sched.clicks.map((c, i) => c + LAT + (i % 2 ? 0.16 : -0.1))
    const est = estimateLatency(claps, sched.clicks, 0.12)
    expect(est.matched).toBe(8)
    expect(est.ok).toBe(false)
    expect(est.madSec).toBeGreaterThanOrEqual(0.06)
    expect(est.latencySec).toBe(0.12)
    expect(est.message).toMatch(/wandered/)
  })

  it('clamps an early-clapping player to 0 and ignores claps far from any click', () => {
    const claps = [...sched.clicks.map((c) => c - 0.05), 10, -3]
    const est = estimateLatency(claps, sched.clicks, 0.12)
    expect(est.ok).toBe(true)
    expect(est.matched).toBe(8)
    expect(est.medianSec).toBeCloseTo(-0.05, 9)
    expect(est.latencySec).toBe(0)
  })

  it('uses only the closest clap per click', () => {
    const claps = sched.clicks.flatMap((c) => [c + 0.1, c + 0.35])
    const est = estimateLatency(claps, sched.clicks, 0.12)
    expect(est.matched).toBe(8)
    expect(est.offsetsSec.every((o) => Math.abs(o - 0.1) < 1e-9)).toBe(true)
  })

  it('measures wrist distance in body units and skips untrackable frames', () => {
    expect(wristDistance(bodyFrame({ l_wrist: [-0.3, 0], r_wrist: [0.3, 0.8] }))).toBeCloseTo(1, 9)
    expect(wristDistance(null)).toBeNull()
    expect(wristDistance(bodyFrame({}, 0.1))).toBeNull()
    expect(wristDistance(bodyFrame({}, 0.9, false))).toBeNull()
  })
})

// --- storage -----------------------------------------------------------------------------

describe('calibration storage', () => {
  it('round-trips through the v1 key', () => {
    const s = new MemoryStorage()
    const c: Calibration = { latencySec: 0.118, source: 'measured', measuredAt: '2026-10-24T12:00:00.000Z' }
    saveCalibration(c, s)
    expect([...s.map.keys()]).toEqual(['midnight-ball.calibration.v1'])
    expect(loadCalibration(s)).toEqual(c)
  })

  it('falls back to the default for missing, corrupt or invalid data', () => {
    const s = new MemoryStorage()
    expect(loadCalibration(s)).toEqual(DEFAULT_CALIBRATION)
    for (const bad of ['{not json', 'null', '42', '{"latencySec":5,"source":"measured"}', '{"latencySec":0.1,"source":"guess"}', '{"latencySec":"0.1","source":"measured"}', '{"latencySec":-0.01,"source":"default"}']) {
      s.setItem(CALIBRATION_STORAGE_KEY, bad)
      expect(loadCalibration(s)).toEqual(DEFAULT_CALIBRATION)
    }
    expect(loadCalibration(null)).toEqual(DEFAULT_CALIBRATION)
  })

  it('never throws when storage is blocked, and clamps what it saves', () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
    }
    expect(loadCalibration(blocked)).toEqual(DEFAULT_CALIBRATION)
    expect(() => saveCalibration(DEFAULT_CALIBRATION, blocked)).not.toThrow()
    const s = new MemoryStorage()
    saveCalibration({ latencySec: 0.9, source: 'measured' }, s)
    expect(loadCalibration(s).latencySec).toBe(0.4)
  })

  it('returns a copy of the default, not the shared object', () => {
    const c = loadCalibration(null)
    c.latencySec = 0.3
    expect(DEFAULT_CALIBRATION.latencySec).toBe(0.12)
  })
})
