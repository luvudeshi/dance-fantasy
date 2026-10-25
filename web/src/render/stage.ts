// Background of the play screen (midnight ballroom), drawn under the coach every frame.
// Static layers (sky gradient, moon, the faint midnight clock, velvet curtains, floor,
// vignette) are rendered once into a scratch canvas keyed by size, and the theme-tinted
// lights (aura, spotlight beam, floor pool) into low-res ones keyed by theme and size. Each
// frame only blits them (the lights with beat-pulsed alpha / size) and adds twinkling stars.

import type { Ctx2D } from '../pose/draw'
import { createLayer, deviceScale, mixHex, withAlpha, type CoachTheme, type Layer } from './coach'
import { fitFigureView } from './stickFigure'

export interface StageFrame {
  /** CSS px. */
  width: number
  height: number
  /** Song time in seconds (for slow ambient animation). */
  time: number
  /** 0..1, 1 right on a beat. */
  beatPulse: number
  theme: CoachTheme
  /**
   * Where the coach stands (CSS px): floor point under mid-hip and px per body unit. Default:
   * fitFigureView(width, height), i.e. a coach filling the whole canvas.
   */
  floor?: { x: number; y: number; scale: number }
}

export interface StageLayout {
  floorX: number
  floorY: number
  /** Px per body unit of the coach standing on the floor. */
  scale: number
}

export function stageLayout(f: Pick<StageFrame, 'width' | 'height' | 'floor'>): StageLayout {
  if (f.floor) return { floorX: f.floor.x, floorY: f.floor.y, scale: f.floor.scale }
  const v = fitFigureView(f.width, f.height)
  return { floorX: v.cx, floorY: v.floorY, scale: v.scale }
}

// --- stars -------------------------------------------------------------------------------

export interface Star {
  /** 0..1 of the width / of the sky height (above the floor). */
  x: number
  y: number
  /** Radius in CSS px at 1080p-ish sizes. */
  r: number
  /** Twinkle angular speed (rad/s) and phase. */
  speed: number
  phase: number
}

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The same star field every time (seeded). */
export function starField(count = 90, seed = 12): Star[] {
  const rand = rng(seed)
  return Array.from({ length: count }, () => {
    const big = rand() < 0.12
    return {
      x: rand(),
      y: Math.pow(rand(), 1.4),
      r: big ? 1.3 + rand() * 0.9 : 0.5 + rand() * 0.7,
      speed: 0.6 + rand() * 2.2,
      phase: rand() * Math.PI * 2,
    }
  })
}

const STARS = starField()

/** Star brightness at time t (0.15..1): slow sine twinkle. */
export function twinkle(star: Star, time: number): number {
  const v = 0.575 + 0.425 * Math.sin(time * star.speed + star.phase)
  return Number.isFinite(v) ? Math.max(0.15, v) : 0.6
}

// --- static layer ------------------------------------------------------------------------

let cache: { key: string; canvas: Layer } | null = null

