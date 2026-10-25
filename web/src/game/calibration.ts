// Calibration: is the player fully in frame, are they ready, and how late is the camera?
// Everything here is pure (no DOM, no clocks): CalibrationScreen.tsx feeds it frames and times.
//
// - checkFraming: which joints the mirror can't see and ONE hint, most important first.
// - ReadyDetector: the player holds a "star" (both hands up and out) for 1 s.
// - ClapCalibrator: the player claps along with metronome clicks; the median clap - click
//   offset is the camera + model latency that scoring subtracts from every frame time.
// - load/saveCalibration: localStorage, defensive (private mode, corrupt values).

import type { Mode } from '@shared/routine'
import type { JointName, Vec2 } from '@shared/skeleton'
import type { PlayerFrame } from './poseSource'

export interface Calibration {
  /** Camera + model latency (s) subtracted from frame times before scoring. */
  latencySec: number
  /** How it was obtained. */
  source: 'measured' | 'default'
  measuredAt?: string
}

/** Typical webcam + MediaPipe latency on a laptop when not measured. */
export const DEFAULT_CALIBRATION: Calibration = { latencySec: 0.12, source: 'default' }

/** Measured latencies are clamped into [0, MAX_LATENCY_SEC]. */
export const MAX_LATENCY_SEC = 0.4

// --- framing -----------------------------------------------------------------------------

export type FramingIssue = 'no-person' | 'step-back' | 'move-left' | 'move-right' | 'closer' | 'ok'

export interface FramingCheck {
  ok: boolean
  /** Joints required for this mode that aren't visible enough. */
  missing: JointName[]
  /** Short instruction for the player, e.g. "Step back so we can see your feet". */
  hint: string
  /** Machine-readable form of the hint (for checklists). */
  issue?: FramingIssue
}

export const FRAMING_MIN_VISIBILITY = 0.6

const ARMS: readonly JointName[] = ['l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist']
const LEGS: readonly JointName[] = ['l_hip', 'r_hip', 'l_knee', 'r_knee', 'l_ankle', 'r_ankle']
export const STANDING_REQUIRED: readonly JointName[] = [...ARMS, ...LEGS]
export const SEATED_REQUIRED: readonly JointName[] = ['nose', ...ARMS]

export const HINTS = {
  noPerson: 'Step into the light',
  feet: 'Step back so the mirror can see your feet',
  hands: 'Step back so the mirror can see your hands',
  seatedBack: 'Sit back so the mirror can see your hands',
  left: 'Move a little to your left',
  right: 'Move a little to your right',
  closer: 'Come a little closer',
  ok: 'Perfect — stay right there!',
} as const

/** Joints this close to an image edge (fraction of the frame) count as cut off. */
const EDGE_MARGIN = 0.02
/** Torso centre further than this from the frame centre (fraction of width): move over. */
const MAX_CENTER_OFFSET = 0.2
/** Smaller than this and MediaPipe gets jittery: come closer. Standing: torso / frame height. */
const MIN_TORSO_FRAC = 0.11
/** Seated: shoulder span / frame width. */
const MIN_SHOULDER_FRAC = 0.1

const fail = (issue: FramingIssue, hint: string, missing: JointName[]): FramingCheck => ({ ok: false, missing, hint, issue })

const requiredJoints = (mode: Mode): readonly JointName[] => (mode === 'seated' ? SEATED_REQUIRED : STANDING_REQUIRED)

