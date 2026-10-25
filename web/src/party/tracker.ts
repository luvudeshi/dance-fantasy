// Who is who: MediaPipe reports people in no stable order, so every frame its detections are matched
// to the party's player slots (pure functions; PartyTracker wraps them around a PeopleFeed).
//
//  - Slots start in left-to-right order of the mirror: a slot nobody has claimed yet sits at its
//    "home" spot ((slot + 0.5) / N of the screen width), so the first dancers to appear get the
//    slots nearest to where they stand, and a latecomer in the middle gets the middle slot.
//  - Once claimed, a slot follows its dancer by nearest hip centre (gated to GATE_TORSOS torso
//    lengths per frame), so two dancers who swap places keep their colours and scores.
//  - Hysteresis in time: a dancer who steps out keeps the slot for HOLD_MS (and can only take it back
//    near where they left). After that the slot is free again and goes to the nearest new arrival.
//  - Duplicate detections of one person (overlapping boxes) are merged before matching.
// All positions are raw (unmirrored) video pixels; `mirrored` only decides where the home spots are.

import type { PlayerFrame } from '../game/poseSource'
import type { PartyFrame, PeopleFeed } from './multiPose'

/** A claimed slot keeps its dancer this long after they vanish (ms). */
export const HOLD_MS = 1500
/** Largest hip-centre jump (in torso lengths) still taken as the same dancer between frames. */
export const GATE_TORSOS = 1.6
/** Two detections closer than this (torso lengths) are one person seen twice. */
export const DUPLICATE_TORSOS = 0.35

export interface Detection {
  /** Mid-hip, raw video px. */
  x: number
  y: number
  /** Torso length, px (> 0). */
  size: number
  /** Mean joint visibility, for picking between duplicates. */
  quality: number
}

export interface Slot {
  x: number
  y: number
  size: number
  seenMs: number
}

/** Per player slot: where its dancer was last seen, or null while unclaimed. */
export type TrackState = readonly (Slot | null)[]

export interface TrackOptions {
  /** Video width (px), for the unclaimed slots' home spots. */
  width: number
  /** The players see a mirrored view (the default): slot 0 is on the left of the mirror = right of the raw image. */
  mirrored: boolean
  holdMs?: number
  gateTorsos?: number
}

export const emptyTrack = (players: number): TrackState => Array.from({ length: players }, () => null)

