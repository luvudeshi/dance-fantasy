/**
 * Sliding-window event counter: events per second and the mean of a value (e.g. inference
 * ms) over the last `windowMs`. Timestamps are caller-supplied (performance.now()) so it
 * is deterministic in tests.
 */
export class RateMeter {
  readonly windowMs: number
  private times: number[] = []
  private values: number[] = []
  private head = 0
  private sum = 0

  constructor(windowMs = 1000) {
    this.windowMs = windowMs
  }

  add(now: number, value = 0): void {
    this.times.push(now)
    this.values.push(value)
    this.sum += value
    this.trim(now)
  }

  /** Events per second over the window. */
  rate(now: number): number {
    this.trim(now)
    return (this.count * 1000) / this.windowMs
  }

  /** Mean value of the events in the window (0 when empty). */
  mean(now: number): number {
    this.trim(now)
    return this.count > 0 ? this.sum / this.count : 0
  }

  get count(): number {
    return this.times.length - this.head
  }

  reset(): void {
    this.times = []
    this.values = []
    this.head = 0
    this.sum = 0
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs
    while (this.head < this.times.length && this.times[this.head] <= cutoff) {
      this.sum -= this.values[this.head]
      this.head++
    }
    if (this.head > 512 && this.head * 2 > this.times.length) {
      this.times = this.times.slice(this.head)
      this.values = this.values.slice(this.head)
      this.head = 0
      // Re-sum occasionally so floating-point drift can't accumulate.
      this.sum = this.values.reduce((a, b) => a + b, 0)
    }
    if (this.count === 0) this.sum = 0
  }
}
