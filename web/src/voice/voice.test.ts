import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoicePlayer, FALLBACK_AFTER_MS, pickSpeechVoice, sha256Hex, STALE_AFTER_MS, type VoiceDeps } from './voice'

// The platform (fetch + decode, Web Audio, speechSynthesis) is replaced by a recorder: each clip "plays"
// for CLIP_MS of fake time, loads take whatever a test sets. The queue logic under test is the real one.
const CLIP_MS = 1000

interface Rig {
  log: string[]
  loads: string[]
  /** Load delay (ms) or failure by text; default: instant. */
  slow: Map<string, number | 'fail'>
  deps: VoiceDeps<string>
}

function rig(): Rig {
  const log: string[] = []
  const loads: string[] = []
  const slow = new Map<string, number | 'fail'>()
  const runFor = (label: string, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      log.push(`start ${label}`)
      const t = setTimeout(end, CLIP_MS)
      signal.addEventListener('abort', end, { once: true })
      function end(): void {
        clearTimeout(t)
        log.push(`end ${label}${signal.aborted ? ' (cut)' : ''}`)
        resolve()
      }
    })
  const deps: VoiceDeps<string> = {
    // WebCrypto resolves on a thread pool, outside fake time: the queue tests use a microtask-only stand-in
    // (sha256Hex itself is checked against the server's ids above).
    hash: (text) => Promise.resolve(`id:${text}`),
    load: (id) => {
      const text = id.replace(/^id:/, '')
      loads.push(text)
      const s = slow.get(text)
      if (s === 'fail') return Promise.reject(new Error('HTTP 404'))
      return new Promise((resolve) => setTimeout(() => resolve(text), s ?? 0))
    },
    play: (clip, signal) => runFor(`audio:${clip}`, signal),
    fallback: (text, signal) => runFor(`speech:${text}`, signal),
    duck: (on) => log.push(`duck ${on}`),
    now: () => Date.now(),
  }
  return { log, loads, slow, deps }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('line ids', () => {
  it('hashes the text like the server (sha256 hex of UTF-8)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await sha256Hex('Hear ye…')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses the id it is given instead of hashing', async () => {
    const r = rig()
    const hash = vi.fn(r.deps.hash)
    const player = createVoicePlayer({ ...r.deps, hash })
    player.speak({ id: 'given-id', text: 'Hello!' })
    await vi.advanceTimersByTimeAsync(CLIP_MS)
    expect(hash).not.toHaveBeenCalled()
    expect(r.loads).toEqual(['given-id'])
  })
})

