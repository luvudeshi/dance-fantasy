// In-game HUD on the stage canvas: score count-up, combo bump + combo-break flash, judgment
// pops beside the coach's head (never over the face), perfect edge glow, 5-star meter, miss
// hints ("Watch your left arm"), the "Can't see you" card, the AUTOPLAY badge and the webcam
// picture-in-picture.
//
// `Hud` is a small event store fed with scoring results; `view(now)` turns it into a plain
// snapshot (pure, unit-tested) and the draw functions only paint that snapshot. Animation
// times are performance.now() milliseconds (wall clock: pops keep fading while paused).

import type { JointName, LimbName, Pose2D, Vec2 } from '@shared/skeleton'
import { drawSkeleton, type Ctx2D } from '../pose/draw'
import { bodyToScreen, imageToDisplay } from '../pose/normalize'
import type { Box } from '../render/pictogram'
import type { PlayerFrame } from './poseSource'
import { popFontSize, TOP_BAR_PX, type PlayLayout, type PopPlacement } from './render'
import type { CheckpointResult, Judgment, ScoreState } from './scoring'
import type { CheckpointResultV2, TimingTag } from './scoringV2'
import { COMBO_BREAK_MIN } from './sfx'

/** Judgment pop: scale-in, hold, fade. */
export const POP_MS = 600
/** A newer pop fades the older ones out this fast. */
export const POP_REPLACE_MS = 150
/** Pops kept at once (older ones are dropped). */
export const MAX_POPS = 4
export const COUNT_UP_MS = 450
export const COMBO_BUMP_MS = 220
export const GLOW_MS = 500
/** Miss hints stay longer than the pop so they can be read. */
export const HINT_MS = 1600
/** Show "Can't see you" after this long without a valid webcam frame. */
export const UNSEEN_TOAST_MS = 1000
/** The PIP border keeps the last judgment's colour this long. */
export const TINT_MS = 1200
/** A broken combo (of COMBO_BREAK_MIN+) shows as a falling, fading "×N" this long. */
export const COMBO_BREAK_MS = 900

export const UNSEEN_TOAST = 'Can’t see you'
export const UNSEEN_TOAST_HINT = 'Step back until the camera sees your whole body'

export interface JudgmentStyle {
  label: string
  color: string
}

export const JUDGMENT_STYLE: Readonly<Record<Judgment, JudgmentStyle>> = {
  perfect: { label: 'PERFECT!', color: '#f2db94' },
  good: { label: 'GOOD', color: '#a3c3d8' },
  ok: { label: 'OK', color: '#e6939f' },
  miss: { label: 'MISS', color: '#b9a59a' },
}

const clamp01 = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : Number.isNaN(u) ? 0 : u)

// --- easing / tweens ------------------------------------------------------------------------

export function easeOutCubic(u: number): number {
  const v = clamp01(u)
  return 1 - (1 - v) * (1 - v) * (1 - v)
}

/** A count-up from `from` to `to` starting at `at` (ms) over `dur` ms. */
export interface Tween {
  from: number
  to: number
  at: number
  dur: number
}

export const tweenAt = (value: number, dur: number): Tween => ({ from: value, to: value, at: 0, dur })

/** Tween value at `nowMs` (ease-out cubic; exact `from` at the start, `to` from `at + dur` on). */
export function tweenValue(tw: Tween, nowMs: number): number {
  if (!(tw.dur > 0)) return tw.to
  return tw.from + (tw.to - tw.from) * easeOutCubic((nowMs - tw.at) / tw.dur)
}

/** Retargets a running tween without a jump: the new one starts from the value shown now. */
export function retarget(tw: Tween, to: number, nowMs: number): Tween {
  if (to === tw.to) return tw
  return { from: tweenValue(tw, nowMs), to, at: nowMs, dur: tw.dur }
}

/** Pop scale over its life u (0..1): overshoots to ~1.15 in the first 20 %, settles to 1. */
export function popScale(u: number): number {
  const v = clamp01(u)
  if (v < 0.2) return 0.55 + 0.6 * easeOutCubic(v / 0.2)
  return 1.15 - 0.15 * easeOutCubic((v - 0.2) / 0.3)
}