/** Is the player fully, comfortably in the mirror? One hint at a time, most important first. */
export function checkFraming(frame: PlayerFrame | null, mode: Mode): FramingCheck {
  const required = requiredJoints(mode)
  if (!frame || !frame.valid) return fail('no-person', HINTS.noPerson, [...required])
  const missing = required.filter((j) => !frame.pose[j] || (frame.visibility[j] ?? 0) < FRAMING_MIN_VISIBILITY)
  if (missing.includes('l_shoulder') && missing.includes('r_shoulder')) return fail('no-person', HINTS.noPerson, missing)

  const geo = imageGeometry(frame, required, mode)
  const backHint = mode === 'seated' ? HINTS.seatedBack : HINTS.feet

  // 1. Cut off at the top/bottom (or both sides), or legs out of view: step back.
  const legsMissing = mode === 'standing' && missing.some((j) => LEGS.includes(j))
  if (legsMissing || (geo && (geo.touchTop || geo.touchBottom || (geo.touchLeft && geo.touchRight)))) {
    return fail('step-back', backHint, missing)
  }

  // 2. Off to one side. Raw image left = the player's right (and the mirrored screen's right):
  //    a player cut off at raw-left, or centred left of the raw frame, should move to THEIR left.
  const side = sideToMove(geo, missing)
  if (side === 'left') return fail('move-left', HINTS.left, missing)
  if (side === 'right') return fail('move-right', HINTS.right, missing)

  // 3. Something still hidden (hands behind the back, out of the top): step back.
  if (missing.length > 0) return fail('step-back', mode === 'seated' ? HINTS.seatedBack : HINTS.hands, missing)

  // 4. Too far away.
  if (geo?.tooSmall) return fail('closer', HINTS.closer, missing)

  return { ok: true, missing: [], hint: HINTS.ok, issue: 'ok' }
}

interface Geometry {
  touchLeft: boolean
  touchRight: boolean
  touchTop: boolean
  touchBottom: boolean
  /** Torso centre, 0..1 across the RAW (unmirrored) frame. */
  centerU: number
  tooSmall: boolean
}

/** Edge contact / centring / size in the raw video frame; null without image coordinates. */
function imageGeometry(frame: PlayerFrame, required: readonly JointName[], mode: Mode): Geometry | null {
  const img = frame.image
  const w = frame.videoWidth
  const h = frame.videoHeight
  if (!img || !w || !h || !(w > 0) || !(h > 0)) return null
  const norm = (j: JointName): Vec2 | null => {
    const p = img[j]
    return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0] / w, p[1] / h] : null
  }
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  // MediaPipe also estimates joints it can't see (outside 0..1 when cut off), so every
  // required joint counts here, whatever its visibility.
  for (const j of required) {
    const p = norm(j)
    if (!p) continue
    minU = Math.min(minU, p[0])
    maxU = Math.max(maxU, p[0])
    minV = Math.min(minV, p[1])
    maxV = Math.max(maxV, p[1])
  }
  if (!Number.isFinite(minU)) return null
  const ls = norm('l_shoulder')
  const rs = norm('r_shoulder')
  const lh = norm('l_hip')
  const rh = norm('r_hip')
  if (!ls || !rs) return null
  const centre: Vec2[] = mode === 'standing' && lh && rh ? [ls, rs, lh, rh] : [ls, rs]
  const centerU = centre.reduce((s, p) => s + p[0], 0) / centre.length
  let tooSmall: boolean
  if (mode === 'standing' && lh && rh) {
    const torsoPx = Math.hypot(((ls[0] + rs[0] - lh[0] - rh[0]) / 2) * w, ((ls[1] + rs[1] - lh[1] - rh[1]) / 2) * h)
    tooSmall = torsoPx / h < MIN_TORSO_FRAC
  } else {
    tooSmall = Math.abs(ls[0] - rs[0]) < MIN_SHOULDER_FRAC
  }
  return {
    touchLeft: minU < EDGE_MARGIN,
    touchRight: maxU > 1 - EDGE_MARGIN,
    touchTop: minV < EDGE_MARGIN,
    touchBottom: maxV > 1 - EDGE_MARGIN,
    centerU,
    tooSmall,
  }
}

function sideToMove(geo: Geometry | null, missing: readonly JointName[]): 'left' | 'right' | null {
  if (geo) {
    if (geo.touchLeft) return 'left'
    if (geo.touchRight) return 'right'
    if (geo.centerU < 0.5 - MAX_CENTER_OFFSET) return 'left'
    if (geo.centerU > 0.5 + MAX_CENTER_OFFSET) return 'right'
  }
  // Without coordinates (or when nothing touches an edge): hidden joints all on one side of the
  // body. The player's right side is cut off -> they stand too far to their right -> move left.
  if (missing.length === 0) return null
  if (missing.every((j) => j.startsWith('r_'))) return 'left'
  if (missing.every((j) => j.startsWith('l_'))) return 'right'
  return null
}

