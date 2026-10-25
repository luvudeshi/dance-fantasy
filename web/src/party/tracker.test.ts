import { describe, expect, it } from 'vitest'
import { NEUTRAL_POSE } from '../routine/pose'
import type { LandmarkLike } from '../pose/normalize'
import { peopleFrame, type PartyFrame, type PeopleFeed } from './multiPose'
import { FAKE_VIDEO, poseToLandmarks } from './synthetic'
import { dedupe, detectionOf, HOLD_MS, homeX, PartyTracker, trackPeople, emptyTrack, type Detection } from './tracker'

const { width: W, height: H } = FAKE_VIDEO
const TORSO = 80

/** A person standing with mid-hip at SCREEN fraction sx of a mirrored view (raw x = W - sx * W). */
const person = (sx: number, opts: { torso?: number; vis?: number; y?: number } = {}): LandmarkLike[] =>
  poseToLandmarks(NEUTRAL_POSE, { hipX: W - sx * W, hipY: opts.y ?? 300, torsoPx: opts.torso ?? TORSO, visibility: opts.vis }, W, H)

const frame = (ms: number, people: LandmarkLike[][]): PartyFrame =>
  peopleFrame(people, W, H, { songTime: ms / 1000, rawSongTime: ms / 1000, captureMs: ms, videoWidth: W, videoHeight: H })

const noFeed: PeopleFeed = { onPeople: () => () => undefined, latestPeople: () => null }

/** Screen fraction of the dancer a tracked frame gives each slot (null = unseen). */
const screenXs = (t: PartyTracker, f: PartyFrame): (number | null)[] =>
  t.update(f).players.map((p) => {
    const d = p ? detectionOf(p) : null
    return d ? Math.round((1 - d.x / W) * 100) / 100 : null
  })

describe('synthetic landmarks round-trip through the single-player normalization', () => {
  it('poseToLandmarks is the inverse of landmarksToPlayerPose', () => {
    const f = frame(0, [person(0.5)])
    expect(f.people).toHaveLength(1)
    const p = f.people[0]
    for (const j of ['l_wrist', 'r_ankle', 'nose'] as const) {
      expect(p.pose[j]?.[0]).toBeCloseTo(NEUTRAL_POSE[j][0], 6)
      expect(p.pose[j]?.[1]).toBeCloseTo(NEUTRAL_POSE[j][1], 6)
    }
    expect(detectionOf(p)?.size).toBeCloseTo(TORSO, 6)
  })
})

