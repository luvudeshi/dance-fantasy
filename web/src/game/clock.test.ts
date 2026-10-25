import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audibleSongTime, GameClock, START_DELAY_SEC } from './clock'

class FakeSource {
  buffer: unknown = null
  onended: (() => void) | null = null
  started: [number, number] | null = null
  stopped = false
  connected = false
  connect(): void {
    this.connected = true
  }
  disconnect(): void {
    this.connected = false
  }
  start(when: number, offset = 0): void {
    this.started = [when, offset]
  }
  stop(): void {
    this.stopped = true
  }
}

class FakeContext {
  static instances: FakeContext[] = []
  currentTime = 0
  baseLatency = 0.01
  outputLatency = 0.02
  state: 'running' | 'suspended' | 'closed' = 'suspended'
  destination = {}
  sources: FakeSource[] = []
  constructor() {
    FakeContext.instances.push(this)
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  decodeAudioData(): Promise<{ duration: number }> {
    return Promise.resolve({ duration: 10 })
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

const LAT = 0.03
const bytes = (): Blob => new Blob([new Uint8Array(8)])

beforeEach(() => {
  FakeContext.instances = []
  vi.stubGlobal('AudioContext', FakeContext)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('audibleSongTime', () => {
  it('subtracts output latency, holds at the floor, stops at the end', () => {
    expect(audibleSongTime(5, 0.03, 2, 0, 60)).toBeCloseTo(2.97, 9)
    expect(audibleSongTime(1, 0.03, 2, 0, 60)).toBe(0)
    expect(audibleSongTime(1, 0.03, 2, -2, 60)).toBeCloseTo(-1.03, 9)
    expect(audibleSongTime(99, 0.03, 2, 0, 60)).toBe(60)
  })
})

describe('GameClock', () => {
  it('creates the AudioContext on unlock (the user gesture) and decodes once per key', async () => {
    const clock = new GameClock()
    expect(clock.context).toBeNull()
    clock.unlock()
    expect(FakeContext.instances).toHaveLength(1)
    expect(FakeContext.instances[0].state).toBe('running')
    expect(await clock.load('k', { file: bytes() })).toBe(10)
    expect(await clock.load('k', { file: bytes() })).toBe(10)
    expect(clock.loadedKey).toBe('k')
  })

  it('plays a count-in lead-in, then the song from 0, on the audio clock', async () => {
    const clock = new GameClock()
    clock.unlock()
    await clock.load('k', { file: bytes() })
    const ctx = FakeContext.instances[0]
    ctx.currentTime = 1
    clock.play(-2)
    const startAt = 1 + START_DELAY_SEC + 2
    expect(ctx.sources[0].started).toEqual([startAt, 0])
    expect(clock.startAt).toBeCloseTo(startAt, 9)
    expect(clock.songTime()).toBe(-2) // held at the start position during the scheduling delay
    ctx.currentTime = startAt + LAT
    expect(clock.songTime()).toBeCloseTo(0, 9) // music audible now
    ctx.currentTime = startAt + LAT + 1.5
    expect(clock.songTime()).toBeCloseTo(1.5, 9)
  })

  it('pauses at the audible time and resumes from there without jumping back', async () => {
    const clock = new GameClock()
    clock.unlock()
    await clock.load('k', { file: bytes() })
    const ctx = FakeContext.instances[0]
    clock.play(0)
    ctx.currentTime = START_DELAY_SEC + LAT + 3
    clock.pause()
    expect(clock.playing).toBe(false)
    expect(ctx.sources[0].stopped).toBe(true)
    expect(clock.songTime()).toBeCloseTo(3, 9)
    ctx.currentTime = 20
    expect(clock.songTime()).toBeCloseTo(3, 9) // frozen while paused
    clock.resume()
    expect(ctx.sources[1].started).toEqual([20 + START_DELAY_SEC, expect.closeTo(3, 9)])
    expect(clock.songTime()).toBeCloseTo(3, 9)
    ctx.currentTime = 20 + START_DELAY_SEC + LAT + 1
    expect(clock.songTime()).toBeCloseTo(4, 9)
  })

  it('reports the end once, stop rewinds, dispose closes the context', async () => {
    const clock = new GameClock()
    const ended = vi.fn()
    clock.setOnEnded(ended)
    clock.unlock()
    await clock.load('k', { file: bytes() })
    const ctx = FakeContext.instances[0]
    clock.play(0)
    const first = ctx.sources[0]
    clock.play(0) // restart: the old source must not report the end
    first.onended?.()
    expect(first.stopped).toBe(true)
    expect(ended).not.toHaveBeenCalled()
    ctx.sources[1].onended?.()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(clock.playing).toBe(false)
    clock.stop()
    expect(clock.songTime()).toBe(0)
    clock.dispose()
    expect(ctx.state).toBe('closed')
    expect(clock.context).toBeNull()
    expect(clock.loadedKey).toBeNull()
  })
})