// --- ready gesture -----------------------------------------------------------------------

export interface ReadyOptions {
  /** How long the star must be held (s). Default 1.0. */
  holdSec?: number
  /** Non-star frames shorter than this don't break the hold (tracking glitches). Default 0.15 s. */
  graceSec?: number
  /** Wrist/shoulder visibility needed. Default 0.5. */
  minVisibility?: number
}

/** Wrists at least this far above the shoulders (body units). */
const STAR_RAISE = 0.15
/** Wrists at least this far outside their own shoulder. */
const STAR_OUT = 0.1
/** Wrist-to-wrist span (body units; shoulders are ~0.9 apart, arms straight up ~1.0). */
const STAR_SPAN = 1.5

/** Both wrists above the shoulders and spread wide, each outside its own shoulder. */
export function isStarPose(frame: PlayerFrame | null, minVisibility = 0.5): boolean {
  if (!frame?.valid) return false
  const { pose, visibility } = frame
  const joints: JointName[] = ['l_shoulder', 'r_shoulder', 'l_wrist', 'r_wrist']
  if (joints.some((j) => !pose[j] || (visibility[j] ?? 0) < minVisibility)) return false
  const ls = pose.l_shoulder as Vec2
  const rs = pose.r_shoulder as Vec2
  const lw = pose.l_wrist as Vec2
  const rw = pose.r_wrist as Vec2
  // Body frame: +x = anatomical right, +y = down.
  return (
    lw[1] < ls[1] - STAR_RAISE &&
    rw[1] < rs[1] - STAR_RAISE &&
    lw[0] < ls[0] - STAR_OUT &&
    rw[0] > rs[0] + STAR_OUT &&
    rw[0] - lw[0] > STAR_SPAN
  )
}

export interface ReadyStatus {
  ready: boolean
  /** 0..1 of the hold. */
  progress: number
  /** This frame shows the star. */
  star: boolean
}

/** "Hold the star for 1 s" detector. Pure: time comes in with every update (seconds). */
export class ReadyDetector {
  private readonly holdSec: number
  private readonly graceSec: number
  private readonly minVisibility: number
  private holdStart: number | null = null
  private lastStar: number | null = null
  private done = false

  constructor(opts: ReadyOptions = {}) {
    this.holdSec = opts.holdSec ?? 1.0
    this.graceSec = opts.graceSec ?? 0.15
    this.minVisibility = opts.minVisibility ?? 0.5
  }

  update(frame: PlayerFrame | null, t: number): ReadyStatus {
    if (this.done) return { ready: true, progress: 1, star: isStarPose(frame, this.minVisibility) }
    const star = isStarPose(frame, this.minVisibility)
    if (this.lastStar !== null && t < this.lastStar) this.reset() // clock went backwards
    if (star) {
      this.holdStart ??= t
      this.lastStar = t
    } else if (this.holdStart !== null && (this.lastStar === null || t - this.lastStar > this.graceSec)) {
      this.holdStart = null
      this.lastStar = null
    }
    const progress = this.holdStart === null ? 0 : Math.min(1, Math.max(0, (t - this.holdStart) / this.holdSec))
    if (star && progress >= 1) this.done = true
    return { ready: this.done, progress, star }
  }

  get ready(): boolean {
    return this.done
  }

  reset(): void {
    this.holdStart = null
    this.lastStar = null
    this.done = false
  }
}

// --- clap-sync latency -------------------------------------------------------------------

export interface ClapOptions {
  /** Hands must open wider than this (body units) to arm the next clap. Default 0.8. */
  openAbove?: number
  /** Hands closer than this = clapping. Default 0.35. */
  closeBelow?: number
  /** A clap matches the nearest click within ± this (s). Default 0.4. */
  matchWindowSec?: number
  /** Matched claps needed for a valid measurement. Default 5. */
  minMatched?: number
  /** Median absolute deviation must stay below this (s). Default 0.06. */
  maxMadSec?: number
}

