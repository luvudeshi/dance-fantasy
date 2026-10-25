// The party's magic mirror: the camera (mirrored, like a reflection) on night glass with every tracked
// dancer outlined in their colour, their name over their head and judgment callouts ("PERFECT!") in
// their colour. Canvas text uses the Dance Fantasy fonts (Figtree UI, Fraunces story voice).

import { useEffect, useRef } from 'react'
import type { JointName, Vec2 } from '@shared/skeleton'
import { prepareCanvas } from '../lib/canvas'
import { drawSkeleton } from '../pose/draw'
import { imageToDisplay } from '../pose/normalize'
import type { PartyPlayerView, PartyRun } from './partyRun'
import { colorOf, displayName, type PartyPlayer } from './players'
import type { PartyTracker } from './tracker'

// theme/tokens.css --df-font-ui / --df-font-display (canvas can't read CSS vars per draw cheaply)
const UI_FONT = "Figtree, 'Avenir Next', system-ui, sans-serif"
const STORY_FONT = "Fraunces, 'Iowan Old Style', Georgia, serif"
const NIGHT = '#263a55'
const NIGHT_DEEP = '#152338'
const ON_NIGHT = '#e9dcb8'

interface Props {
  tracker: PartyTracker
  players: readonly PartyPlayer[]
  video?: HTMLVideoElement
  /** In game: callouts and the "can't see you" state come from the run. */
  run?: PartyRun | null
  /** Shown on the glass while nobody is there. */
  emptyText?: string
  label: string
}

interface Figure {
  player: PartyPlayer
  points: Partial<Record<JointName, Vec2>>
  visibility: Partial<Record<JointName, number>>
  view: PartyPlayerView | null
}

function popScale(age: number): number {
  return age < 0.2 ? 0.6 + (0.4 * age) / 0.2 + 0.15 * Math.sin((age / 0.2) * Math.PI) : 1
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, ink: string, size: number): void {
  ctx.font = `800 ${size}px ${UI_FONT}`
  const w = ctx.measureText(text).width + size * 1.1
  const h = size * 1.55
  ctx.fillStyle = '#fffaf0'
  ctx.beginPath()
  ctx.roundRect(x - w / 2 - 3, y - h / 2 - 3, w + 6, h + 6, h)
  ctx.fill()
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h)
  ctx.fill()
  ctx.fillStyle = ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y + 1)
}

function drawCallout(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, age: number): void {
  ctx.save()
  ctx.globalAlpha = age > 0.7 ? Math.max(0, (1 - age) / 0.3) : 1
  ctx.translate(x, y - age * size * 0.6)
  const s = popScale(age)
  ctx.scale(s, s)
  ctx.font = `italic 800 ${size}px ${STORY_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.lineWidth = size * 0.22
  ctx.strokeStyle = '#fffaf0'
  ctx.strokeText(text, 0, 0)
  ctx.lineWidth = size * 0.1
  ctx.strokeStyle = NIGHT_DEEP
  ctx.strokeText(text, 0, 0)
  ctx.fillStyle = color
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

function drawPartyMirror(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  o: { figures: readonly Figure[]; video?: HTMLVideoElement; vw: number; vh: number; emptyText?: string },
): void {
  ctx.fillStyle = NIGHT
  ctx.fillRect(0, 0, w, h)
  const { video, vw, vh } = o
  if (video && video.readyState >= 2 && vw > 0 && vh > 0) {
    const s = Math.min(w / vw, h / vh)
    const dw = vw * s
    const dh = vh * s
    ctx.save()
    ctx.translate(w, 0)
    ctx.scale(-1, 1) // a reflection: the players' right hand is on the right of the mirror
    ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh)
    ctx.restore()
    ctx.fillStyle = 'rgb(21 35 56 / 0.28)' // calm the video so the outlines read
    ctx.fillRect(0, 0, w, h)
  }
  const unit = Math.max(10, Math.min(w, h) / 22)
  if (o.figures.length === 0 && o.emptyText) {
    ctx.font = `italic 600 ${Math.round(unit * 1.3)}px ${STORY_FONT}`
    ctx.fillStyle = ON_NIGHT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(o.emptyText, w / 2, h / 2)
  }
  const heads = o.figures.map((f) => f.points.nose ?? f.points.l_shoulder)
  o.figures.forEach((f, i) => {
    const c = colorOf(f.player)
    drawSkeleton(ctx, f.points, { visibility: f.visibility, color: c.hex, outlineColor: NIGHT_DEEP, lineWidth: Math.max(3, unit * 0.42), minVisibility: 0.5 })
    const head = heads[i]
    if (!head) return
    const topY = Math.max(unit * 1.2, head[1] - unit * 2.2)
    drawLabel(ctx, displayName(f.player), head[0], topY, c.hex, c.on, Math.round(unit * 0.85))
    const call = f.view?.callout
    if (!call) return
    // as wide as the gap to the nearest neighbour allows, so side-by-side callouts never overlap
    let room = w
    heads.forEach((h2, k) => {
      if (h2 && k !== i) room = Math.min(room, Math.abs(h2[0] - head[0]))
    })
    ctx.font = `italic 800 100px ${STORY_FONT}`
    const at100 = ctx.measureText(call.label).width * 1.15 // + the cut-out stroke
    const size = Math.min(unit * 1.9, (room * 0.95 * 100) / Math.max(1, at100))
    if (size >= 9) drawCallout(ctx, call.label, head[0], Math.max(size * 1.4, topY - unit * 1.2), c.hex, Math.round(size), call.age)
  })
}

export default function PartyMirror({ tracker, players, video, run, emptyText, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const prepared = prepareCanvas(canvas, 2)
      if (!prepared) return
      const t = tracker.latest()
      const views = run ? run.view() : null
      const vw = t?.videoWidth ?? video?.videoWidth ?? 0
      const vh = t?.videoHeight ?? video?.videoHeight ?? 0
      const figures: Figure[] = []
      players.forEach((player, i) => {
        const view = views?.[i] ?? null
        const frame = views ? (view?.frame ?? null) : (t?.players[i] ?? null)
        if (!frame?.image || !(vw > 0)) return
        const points: Partial<Record<JointName, Vec2>> = {}
        for (const [j, p] of Object.entries(frame.image) as [JointName, Vec2][]) {
          points[j] = imageToDisplay(p, vw, vh, prepared.width, prepared.height, true)
        }
        figures.push({ player, points, visibility: frame.visibility, view })
      })
      drawPartyMirror(prepared.ctx, prepared.width, prepared.height, { figures, video, vw, vh, emptyText })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [tracker, players, video, run, emptyText])
  return <canvas ref={canvasRef} className="party-mirror-canvas" role="img" aria-label={label} />
}
