import { describe, expect, it } from 'vitest'
import type { LimbName } from '@shared/skeleton'
import { stubContext } from '../render/stubCanvas'
import {
  COMBO_BREAK_MS,
  COMBO_BUMP_MS,
  COUNT_UP_MS,
  drawHud,
  drawPip,
  easeOutCubic,
  GLOW_MS,
  HINT_MS,
  Hud,
  JUDGMENT_STYLE,
  MAX_POPS,
  missHint,
  pipBox,
  pipImagePoints,
  POP_MS,
  popAlpha,
  popScale,
  retarget,
  tweenAt,
  tweenValue,
  UNSEEN_TOAST,
  UNSEEN_TOAST_HINT,
  UNSEEN_TOAST_MS,
  worstLimb,
} from './hud'
import { playLayout } from './render'
import type { CheckpointResult, Judgment, ScoreState } from './scoring'
import type { Ctx2D } from '../pose/draw'

/** The recording stub plus a measureText (the HUD's pills size themselves to their text). */
function measuringStub(): ReturnType<typeof stubContext> {
  const stub = stubContext()
  const ctx = new Proxy(stub.ctx, {
    get: (t, p) => (p === 'measureText' ? (s: string) => ({ width: s.length * 8 }) : Reflect.get(t, p)),
  }) as Ctx2D
  return { ctx, calls: stub.calls }
}

function result(judgment: Judgment, perLimb: Partial<Record<LimbName, number>> = {}, index = 0): CheckpointResult {
  return {
    checkpoint: { index, moveIndex: 0, time: index * 0.5, target: {}, limbs: Object.keys(perLimb) as LimbName[] },
    score: { perfect: 95, good: 75, ok: 55, miss: 10 }[judgment],
    judgment,
    offsetSec: 0,
    perLimb,
  }
}

function state(o: Partial<ScoreState> = {}): ScoreState {
  return { score: 0, combo: 0, maxCombo: 0, counts: { perfect: 0, good: 0, ok: 0, miss: 0 }, stars: 0, judged: 0, total: 10, ...o }
}

describe('count-up easing', () => {
  it('eases out from `from` to `to` over the duration, monotonically', () => {
    const tw = { from: 100, to: 300, at: 1000, dur: COUNT_UP_MS }
    expect(tweenValue(tw, 1000)).toBe(100)
    expect(tweenValue(tw, 500)).toBe(100) // before the start
    expect(tweenValue(tw, 1000 + COUNT_UP_MS)).toBe(300)
    expect(tweenValue(tw, 1e9)).toBe(300)
    let prev = -Infinity
    for (let ms = 1000; ms <= 1000 + COUNT_UP_MS; ms += 10) {
      const v = tweenValue(tw, ms)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
    // Ease-out: more than half way at the midpoint.
    expect(tweenValue(tw, 1000 + COUNT_UP_MS / 2)).toBeGreaterThan(200)
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(Number.NaN)).toBe(0)
  })

  it('retargets from the value on screen, without a jump', () => {
    const tw = { from: 0, to: 100, at: 0, dur: 400 }
    const mid = tweenValue(tw, 200)
    const next = retarget(tw, 250, 200)
    expect(tweenValue(next, 200)).toBeCloseTo(mid, 9)
    expect(tweenValue(next, 600)).toBe(250)
    expect(retarget(next, 250, 300)).toBe(next) // same target: untouched
  })

  it('a zero-duration tween shows the target', () => {
    expect(tweenValue(tweenAt(7, 0), 0)).toBe(7)
  })
})

describe('pop animation curves', () => {
  it('scales in with an overshoot and settles at 1', () => {
    expect(popScale(0)).toBeLessThan(0.7)
    expect(Math.max(...[0.1, 0.2, 0.25, 0.3].map(popScale))).toBeGreaterThan(1.1)
    expect(popScale(0.6)).toBeCloseTo(1, 9)
    expect(popScale(1)).toBeCloseTo(1, 9)
  })

  it('fades in fast, holds, then fades out to 0', () => {
    expect(popAlpha(0)).toBe(0)
    expect(popAlpha(0.3)).toBe(1)
    expect(popAlpha(0.8)).toBeGreaterThan(0)
    expect(popAlpha(0.8)).toBeLessThan(1)
    expect(popAlpha(1)).toBeCloseTo(0, 9)
  })
})

