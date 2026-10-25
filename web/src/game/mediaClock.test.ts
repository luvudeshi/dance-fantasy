import { describe, expect, it } from 'vitest'
import {
  audibleMediaTime,
  isTeachRate,
  loopAction,
  MediaTimeSmoother,
  preservePitch,
  SMOOTH_GAIN,
  songTimeAtPerf,
  TeachClock,
} from './mediaClock'

describe('MediaTimeSmoother', () => {
  it('extrapolates between currentTime refreshes at the playback rate', () => {
    const s = new MediaTimeSmoother()
    s.reset(10, 1000, 0.5, true)
    expect(s.sample(10, 1000)).toBeCloseTo(10)
    expect(s.sample(10, 1200)).toBeCloseTo(10.1) // 200 ms real at 0.5x = 0.1 s of song
    expect(s.sample(10, 2000)).toBeCloseTo(10.5)
  })

  it('stays monotonic when a refresh is a little behind the extrapolation', () => {
    const s = new MediaTimeSmoother()
    s.reset(0, 0, 1, true)
    expect(s.sample(0, 100)).toBeCloseTo(0.1)
    const held = s.sample(0.08, 100) // 20 ms behind: absorbed, never goes backwards
    expect(held).toBeCloseTo(0.1)
    const next = s.sample(0.08, 110)
    expect(next).toBeGreaterThanOrEqual(held)
    expect(next).toBeCloseTo(0.1 - 0.02 * SMOOTH_GAIN + 0.01, 5)
  })

  it('pulls toward a refresh that is ahead, by SMOOTH_GAIN', () => {
    const s = new MediaTimeSmoother()
    s.reset(0, 0, 1, true)
    expect(s.sample(0.14, 100)).toBeCloseTo(0.1 + 0.04 * SMOOTH_GAIN)
  })

  it('snaps on a jump (seek / loop restart), even backwards', () => {
    const s = new MediaTimeSmoother()
    s.reset(20, 0, 0.75, true)
    s.sample(20, 500)
    expect(s.sample(5, 600)).toBe(5)
    expect(s.sample(5, 1000)).toBeCloseTo(5 + 0.4 * 0.75)
  })

  it('reports the raw time while not running (paused / seeking)', () => {
    const s = new MediaTimeSmoother()
    s.reset(3, 0, 1, false)
    expect(s.sample(3, 5000)).toBe(3)
    expect(s.sample(7.5, 6000)).toBe(7.5)
  })
})

describe('time mapping', () => {
  it('subtracts output latency as latency x rate', () => {
    expect(audibleMediaTime(10, 0.1, 0.5)).toBeCloseTo(9.95)
    expect(audibleMediaTime(10, 0.1, 1)).toBeCloseTo(9.9)
  })

  it('maps a capture timestamp to song time at the playback rate', () => {
    expect(songTimeAtPerf(10, 2000, 1800, 0.5, 0)).toBeCloseTo(9.9)
    expect(songTimeAtPerf(10, 2000, 1800, 1, 0)).toBeCloseTo(9.8)
    expect(songTimeAtPerf(10, 2000, 1800, 0, 0)).toBe(10) // paused: frozen
  })

  it('maps frames from before the last seek / loop restart to NaN', () => {
    expect(songTimeAtPerf(10, 2000, 1499, 1, 1500)).toBeNaN()
    expect(songTimeAtPerf(10, 2000, 1500, 1, 1500)).toBeCloseTo(9.5)
  })

  it('decides loop jumps', () => {
    expect(loopAction(4.9, 5, true)).toBe('none')
    expect(loopAction(5, 5, true)).toBe('wrap')
    expect(loopAction(5.2, 5, false)).toBe('stop')
    expect(loopAction(1, 5, true, true)).toBe('wrap') // the song ended before the loop end
  })

  it('knows the teach rates', () => {
    expect(isTeachRate(0.75)).toBe(true)
    expect(isTeachRate(2)).toBe(false)
  })
})

describe('preservePitch', () => {
  it('sets the standard and prefixed flags', () => {
    const m = { preservesPitch: false, webkitPreservesPitch: false, mozPreservesPitch: false }
    preservePitch(m as unknown as HTMLMediaElement)
    expect(m).toEqual({ preservesPitch: true, webkitPreservesPitch: true, mozPreservesPitch: true })
  })
})

/** Just enough of an <audio> element for TeachClock. */
class FakeMedia {
  currentTime = 0
  playbackRate = 1
  paused = true
  seeking = false
  ended = false
  readyState = 4
  duration = 60
  preload = ''
  preservesPitch = false
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  removeAttribute(): void {}
  load(): void {}
}

describe('TeachClock', () => {
  const make = (): { clock: TeachClock; media: FakeMedia; now: { ms: number } } => {
    const media = new FakeMedia()
    const now = { ms: 0 }
    const clock = new TeachClock(media as unknown as HTMLAudioElement, () => now.ms)
    return { clock, media, now }
  }

  it('plays at the chosen rate with the pitch preserved', () => {
    const { clock, media } = make()
    media.preservesPitch = false
    clock.setRate(0.5)
    void clock.play()
    expect(media.playbackRate).toBe(0.5)
    expect(media.preservesPitch).toBe(true)
    expect(clock.rate).toBe(0.5)
  })

  it('extrapolates song time between refreshes and maps webcam timestamps at the rate', () => {
    const { clock, media, now } = make()
    clock.setRate(0.5)
    media.currentTime = 10
    void clock.play()
    now.ms = 400
    expect(clock.songTime()).toBeCloseTo(10.2)
    expect(clock.songTimeAt(200)).toBeCloseTo(10.1)
  })

  it('jumps back to the loop start at the loop end, or stops there with looping off', () => {
    const { clock, media, now } = make()
    clock.setLoop(8, 12, 2)
    expect(clock.loopRegion).toEqual({ start: 6, end: 12 })
    void clock.play()
    media.currentTime = 11.9
    expect(clock.update()).toBe('none')
    now.ms += 150
    media.currentTime = 12.05
    expect(clock.update()).toBe('wrap')
    expect(media.currentTime).toBe(6)
    expect(clock.loopPasses).toBe(1)
    expect(clock.songTimeAt(-1)).toBeNaN() // frames from the previous pass are dropped
    clock.setLooping(false)
    media.currentTime = 12.1 // a jump: snaps
    expect(clock.update()).toBe('stop')
    expect(media.paused).toBe(true)
    expect(media.currentTime).toBe(6)
  })
})
