import { describe, expect, it } from 'vitest'
import { coachThemeFor } from '../render/coach'
import { stubContext } from '../render/stubCanvas'
import { NEUTRAL_POSE } from '../routine/pose'
import { drawCountIn, playLayout, popAnchor } from './render'

describe('count-in overlay', () => {
  const L = playLayout(1024, 768, true)
  const timeline = { countdown: { times: [1, 1.5, 2, 2.5], preRollSec: 0 } }
  const theme = coachThemeFor('intro')

  it('outlines each count digit before filling it, so it reads over the white coach', () => {
    const { ctx, calls } = stubContext()
    drawCountIn(ctx, L, timeline, 1.2, theme)
    const text = calls.filter((c) => c.name === 'strokeText' || c.name === 'fillText')
    expect(text.map((c) => [c.name, c.args[0]])).toEqual([
      ['strokeText', '3'],
      ['fillText', '3'],
    ])
    expect(text[0].args.slice(1)).toEqual(text[1].args.slice(1))
  })

  it('shows "Get ready…" before the count and nothing after "Dance!" fades', () => {
    const before = stubContext()
    drawCountIn(before.ctx, L, timeline, 0.5, theme)
    expect(before.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])).toEqual(['Get ready…'])
    const after = stubContext()
    drawCountIn(after.ctx, L, timeline, 10, theme)
    expect(after.calls.some((c) => c.name === 'fillText' || c.name === 'strokeText')).toBe(false)
  })
})

describe('play layout', () => {
  it('keeps the coach (floor and head) inside the area between the top bar and the cue strip', () => {
    for (const [w, h] of [[1024, 768], [1920, 1080], [390, 844]]) {
      const L = playLayout(w, h, true)
      expect(L.coach.floorY).toBeLessThanOrEqual(L.strip.y)
      expect(L.coach.floorY).toBeGreaterThan(L.coachArea.y)
      expect(L.hitX).toBeGreaterThan(L.strip.x)
    }
  })
})

describe('judgment pop anchor', () => {
  it('sits left of the coach\'s screen-left shoulder, above it, inside the coach area', () => {
    for (const mirrored of [true, false]) {
      const L = playLayout(1280, 720, mirrored)
      const [x, y] = popAnchor(NEUTRAL_POSE, [0, 0], L)
      const shoulderY = L.coach.floorY - (1.85 + 1) * L.coach.scale
      expect(x).toBeLessThan(L.coach.cx - 0.45 * L.coach.scale)
      expect(y).toBeLessThan(shoulderY)
      expect(x).toBeGreaterThan(L.coachArea.x)
      expect(y).toBeGreaterThan(L.coachArea.y)
    }
  })

  it('stays on screen on a narrow phone layout and without shoulders', () => {
    const L = playLayout(390, 844, true)
    for (const pose of [NEUTRAL_POSE, {}]) {
      const [x, y] = popAnchor(pose, [0, 0], L)
      expect(x).toBeGreaterThanOrEqual(L.coachArea.x)
      expect(x).toBeLessThanOrEqual(L.coachArea.x + L.coachArea.w)
      expect(y).toBeGreaterThanOrEqual(L.coachArea.y)
    }
  })
})
