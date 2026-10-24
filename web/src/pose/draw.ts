// Generic stick-figure renderer for any 2D canvas. Points are already in screen (CSS px)
// coordinates: map them with imageToDisplay / bodyToScreen first.

import { BONES, JOINTS, type JointName, type Vec2 } from '@shared/skeleton'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface DrawSkeletonOptions {
  /** Per-joint visibility (0..1). Joints without an entry count as visible. */
  visibility?: Partial<Record<JointName, number>>
  /** Joints (and bones touching them) below this are drawn faded and dashed. Default 0.5. */
  minVisibility?: number
  /** Default '#7dd3fc'. */
  color?: string
  /** Default 4 (CSS px). */
  lineWidth?: number
  /** Default 1.25 x lineWidth. */
  jointRadius?: number
  /** Optional darker under-stroke for contrast on busy backgrounds such as video. */
  outlineColor?: string
  /** Opacity of low-visibility parts. Default 0.35. */
  fadedAlpha?: number
}

const isPoint = (p: Vec2 | undefined): p is Vec2 =>
  p !== undefined && Number.isFinite(p[0]) && Number.isFinite(p[1])

export function drawSkeleton(
  ctx: Ctx2D,
  points: Partial<Record<JointName, Vec2>>,
  opts: DrawSkeletonOptions = {},
): void {
  const {
    visibility,
    minVisibility = 0.5,
    color = '#7dd3fc',
    lineWidth = 4,
    jointRadius = lineWidth * 1.25,
    outlineColor,
    fadedAlpha = 0.35,
  } = opts
  const visible = (j: JointName): boolean => (visibility?.[j] ?? 1) >= minVisibility

  const solidBones: Array<[Vec2, Vec2]> = []
  const fadedBones: Array<[Vec2, Vec2]> = []
  for (const [a, b] of BONES) {
    const pa = points[a]
    const pb = points[b]
    if (!isPoint(pa) || !isPoint(pb)) continue
    ;(visible(a) && visible(b) ? solidBones : fadedBones).push([pa, pb])
  }

  const strokeBones = (bones: Array<[Vec2, Vec2]>): void => {
    if (bones.length === 0) return
    ctx.beginPath()
    for (const [pa, pb] of bones) {
      ctx.moveTo(pa[0], pa[1])
      ctx.lineTo(pb[0], pb[1])
    }
    if (outlineColor) {
      ctx.strokeStyle = outlineColor
      ctx.lineWidth = lineWidth + 3
      ctx.stroke()
    }
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.stroke()
  }

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  ctx.globalAlpha = fadedAlpha
  ctx.setLineDash([lineWidth * 1.5, lineWidth * 1.5])
  strokeBones(fadedBones)
  ctx.globalAlpha = 1
  ctx.setLineDash([])
  strokeBones(solidBones)

  for (const j of JOINTS) {
    const p = points[j]
    if (!isPoint(p)) continue
    ctx.beginPath()
    ctx.arc(p[0], p[1], jointRadius, 0, Math.PI * 2)
    if (visible(j)) {
      ctx.globalAlpha = 1
      if (outlineColor) {
        ctx.strokeStyle = outlineColor
        ctx.lineWidth = 2
        ctx.stroke()
      }
      ctx.fillStyle = color
      ctx.fill()
    } else {
      ctx.globalAlpha = fadedAlpha
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, lineWidth / 2)
      ctx.stroke()
    }
  }
  ctx.restore()
}