/** Everything that doesn't move, in CSS px. */
function drawStatic(ctx: Ctx2D, w: number, h: number, L: StageLayout): void {
  const fy = Math.min(h, Math.max(h * 0.5, L.floorY))
  const m = Math.min(w, h)

  // Sky: Dance Fantasy night glass (#152338 -> #263a55).
  const sky = ctx.createLinearGradient(0, 0, 0, fy)
  sky.addColorStop(0, '#0d1726')
  sky.addColorStop(0.55, '#152338')
  sky.addColorStop(1, '#263a55')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, fy)

  // Moon (crescent: a sky-coloured disc bites it) with a soft halo.
  const mx = w * 0.84
  const my = h * 0.17
  const mr = m * 0.065
  ctx.fillStyle = '#f2db94'
  ctx.beginPath()
  ctx.arc(mx, my, mr, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = sky
  ctx.beginPath()
  ctx.arc(mx - mr * 0.42, my - mr * 0.22, mr * 0.9, 0, Math.PI * 2)
  ctx.fill()
  const halo = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 4.5)
  halo.addColorStop(0, 'rgba(242, 219, 148, 0.22)')
  halo.addColorStop(1, 'rgba(242, 219, 148, 0)')
  ctx.fillStyle = halo
  ctx.fillRect(mx - mr * 5, my - mr * 5, mr * 10, mr * 10)

  // The midnight clock: a faint face behind the dancer, hands a breath before twelve.
  const cx = L.floorX
  const cr = m * 0.2
  const cy = Math.max(cr * 1.15, fy - L.scale * 3.35 - cr * 0.2)
  ctx.strokeStyle = 'rgba(219, 179, 94, 0.1)'
  ctx.fillStyle = 'rgba(219, 179, 94, 0.03)'
  ctx.lineWidth = Math.max(1, m * 0.006)
  ctx.beginPath()
  ctx.arc(cx, cy, cr, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(cx, cy, cr * 0.86, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineCap = 'round'
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const r0 = i % 3 === 0 ? cr * 0.66 : cr * 0.74
    ctx.beginPath()
    ctx.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0)
    ctx.lineTo(cx + Math.sin(a) * cr * 0.8, cy - Math.cos(a) * cr * 0.8)
    ctx.stroke()
  }
  ctx.lineWidth = Math.max(1.5, m * 0.01)
  for (const [a, len] of [
    [-0.06, 0.48],
    [-0.21, 0.66],
  ] as const) {
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.sin(a) * cr * len, cy - Math.cos(a) * cr * len)
    ctx.stroke()
  }

  // Ballroom floor: violet sheen at the horizon fading to black, faint perspective seams.
  const floor = ctx.createLinearGradient(0, fy, 0, h)
  floor.addColorStop(0, '#34496a')
  floor.addColorStop(0.35, '#1a2a42')
  floor.addColorStop(1, '#0b1320')
  ctx.fillStyle = floor
  ctx.fillRect(0, fy, w, h - fy)
  ctx.strokeStyle = 'rgba(163, 195, 216, 0.08)'
  ctx.lineWidth = 1
  for (let i = -8; i <= 8; i++) {
    ctx.beginPath()
    ctx.moveTo(cx + i * w * 0.035, fy)
    ctx.lineTo(cx + i * w * 0.22, h)
    ctx.stroke()
  }
  const line = ctx.createLinearGradient(0, 0, w, 0)
  line.addColorStop(0, 'rgba(242, 219, 148, 0)')
  line.addColorStop(0.5, 'rgba(242, 219, 148, 0.5)')
  line.addColorStop(1, 'rgba(242, 219, 148, 0)')
  ctx.fillStyle = line
  ctx.fillRect(0, fy - 0.5, w, 1.5)

  // Velvet curtains framing the stage, with a scalloped valance.
  const curtainW = w * 0.075
  for (const side of [0, 1] as const) {
    const x0 = side === 0 ? 0 : w
    const dir = side === 0 ? 1 : -1
    const g = ctx.createLinearGradient(x0, 0, x0 + dir * curtainW * 1.6, 0)
    g.addColorStop(0, '#3a1220')
    g.addColorStop(0.7, '#6e2338')
    g.addColorStop(1, 'rgba(110, 35, 56, 0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(x0, 0)
    ctx.lineTo(x0 + dir * curtainW * 1.6, 0)
    ctx.quadraticCurveTo(x0 + dir * curtainW * 0.55, h * 0.35, x0 + dir * curtainW * 0.9, h)
    ctx.lineTo(x0, h)
    ctx.closePath()
    ctx.fill()
  }
  const vh = Math.max(8, h * 0.045)
  const n = Math.max(5, Math.round(w / (vh * 3.2)))
  const sw = w / n
  ctx.fillStyle = '#4a1626'
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(w, 0)
  ctx.lineTo(w, vh * 0.55)
  for (let i = n - 1; i >= 0; i--) ctx.quadraticCurveTo(i * sw + sw / 2, vh * 1.55, i * sw, vh * 0.55)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = 'rgba(219, 179, 94, 0.6)'
  ctx.lineWidth = Math.max(1, m * 0.003)
  ctx.beginPath()
  ctx.moveTo(w, vh * 0.55)
  for (let i = n - 1; i >= 0; i--) ctx.quadraticCurveTo(i * sw + sw / 2, vh * 1.55, i * sw, vh * 0.55)
  ctx.stroke()

  // Vignette.
  const R = Math.hypot(w, h) / 2
  const vig = ctx.createRadialGradient(w / 2, h * 0.55, R * 0.4, w / 2, h * 0.55, R * 1.05)
  vig.addColorStop(0, 'rgba(2, 3, 12, 0)')
  vig.addColorStop(1, 'rgba(2, 3, 12, 0.72)')
  ctx.fillStyle = vig
  ctx.fillRect(0, 0, w, h)
}