/** The detection for a person's frame (null without a usable torso). */
export function detectionOf(f: PlayerFrame): Detection | null {
  const im = f.image
  if (!f.valid || !im?.l_hip || !im.r_hip || !im.l_shoulder || !im.r_shoulder) return null
  const x = (im.l_hip[0] + im.r_hip[0]) / 2
  const y = (im.l_hip[1] + im.r_hip[1]) / 2
  const size = Math.hypot((im.l_shoulder[0] + im.r_shoulder[0]) / 2 - x, (im.l_shoulder[1] + im.r_shoulder[1]) / 2 - y)
  if (!(size > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const vis = Object.values(f.visibility)
  const quality = vis.length > 0 ? vis.reduce((a, v) => a + (v ?? 0), 0) / vis.length : 0
  return { x, y, size, quality }
}

/** Indices of `dets` to keep: of two detections within DUPLICATE_TORSOS of each other, the better one. */
export function dedupe(dets: readonly Detection[]): number[] {
  const order = dets.map((_, i) => i).sort((a, b) => dets[b].quality - dets[a].quality)
  const kept: number[] = []
  for (const i of order) {
    const d = dets[i]
    const dup = kept.some((k) => Math.hypot(dets[k].x - d.x, dets[k].y - d.y) < DUPLICATE_TORSOS * Math.max(d.size, dets[k].size))
    if (!dup) kept.push(i)
  }
  return kept.sort((a, b) => a - b)
}

/** Raw-image x of an unclaimed slot's home spot. */
export function homeX(slot: number, players: number, width: number, mirrored: boolean): number {
  const screenX = ((slot + 0.5) / players) * width
  return mirrored ? width - screenX : screenX
}

/**
 * Best assignment of `cands` (detection indices) to `slots`: maximizes the summed gain over matched
 * pairs (pairs with gain <= 0 are not allowed). Exhaustive: at most 4 slots x 4 people.
 */
function bestMatch(slots: readonly number[], cands: readonly number[], gain: (slot: number, det: number) => number): Map<number, number> {
  let best = new Map<number, number>()
  let bestGain = 0
  const cur = new Map<number, number>()
  const used = new Set<number>()
  const walk = (k: number, total: number): void => {
    if (k === slots.length) {
      if (total > bestGain + 1e-9) {
        bestGain = total
        best = new Map(cur)
      }
      return
    }
    walk(k + 1, total) // this slot stays unmatched
    for (const d of cands) {
      if (used.has(d)) continue
      const g = gain(slots[k], d)
      if (!(g > 0)) continue
      used.add(d)
      cur.set(slots[k], d)
      walk(k + 1, total + g)
      cur.delete(slots[k])
      used.delete(d)
    }
  }
  walk(0, 0)
  return best
}

export interface TrackResult {
  state: TrackState
  /** assign[slot] = index into the detections, or null when that player isn't seen this frame. */
  assign: (number | null)[]
}

/** Matches this frame's detections to the player slots (see the file comment). Pure. */
export function trackPeople(state: TrackState, dets: readonly Detection[], nowMs: number, opts: TrackOptions): TrackResult {
  const n = state.length
  const hold = opts.holdMs ?? HOLD_MS
  const gate = opts.gateTorsos ?? GATE_TORSOS
  const assign: (number | null)[] = Array.from({ length: n }, () => null)
  const live: number[] = []
  const free: number[] = []
  state.forEach((s, i) => (s && nowMs - s.seenMs <= hold ? live : free).push(i))

  // 1. claimed slots follow their dancer (nearest hip centre within the gate)
  const cands = dedupe(dets)
  const follow = bestMatch(live, cands, (slot, d) => {
    const s = state[slot] as Slot
    const det = dets[d]
    const dist = Math.hypot(det.x - s.x, det.y - s.y) / Math.max(s.size, det.size)
    return gate - dist
  })
  for (const [slot, d] of follow) assign[slot] = d

  // 2. newcomers take the free slots nearest to them (home spots for never-claimed slots)
  const taken = new Set(follow.values())
  const rest = cands.filter((d) => !taken.has(d))
  if (rest.length > 0 && free.length > 0) {
    const far = 4 * opts.width // every distance is below this, so the most newcomers get placed
    const claim = bestMatch(free, rest, (slot, d) => {
      const s = state[slot]
      const det = dets[d]
      const dist = s ? Math.hypot(det.x - s.x, det.y - s.y) : Math.abs(det.x - homeX(slot, n, opts.width, opts.mirrored))
      return far - dist
    })
    for (const [slot, d] of claim) assign[slot] = d
  }

  const next = state.map((s, i) => {
    const d = assign[i]
    if (d === null) return s
    const det = dets[d]
    return { x: det.x, y: det.y, size: det.size, seenMs: nowMs }
  })
  return { state: next, assign }
}

// --- the stateful wrapper around a feed ------------------------------------------------------

/** One camera frame, per player: their frame, or null when not seen. */
export interface TrackedFrame {
  songTime: number
  captureMs: number
  videoWidth: number
  videoHeight: number
  players: (PlayerFrame | null)[]
  /** People detected (after merging duplicates), including ones without a free slot. */
  detected: number
}

export class PartyTracker {
  private state: TrackState
  private last: TrackedFrame | null = null
  private readonly listeners = new Set<(t: TrackedFrame) => void>()
  private readonly unsubscribe: () => void
  private readonly mirrored: boolean
  readonly players: number

  constructor(feed: PeopleFeed, players: number, opts: { mirrored?: boolean } = {}) {
    this.players = players
    this.mirrored = opts.mirrored ?? true
    this.state = emptyTrack(players)
    this.unsubscribe = feed.onPeople((f) => this.update(f))
  }

  /** Feeds one camera frame (the feed subscription calls this; tests may too). */
  update(f: PartyFrame): TrackedFrame {
    const dets: Detection[] = []
    const frameOf: PlayerFrame[] = []
    for (const p of f.people) {
      const d = detectionOf(p)
      if (!d) continue
      dets.push(d)
      frameOf.push(p)
    }
    const r = trackPeople(this.state, dets, f.captureMs, { width: f.videoWidth, mirrored: this.mirrored })
    this.state = r.state
    const t: TrackedFrame = {
      songTime: f.songTime,
      captureMs: f.captureMs,
      videoWidth: f.videoWidth,
      videoHeight: f.videoHeight,
      players: r.assign.map((d) => (d === null ? null : frameOf[d])),
      detected: dedupe(dets).length,
    }
    this.last = t
    for (const cb of [...this.listeners]) cb(t)
    return t
  }

  latest(): TrackedFrame | null {
    return this.last
  }

  onTracked(cb: (t: TrackedFrame) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Everyone forgets their slot (a new line-up). */
  reset(): void {
    this.state = emptyTrack(this.players)
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }
}