const CLAP_DEFAULTS: Required<ClapOptions> = {
  openAbove: 0.8,
  closeBelow: 0.35,
  matchWindowSec: 0.4,
  minMatched: 5,
  maxMadSec: 0.06,
}

export interface ClapEvent {
  /** Interpolated time of the closest approach (same time base as the samples). */
  t: number
  minDist: number
}

/** Distance between the wrists in body units (torso lengths); null when not trackable. */
export function wristDistance(frame: PlayerFrame | null, minVisibility = 0.3): number | null {
  if (!frame?.valid) return null
  const l = frame.pose.l_wrist
  const r = frame.pose.r_wrist
  if (!l || !r) return null
  if ((frame.visibility.l_wrist ?? 0) < minVisibility || (frame.visibility.r_wrist ?? 0) < minVisibility) return null
  const d = Math.hypot(l[0] - r[0], l[1] - r[1])
  return Number.isFinite(d) ? d : null
}

type Sample = readonly [t: number, d: number]

const det3 = (m: readonly number[]): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])

/**
 * x of the minimum of the least-squares parabola through `points` (3 points: the exact
 * parabola; 5 points average out landmark jitter). The middle point's x when the fit isn't a
 * proper minimum; always clamped to the points' x range.
 */
export function parabolicMinimum(points: readonly Sample[]): number {
  const n = points.length
  if (n === 0) return NaN
  const xm = points[Math.floor(n / 2)][0]
  if (n < 3) return xm
  const s = [0, 0, 0, 0, 0]
  const t = [0, 0, 0]
  for (const [x, y] of points) {
    const X = x - xm
    let p = 1
    for (let k = 0; k < 5; k++) {
      s[k] += p
      if (k < 3) t[k] += y * p
      p *= X
    }
  }
  // Normal equations for y = aX^2 + bX + c (Cramer's rule).
  const m = [s[4], s[3], s[2], s[3], s[2], s[1], s[2], s[1], s[0]]
  const d = det3(m)
  if (!(Math.abs(d) > 1e-18)) return xm
  const a = det3([t[2], s[3], s[2], t[1], s[2], s[1], t[0], s[1], s[0]]) / d
  const b = det3([s[4], t[2], s[2], s[3], t[1], s[1], s[2], t[0], s[0]]) / d
  if (!(a > 0)) return xm
  const xv = xm - b / (2 * a)
  return Number.isFinite(xv) ? Math.min(points[n - 1][0], Math.max(points[0][0], xv)) : xm
}


/**
 * Incremental clap finder on a wrist-distance signal: armed once the hands are wider than
 * `openAbove`; a dip below `closeBelow` is a clap, timed at its minimum (parabolic
 * interpolation on the neighbouring samples, least squares over 5 frames) once the hands open past the midpoint again.
 */
export class ClapDetector {
  private readonly open: number
  private readonly close: number
  private readonly release: number
  private armed = false
  /** The last samples before the current dip (neighbours for the fit). */
  private recent: Sample[] = []
  /** Samples of the current dip, starting with the two just before it. */
  private dip: Sample[] | null = null

  constructor(opts: ClapOptions = {}) {
    this.open = opts.openAbove ?? CLAP_DEFAULTS.openAbove
    this.close = opts.closeBelow ?? CLAP_DEFAULTS.closeBelow
    this.release = (this.open + this.close) / 2
  }

  /** Feeds one sample (null distance = no tracking, ignored). Returns a clap when one completes. */
  push(t: number, d: number | null): ClapEvent | null {
    if (d === null || !Number.isFinite(d) || !Number.isFinite(t)) return null
    const prev = this.recent.at(-1)
    if (prev && t <= prev[0]) return null // out of order / duplicate
    const s: Sample = [t, d]
    let out: ClapEvent | null = null
    if (this.dip) {
      this.dip.push(s)
      if (d > this.release) {
        out = this.finish()
        if (d > this.open) this.armed = true
      }
    } else if (d > this.open) {
      this.armed = true
    } else if (this.armed && d < this.close) {
      this.dip = [...this.recent, s]
      this.armed = false
    }
    this.recent = [...this.recent.slice(-1), s]
    return out
  }