describe('Hud event queue', () => {
  it('pops each judgment in order with its colour and expires it after POP_MS', () => {
    const hud = new Hud({ autoplay: false })
    hud.push([result('perfect', {}, 0)], state({ score: 100 }), 1000)
    hud.push([result('good', {}, 1)], state({ score: 170 }), 1100)
    const v = hud.view(1150)
    expect(v.pops.map((p) => p.label)).toEqual(['PERFECT!', 'GOOD'])
    expect(v.pops[0].color).toBe(JUDGMENT_STYLE.perfect.color)
    expect(v.pops[1].color).toBe(JUDGMENT_STYLE.good.color)
    // The newer pop fades the older one out quickly.
    expect(v.pops[0].alpha).toBeLessThan(popAlpha(150 / POP_MS))
    expect(hud.view(1000 + POP_MS + 1).pops.map((p) => p.label)).toEqual(['GOOD'])
    expect(hud.view(1100 + POP_MS).pops).toEqual([])
  })

  it('keeps at most MAX_POPS, dropping the oldest', () => {
    const hud = new Hud({ autoplay: false })
    const batch = (['perfect', 'good', 'ok', 'miss', 'perfect', 'good'] as Judgment[]).map((j, i) => result(j, {}, i))
    hud.push(batch, state(), 0)
    const v = hud.view(10)
    expect(v.pops).toHaveLength(MAX_POPS)
    expect(v.pops.map((p) => p.judgment)).toEqual(['ok', 'miss', 'perfect', 'good'])
    const ids = v.pops.map((p) => p.id)
    expect([...ids].sort((a, b) => a - b)).toEqual(ids)
  })

  it('counts the score up towards the new total', () => {
    const hud = new Hud({ autoplay: false })
    hud.push([result('perfect')], state({ score: 1000 }), 0)
    expect(hud.view(0).score).toBe(0)
    const mid = hud.view(COUNT_UP_MS / 2).score
    expect(mid).toBeGreaterThan(500)
    expect(mid).toBeLessThan(1000)
    expect(hud.view(COUNT_UP_MS).score).toBe(1000)
    expect(Number.isInteger(mid)).toBe(true)
  })

  it('fills the star meter smoothly and clamps it to 0..5', () => {
    const hud = new Hud({ autoplay: false })
    hud.push([result('perfect')], state({ stars: 2.5 }), 0)
    expect(hud.view(COUNT_UP_MS / 2).stars).toBeGreaterThan(0)
    expect(hud.view(COUNT_UP_MS).stars).toBe(2.5)
    hud.push([result('perfect')], state({ stars: 9 }), COUNT_UP_MS)
    expect(hud.view(COUNT_UP_MS * 3).stars).toBe(5)
  })

  it('bumps the combo when it grows and not when it breaks', () => {
    const hud = new Hud({ autoplay: false })
    hud.push([result('perfect')], state({ combo: 3 }), 0)
    expect(hud.view(0).comboScale).toBeGreaterThan(1.3)
    expect(hud.view(COMBO_BUMP_MS).comboScale).toBe(1)
    hud.push([result('miss')], state({ combo: 0 }), 1000)
    const v = hud.view(1000)
    expect(v.combo).toBe(0)
    expect(v.comboScale).toBe(1)
  })

  it('glows on a perfect only', () => {
    const hud = new Hud({ autoplay: false })
    hud.push([result('good')], state(), 0)
    expect(hud.view(0).glow).toBe(0)
    hud.push([result('perfect')], state(), 100)
    expect(hud.view(100).glow).toBe(1)
    expect(hud.view(100 + GLOW_MS / 2).glow).toBeGreaterThan(0)
    expect(hud.view(100 + GLOW_MS).glow).toBe(0)
  })

  it('names the worst limb from the player perspective on a miss, for HINT_MS', () => {
    const hud = new Hud({ autoplay: false })
    hud.push([result('miss', { r_forearm: 60, l_upper_arm: 20, torso: 90 })], state(), 0)
    expect(hud.view(10).hint?.text).toBe('Watch your left arm')
    expect(hud.view(HINT_MS - 1).hint).not.toBeNull()
    expect(hud.view(HINT_MS).hint).toBeNull()
    // No hint for a non-miss, or for a miss without any limb scores (nobody seen).
    expect(missHint(result('ok', { l_shin: 0 }))).toBeNull()
    expect(missHint(result('miss'))).toBeNull()
    expect(missHint(result('miss', { r_shin: 10, l_thigh: 40 }))).toBe('Watch your right leg')
    expect(missHint(result('miss', { torso: 5 }))).toBe('Watch your body')
    expect(missHint({ ...result('miss', { torso: 5 }), unseen: true })).toBeNull()
  })

  it('tints with the last judgment, then fades back to neutral', () => {
    const hud = new Hud({ autoplay: false })
    expect(hud.view(0).tint).toBeNull()
    hud.push([result('ok')], state(), 0)
    expect(hud.view(10).tint).toBe(JUDGMENT_STYLE.ok.color)
    expect(hud.view(5000).tint).toBeNull()
  })
})

describe('worstLimb', () => {
  it('picks the lowest finite score; null when empty', () => {
    expect(worstLimb({})).toBeNull()
    expect(worstLimb({ l_forearm: 50, r_forearm: 50 })).toBe('l_forearm')
    expect(worstLimb({ l_forearm: Number.NaN, r_thigh: 80 })).toBe('r_thigh')
  })
})