/** Draws (or reuses) the static layer for this size. */
function blitStatic(ctx: Ctx2D, w: number, h: number, L: StageLayout): void {
  const k = deviceScale(ctx)
  const pw = Math.max(1, Math.round(w * k))
  const ph = Math.max(1, Math.round(h * k))
  const key = `${pw}x${ph}|${Math.round(L.floorX)}|${Math.round(L.floorY)}|${Math.round(L.scale)}`
  if (!cache || cache.key !== key) {
    const canvas = createLayer(pw, ph)
    const lctx = canvas?.getContext('2d') as Ctx2D | null | undefined
    if (!canvas || !lctx) {
      drawStatic(ctx, w, h, L)
      return
    }
    lctx.setTransform(pw / w, 0, 0, ph / h, 0, 0)
    drawStatic(lctx, w, h, L)
    cache = { key, canvas }
  }
  ctx.drawImage(cache.canvas, 0, 0, w, h)
}

// --- lights ------------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Aura behind the coach + spotlight beam from above (CSS px), at full beat strength. */
/** Whole CSS px, so the cached layer blits 1:1 (much cheaper than a scaled blit). */
function pixelRect(x: number, y: number, w: number, h: number): Rect {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  return { x: x0, y: y0, w: Math.ceil(x + w) - x0, h: Math.ceil(y + h) - y0 }
}

function ambientRect(L: StageLayout): Rect {
  const s = L.scale
  const r = 2.8 * s
  const top = Math.min(0, L.floorY - 1.9 * s - r)
  return pixelRect(L.floorX - r, top, 2 * r, Math.max(L.floorY, L.floorY - 1.9 * s + r) - top)
}

function drawAmbient(ctx: Ctx2D, L: StageLayout, theme: CoachTheme, pulse: number): void {
  const s = L.scale
  const ax = L.floorX
  const ay = L.floorY - 1.9 * s
  const aura = ctx.createRadialGradient(ax, ay, 0, ax, ay, 2.8 * s)
  aura.addColorStop(0, withAlpha(theme.glow, 0.16 + 0.1 * pulse))
  aura.addColorStop(1, withAlpha(theme.glow, 0))
  ctx.fillStyle = aura
  ctx.fillRect(ax - 2.8 * s, ay - 2.8 * s, 5.6 * s, 5.6 * s)
  const beam = ctx.createLinearGradient(0, 0, 0, L.floorY)
  beam.addColorStop(0, withAlpha('#ffffff', 0))
  beam.addColorStop(1, withAlpha(mixHex(theme.glow, '#ffffff', 0.55), 0.07 + 0.05 * pulse))
  ctx.fillStyle = beam
  ctx.beginPath()
  ctx.moveTo(ax - 0.25 * s, 0)
  ctx.lineTo(ax + 0.25 * s, 0)
  ctx.lineTo(ax + 1.5 * s, L.floorY)
  ctx.lineTo(ax - 1.5 * s, L.floorY)
  ctx.closePath()
  ctx.fill()
}