describe('trackPeople', () => {
  it('home spots run left to right across the mirror', () => {
    expect(homeX(0, 3, 600, true)).toBeCloseTo(500)
    expect(homeX(2, 3, 600, true)).toBeCloseTo(100)
    expect(homeX(0, 3, 600, false)).toBeCloseTo(100)
  })

  it('first frame: slots go left to right as the players see the mirror, whatever MediaPipe order', () => {
    const t = new PartyTracker(noFeed, 3)
    expect(screenXs(t, frame(0, [person(0.8), person(0.2), person(0.5)]))).toEqual([0.2, 0.5, 0.8])
  })

  it('an unmirrored view orders by the raw image instead', () => {
    const t = new PartyTracker(noFeed, 2, { mirrored: false })
    expect(screenXs(t, frame(0, [person(0.3), person(0.7)]))).toEqual([0.7, 0.3])
  })

  it('identities stick while MediaPipe shuffles its order and people sway', () => {
    const t = new PartyTracker(noFeed, 3)
    screenXs(t, frame(0, [person(0.2), person(0.5), person(0.8)]))
    for (let k = 1; k <= 30; k++) {
      const s = 0.03 * Math.sin(k)
      const people = [person(0.2 + s), person(0.5 - s), person(0.8 + s)]
      const shuffled = k % 2 ? [people[2], people[0], people[1]] : [people[1], people[2], people[0]]
      const xs = screenXs(t, frame(k * 33, shuffled))
      expect(xs[0]).toBeLessThan(0.3)
      expect(xs[1]).toBeGreaterThan(0.4)
      expect(xs[1]).toBeLessThan(0.6)
      expect(xs[2]).toBeGreaterThan(0.7)
    }
  })

  it('two dancers who swap places keep their slots (nearest match, not left-to-right)', () => {
    const t = new PartyTracker(noFeed, 2)
    let xs = screenXs(t, frame(0, [person(0.3), person(0.7)]))
    expect(xs).toEqual([0.3, 0.7])
    // they walk past each other at different depths (one closer to the camera: lower and bigger)
    for (let k = 1; k <= 20; k++) {
      const a = 0.3 + (0.4 * k) / 20
      const b = 0.7 - (0.4 * k) / 20
      xs = screenXs(t, frame(k * 33, [person(b, { y: 340, torso: 90 }), person(a)]))
    }
    expect(xs).toEqual([0.7, 0.3])
  })

  it('a dancer who steps out briefly gets their slot back; after HOLD_MS a newcomer can take it', () => {
    const t = new PartyTracker(noFeed, 3)
    screenXs(t, frame(0, [person(0.2), person(0.5), person(0.8)]))
    // the middle dancer leaves for 1 s: their slot stays empty, nobody else moves
    expect(screenXs(t, frame(500, [person(0.2), person(0.8)]))).toEqual([0.2, null, 0.8])
    expect(screenXs(t, frame(1000, [person(0.8), person(0.52), person(0.2)]))).toEqual([0.2, 0.52, 0.8])
    // now they leave for longer than the hold; someone new turns up on the far left of the free spot
    screenXs(t, frame(1100, [person(0.2), person(0.8)]))
    const late = 1100 + HOLD_MS + 100
    expect(screenXs(t, frame(late, [person(0.2), person(0.8), person(0.35)]))).toEqual([0.2, 0.35, 0.8])
  })

  it('a re-entering dancer far from their old spot does not steal a held slot', () => {
    const t = new PartyTracker(noFeed, 2)
    screenXs(t, frame(0, [person(0.25), person(0.75)]))
    // slot 1 vanishes; a detection appears right next to slot 0 (a duplicate-ish second person)
    expect(screenXs(t, frame(100, [person(0.25)]))).toEqual([0.25, null])
    expect(screenXs(t, frame(200, [person(0.25), person(0.05)]))).toEqual([0.25, null])
  })

  it('a latecomer in the middle takes the middle slot', () => {
    const t = new PartyTracker(noFeed, 3)
    expect(screenXs(t, frame(0, [person(0.17), person(0.83)]))).toEqual([0.17, null, 0.83])
    expect(screenXs(t, frame(33, [person(0.5), person(0.17), person(0.83)]))).toEqual([0.17, 0.5, 0.83])
  })

  it('more people than slots: the extra one is counted but not assigned', () => {
    const t = new PartyTracker(noFeed, 2)
    const r = t.update(frame(0, [person(0.2), person(0.5), person(0.8)]))
    expect(r.detected).toBe(3)
    expect(r.players.filter(Boolean)).toHaveLength(2)
  })

  it('merges duplicate detections of one person, keeping the clearer one', () => {
    const t = new PartyTracker(noFeed, 2)
    const r = t.update(frame(0, [person(0.5, { vis: 0.6 }), person(0.505, { vis: 0.9 })]))
    expect(r.detected).toBe(1)
    expect(r.players.filter(Boolean)).toHaveLength(1)
    const d: Detection[] = [
      { x: 100, y: 100, size: 50, quality: 0.5 },
      { x: 105, y: 100, size: 50, quality: 0.9 },
      { x: 300, y: 100, size: 50, quality: 0.1 },
    ]
    expect(dedupe(d)).toEqual([1, 2])
  })

  it('is pure: the input state is not modified', () => {
    const s0 = emptyTrack(2)
    const r = trackPeople(s0, [{ x: 100, y: 100, size: 40, quality: 1 }], 0, { width: 640, mirrored: true })
    expect(s0).toEqual([null, null])
    expect(r.assign).toEqual([null, 0])
  })

  it('follows a feed between attach and detach', () => {
    const cbs = new Set<(f: PartyFrame) => void>()
    const feed: PeopleFeed = {
      onPeople: (cb) => {
        cbs.add(cb)
        return () => cbs.delete(cb)
      },
      latestPeople: () => null,
    }
    const t = new PartyTracker(feed, 2)
    expect(cbs.size).toBe(0)
    const detach = t.attach()
    const seen: number[] = []
    t.onTracked((x) => seen.push(x.detected))
    for (const cb of cbs) cb(frame(0, [person(0.3)]))
    detach()
    expect(cbs.size).toBe(0)
    expect(seen).toEqual([1])
    expect(t.latest()?.detected).toBe(1)
  })
})