describe('"Can\'t see you" toast', () => {
  it('appears after UNSEEN_TOAST_MS without a valid frame and goes away on the next one', () => {
    const hud = new Hud({ autoplay: false })
    expect(hud.view(5000).toast).toBeNull() // not watching yet
    hud.watch(1000)
    expect(hud.view(1000 + UNSEEN_TOAST_MS).toast).toBeNull()
    expect(hud.view(1001 + UNSEEN_TOAST_MS).toast).toBe(UNSEEN_TOAST)
    hud.noteFrame(true, 2100)
    expect(hud.view(2200).toast).toBeNull()
    hud.noteFrame(false, 2500) // invalid frames don't count as seen
    expect(hud.view(2101 + UNSEEN_TOAST_MS).toast).toBe(UNSEEN_TOAST)
  })

  it('stays quiet while paused and in autoplay', () => {
    const hud = new Hud({ autoplay: false })
    hud.watch(0)
    expect(hud.view(5000, false).toast).toBeNull()
    const bot = new Hud({ autoplay: true })
    bot.watch(0)
    expect(bot.view(5000).toast).toBeNull()
    expect(bot.view(0).autoplay).toBe(true)
  })
})

describe('HUD drawing', () => {
  const L = playLayout(1280, 720, true)

  it('draws score, pops, hint, toast and the autoplay badge', () => {
    const hud = new Hud({ autoplay: true })
    hud.push([result('miss', { l_shin: 3 })], state({ score: 1234, combo: 0 }), 0)
    const v = { ...hud.view(COUNT_UP_MS + 100), toast: UNSEEN_TOAST }
    const { ctx, calls } = measuringStub()
    drawHud(ctx, { width: 1280, height: 720, layout: L, popAnchor: [300, 300] }, v)
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])
    expect(texts).toEqual(expect.arrayContaining(['1,234', 'MISS', 'Watch your left leg', `📷  ${UNSEEN_TOAST}`, UNSEEN_TOAST_HINT, '🤖 AUTOPLAY']))
  })

  it('shows the combo from ×2 up', () => {
    const hud = new Hud({ autoplay: false })
    hud.push([result('good')], state({ combo: 1 }), 0)
    const one = stubContext()
    drawHud(one.ctx, { width: 1280, height: 720, layout: L, popAnchor: [300, 300] }, hud.view(1000))
    expect(one.calls.some((c) => c.name === 'fillText' && c.args[0] === '×1')).toBe(false)
    hud.push([result('good')], state({ combo: 2 }), 1000)
    const two = stubContext()
    drawHud(two.ctx, { width: 1280, height: 720, layout: L, popAnchor: [300, 300] }, hud.view(1000))
    expect(two.calls.some((c) => c.name === 'fillText' && c.args[0] === '×2')).toBe(true)
  })

  it('shows a combo break when a combo of 5+ is lost, then lets it fade', () => {
    const hud = new Hud({ autoplay: false })
    hud.push([result('good')], state({ combo: 6 }), 0)
    hud.push([result('miss')], state({ combo: 0 }), 100)
    expect(hud.view(150).comboBreak?.combo).toBe(6)
    const { ctx, calls } = measuringStub()
    drawHud(ctx, { width: 1280, height: 720, layout: L, popAnchor: [300, 300] }, hud.view(150))
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])
    expect(texts).toEqual(expect.arrayContaining(['×6', 'COMBO BREAK']))
    expect(hud.view(100 + COMBO_BREAK_MS).comboBreak).toBeNull()
    // A short combo just ends quietly; a new hit clears the flash.
    const small = new Hud({ autoplay: false })
    small.push([result('good')], state({ combo: 3 }), 0)
    small.push([result('miss')], state({ combo: 0 }), 100)
    expect(small.view(150).comboBreak).toBeNull()
    hud.push([result('good')], state({ combo: 1 }), 200)
    expect(hud.view(250).comboBreak).toBeNull()
  })

})

describe('webcam PIP', () => {
  it('sits bottom-right just above the cue strip, inside the screen', () => {
    for (const [w, h] of [[1280, 720], [1920, 1080], [800, 600]]) {
      const L = playLayout(w, h, true)
      const b = pipBox(w, L, 4 / 3)
      expect(b.x + b.w).toBeLessThanOrEqual(w - 16 + 1e-9)
      expect(b.y + b.h).toBeLessThanOrEqual(L.strip.y)
      expect(b.y).toBeGreaterThan(0)
      expect(b.w / b.h).toBeCloseTo(4 / 3, 6)
    }
  })

  it('maps video pixels mirrored into the box', () => {
    const box = { x: 100, y: 50, w: 320, h: 240 }
    const pts = pipImagePoints({ nose: [0, 0], l_wrist: [640, 480] }, 640, 480, box)
    // Mirrored: the video's left edge lands on the box's right edge.
    expect(pts.nose).toEqual([420, 50])
    expect(pts.l_wrist).toEqual([100, 290])
  })

  it('draws the bot figure without touching any video', () => {
    const { ctx, calls } = stubContext()
    const frame = { songTime: 1, pose: { l_shoulder: [-0.45, -1] as [number, number], l_elbow: [-0.5, -0.4] as [number, number] }, visibility: {}, valid: true }
    drawPip(ctx, { x: 0, y: 0, w: 200, h: 150 }, { kind: 'bot', frame, tint: null })
    expect(calls.some((c) => c.name === 'drawImage')).toBe(false)
    expect(calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])).toContain('BOT')
    expect(calls.some((c) => c.name === 'lineTo')).toBe(true)
  })
})
