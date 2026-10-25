import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pose2D, Vec2 } from '@shared/skeleton'
import { NEUTRAL_POSE } from '../routine/pose'
import {
  COACH_THEMES,
  coachShape,
  coachThemeFor,
  drawCoach,
  hexToRgb,
  highlightPrims,
  mixHex,
  signedArea,
  tracePrim,
  withAlpha,
  type CoachPrim,
} from './coach'
import type { FigureView } from './stickFigure'
import { RecordingPath, stubContext } from './stubCanvas'

const VIEW: FigureView = { cx: 400, floorY: 900, scale: 180, mirrored: true }

const byPart = (prims: CoachPrim[], part: string): CoachPrim | undefined => prims.find((p) => p.part === part)

describe('themes and colours', () => {
  it('maps section labels to themes, defaulting to intro', () => {
    expect(coachThemeFor('chorus')).toBe(COACH_THEMES.chorus)
    expect(coachThemeFor(null)).toBe(COACH_THEMES.intro)
    expect(coachThemeFor('mystery')).toBe(COACH_THEMES.intro)
    expect(coachThemeFor('constructor')).toBe(COACH_THEMES.intro)
    for (const t of Object.values(COACH_THEMES)) {
      // Bodies stay bright for projectors.
      const [r, g, b] = hexToRgb(t.body)
      expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(225)
    }
  })

  it('parses, mixes and fades hex colours', () => {
    expect(hexToRgb('#ff8000')).toEqual([255, 128, 0])
    expect(hexToRgb('#fff')).toEqual([255, 255, 255])
    expect(hexToRgb('nope')).toEqual([0, 0, 0])
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#102030', '#ffffff', 0)).toBe('#102030')
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)')
    expect(withAlpha('#ff0000', 3)).toBe('rgba(255, 0, 0, 1)')
  })
})

