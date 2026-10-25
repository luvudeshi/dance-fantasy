// Test helpers (used by the render unit tests only): a recording 2D context and Path2D for
// Node, where there is no canvas.

import type { Ctx2D } from '../pose/draw'

export interface RecordedCall {
  name: string
  args: unknown[]
}

/** A Ctx2D stand-in that records every method call; gradients and getTransform behave. */
export function stubContext(scale = 1): { ctx: Ctx2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const gradient = { addColorStop: () => undefined }
  const special: Record<string, (...args: unknown[]) => unknown> = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getTransform: () => ({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }),
  }
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined
        return (...args: unknown[]) => {
          calls.push({ name: prop, args })
          return special[prop]?.(...args)
        }
      },
      set: () => true,
    },
  ) as unknown as Ctx2D
  return { ctx, calls }
}

/** Path2D stand-in that records its segments. */
export class RecordingPath {
  readonly ops: RecordedCall[] = []
  private rec(name: string, args: unknown[]): void {
    this.ops.push({ name, args })
  }
  moveTo(...a: number[]): void {
    this.rec('moveTo', a)
  }
  lineTo(...a: number[]): void {
    this.rec('lineTo', a)
  }
  quadraticCurveTo(...a: number[]): void {
    this.rec('quadraticCurveTo', a)
  }
  arc(...a: Array<number | boolean | undefined>): void {
    this.rec('arc', a)
  }
  ellipse(...a: Array<number | boolean | undefined>): void {
    this.rec('ellipse', a)
  }
  closePath(): void {
    this.rec('closePath', [])
  }
}
