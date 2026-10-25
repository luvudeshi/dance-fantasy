import { describe, expect, it } from 'vitest'
import { coachThemeFor } from './coach'
import { drawStage, stageLayout, starField, twinkle } from './stage'
import { fitFigureView } from './stickFigure'
import { stubContext } from './stubCanvas'

describe('stage helpers', () => {
  it('has a deterministic star field', () => {
    const a = starField(50, 3)
    expect(starField(50, 3)).toEqual(a)
    expect(starField(50, 4)).not.toEqual(a)
    for (const s of a) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThan(1)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThan(1)
    }
  })

  it('twinkles within [0.15, 1] and survives NaN time', () => {
    const [s] = starField(1)
    for (let t = 0; t < 10; t += 0.13) {
      const v = twinkle(s, t)
      expect(v).toBeGreaterThanOrEqual(0.15)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(twinkle(s, Number.NaN)).toBe(0.6)
  })

  it('puts the floor under a full-canvas coach by default', () => {
    const v = fitFigureView(1920, 1080)
    expect(stageLayout({ width: 1920, height: 1080 })).toEqual({ floorX: v.cx, floorY: v.floorY, scale: v.scale })
    expect(stageLayout({ width: 1920, height: 1080, floor: { x: 500, y: 900, scale: 150 } })).toEqual({ floorX: 500, floorY: 900, scale: 150 })
  })
})

describe('drawStage', () => {
  it('draws (without a DOM: straight onto the context) and restores state', () => {
    const { ctx, calls } = stubContext(2)
    drawStage(ctx, { width: 1280, height: 720, time: 12.3, beatPulse: 0.7, theme: coachThemeFor('chorus') })
    const names = calls.map((c) => c.name)
    expect(names[0]).toBe('save')
    expect(names.at(-1)).toBe('restore')
    expect(names.filter((n) => n === 'save').length).toBe(names.filter((n) => n === 'restore').length)
    expect(names.filter((n) => n === 'fillRect').length).toBeGreaterThan(90) // stars
    const empty = stubContext()
    drawStage(empty.ctx, { width: 0, height: 720, time: 0, beatPulse: 0, theme: coachThemeFor(null) })
    expect(empty.calls).toHaveLength(0)
  })
})