describe('coachShape', () => {
  it('builds a full silhouette for the neutral pose with tapered limbs', () => {
    const prims = coachShape(NEUTRAL_POSE, [0, 0], VIEW)
    expect(prims).toHaveLength(15) // torso, neck, head, 8 limbs, 2 hands, 2 feet
    const ua = byPart(prims, 'r_upper_arm')
    const fa = byPart(prims, 'r_forearm')
    const th = byPart(prims, 'r_thigh')
    const sh = byPart(prims, 'r_shin')
    if (ua?.kind !== 'capsule' || fa?.kind !== 'capsule' || th?.kind !== 'capsule' || sh?.kind !== 'capsule') throw new Error('limbs missing')
    expect(ua.ra).toBeGreaterThan(ua.rb)
    expect(fa.ra).toBeCloseTo(ua.rb) // smooth at the elbow
    expect(fa.ra).toBeGreaterThan(fa.rb)
    expect(th.ra).toBeGreaterThan(ua.ra) // thigh thicker than the upper arm
    expect(sh.ra).toBeCloseTo(th.rb)
    for (const p of prims) {
      const nums = p.kind === 'blob' ? p.pts.flat() : p.kind === 'ellipse' ? [...p.c, p.rx, p.ry, p.rot] : [...p.a, ...p.b, p.ra, p.rb]
      for (const v of nums) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('respects mirroring and keeps the torso outline clockwise', () => {
    for (const mirrored of [true, false]) {
      const prims = coachShape(NEUTRAL_POSE, [0, 0], { ...VIEW, mirrored })
      const fa = byPart(prims, 'r_forearm')
      if (fa?.kind !== 'capsule') throw new Error('no forearm')
      expect(fa.b[0] > VIEW.cx).toBe(mirrored) // dancer's right hand on screen right when mirrored
      const torso = byPart(prims, 'torso')
      if (torso?.kind !== 'blob') throw new Error('no torso')
      expect(signedArea(torso.pts)).toBeGreaterThan(0)
    }
  })

  it('drops parts whose joints are missing and keeps a spinning torso wide', () => {
    const upper: Pose2D = { nose: [0, -1.45], l_shoulder: [-0.45, -1], r_shoulder: [0.45, -1], l_elbow: [-0.5, -0.4], l_wrist: [-0.5, 0.1] }
    const prims = coachShape(upper, [0, 0], VIEW)
    expect(prims.map((p) => p.part).sort()).toEqual(['head', 'l_forearm', 'l_hand', 'l_upper_arm'])
    const side: Pose2D = { ...NEUTRAL_POSE, l_shoulder: [0, -1], r_shoulder: [0, -1], l_hip: [0, 0], r_hip: [0, 0] }
    const torso = byPart(coachShape(side, [0, 0], VIEW), 'torso')
    if (torso?.kind !== 'blob') throw new Error('no torso')
    const xs = torso.pts.map((p) => p[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.3 * VIEW.scale)
    expect(coachShape(NEUTRAL_POSE, [0, 0], { ...VIEW, scale: 0 })).toEqual([])
  })

  it('highlights scored limbs as gloves (forearm + hand) and sleeves (upper arm, from 30%)', () => {
    const prims = coachShape(NEUTRAL_POSE, [0, 0], VIEW)
    expect(highlightPrims(prims, ['r_wrist']).map((p) => p.part)).toEqual(['r_forearm', 'r_hand'])
    const sleeve = highlightPrims(prims, ['l_elbow'])
    const ua = byPart(prims, 'l_upper_arm')
    expect(sleeve).toHaveLength(1)
    if (sleeve[0].kind !== 'capsule' || ua?.kind !== 'capsule') throw new Error('no sleeve')
    expect(sleeve[0].b).toEqual(ua.b)
    expect(sleeve[0].a[1]).toBeGreaterThan(ua.a[1])
    expect(highlightPrims(prims, [])).toEqual([])
  })
})

describe('tracePrim', () => {
  it('traces tapered capsules clockwise with tangent sides', () => {
    const a: Vec2 = [100, 100]
    const b: Vec2 = [180, 160]
    const path = new RecordingPath()
    tracePrim(path, { kind: 'capsule', part: 'r_forearm', a, b, ra: 20, rb: 10 })
    const arcs = path.ops.filter((o) => o.name === 'arc').map((o) => o.args as number[])
    expect(path.ops[0].name).toBe('moveTo')
    expect(arcs).toHaveLength(2)
    for (const [, , , a0, a1] of arcs) expect(a1).toBeGreaterThan(a0) // clockwise on screen
    // The side from the end of arc A to the start of arc B is tangent to both circles.
    const endA: Vec2 = [a[0] + 20 * Math.cos(arcs[0][4]), a[1] + 20 * Math.sin(arcs[0][4])]
    const startB: Vec2 = [b[0] + 10 * Math.cos(arcs[1][3]), b[1] + 10 * Math.sin(arcs[1][3])]
    const n: Vec2 = [Math.cos(arcs[1][3]), Math.sin(arcs[1][3])]
    expect((startB[0] - endA[0]) * n[0] + (startB[1] - endA[1]) * n[1]).toBeCloseTo(0, 9)
    // Degenerate capsule: a disc.
    const disc = new RecordingPath()
    tracePrim(disc, { kind: 'capsule', part: 'r_forearm', a, b: [101, 100], ra: 20, rb: 10 })
    expect(disc.ops.filter((o) => o.name === 'arc')).toHaveLength(1)
  })
})

describe('drawCoach', () => {
  beforeEach(() => vi.stubGlobal('Path2D', RecordingPath))
  afterEach(() => vi.unstubAllGlobals())

  it('fills the body once with a glow, then seams, shading and accents, and restores state', () => {
    const { ctx, calls } = stubContext(2)
    drawCoach(ctx, NEUTRAL_POSE, [0, 0], VIEW, { theme: coachThemeFor('verse'), beatPulse: 1, highlightJoints: ['r_wrist'] })
    const names = calls.map((c) => c.name)
    expect(names).toContain('getTransform') // pixel ratio for shadowBlur
    expect(names[0]).not.toBe('restore')
    expect(names.filter((n) => n === 'save').length).toBe(names.filter((n) => n === 'restore').length)
    expect(names.at(-1)).toBe('restore')
    // Union body (glow), 2 legs, torso/head, 2 arms, shading, gloves + tiara.
    expect(names.filter((n) => n === 'fill')).toHaveLength(8)
    expect(names.filter((n) => n === 'stroke')).toHaveLength(5) // seams: legs, torso/head, arms
  })

  it('draws nothing without a usable view', () => {
    const { ctx, calls } = stubContext()
    drawCoach(ctx, NEUTRAL_POSE, [0, 0], { ...VIEW, scale: 0 })
    expect(calls).toHaveLength(0)
  })
})