  /** Ends a dip still in progress (end of the recording). */
  flush(): ClapEvent | null {
    return this.dip ? this.finish() : null
  }

  private finish(): ClapEvent | null {
    const dip = this.dip
    this.dip = null
    if (!dip || dip.length === 0) return null
    let i = 0
    for (let k = 1; k < dip.length; k++) if (dip[k][1] < dip[i][1]) i = k
    const [t, d] = dip[i]
    if (i === 0 || i === dip.length - 1) return { t, minDist: d }
    // Least-squares parabola on up to 2 frames either side, kept between the direct neighbours.
    const fitT = parabolicMinimum(dip.slice(Math.max(0, i - 2), i + 3))
    return { t: Math.min(dip[i + 1][0], Math.max(dip[i - 1][0], fitT)), minDist: d }
  }
}

/** Runs ClapDetector over a whole recording. */
export function detectClaps(samples: ReadonlyArray<readonly [number, number | null]>, opts: ClapOptions = {}): ClapEvent[] {
  const det = new ClapDetector(opts)
  const out: ClapEvent[] = []
  for (const [t, d] of samples) {
    const c = det.push(t, d)
    if (c) out.push(c)
  }
  const last = det.flush()
  if (last) out.push(last)
  return out
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return NaN
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

export interface LatencyEstimate {
  ok: boolean
  /** The measured latency when ok, else the fallback. Always within [0, MAX_LATENCY_SEC]. */
  latencySec: number
  /** Clicks with a matching clap. */
  matched: number
  clicks: number
  /** Median clap - click (s) before clamping; null with no matches. */
  medianSec: number | null
  /** Median absolute deviation of the offsets (s); null with no matches. */
  madSec: number | null
  /** Per matched click, clap - click (s). */
  offsetsSec: number[]
  /** Storybook explanation for the player. */
  message: string
}

const ms = (s: number): number => Math.round(s * 1000)

/**
 * Matches each clap to its nearest click (within ±matchWindowSec; one clap per click, the
 * closest) and turns the offsets into a latency: median(clap - click), valid with at least
 * `minMatched` matches and MAD < `maxMadSec`, clamped to [0, MAX_LATENCY_SEC].
 */
export function estimateLatency(
  claps: readonly number[],
  clicks: readonly number[],
  fallbackSec: number,
  opts: ClapOptions = {},
): LatencyEstimate {
  const o = { ...CLAP_DEFAULTS, ...opts }
  const fallback = clampLatency(fallbackSec)
  const best = new Map<number, number>() // click index -> offset
  for (const c of claps) {
    let k = -1
    for (let i = 0; i < clicks.length; i++) if (k < 0 || Math.abs(c - clicks[i]) < Math.abs(c - clicks[k])) k = i
    if (k < 0) continue
    const off = c - clicks[k]
    if (Math.abs(off) > o.matchWindowSec) continue
    const cur = best.get(k)
    if (cur === undefined || Math.abs(off) < Math.abs(cur)) best.set(k, off)
  }
  const offsetsSec = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, off]) => off)
  const matched = offsetsSec.length
  const med = matched > 0 ? median(offsetsSec) : null
  const mad = med !== null ? median(offsetsSec.map((x) => Math.abs(x - med))) : null
  const base = { matched, clicks: clicks.length, medianSec: med, madSec: mad, offsetsSec }
  const keep = `Keeping ${ms(fallback)} ms for now.`
  if (med === null || mad === null || matched < o.minMatched) {
    return {
      ...base,
      ok: false,
      latencySec: fallback,
      message: `The mirror only caught ${matched} of ${clicks.length} claps. Big claps, arms wide between each one! ${keep}`,
    }
  }
  if (!(mad < o.maxMadSec)) {
    return {
      ...base,
      ok: false,
      latencySec: fallback,
      message: `Those claps wandered a little (±${ms(mad)} ms). Try to land each one right on the chime. ${keep}`,
    }
  }
  const latencySec = clampLatency(med)
  return { ...base, ok: true, latencySec, message: `The magic mirror runs ${ms(latencySec)} ms behind the music. Saved!` }
}

