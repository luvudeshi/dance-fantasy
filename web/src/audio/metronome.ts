// Sample-accurate metronome clicks scheduled on the AudioContext clock.

export interface ClickTrack {
  /** Mute/unmute without rescheduling (takes effect immediately). */
  setEnabled(enabled: boolean): void
  /** Silences and cancels every scheduled click. Safe to call more than once. */
  stop(): void
}

export interface ClickOptions {
  /** Default ctx.destination. */
  destination?: AudioNode
  /** Start muted when false. Default true. */
  enabled?: boolean
  /** Click gain, 0..1. Default 0.35. */
  volume?: number
  /** Click pitch in Hz. Default 1200. */
  frequency?: number
}

const CLICK_SEC = 0.045

/**
 * Schedules one short sine blip at exactly `startAt + t` for every `t` in `times`
 * (seconds, song time). Everything is scheduled upfront on the audio clock, so clicks
 * stay tight even when the page is in a background tab; beats already in the past are
 * skipped. All clicks go through one bus gain, which makes muting and stopping instant.
 */
export function scheduleClicks(
  ctx: BaseAudioContext,
  times: readonly number[],
  startAt: number,
  opts: ClickOptions = {},
): ClickTrack {
  const volume = opts.volume ?? 0.35
  const bus = ctx.createGain()
  bus.gain.value = opts.enabled === false ? 0 : volume
  bus.connect(opts.destination ?? ctx.destination)

  const now = ctx.currentTime
  const oscillators: OscillatorNode[] = []
  for (const t of times) {
    const when = startAt + t
    if (!Number.isFinite(when) || when < now) continue
    const osc = ctx.createOscillator()
    osc.frequency.value = opts.frequency ?? 1200
    const env = ctx.createGain()
    env.gain.value = 0
    env.gain.setValueAtTime(0, when)
    env.gain.linearRampToValueAtTime(1, when + 0.002)
    env.gain.exponentialRampToValueAtTime(0.001, when + CLICK_SEC)
    osc.connect(env)
    env.connect(bus)
    osc.start(when)
    osc.stop(when + CLICK_SEC + 0.005)
    osc.onended = () => env.disconnect()
    oscillators.push(osc)
  }

  let stopped = false
  return {
    setEnabled(enabled: boolean) {
      if (stopped) return
      bus.gain.cancelScheduledValues(ctx.currentTime)
      bus.gain.setValueAtTime(enabled ? volume : 0, ctx.currentTime)
    },
    stop() {
      if (stopped) return
      stopped = true
      bus.disconnect()
      for (const osc of oscillators) {
        osc.onended = null
        try {
          osc.stop()
        } catch {
          // Older Safari throws when stop() is called twice; the click is silent anyway.
        }
        osc.disconnect()
      }
      oscillators.length = 0
    },
  }
}