/** Pop opacity over its life u: quick fade-in, hold, fade out over the last 45 %. */
export function popAlpha(u: number): number {
  const v = clamp01(u)
  if (v < 0.08) return v / 0.08
  if (v < 0.55) return 1
  return 1 - (v - 0.55) / 0.45
}

// --- limb names (the PLAYER's perspective) ---------------------------------------------------

/**
 * Routine joints are compared to the player's own anatomical joints (the player mirrors the
 * mirrored coach), so `l_` is the player's left: "left arm" is what they should fix.
 */
export const LIMB_LABEL: Readonly<Record<LimbName, string>> = {
  l_upper_arm: 'left arm',
  l_forearm: 'left arm',
  r_upper_arm: 'right arm',
  r_forearm: 'right arm',
  l_thigh: 'left leg',
  l_shin: 'left leg',
  r_thigh: 'right leg',
  r_shin: 'right leg',
  torso: 'body',
}

/** Lowest-scoring limb (first listed wins ties); null when none were compared. */
export function worstLimb(perLimb: Partial<Record<LimbName, number>>): LimbName | null {
  let worst: LimbName | null = null
  let lo = Infinity
  for (const [limb, s] of Object.entries(perLimb) as Array<[LimbName, number | undefined]>) {
    if (s === undefined || !Number.isFinite(s)) continue
    if (s < lo) {
      lo = s
      worst = limb
    }
  }
  return worst
}

/**
 * "Watch your left arm" for a miss the camera actually saw; null otherwise (unseen: the
 * "Can't see you" toast covers it).
 */
export function missHint(r: Pick<CheckpointResult, 'judgment' | 'perLimb' | 'unseen'>): string | null {
  if (r.judgment !== 'miss' || r.unseen) return null
  const limb = worstLimb(r.perLimb)
  return limb ? `Watch your ${LIMB_LABEL[limb]}` : null
}

// --- the HUD store ------------------------------------------------------------------------

interface Pop {
  id: number
  judgment: Judgment
  at: number
  timing?: TimingTag
}

export interface PopView {
  id: number
  judgment: Judgment
  label: string
  color: string
  /** 0..1 through the pop's life. */
  life: number
  scale: number
  alpha: number
  /** Upward drift, 0..1 (multiply by a pixel distance). */
  rise: number
  /** "EARLY" / "LATE" next to the judgment (scoring v2), if any. */
  tag?: string
}

export interface HudView {
  /** Displayed (counting-up) score, rounded. */
  score: number
  /** Displayed star meter, 0..5 (fractional while filling). */
  stars: number
  combo: number
  /** Combo text scale (1 at rest, > 1 right after the combo grows). */
  comboScale: number
  /** Oldest first: draw in order so the newest is on top. */
  pops: PopView[]
  hint: { text: string; alpha: number } | null
  /** Perfect edge glow strength, 0..1. */
  glow: number
  toast: string | null
  /** 0..1 slow pulse for the toast's border. */
  toastPulse: number
  /** The combo that just broke (shown falling away while life < 1). */
  comboBreak: { combo: number; life: number } | null
  /** Colour of the last judgment (fading back to null), for the PIP border. */
  tint: string | null
  autoplay: boolean
}

export class Hud {
  readonly autoplay: boolean
  private pops: Pop[] = []
  private nextId = 0
  private score: Tween = tweenAt(0, COUNT_UP_MS)
  private stars: Tween = tweenAt(0, COUNT_UP_MS)
  private combo = 0
  private comboAt = Number.NEGATIVE_INFINITY
  private perfectAt = Number.NEGATIVE_INFINITY
  private hint: { text: string; at: number } | null = null
  private last: { judgment: Judgment; at: number } | null = null
  private seenAt = Number.NEGATIVE_INFINITY
  private watchFrom: number | null = null
  private broke: { combo: number; at: number } | null = null

  constructor(opts: { autoplay: boolean }) {
    this.autoplay = opts.autoplay
  }

