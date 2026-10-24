export interface PreparedCanvas {
  ctx: CanvasRenderingContext2D
  /** Drawing size in CSS pixels (the context is pre-scaled for devicePixelRatio). */
  width: number
  height: number
}

/**
 * Matches the canvas backing store to its CSS box x devicePixelRatio (cheap no-op when
 * unchanged, so it can run every frame and follows resizes and monitor changes), clears
 * it and returns a context that draws in CSS pixels. Null when the canvas has no size.
 */
export function prepareCanvas(canvas: HTMLCanvasElement): PreparedCanvas | null {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width <= 0 || height <= 0) return null
  const dpr = window.devicePixelRatio || 1
  const pxW = Math.round(width * dpr)
  const pxH = Math.round(height * dpr)
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW
    canvas.height = pxH
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(pxW / width, 0, 0, pxH / height, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return { ctx, width, height }
}