describe('the queue', () => {
  it('plays the audio, one line at a time, ducking the music around the whole run', async () => {
    const r = rig()
    const player = createVoicePlayer(r.deps)
    player.speak('One!')
    player.speak('Two!')
    await vi.advanceTimersByTimeAsync(2 * CLIP_MS + 10)
    expect(r.log).toEqual(['duck true', 'start audio:One!', 'end audio:One!', 'start audio:Two!', 'end audio:Two!', 'duck false'])
  })

  it('drops a line still waiting more than STALE_AFTER_MS after speak()', async () => {
    const r = rig()
    const LONG_MS = STALE_AFTER_MS + 500 // each clip outlasts the stale limit
    const longPlay = vi.fn(
      (_clip: string, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, LONG_MS)
          signal.addEventListener('abort', () => resolve(), { once: true })
        }),
    )
    const player = createVoicePlayer({ ...r.deps, play: longPlay })
    player.speak('First!')
    player.speak('Stale!') // waits LONG_MS behind First: dropped
    await vi.advanceTimersByTimeAsync(LONG_MS - 1500)
    player.speak('Fresh!') // waits 1.5 s: still fresh
    await vi.advanceTimersByTimeAsync(3 * LONG_MS)
    expect(longPlay.mock.calls.map((c) => c[0])).toEqual(['First!', 'Fresh!'])
  })

  it('falls back to speech when the audio takes longer than FALLBACK_AFTER_MS, and keeps the late clip', async () => {
    const r = rig()
    const player = createVoicePlayer(r.deps)
    r.slow.set('Slow!', FALLBACK_AFTER_MS + 800)
    player.speak('Slow!')
    await vi.advanceTimersByTimeAsync(FALLBACK_AFTER_MS - 50)
    expect(r.log).toEqual([]) // still waiting for the audio
    await vi.advanceTimersByTimeAsync(100)
    expect(r.log).toEqual(['duck true', 'start speech:Slow!'])
    await vi.advanceTimersByTimeAsync(CLIP_MS + 1000)
    player.speak('Slow!') // the clip arrived meanwhile: the next time is the real voice
    await vi.advanceTimersByTimeAsync(CLIP_MS + 10)
    expect(r.log.filter((l) => l.startsWith('start'))).toEqual(['start speech:Slow!', 'start audio:Slow!'])
    expect(r.loads).toEqual(['Slow!'])
  })

  it('falls back to speech at once when the audio fails, can not play, or the text can not be hashed', async () => {
    const r = rig()
    r.slow.set('Unknown!', 'fail')
    const player = createVoicePlayer(r.deps)
    player.speak('Unknown!')
    await vi.advanceTimersByTimeAsync(CLIP_MS + 10)
    expect(r.log).toContain('start speech:Unknown!')

    const broken = createVoicePlayer({ ...r.deps, play: () => Promise.reject(new Error('locked')) })
    broken.speak('Locked!')
    await vi.advanceTimersByTimeAsync(CLIP_MS + 10)
    expect(r.log).toContain('start speech:Locked!')

    const insecure = createVoicePlayer({ ...r.deps, hash: async () => null })
    insecure.speak('Plain http!')
    await vi.advanceTimersByTimeAsync(CLIP_MS + 10)
    expect(r.log).toContain('start speech:Plain http!')
  })

  it('retries a failed line later instead of remembering the failure', async () => {
    const r = rig()
    r.slow.set('Retry!', 'fail')
    const player = createVoicePlayer(r.deps)
    player.speak('Retry!')
    await vi.advanceTimersByTimeAsync(CLIP_MS + 10)
    r.slow.delete('Retry!')
    player.speak('Retry!')
    await vi.advanceTimersByTimeAsync(CLIP_MS + 10)
    expect(r.loads).toEqual(['Retry!', 'Retry!'])
    expect(r.log.filter((l) => l.startsWith('start'))).toEqual(['start speech:Retry!', 'start audio:Retry!'])
  })

  it('stop() cuts the current line, drops the queue and lifts the duck', async () => {
    const r = rig()
    const player = createVoicePlayer(r.deps)
    player.speak('A!')
    player.speak('B!')
    await vi.advanceTimersByTimeAsync(CLIP_MS / 2)
    player.stop()
    await vi.advanceTimersByTimeAsync(3 * CLIP_MS)
    expect(r.log).toEqual(['duck true', 'start audio:A!', 'end audio:A! (cut)', 'duck false'])
    player.speak('C!') // still usable afterwards
    await vi.advanceTimersByTimeAsync(CLIP_MS + 10)
    expect(r.log.slice(-3)).toEqual(['start audio:C!', 'end audio:C!', 'duck false'])
  })

  it('stop() while waiting for the audio speaks nothing', async () => {
    const r = rig()
    r.slow.set('Late!', 800)
    const player = createVoicePlayer(r.deps)
    player.speak('Late!')
    await vi.advanceTimersByTimeAsync(200)
    player.stop()
    await vi.advanceTimersByTimeAsync(3 * CLIP_MS)
    expect(r.log).toEqual([]) // never spoke, so the music was never ducked
  })

  it('prefetch() loads each line once, so speak() plays it with no wait', async () => {
    const r = rig()
    r.slow.set('Next!', FALLBACK_AFTER_MS + 500) // too slow for speak() on its own
    const player = createVoicePlayer(r.deps)
    player.prefetch(['Next!', { text: 'Next!' }, '   '])
    await vi.advanceTimersByTimeAsync(FALLBACK_AFTER_MS + 600)
    player.speak('Next!')
    await vi.advanceTimersByTimeAsync(CLIP_MS + 10)
    expect(r.loads).toEqual(['Next!'])
    expect(r.log).toContain('start audio:Next!')
  })

  it('ignores blank lines', async () => {
    const r = rig()
    createVoicePlayer(r.deps).speak('   ')
    await vi.advanceTimersByTimeAsync(CLIP_MS)
    expect(r.log).toEqual([])
  })
})

describe('speech fallback voice', () => {
  it('prefers a British English voice, then any English one', () => {
    const v = (name: string, lang: string) => ({ name, lang })
    expect(pickSpeechVoice([v('Thomas', 'fr-FR'), v('Samantha', 'en-US'), v('Daniel', 'en-GB')])?.name).toBe('Daniel')
    expect(pickSpeechVoice([v('Thomas', 'fr-FR'), v('Samantha', 'en-US')])?.name).toBe('Samantha')
    expect(pickSpeechVoice([v('Thomas', 'fr-FR')])).toBeNull()
  })
})