  /** Finalized checkpoints (in order) plus the score state after them. */
  push(results: readonly CheckpointResult[], state: ScoreState, nowMs: number): void {
    for (const r of results) {
      this.pops.push({ id: this.nextId++, judgment: r.judgment, at: nowMs, timing: (r as CheckpointResultV2).timing })
      if (r.judgment === 'perfect') this.perfectAt = nowMs
      const hint = missHint(r)
      if (hint) this.hint = { text: hint, at: nowMs }
      this.last = { judgment: r.judgment, at: nowMs }
    }
    if (this.pops.length > MAX_POPS) this.pops.splice(0, this.pops.length - MAX_POPS)
    this.score = retarget(this.score, state.score, nowMs)
    this.stars = retarget(this.stars, state.stars, nowMs)
    if (state.combo > this.combo) this.comboAt = nowMs
    if (state.combo === 0 && this.combo >= COMBO_BREAK_MIN) this.broke = { combo: this.combo, at: nowMs }
    else if (state.combo > 0) this.broke = null
    this.combo = state.combo
  }

  /** Every pose frame (valid or not), for the "Can't see you" toast. */
  noteFrame(valid: boolean, nowMs: number): void {
    if (valid) this.seenAt = Math.max(this.seenAt, nowMs)
  }

  /** Starts the unseen clock (game start): no toast before UNSEEN_TOAST_MS has passed. */
  watch(nowMs: number): void {
    this.watchFrom = nowMs
  }

  /** Snapshot at `nowMs`; `playing` gates the toast (no nagging while paused). Drops expired pops. */
  view(nowMs: number, playing = true): HudView {
    this.pops = this.pops.filter((p) => nowMs - p.at < POP_MS)
    const pops: PopView[] = this.pops.map((p, i) => {
      const life = clamp01((nowMs - p.at) / POP_MS)
      const newer = this.pops[i + 1]
      const replaced = newer && newer.at > p.at ? clamp01(1 - (nowMs - newer.at) / POP_REPLACE_MS) : 1
      const style = JUDGMENT_STYLE[p.judgment]
      return {
        id: p.id,
        judgment: p.judgment,
        label: style.label,
        color: style.color,
        life,
        scale: popScale(life),
        alpha: popAlpha(life) * replaced,
        rise: easeOutCubic(life),
        ...(p.timing ? { tag: p.timing === 'early' ? 'EARLY' : 'LATE' } : {}),
      }
    })

    let hint: HudView['hint'] = null
    if (this.hint) {
      const u = (nowMs - this.hint.at) / HINT_MS
      if (u >= 1) this.hint = null
      else hint = { text: this.hint.text, alpha: u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3 }
    }

    const bump = clamp01((nowMs - this.comboAt) / COMBO_BUMP_MS)
    const glowU = clamp01((nowMs - this.perfectAt) / GLOW_MS)
    const since = Math.max(this.seenAt, this.watchFrom ?? Number.POSITIVE_INFINITY)
    const unseen = !this.autoplay && playing && this.watchFrom !== null && nowMs - since > UNSEEN_TOAST_MS
    const tint = this.last && nowMs - this.last.at < TINT_MS ? JUDGMENT_STYLE[this.last.judgment].color : null
    let comboBreak: HudView['comboBreak'] = null
    if (this.broke) {
      const life = (nowMs - this.broke.at) / COMBO_BREAK_MS
      if (life >= 1) this.broke = null
      else comboBreak = { combo: this.broke.combo, life: clamp01(life) }
    }

    return {
      score: Math.round(tweenValue(this.score, nowMs)),
      stars: Math.max(0, Math.min(5, tweenValue(this.stars, nowMs))),
      combo: this.combo,
      comboScale: 1 + 0.35 * (1 - bump) * (1 - bump),
      pops,
      hint,
      glow: (1 - glowU) * (1 - glowU),
      toast: unseen ? UNSEEN_TOAST : null,
      toastPulse: 0.5 + 0.5 * Math.sin((nowMs / 1000) * Math.PI * 2 * 0.9),
      comboBreak,
      tint,
      autoplay: this.autoplay,
    }
  }
}

// --- drawing --------------------------------------------------------------------------------

const UI_FONT = 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif'
const STORY_FONT = "Fraunces, Georgia, 'Times New Roman', serif"

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, w / 2, h / 2)))
}

