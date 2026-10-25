import { describe, expect, it } from 'vitest'
import type { Pose2D } from '@shared/skeleton'
import { NEUTRAL_POSE } from '../routine/pose'
import { liftPose } from './lift'
import { bandVertices, profileRadius } from './parts3d'
import { DOUBLET, doubletSection } from './prince3d'

describe('profileRadius', () => {
  const pts = [
    [0, 0],
    [1, 1],
    [0.5, 2],
  ] as const
  it('interpolates between profile points and is 0 outside', () => {
    expect(profileRadius(pts, 0.5)).toBeCloseTo(0.5)
    expect(profileRadius(pts, 1.5)).toBeCloseTo(0.75)
    expect(profileRadius(pts, 2)).toBeCloseTo(0.5)
    expect(profileRadius(pts, -0.1)).toBe(0)
    expect(profileRadius(pts, 2.1)).toBe(0)
  })
})

describe('bandVertices', () => {
  it('hugs the doublet `lift` outside its surface, tilted from one shoulder to the other hip', () => {
    const segs = 48
    const lift = 0.02
    const depth = 0.62
    const v = bandVertices(DOUBLET, depth, 0.6, 0.3, 0.1, lift, segs)
    expect(v).toHaveLength(segs * 2 * 3)
    for (let i = 0; i < segs * 2; i++) {
      const [x, y, z] = [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]
      const r = profileRadius(DOUBLET, y) + lift
      expect(Math.hypot(x / r, z / (r * depth))).toBeCloseTo(1, 5)
    }
    // Centre height: y0 + tilt at u = 0 (+x side), y0 - tilt at u = pi; bottom edge first, width apart.
    const mid = (i: number): number => (v[i * 6 + 1] + v[i * 6 + 4]) / 2
    expect(mid(0)).toBeCloseTo(0.9)
    expect(mid(segs / 2)).toBeCloseTo(0.3)
    expect(v[4] - v[1]).toBeCloseTo(0.1)
  })
})

describe('doubletSection', () => {
  it('follows the doublet and ends at its hem and collar', () => {
    expect(doubletSection(0.92)?.[0]).toBeCloseTo(0.385)
    expect(doubletSection(0.4)?.[1]).toBeCloseTo(profileRadius(DOUBLET, 0.4) * 0.62)
    expect(doubletSection(-0.3)).toBeNull()
    expect(doubletSection(1.2)).toBeNull()
  })

  it('keeps a hand on the belly in front of the doublet', () => {
    const pose: Pose2D = { ...NEUTRAL_POSE, r_elbow: [0.46, -0.5], r_wrist: [-0.04, -0.4] }
    const lifted = liftPose(pose, doubletSection)
    const wrist = lifted.joints.r_wrist
    const elbow = lifted.joints.r_elbow
    if (!wrist || !elbow) throw new Error('arm missing')
    const front = (t: number): number => doubletSection(t)?.[1] ?? 0
    expect(wrist[2]).toBeGreaterThan(front(0.4) + 0.09)
    expect((wrist[2] + elbow[2]) / 2).toBeGreaterThan(front(0.45) + 0.06)
  })
})