/** Spotlight pool on the floor (ellipse), radius grown by `grow`. */
function drawPool(ctx: Ctx2D, L: StageLayout, theme: CoachTheme, pulse: number, grow = 1): void {
  ctx.save()
  ctx.translate(L.floorX, L.floorY)
  ctx.scale(1, 0.22)
  const rx = 1.65 * L.scale * grow
  const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  pool.addColorStop(0, withAlpha(mixHex(theme.glow, '#ffffff', 0.55), 0.42 + 0.33 * pulse))
  pool.addColorStop(0.55, withAlpha(theme.glow, 0.16 + 0.14 * pulse))
  pool.addColorStop(1, withAlpha(theme.glow, 0))
  ctx.fillStyle = pool
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function poolRect(L: StageLayout): Rect {
  const rx = 1.65 * L.scale
  return pixelRect(L.floorX - rx, L.floorY - 0.22 * rx, 2 * rx, 0.44 * rx)
}

const lightCache = new Map<string, { ambient: Layer; pool: Layer }>()

function renderLight(r: Rect, f: number, draw: (c: Ctx2D) => void): Layer | null {
  const canvas = createLayer(Math.max(1, Math.round(r.w * f)), Math.max(1, Math.round(r.h * f)))
  const c = canvas?.getContext('2d') as Ctx2D | null | undefined
  if (!canvas || !c) return null
  c.setTransform(f, 0, 0, f, -r.x * f, -r.y * f)
  draw(c)
  return canvas
}

/** Lights at full strength, cached per theme + layout; null without a scratch canvas. */
function lights(L: StageLayout, theme: CoachTheme, k: number): { ambient: Layer; pool: Layer } | null {
  const key = `${theme.glow}|${Math.round(L.floorX)}|${Math.round(L.floorY)}|${Math.round(L.scale)}|${k}`
  const hit = lightCache.get(key)
  if (hit) return hit
  const f = k
  const ambient = renderLight(ambientRect(L), f, (c) => drawAmbient(c, L, theme, 1))
  const pool = renderLight(poolRect(L), f, (c) => drawPool(c, L, theme, 1))
  if (!ambient || !pool) return null
  if (lightCache.size >= 8) lightCache.clear()
  const entry = { ambient, pool }
  lightCache.set(key, entry)
  return entry
}

export function drawStage(ctx: Ctx2D, f: StageFrame): void {
  const { width: w, height: h } = f
  if (!(w > 0 && h > 0)) return
  const L = stageLayout(f)
  const pulse = Math.max(0, Math.min(1, Number.isFinite(f.beatPulse) ? f.beatPulse : 0))
  const time = Number.isFinite(f.time) ? f.time : 0
  const fy = Math.min(h, Math.max(h * 0.5, L.floorY))

  ctx.save()
  blitStatic(ctx, w, h, L)

  // Twinkling stars in the sky (dimmer towards the horizon).
  const sizeK = Math.max(0.6, Math.min(2, Math.min(w, h) / 700))
  ctx.fillStyle = '#ffffff'
  for (const st of STARS) {
    const x = st.x * w
    const y = h * 0.06 + st.y * (fy - h * 0.12)
    const a = twinkle(st, time) * (1 - 0.6 * st.y)
    ctx.globalAlpha = a
    const r = st.r * sizeK
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
    if (st.r > 1.3) {
      ctx.globalAlpha = a * 0.5
      ctx.fillRect(x - r * 3.5, y - r * 0.25, r * 7, r * 0.5)
      ctx.fillRect(x - r * 0.25, y - r * 3.5, r * 0.5, r * 7)
    }
  }
  ctx.globalAlpha = 1

  // Theme aura + spotlight beam, and the floor pool pulsing (brighter, a little wider) on beats.
  const lit = lights(L, f.theme, deviceScale(ctx))
  if (lit) {
    const a = ambientRect(L)
    ctx.globalAlpha = 0.62 + 0.38 * pulse
    ctx.drawImage(lit.ambient, a.x, a.y, a.w, a.h)
    const p = poolRect(L)
    const grow = 1 + 0.07 * pulse
    ctx.globalAlpha = 0.58 + 0.42 * pulse
    ctx.drawImage(lit.pool, L.floorX - (p.w * grow) / 2, L.floorY - (p.h * grow) / 2, p.w * grow, p.h * grow)
    ctx.globalAlpha = 1
  } else {
    drawAmbient(ctx, L, f.theme, pulse)
    drawPool(ctx, L, f.theme, pulse, 1 + 0.07 * pulse)
  }
  ctx.restore()
}