function starPath(ctx: Ctx2D, cx: number, cy: number, r: number): void {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    const rr = i % 2 === 0 ? r : r * 0.45
    const x = cx + Math.cos(a) * rr
    const y = cy + Math.sin(a) * rr
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** Five stars, the first `filled` (fractional) of them gold. Right-aligned at (right, cy). */
export function drawStarMeter(ctx: Ctx2D, right: number, cy: number, r: number, filled: number): void {
  const gap = r * 0.5
  const step = 2 * r + gap
  const x0 = right - 5 * step + gap + r
  ctx.save()
  for (let i = 0; i < 5; i++) {
    const cx = x0 + i * step
    starPath(ctx, cx, cy, r)
    ctx.fillStyle = 'rgba(233, 220, 184, 0.16)'
    ctx.fill()
    ctx.lineWidth = 1.2
    ctx.strokeStyle = 'rgba(219, 179, 94, 0.6)'
    ctx.stroke()
    const f = clamp01(filled - i)
    if (f > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(cx - r, cy - r, 2 * r * f, 2 * r)
      ctx.clip()
      starPath(ctx, cx, cy, r)
      ctx.shadowColor = '#dbb35e'
      ctx.shadowBlur = f >= 1 ? 10 : 4
      ctx.fillStyle = '#e0b858'
      ctx.fill()
      ctx.restore()
    }
  }
  ctx.restore()
}

/** Score + stars + combo panel, top-right under the top bar. */
function drawScorePanel(ctx: Ctx2D, width: number, v: HudView): void {
  const right = width - 22
  const scale = Math.max(0.7, Math.min(1.25, width / 1280))
  let y = TOP_BAR_PX + 6
  ctx.save()
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(233, 220, 184, 0.85)'
  ctx.font = `700 ${Math.max(13, Math.round(13 * scale))}px ${UI_FONT}`
  ctx.fillText('SCORE', right, y)
  y += Math.round(15 * scale)
  const scoreSize = Math.round(44 * scale)
  ctx.font = `800 ${scoreSize}px ${UI_FONT}`
  ctx.shadowColor = 'rgba(219, 179, 94, 0.7)'
  ctx.shadowBlur = 14
  ctx.lineJoin = 'round'
  ctx.lineWidth = 5
  ctx.strokeStyle = 'rgba(21, 35, 56, 0.9)'
  const text = v.score.toLocaleString('en-US')
  ctx.strokeText(text, right, y)
  ctx.shadowBlur = 0
  ctx.fillStyle = '#fffaf0'
  ctx.fillText(text, right, y)
  y += scoreSize + 6
  const r = Math.round(11 * scale)
  drawStarMeter(ctx, right, y + r, r, v.stars)
  y += 2 * r + 10

  if (v.combo >= 2) {
    const size = Math.round(30 * scale)
    ctx.save()
    ctx.translate(right, y + size / 2)
    ctx.scale(v.comboScale, v.comboScale)
    ctx.textBaseline = 'middle'
    ctx.font = `italic 800 ${size}px ${STORY_FONT}`
    ctx.shadowColor = '#c04f66'
    ctx.shadowBlur = 8 + 14 * (v.comboScale - 1) * 3
    ctx.fillStyle = '#fff8ec'
    ctx.fillText(`×${v.combo}`, 0, 0)
    ctx.restore()
    ctx.font = `700 ${Math.max(12, Math.round(12 * scale))}px ${UI_FONT}`
    ctx.fillStyle = 'rgba(230, 147, 159, 0.95)'
    ctx.fillText('COMBO', right, y + size + 4)
  } else if (v.comboBreak) {
    // Combo break: the lost "×N" drops, tilts and fades in muted red.
    const { combo, life } = v.comboBreak
    const size = Math.round(30 * scale)
    ctx.save()
    ctx.globalAlpha = 1 - life * life
    ctx.translate(right - size * 0.9, y + size / 2 + life * size * 0.9)
    ctx.rotate(0.25 * life)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `italic 800 ${size}px ${STORY_FONT}`
    ctx.fillStyle = '#ff8fa3'
    ctx.fillText(`×${combo}`, 0, 0)
    const w = ctx.measureText(`×${combo}`).width
    ctx.strokeStyle = 'rgba(255, 143, 163, 0.9)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(-w / 2 - 4, 2)
    ctx.lineTo(w / 2 + 4, -2)
    ctx.stroke()
    ctx.restore()
    ctx.globalAlpha = 1 - life
    ctx.font = `800 ${Math.max(12, Math.round(12 * scale))}px ${UI_FONT}`
    ctx.fillStyle = '#ff8fa3'
    ctx.fillText('COMBO BREAK', right, y + size + 4)
  }
  ctx.restore()
}

/**
 * Judgment pops (and the miss hint) at `anchor`, beside the coach's head: with align 'right'
 * the text ends at the anchor (and scales / rises away from the face), 'left' starts there.
 */
function drawPops(ctx: Ctx2D, anchor: Vec2, align: CanvasTextAlign, area: Box, v: HudView): void {
  const size = popFontSize(area.h)
  ctx.save()
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  for (const p of v.pops) {
    if (p.alpha <= 0) continue
    ctx.save()
    ctx.globalAlpha = p.alpha
    ctx.font = `italic 800 ${size}px ${STORY_FONT}`
    const w = ctx.measureText(p.label).width * p.scale // keep the scaled text inside the coach area
    const x = Math.max(area.x + 8 + (align === 'right' ? w : align === 'center' ? w / 2 : 0), Math.min(area.x + area.w - 8 - (align === 'left' ? w : align === 'center' ? w / 2 : 0), anchor[0]))
    ctx.translate(x, anchor[1] - p.rise * size * 0.5)
    ctx.scale(p.scale, p.scale)
    ctx.lineWidth = Math.max(3, size * 0.12)
    ctx.strokeStyle = 'rgba(21, 35, 56, 0.92)'
    ctx.shadowColor = p.color
    ctx.shadowBlur = p.judgment === 'perfect' ? 26 : 14
    ctx.strokeText(p.label, 0, 0)
    ctx.shadowBlur = 0
    ctx.fillStyle = p.color
    ctx.fillText(p.label, 0, 0)
    if (p.tag) {
      ctx.font = `800 ${Math.max(12, Math.round(size * 0.34))}px ${UI_FONT}`
      ctx.lineWidth = 3
      ctx.strokeText(p.tag, 0, -size * 0.72)
      ctx.fillText(p.tag, 0, -size * 0.72)
    }
    ctx.restore()
  }
  if (v.hint) {
    const hs = Math.max(16, Math.round(size * 0.42))
    ctx.globalAlpha = v.hint.alpha
    ctx.font = `600 ${hs}px ${UI_FONT}`
    ctx.lineWidth = 4
    ctx.strokeStyle = 'rgba(21, 35, 56, 0.9)'
    ctx.strokeText(v.hint.text, anchor[0], anchor[1] + size * 0.85)
    ctx.fillStyle = '#fffaf0'
    ctx.fillText(v.hint.text, anchor[0], anchor[1] + size * 0.85)
  }
  ctx.restore()
}

/** Gold glow on all four screen edges (perfect). */
function drawEdgeGlow(ctx: Ctx2D, width: number, height: number, strength: number): void {
  if (strength <= 0.01) return
  const d = Math.min(width, height) * 0.09
  const color = (a: number): string => `rgba(242, 219, 148, ${(a * strength).toFixed(3)})`
  ctx.save()
  const edges: Array<[number, number, number, number, number, number, number, number]> = [
    // gradient x0,y0,x1,y1 then rect x,y,w,h
    [0, 0, 0, d, 0, 0, width, d],
    [0, height, 0, height - d, 0, height - d, width, d],
    [0, 0, d, 0, 0, 0, d, height],
    [width, 0, width - d, 0, width - d, 0, d, height],
  ]
  for (const [gx0, gy0, gx1, gy1, x, y, w, h] of edges) {
    const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1)
    g.addColorStop(0, color(0.55))
    g.addColorStop(1, color(0))
    ctx.fillStyle = g
    ctx.fillRect(x, y, w, h)
  }
  ctx.restore()
}

