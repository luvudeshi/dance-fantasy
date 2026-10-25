import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryMove } from '@shared/moves'
import type { Vec2 } from '@shared/skeleton'
import { bodyToScreen } from '../pose/normalize'
import { DEMO_LIBRARY } from '../routine/demo'
import { NEUTRAL_POSE } from '../routine/pose'
import { drawPictogram, fitPointsView, keyFrameIndex, moveTrails } from './pictogram'
import { figureBodyView } from './stickFigure'
import { RecordingPath, stubContext } from './stubCanvas'

const demo = (id: string): LibraryMove => {
  const m = DEMO_LIBRARY.moves.find((x) => x.id === id)
  if (!m) throw new Error(`no demo move ${id}`)
  return m
}

describe('keyFrameIndex', () => {
  it('picks the keyframe farthest from the start anchor', () => {
    expect(keyFrameIndex(demo('arm_raise_R'))).toBe(1)
    expect(keyFrameIndex({ keyframes: [] })).toBe(0)
  })

  it('weighs the scored joints (and root) over the rest', () => {
    const kf = (t: number, o: Partial<typeof NEUTRAL_POSE>, root: Vec2 = [0, 0]) => ({ t, pose: { ...NEUTRAL_POSE, ...o }, root })
    const move = {
      keyframes: [kf(0, {}), kf(0.3, { l_wrist: [-1.5, -2] }), kf(0.6, { r_wrist: [0.9, -0.6] }), kf(1, {})],
      scoredJoints: ['r_wrist' as const],
    }
    expect(keyFrameIndex(move)).toBe(2)
    expect(keyFrameIndex({ keyframes: move.keyframes })).toBe(1) // unscored: all joints count
    const jump = { keyframes: [kf(0, {}), kf(0.5, {}, [0, -0.6]), kf(1, {})], scoredJoints: ['l_ankle' as const] }
    expect(keyFrameIndex(jump)).toBe(1)
  })
})

describe('moveTrails', () => {
  it('follows the scored hand and drops the return to the anchor', () => {
    const raise = demo('arm_raise_R')
    const t = moveTrails(raise)
    expect(t).toHaveLength(1)
    expect(t[0].joint).toBe('r_wrist')
    const close = (a: Vec2 | undefined, b: Vec2 | undefined) => expect(Math.hypot((a?.[0] ?? 9) - (b?.[0] ?? 0), (a?.[1] ?? 9) - (b?.[1] ?? 0))).toBeLessThan(1e-9)
    close(t[0].points[0], raise.keyframes[0].pose.r_wrist)
    close(t[0].points.at(-1), raise.keyframes[1].pose.r_wrist) // ends up high, at the key pose
    // Sampled from the rigid-limb track: the hand sweeps an arc (stays far from the shoulder).
    const sh = raise.keyframes[0].pose.r_shoulder as Vec2
    const reach = t[0].points.map((p) => Math.hypot(p[0] - sh[0], p[1] - sh[1]))
    expect(Math.min(...reach)).toBeGreaterThan(0.75 * Math.max(...reach))
    expect(moveTrails(raise)).toBe(t) // cached
    const wave = demo('royal_wave_R')
    const w = moveTrails(wave)[0].points
    expect(w).toHaveLength(3 * 12 + 1) // out, in, out (the return to neutral is dropped)
    close(w.at(-1), wave.keyframes[3].pose.r_wrist)
  })

  it('ignores unscored limbs and joints that barely move', () => {
    expect(moveTrails({ ...demo('arm_raise_R'), scoredJoints: [] })).toEqual([])
    const squat = moveTrails(demo('squat_clap'))
    expect(squat.map((t) => t.joint).sort()).toEqual(expect.arrayContaining(['l_wrist', 'r_wrist']))
  })
})

describe('fitPointsView', () => {
  it('fits every demo key pose and its trails inside the card, mirrored or not', () => {
    const box = { x: 10, y: 20, w: 90, h: 90 }
    for (const m of DEMO_LIBRARY.moves) {
      const k = m.keyframes[keyFrameIndex(m)]
      const pts: Vec2[] = Object.values(k.pose).map((p) => [p[0] + k.root[0], p[1] + k.root[1]])
      for (const t of moveTrails(m)) pts.push(...t.points)
      for (const mirrored of [true, false]) {
        const view = fitPointsView(pts, box, mirrored)
        const bv = figureBodyView(view, [0, 0])
        for (const p of pts) {
          const [x, y] = bodyToScreen(p, bv)
          expect(x).toBeGreaterThanOrEqual(box.x)
          expect(x).toBeLessThanOrEqual(box.x + box.w)
          expect(y).toBeGreaterThanOrEqual(box.y)
          expect(y).toBeLessThanOrEqual(box.y + box.h)
        }
      }
    }
  })
})

describe('drawPictogram', () => {
  beforeEach(() => vi.stubGlobal('Path2D', RecordingPath))
  afterEach(() => vi.unstubAllGlobals())

  it('draws a card with balanced save/restore, a figure, arrows and an optional label', () => {
    for (const active of [false, true]) {
      const { ctx, calls } = stubContext()
      drawPictogram(ctx, demo('royal_wave_R'), { x: 0, y: 0, w: 90, h: 90 }, { mirrored: true, active, label: true })
      const names = calls.map((c) => c.name)
      expect(names.filter((n) => n === 'save').length).toBe(names.filter((n) => n === 'restore').length)
      expect(names).toContain('clip')
      expect(names).toContain('fillText')
      expect(names.filter((n) => n === 'stroke').length).toBeGreaterThanOrEqual(3) // trail casing + trail + border
    }
    const bare = stubContext()
    drawPictogram(bare.ctx, demo('royal_wave_R'), { x: 0, y: 0, w: 90, h: 90 }, { mirrored: true, card: false })
    const bareNames = bare.calls.map((c) => c.name)
    expect(bareNames.filter((n) => n === 'save').length).toBe(bareNames.filter((n) => n === 'restore').length)
    expect(bareNames).not.toContain('fillRect') // no card background
    const { ctx, calls } = stubContext()
    drawPictogram(ctx, demo('royal_wave_R'), { x: 0, y: 0, w: 0, h: 90 }, { mirrored: true })
    expect(calls).toHaveLength(0)
  })
})
