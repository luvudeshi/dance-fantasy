// One requestAnimationFrame loop shared by many canvases; only canvases currently on screen
// (IntersectionObserver) are drawn. The loop stops while nothing is registered.

export type DrawFn = (nowSec: number) => void

interface Entry {
  draw: DrawFn
  visible: boolean
}

export class CanvasLoop {
  private readonly entries = new Map<Element, Entry>()
  private io: IntersectionObserver | null = null
  private raf = 0

  /** Registers `el`; `draw` runs every frame while it is visible. Returns the unregister function. */
  add(el: Element, draw: DrawFn): () => void {
    const entry: Entry = { draw, visible: false }
    this.entries.set(el, entry)
    this.observer().observe(el)
    this.start()
    return () => {
      if (this.entries.get(el) === entry) {
        this.entries.delete(el)
        this.io?.unobserve(el)
      }
      if (this.entries.size === 0) this.stop()
    }
  }

  /** Number of entries drawn on the last frame (debug readout). */
  visibleCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.visible) n++
    return n
  }

  dispose(): void {
    this.stop()
    this.io?.disconnect()
    this.io = null
    this.entries.clear()
  }

  private observer(): IntersectionObserver {
    this.io ??= new IntersectionObserver(
      (records) => {
        for (const r of records) {
          const e = this.entries.get(r.target)
          if (e) e.visible = r.isIntersecting
        }
      },
      { rootMargin: '120px' },
    )
    return this.io
  }

  private readonly tick = (ms: number): void => {
    this.raf = 0
    const now = ms / 1000
    for (const e of this.entries.values()) if (e.visible) e.draw(now)
    if (this.entries.size > 0) this.raf = requestAnimationFrame(this.tick)
  }

  private start(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick)
  }

  private stop(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }
}
