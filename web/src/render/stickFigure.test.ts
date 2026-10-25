import { describe, expect, it, vi } from 'vitest'
import { bodyToScreen } from '../pose/normalize'
import type { Ctx2D } from '../pose/draw'
import { DEMO_LIBRARY } from '../routine/demo'
import { NEUTRAL_POSE } from '../routine/pose'
import { drawFigure, figureBodyView, fitFigureView, headCircle, highlightedLimbs, type FigureView } from './stickFigure'

const VIEW: FigureView = { cx: 200, floorY: 500, scale: 100, mirrored: true }

describe('figure view math', () => {
  it('stands neutral ankles on the floor and mid-hip above it', () => {
    const bv = figureBodyView(VIEW, [0, 0])
    expect(bodyToScreen(NEUTRAL_POSE.l_ankle, bv)[1]).toBeCloseTo(500)
    expect(bv).toEqual({ cx: 200, cy: 315, scale: 100, mirrored: true })
  })

  it('applies root like a body-frame offset (mirrored and true view)', () => {
    expect(figureBodyView(VIEW, [0.3, -0.5])).toMatchObject({ cx: 230, cy: 265 })
    expect(figureBodyView({ ...VIEW, mirrored: false }, [0.3, -0.5])).toMatchObject({ cx: 170, cy: 265 })
    // Mirrored: the dancer's right wrist is on screen right.
    const bv = figureBodyView(VIEW, [0, 0])
    expect(bodyToScreen(NEUTRAL_POSE.r_wrist, bv)[0]).toBeGreaterThan(200)
    expect(bodyToScreen(NEUTRAL_POSE.r_wrist, { ...bv, mirrored: false })[0]).toBeLessThan(200)
  })

  it('fits every demo keyframe (incl. jumps and overhead arms) inside the box', () => {
    const w = 180
    const h = 220
    const view = fitFigureView(w, h)
    for (const m of DEMO_LIBRARY.moves) {
      for (const k of m.keyframes) {
        const bv = figureBodyView(view, k.root)
        for (const p of Object.values(k.pose)) {
          const [x, y] = bodyToScreen(p, bv)
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(w)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(y).toBeLessThanOrEqual(h)
        }
      }
    }
  })
})

describe('highlightedLimbs', () => {
  it('uses the distal-joint rule; shoulders mark the torso', () => {
    expect([...highlightedLimbs(['r_wrist'])]).toEqual(['r_forearm'])
    expect(highlightedLimbs(['l_elbow', 'l_ankle'])).toEqual(new Set(['l_upper_arm', 'l_shin']))
    expect(highlightedLimbs(['r_shoulder']).has('torso')).toBe(true)
    expect(highlightedLimbs([]).size).toBe(0)
  })
})

describe('headCircle', () => {
  it('centres on the face joints with a sensible radius', () => {
    const h = headCircle(NEUTRAL_POSE)
    expect(h?.center[0]).toBeCloseTo(0)
    expect(h?.center[1]).toBeCloseTo(-1.49)
    expect(h?.radius).toBeCloseTo(0.225)
    expect(headCircle({ l_wrist: [0, 0] })).toBeNull()
    expect(headCircle({ nose: [0.1, -1.4] })).toEqual({ center: [0.1, -1.4], radius: 0.22 })
  })

  it('keeps its size as the head turns into profile', () => {
    // Server FK head: ears (+-0.15, z -0.02), nose (0, z 0.15) around the neck; turned by psi.
    const radiusAt = (psi: number): number => {
      const x = (bx: number, z: number): number => bx * Math.cos(psi) + z * Math.sin(psi)
      const h = headCircle({ nose: [x(0, 0.15), -1.45], l_ear: [x(-0.15, -0.02), -1.48], r_ear: [x(0.15, -0.02), -1.48] })
      return h?.radius ?? 0
    }
    const front = radiusAt(0)
    for (const deg of [30, 66.4, 90]) expect(radiusAt((deg * Math.PI) / 180) / front).toBeGreaterThan(0.9)
    for (const deg of [30, 66.4, 90]) expect(radiusAt((deg * Math.PI) / 180) / front).toBeLessThan(1.15)
  })
})

describe('drawFigure', () => {
  it('draws with a stub context and restores its state', () => {
    const calls: string[] = []
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== 'string') return undefined
          return vi.fn(() => calls.push(prop))
        },
        set: () => true,
      },
    ) as unknown as Ctx2D
    drawFigure(ctx, NEUTRAL_POSE, [0, 0], VIEW, {
      lineWidth: 10,
      color: '#fff',
      leftColor: '#0ff',
      rightColor: '#f0f',
      glow: 12,
      highlightJoints: ['r_wrist'],
    })
    expect(calls[0]).toBe('save')
    expect(calls.at(-1)).toBe('restore')
    expect(calls.filter((c) => c === 'stroke').length).toBeGreaterThanOrEqual(8)
  })
})