function drawPill(ctx: Ctx2D, text: string, cx: number, cy: number, size: number, fg: string, bg: string, border: string): void {
  ctx.save()
  ctx.font = `700 ${size}px ${UI_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const w = ctx.measureText(text).width + size * 1.6
  const h = size * 2
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = border
  ctx.stroke()
  ctx.fillStyle = fg
  ctx.fillText(text, cx, cy + 1)
  ctx.restore()
}

export interface HudFrame {
  width: number
  height: number
  layout: Pick<PlayLayout, 'coachArea'>
  /** Where judgment pops appear (beside the coach's head: render.ts popPlacement). */
  popAnchor: Vec2
  /** Which way pop text runs from the anchor (default 'right': it ends there, left of the face). */
  popAlign?: PopPlacement['align'] | 'center'
}

/** The "Can't see you" card: a big headline, the fix underneath, a pulsing border. */
function drawToast(ctx: Ctx2D, area: Box, title: string, pulse: number): void {
  const size = Math.round(Math.max(20, Math.min(34, area.h * 0.045)))
  const sub = Math.max(15, Math.round(size * 0.55))
  const cx = area.x + area.w / 2
  const cy = area.y + Math.max(size * 2.2, area.h * 0.14)
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${size}px ${UI_FONT}`
  const w1 = ctx.measureText(title).width
  ctx.font = `600 ${sub}px ${UI_FONT}`
  const w2 = ctx.measureText(UNSEEN_TOAST_HINT).width
  const w = Math.min(area.w - 16, Math.max(w1, w2) + size * 1.6)
  const h = size * 1.4 + sub * 1.5 + size * 0.7
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, Math.min(22, h / 3))
  ctx.fillStyle = 'rgba(150, 50, 72, 0.95)'
  ctx.shadowColor = 'rgba(219, 179, 94, 0.8)'
  ctx.shadowBlur = 12 + 18 * pulse
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.lineWidth = 2 + pulse
  ctx.strokeStyle = `rgba(255, 250, 240, ${(0.6 + 0.4 * pulse).toFixed(3)})`
  ctx.stroke()
  ctx.fillStyle = '#fffaf0'
  ctx.font = `800 ${size}px ${UI_FONT}`
  ctx.fillText(title, cx, cy - sub * 0.75, w - 16)
  ctx.fillStyle = 'rgba(255, 248, 236, 0.95)'
  ctx.font = `600 ${sub}px ${UI_FONT}`
  ctx.fillText(UNSEEN_TOAST_HINT, cx, cy + size * 0.6, w - 16)
  ctx.restore()
}

