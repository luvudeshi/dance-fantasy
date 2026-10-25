// Highlight reel frames on one 16:9 canvas: the clip's video (cover-fit) under the overlays
// (×N COMBO counter, Perfect/Good pops, slow-mo bars, caption) and the title / awards cards.
// Big type and high contrast for a projector. Timing comes from timeline.ts.

import { STORY_FONT as STORY, UI_FONT as SANS } from '../theme/fonts' // Fraunces, Figtree
import type { Award } from './awards'
import { overlayAt, type Segment } from './timeline'
import type { ClipMeta } from './types'

export const REEL_W = 1280
export const REEL_H = 720

const GOLD = '#fde68a'
const CYAN = '#7dd3fc'

function background(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createRadialGradient(REEL_W / 2, REEL_H * 0.35, 40, REEL_W / 2, REEL_H / 2, REEL_W * 0.75)
  g.addColorStop(0, '#2a2466')
  g.addColorStop(1, '#070a18')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, REEL_W, REEL_H)
}

function drawVideo(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, mirror: boolean): void {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return
  const scale = Math.max(REEL_W / vw, REEL_H / vh)
  const w = vw * scale
  const h = vh * scale
  ctx.save()
  if (mirror) {
    ctx.translate(REEL_W, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(video, (REEL_W - w) / 2, (REEL_H - h) / 2, w, h)
  ctx.restore()
}

function shadowText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.lineJoin = 'round'
  ctx.lineWidth = 10
  ctx.strokeStyle = 'rgba(5, 6, 20, 0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

export interface ClipFrame {
  video: HTMLVideoElement | null
  clip: ClipMeta
  segment: Segment
  songTime: number
  caption: string
  /** 1-based position in the reel. */
  index: number
  total: number
  /** Several players in the reel: name tags on. */
  showPlayer: boolean
}

export function drawClipFrame(ctx: CanvasRenderingContext2D, f: ClipFrame): void {
  background(ctx)
  if (f.video && f.clip.hasVideo) drawVideo(ctx, f.video, f.clip.mirrorVideo)
  else {
    ctx.font = `italic 34px ${STORY}`
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(230, 233, 248, 0.5)'
    ctx.fillText('(the magic mirror kept this one to itself)', REEL_W / 2, REEL_H / 2)
  }
  // Vignette so white type reads over any room.
  const v = ctx.createLinearGradient(0, 0, 0, REEL_H)
  v.addColorStop(0, 'rgba(5,6,20,0.55)')
  v.addColorStop(0.25, 'rgba(5,6,20,0)')
  v.addColorStop(0.7, 'rgba(5,6,20,0)')
  v.addColorStop(1, 'rgba(5,6,20,0.75)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, REEL_W, REEL_H)

  const slow = f.segment.kind === 'slowmo'
  if (slow) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, REEL_W, 56)
    ctx.fillRect(0, REEL_H - 56, REEL_W, 56)
    ctx.font = `800 30px ${SANS}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const blink = Math.floor(f.songTime * 4) % 2 === 0
    shadowText(ctx, `${blink ? '●' : '○'} SLOW-MO ×0.5`, 32, 28, '#f9a8d4')
  }

  // Header: which highlight, whose.
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.font = `700 28px ${SANS}`
  const who = f.showPlayer ? ` · ${f.clip.playerName}` : ''
  shadowText(ctx, `HIGHLIGHT ${f.index}/${f.total}${who}`, 32, slow ? 72 : 28, 'rgba(230,233,248,0.9)')

  // ×N COMBO, top right, bumping on each hit.
  const o = overlayAt(f.clip.judgments, f.songTime)
  if (o.combo > 0) {
    const s = 1 + 0.25 * o.bump
    ctx.save()
    ctx.translate(REEL_W - 40, slow ? 72 : 24)
    ctx.scale(s, s)
    ctx.textAlign = 'right'
    ctx.font = `900 112px ${SANS}`
    shadowText(ctx, `×${o.combo}`, 0, 0, GOLD)
    ctx.font = `800 34px ${SANS}`
    shadowText(ctx, 'COMBO', 0, 112, GOLD)
    ctx.restore()
  }

  // Perfect / Good pops, center.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const p of o.pops) {
    ctx.save()
    ctx.globalAlpha = p.alpha
    ctx.translate(REEL_W / 2, REEL_H * 0.42 - 60 * p.progress)
    ctx.scale(p.scale, p.scale)
    ctx.font = `italic 900 ${p.judgment === 'perfect' ? 110 : 90}px ${SANS}`
    shadowText(ctx, p.judgment === 'perfect' ? 'PERFECT!' : 'GOOD!', 0, 0, p.judgment === 'perfect' ? GOLD : CYAN)
    ctx.restore()
  }

  // Caption, bottom.
  if (f.caption) {
    const since = f.songTime - f.segment.from
    ctx.save()
    ctx.globalAlpha = f.segment.kind === 'play' ? Math.min(1, Math.max(0, since / 0.4)) : 1
    ctx.font = `italic 44px ${STORY}`
    ctx.textBaseline = 'alphabetic'
    let size = 44
    while (size > 24 && ctx.measureText(`“${f.caption}”`).width > REEL_W - 120) {
      size -= 2
      ctx.font = `italic ${size}px ${STORY}`
    }
    shadowText(ctx, `“${f.caption}”`, REEL_W / 2, REEL_H - (slow ? 84 : 48), '#ffffff')
    ctx.restore()
  }
}

export function drawTitleCard(ctx: CanvasRenderingContext2D, title: string, progress: number): void {
  background(ctx)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha = Math.min(1, progress * 3)
  ctx.font = `800 40px ${SANS}`
  shadowText(ctx, '✨ HIGHLIGHTS OF THE BALL ✨', REEL_W / 2, REEL_H * 0.4, GOLD)
  ctx.font = `italic 56px ${STORY}`
  shadowText(ctx, title, REEL_W / 2, REEL_H * 0.55, '#ffffff')
  ctx.globalAlpha = 1
}

export function drawAwardsCard(ctx: CanvasRenderingContext2D, awards: readonly Award[], showPlayer: boolean, progress: number): void {
  background(ctx)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `italic 64px ${STORY}`
  shadowText(ctx, 'The Royal Awards', REEL_W / 2, 110, GOLD)
  if (awards.length === 0) {
    ctx.font = `italic 36px ${STORY}`
    shadowText(ctx, 'The court awaits a longer streak next time', REEL_W / 2, REEL_H / 2, '#ffffff')
    return
  }
  const rowH = 150
  const top = REEL_H / 2 - ((awards.length - 1) * rowH) / 2 + 30
  awards.forEach((a, i) => {
    const appear = Math.min(1, Math.max(0, progress * 4 - i * 0.6))
    if (appear <= 0) return
    const y = top + i * rowH
    ctx.save()
    ctx.globalAlpha = appear
    ctx.translate((1 - appear) * 80, 0)
    ctx.textAlign = 'left'
    ctx.font = `80px ${SANS}`
    ctx.fillText(a.icon, 200, y)
    ctx.font = `800 46px ${SANS}`
    shadowText(ctx, a.title.toUpperCase(), 310, y - 26, '#ffffff')
    ctx.font = `600 36px ${SANS}`
    shadowText(ctx, showPlayer ? `${a.playerName} · ${a.detail}` : a.detail, 310, y + 28, GOLD)
    ctx.restore()
  })
}