export function clampLatency(sec: number): number {
  return Number.isFinite(sec) ? Math.min(MAX_LATENCY_SEC, Math.max(0, sec)) : DEFAULT_CALIBRATION.latencySec
}

export interface ClapSchedule {
  /** Soft count-in chimes (not scored), seconds from the schedule start. */
  countIn: number[]
  /** The clicks the player claps on. */
  clicks: number[]
  /** When to stop listening (last click + match window). */
  endSec: number
}

/** 8 clicks at 100 BPM after a 4-click count-in (so the first claps aren't reactions). */
export function clapSchedule(bpm = 100, clicks = 8, countIn = 4, matchWindowSec = CLAP_DEFAULTS.matchWindowSec): ClapSchedule {
  const beat = 60 / bpm
  const ci = Array.from({ length: countIn }, (_, i) => i * beat)
  const cl = Array.from({ length: clicks }, (_, i) => (countIn + i) * beat)
  return { countIn: ci, clicks: cl, endSec: (cl.at(-1) ?? 0) + matchWindowSec + 0.1 }
}

/** Collects wrist-distance samples during the clap test and produces the calibration. */
export class ClapCalibrator {
  readonly clicks: readonly number[]
  private readonly opts: ClapOptions
  private readonly detector: ClapDetector
  private readonly found: ClapEvent[] = []

  /** `clicks`: click times in the same time base as the sample times passed to addSample/addFrame. */
  constructor(clicks: readonly number[], opts: ClapOptions = {}) {
    this.clicks = clicks
    this.opts = opts
    this.detector = new ClapDetector(opts)
  }

  /** Returns the clap detected by this sample, if any. */
  addSample(t: number, dist: number | null): ClapEvent | null {
    const c = this.detector.push(t, dist)
    if (c) this.found.push(c)
    return c
  }

  addFrame(frame: PlayerFrame | null, t: number): ClapEvent | null {
    return this.addSample(t, wristDistance(frame))
  }

  get claps(): readonly ClapEvent[] {
    return this.found
  }

  /** Finishes the test. `previous` is kept (with an explanation) when the measurement is invalid. */
  finish(previous: Calibration, now: Date = new Date()): { estimate: LatencyEstimate; calibration: Calibration } {
    const last = this.detector.flush()
    if (last) this.found.push(last)
    const estimate = estimateLatency(
      this.found.map((c) => c.t),
      this.clicks,
      previous.latencySec,
      this.opts,
    )
    const calibration: Calibration = estimate.ok
      ? { latencySec: estimate.latencySec, source: 'measured', measuredAt: now.toISOString() }
      : { ...previous }
    return { estimate, calibration }
  }
}

// --- storage -----------------------------------------------------------------------------

export const CALIBRATION_STORAGE_KEY = 'midnight-ball.calibration.v1'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // blocked storage throws on access
  }
}

/** A valid Calibration from untrusted JSON, or null. */
export function parseCalibration(v: unknown): Calibration | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const lat = r.latencySec
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < 0 || lat > MAX_LATENCY_SEC) return null
  if (r.source !== 'measured' && r.source !== 'default') return null
  const out: Calibration = { latencySec: lat, source: r.source }
  if (typeof r.measuredAt === 'string') out.measuredAt = r.measuredAt
  return out
}

/** The saved calibration, or DEFAULT_CALIBRATION when missing, unreadable or invalid. */
export function loadCalibration(storage: StorageLike | null = defaultStorage()): Calibration {
  try {
    const raw = storage?.getItem(CALIBRATION_STORAGE_KEY)
    if (raw) {
      const parsed = parseCalibration(JSON.parse(raw))
      if (parsed) return parsed
    }
  } catch {
    // corrupt JSON / storage access denied
  }
  return { ...DEFAULT_CALIBRATION }
}

export function saveCalibration(c: Calibration, storage: StorageLike | null = defaultStorage()): void {
  const value: Calibration = { ...c, latencySec: clampLatency(c.latencySec) }
  try {
    storage?.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // quota / private mode: the calibration just isn't remembered
  }
}