/** Paints the HUD snapshot over the stage (`scorePanel: false` for a practice run: no score). */
export function drawHud(ctx: Ctx2D, f: HudFrame, v: HudView, opts: { scorePanel?: boolean } = {}): void {
  drawEdgeGlow(ctx, f.width, f.height, v.glow)
  if (opts.scorePanel !== false) drawScorePanel(ctx, f.width, v)
  drawPops(ctx, f.popAnchor, f.popAlign ?? 'right', f.layout.coachArea, v)
  const area = f.layout.coachArea
  if (v.autoplay) {
    drawPill(ctx, 'AUTOPLAY', 96, TOP_BAR_PX + 38, 15, '#4a3612', 'rgba(219, 179, 94, 0.96)', '#fffaf0')
  }
  if (v.toast) drawToast(ctx, area, v.toast, v.toastPulse)
}

// --- webcam picture-in-picture ------------------------------------------------------------------

/** Rounded PIP box: bottom-right, just above the cue strip, sized for `aspect` (w / h). */
export function pipBox(width: number, layout: Pick<PlayLayout, 'strip'>, aspect = 4 / 3): Box {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 4 / 3
  const room = layout.strip.y - 12 - (TOP_BAR_PX + 150) // keep clear of the score panel
  let w = Math.max(120, Math.min(300, width * 0.2))
  let h = w / a
  if (room > 40 && h > room) {
    h = room
    w = h * a
  }
  return { x: width - w - 16, y: layout.strip.y - h - 12, w, h }
}

