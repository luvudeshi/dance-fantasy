import { describe, expect, it } from 'vitest'
import type { Pose2D, Vec2 } from '@shared/skeleton'
import { bodyToScreen } from '../pose/normalize'
import { NEUTRAL_POSE } from '../routine/pose'
import { figureBodyView, type FigureView } from '../render/stickFigure'
import { BONE_LENGTH } from './lift'
import { buildRig, SKIRT_RINGS, SKIRT_SEGMENTS, type Basis } from './rig'

const VIEW: FigureView = { cx: 400, floorY: 900, scale: 180, mirrored: true }

const det = (b: Basis): number =>
  b.x[0] * (b.y[1] * b.z[2] - b.y[2] * b.z[1]) - b.y[0] * (b.x[1] * b.z[2] - b.x[2] * b.z[1]) + b.z[0] * (b.x[1] * b.y[2] - b.x[2] * b.y[1])

/** Screen point (y down) of a rig origin. */
const screen = (b: Basis | undefined): Vec2 => (b ? [b.o[0], -b.o[1]] : [Number.NaN, Number.NaN])

describe('buildRig', () => {
  it('puts every joint exactly where the 2D coach draws it, mirrored or not', () => {
    for (const mirrored of [true, false]) {
      const view = { ...VIEW, mirrored }
      const root: Vec2 = [0.3, -0.2]
      const rig = buildRig(NEUTRAL_POSE, root, view)
      const bv = figureBodyView(view, root)
      for (const j of ['l_elbow', 'r_knee', 'l_ankle', 'r_shoulder'] as const) {
        const [x, y] = bodyToScreen(NEUTRAL_POSE[j], bv)
        expect(screen(rig.parts[j])[0]).toBeCloseTo(x, 6)
        expect(screen(rig.parts[j])[1]).toBeCloseTo(y, 6)
      }
      // Mirrored (the player's reflection): the dancer's left arm is on the screen's left.
      expect((rig.parts.l_elbow?.o[0] ?? 0) < (rig.parts.r_elbow?.o[0] ?? 0)).toBe(mirrored)
    }
  })

  it('builds right-handed frames with limbs spanning their joints at full bone length', () => {
    const rig = buildRig(NEUTRAL_POSE, [0, 0], VIEW)
    const names = Object.keys(rig.parts)
    expect(names).toEqual(expect.arrayContaining(['torso', 'head', 'neck', 'sash', 'l_hand', 'r_foot', 'l_upper_arm', 'r_shin']))
    for (const b of Object.values(rig.parts)) expect(det(b)).toBeGreaterThan(0)
    const thigh = rig.parts.r_thigh
    expect(thigh && Math.hypot(...thigh.y)).toBeCloseTo(BONE_LENGTH.thigh * VIEW.scale, 3)
    expect(screen(thigh)).toEqual(screen(rig.parts.r_hip))
  })

  it('hangs the skirt from the waist and lifts its hem over a raised knee', () => {
    const at = (rig: ReturnType<typeof buildRig>, ring: number, seg: number): [number, number, number] => {
      const s = rig.skirt
      if (!s) throw new Error('no skirt')
      const o = (ring * SKIRT_SEGMENTS + seg) * 3
      return [s[o], s[o + 1], s[o + 2]]
    }
    const flat = buildRig(NEUTRAL_POSE, [0, 0], VIEW)
    expect(flat.skirt).toHaveLength(SKIRT_RINGS * SKIRT_SEGMENTS * 3)
    const front = SKIRT_SEGMENTS / 4 // theta = 90 deg: the dancer's front
    const hem = SKIRT_RINGS - 1
    const waistY = at(flat, 0, front)[1]
    const hemY = at(flat, hem, front)[1]
    expect(waistY - hemY).toBeGreaterThan(0.9 * VIEW.scale) // hangs about a torso length
    // Right knee lifted forward (2D: the knee rises and the thigh foreshortens).
    const kneeUp: Pose2D = { ...NEUTRAL_POSE, r_knee: [0.22, 0.3], r_ankle: [0.22, 1.2] }
    const lifted = buildRig(kneeUp, [0, 0], VIEW)
    expect(at(lifted, hem, front)[1]).toBeGreaterThan(hemY + 0.15 * VIEW.scale)
    expect(at(lifted, hem, front)[2]).toBeGreaterThan(at(flat, hem, front)[2])
    // The box holds the whole figure, gown included.
    for (let j = 0; j < SKIRT_SEGMENTS; j++) {
      const [x, y] = at(lifted, hem, j)
      expect(x).toBeGreaterThanOrEqual(lifted.box.x0)
      expect(x).toBeLessThanOrEqual(lifted.box.x1)
      expect(-y).toBeLessThanOrEqual(lifted.box.y1)
    }
  })

  it('degrades with missing joints and a zero scale', () => {
    const upper = buildRig({ l_shoulder: [-0.45, -1], r_shoulder: [0.45, -1], nose: [0, -1.45] }, [0, 0], VIEW)
    expect(upper.skirt).toBeNull()
    expect(upper.parts.torso).toBeUndefined()
    expect(upper.parts.head).toBeDefined()
    expect(Number.isFinite(upper.box.x0)).toBe(true)
    expect(Number.isFinite(buildRig({}, [0, 0], VIEW).box.x0)).toBe(false)
  })
})