export interface PipFrame {
  kind: 'webcam' | 'bot'
  video?: HTMLVideoElement | null
  frame: PlayerFrame | null
  /** Last judgment colour (null = neutral). */
  tint: string | null
}

const PIP_NEUTRAL = '#dbb35e'

/** Body-frame pose -> PIP pixels (mirrored self-view, whole body fitted in the box). */
export function pipBodyPoints(pose: Pose2D, box: Box): Partial<Record<JointName, Vec2>> {
  const scale = box.h / 4.3
  const view = { cx: box.x + box.w / 2, cy: box.y + box.h * 0.5 + 0.1 * scale, scale, mirrored: true }
  const out: Partial<Record<JointName, Vec2>> = {}
  for (const [j, p] of Object.entries(pose) as Array<[JointName, Vec2 | undefined]>) {
    if (p) out[j] = bodyToScreen(p, view)
  }
  return out
}

/** Video pixels -> PIP pixels (contain-fit, mirrored like the video). */
export function pipImagePoints(
  image: Partial<Record<JointName, Vec2>>,
  videoWidth: number,
  videoHeight: number,
  box: Box,
): Partial<Record<JointName, Vec2>> {
  const out: Partial<Record<JointName, Vec2>> = {}
  for (const [j, p] of Object.entries(image) as Array<[JointName, Vec2 | undefined]>) {
    if (!p) continue
    const [x, y] = imageToDisplay(p, videoWidth, videoHeight, box.w, box.h, true)
    out[j] = [box.x + x, box.y + y]
  }
  return out
}

export function drawPip(ctx: Ctx2D, box: Box, p: PipFrame): void {
  if (box.w <= 0 || box.h <= 0) return
  const color = p.tint ?? PIP_NEUTRAL
  const r = Math.min(18, box.h * 0.12)
  ctx.save()
  roundRect(ctx, box.x, box.y, box.w, box.h, r)
  ctx.fillStyle = 'rgba(21, 35, 56, 0.88)'
  ctx.shadowColor = color
  ctx.shadowBlur = p.tint ? 22 : 10
  ctx.fill()
  ctx.shadowBlur = 0

  ctx.save()
  roundRect(ctx, box.x, box.y, box.w, box.h, r)
  ctx.clip()
  const frame = p.frame
  const video = p.video
  if (p.kind === 'webcam') {
    const vw = video?.videoWidth ?? 0
    const vh = video?.videoHeight ?? 0
    if (video && vw > 0 && vh > 0 && video.readyState >= 2) {
      const s = Math.min(box.w / vw, box.h / vh)
      const dw = vw * s
      const dh = vh * s
      // Mirrored self-view: flip around the box's vertical centre line.
      ctx.save()
      ctx.translate(box.x + box.w, box.y)
      ctx.scale(-1, 1)
      ctx.globalAlpha = 0.85
      ctx.drawImage(video, (box.w - dw) / 2, (box.h - dh) / 2, dw, dh)
      ctx.restore()
      if (frame?.valid && frame.image) {
        drawSkeleton(ctx, pipImagePoints(frame.image, vw, vh, box), {
          visibility: frame.visibility,
          color,
          lineWidth: 3,
          outlineColor: 'rgba(21, 35, 56, 0.75)',
        })
      }
    } else {
      ctx.fillStyle = 'rgba(233, 220, 184, 0.75)'
      ctx.font = `600 14px ${UI_FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Waking the mirror…', box.x + box.w / 2, box.y + box.h / 2)
    }
  } else if (frame?.valid) {
    drawSkeleton(ctx, pipBodyPoints(frame.pose, box), { color, lineWidth: 3, visibility: frame.visibility })
  }
  ctx.restore()

  roundRect(ctx, box.x, box.y, box.w, box.h, r)
  ctx.lineWidth = p.tint ? 3 : 1.5
  ctx.strokeStyle = color
  ctx.stroke()
  ctx.font = `800 13px ${UI_FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(242, 219, 148, 0.95)'
  ctx.fillText(p.kind === 'webcam' ? 'YOU' : 'BOT', box.x + 10, box.y + 8)
  ctx.restore()
}
