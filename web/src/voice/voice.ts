// The herald's voice: announcer lines played as the server's expressive TTS audio
// (GET /api/announcer/voice/{id}, shared/README.md "AI endpoints"), one line at a time, with the
// browser's speechSynthesis as the fallback when the audio fails or is slow.
//
//   speak(line)       queue a line (a string, or an { id, text } item from POST /api/announcer)
//   prefetch(lines)   warm the audio of lines that are likely next
//   stopVoice()       silence now and drop the queue
//   unlockVoice()     call in a click handler (autoplay policy), e.g. on Play
//   setVoiceDucker()  the game music's duck(on) hook: true while the herald speaks
//
// A line's id is sha256 of its text, so a plain string is hashed here; the server only voices lines its
// announcer gave out (anything else is a 404, which falls back to speechSynthesis).

import { apiUrl } from '../api'
import { errorMessage, isAbortError } from '../lib/errors'

export interface VoiceLine {
  /** sha256 hex of `text` (POST /api/announcer `items[].id`); computed when missing. */
  id?: string
  text: string
}

/**
 * Speak with speechSynthesis instead when the audio isn't ready this long after speak(). A recorded line
 * arrives well within it; a fresh one takes ~2.5 s to voice, and the herald's voice beats a robotic one late.
 */
export const FALLBACK_AFTER_MS = 3500
/** A queued line still waiting this long after speak() is dropped: the moment has passed. */
export const STALE_AFTER_MS = 4000
const CLIP_CACHE_MAX = 32
const LOAD_TIMEOUT_MS = 10_000
const ATTACK_SEC = 0.012
const RELEASE_SEC = 0.04

/** What the player needs from the platform (the browser's below; tests pass their own). */
export interface VoiceDeps<C> {
  /** Fetch and decode one line's audio. */
  load: (id: string, signal: AbortSignal) => Promise<C>
  /** Play a clip; resolves when it ends or `signal` aborts. Rejects if it can't play. */
  play: (clip: C, signal: AbortSignal) => Promise<void>
  /** Say the text another way (speechSynthesis); resolves when done or aborted. */
  fallback: (text: string, signal: AbortSignal) => Promise<void>
  /** sha256 hex of the text, null when the platform can't hash (the line then falls back). */
  hash: (text: string) => Promise<string | null>
  /** True while the herald speaks (game-music ducking). */
  duck?: (on: boolean) => void
  now?: () => number
}

export interface VoicePlayer {
  speak(line: string | VoiceLine): void
  prefetch(lines: readonly (string | VoiceLine)[]): void
  stop(): void
}

interface Queued<C> {
  text: string
  clip: Promise<C | null>
  at: number
}

const asLine = (line: string | VoiceLine): VoiceLine => (typeof line === 'string' ? { text: line } : line)

/** Resolves after `ms`, or as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

export function createVoicePlayer<C>(deps: VoiceDeps<C>): VoicePlayer {
  const now = deps.now ?? (() => performance.now())
  /** Decoded clips by text (null: failed, so the line falls back). Oldest first, for eviction. */
  const clips = new Map<string, Promise<C | null>>()
  let queue: Queued<C>[] = []
  let current: AbortController | null = null
  let running = false
  let ducked = false

  const duck = (on: boolean): void => {
    if (on === ducked) return
    ducked = on
    deps.duck?.(on)
  }

  const clipFor = (line: VoiceLine): Promise<C | null> => {
    const cached = clips.get(line.text)
    if (cached) return cached
    const clip = (async () => {
      const id = line.id ?? (await deps.hash(line.text))
      return id ? await deps.load(id, AbortSignal.timeout(LOAD_TIMEOUT_MS)) : null
    })().catch((err: unknown) => {
      clips.delete(line.text) // not remembered: a later speak() may get it (e.g. once the server has a key)
      if (!isAbortError(err)) console.warn(`voice: no audio for a line (${errorMessage(err)})`)
      return null
    })
    clips.set(line.text, clip)
    if (clips.size > CLIP_CACHE_MAX) clips.delete(clips.keys().next().value as string)
    return clip
  }

  const say = async (item: Queued<C>, signal: AbortSignal): Promise<void> => {
    const deadline = Math.max(0, item.at + FALLBACK_AFTER_MS - now())
    const clip = await Promise.race([item.clip, wait(deadline, signal).then(() => null)])
    if (signal.aborted) return
    duck(true) // stays down across back-to-back lines; up again once the queue is empty
    if (clip !== null) {
      try {
        await deps.play(clip, signal)
        return
      } catch (err) {
        if (signal.aborted) return
        console.warn(`voice: audio playback failed, using speech (${errorMessage(err)})`)
      }
    }
    await deps.fallback(item.text, signal)
  }

  const pump = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (now() - item.at > STALE_AFTER_MS) continue
        const ctl = new AbortController()
        current = ctl
        await say(item, ctl.signal).catch((err: unknown) => console.warn(`voice: could not speak a line (${errorMessage(err)})`))
        current = null
      }
    } finally {
      running = false
      current = null
      duck(false)
    }
  }

  return {
    speak(line) {
      const l = asLine(line)
      const text = l.text.trim()
      if (!text) return
      queue.push({ text, clip: clipFor({ ...l, text }), at: now() })
      void pump()
    },
    prefetch(lines) {
      for (const line of lines) {
        const l = asLine(line)
        if (l.text.trim()) void clipFor({ ...l, text: l.text.trim() })
      }
    },
    stop() {
      queue = []
      current?.abort()
    },
  }
}

// --- the browser ---------------------------------------------------------------------------------

let ownContext: AudioContext | null = null

function audioContext(): AudioContext {
  if (!ownContext || ownContext.state === 'closed') ownContext = new AudioContext({ latencyHint: 'interactive' })
  return ownContext
}

/** A line's id as the server computes it: sha256 hex of the UTF-8 text (null outside secure contexts). */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle as SubtleCrypto | undefined // missing outside secure contexts
  if (!subtle) return null
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function loadClip(id: string, signal: AbortSignal): Promise<AudioBuffer> {
  const res = await fetch(apiUrl(`/api/announcer/voice/${encodeURIComponent(id)}`), { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return audioContext().decodeAudioData(await res.arrayBuffer())
}

async function playClip(buffer: AudioBuffer, signal: AbortSignal): Promise<void> {
  const ctx = audioContext()
  const running = (): boolean => ctx.state === 'running' // a call, so the check after the await isn't narrowed away
  if (!running()) {
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))])
    if (!running()) throw new Error('audio is locked until the page is clicked')
  }
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const gain = ctx.createGain()
  const t = ctx.currentTime
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(1, t + ATTACK_SEC) // a short attack: no click on the first sample
  source.connect(gain).connect(ctx.destination)
  await new Promise<void>((resolve) => {
    const release = (): void => {
      const at = ctx.currentTime
      gain.gain.cancelScheduledValues(at)
      gain.gain.setValueAtTime(gain.gain.value, at)
      gain.gain.linearRampToValueAtTime(0, at + RELEASE_SEC)
      source.stop(at + RELEASE_SEC)
    }
    source.onended = () => {
      signal.removeEventListener('abort', release)
      source.disconnect()
      gain.disconnect()
      resolve()
    }
    signal.addEventListener('abort', release, { once: true })
    source.start(t)
  })
}

type VoiceLike = Pick<SpeechSynthesisVoice, 'name' | 'lang'>

/** Neural / natural-sounding browser voices (Edge "Natural", Apple "Premium"/"Enhanced", Chrome's Google voices). */
const NATURAL_VOICE = /natural|neural|premium|enhanced|^google/i

/** The least robotic English voice: natural ones first, British before others (the herald), then any English. */
export function pickSpeechVoice<V extends VoiceLike>(voices: readonly V[]): V | null {
  const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang))
  const gb = (v: V): boolean => /^en[-_]gb/i.test(v.lang)
  const natural = en.filter((v) => NATURAL_VOICE.test(v.name))
  return natural.find(gb) ?? natural[0] ?? en.find(gb) ?? en[0] ?? null
}

function speakWithSynthesis(text: string, signal: AbortSignal): Promise<void> {
  const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined' || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text)
    const voice = pickSpeechVoice(synth.getVoices())
    if (voice) u.voice = voice
    u.lang = voice?.lang ?? 'en-GB'
    // A touch quick for energy; the voice's own pitch (raised pitch is what made it sound robotic).
    u.rate = 1.05
    // Some browsers never fire `end` for an utterance: give up after a generous estimate of its length.
    const guard = setTimeout(done, 2000 + text.length * 120)
    const abort = (): void => {
      synth.cancel()
      done()
    }
    function done(): void {
      clearTimeout(guard)
      signal.removeEventListener('abort', abort)
      resolve()
    }
    u.onend = done
    u.onerror = done
    signal.addEventListener('abort', abort, { once: true })
    synth.speak(u)
  })
}

let ducker: ((on: boolean) => void) | null = null
let herald: VoicePlayer | null = null

function heraldVoice(): VoicePlayer {
  herald ??= createVoicePlayer<AudioBuffer>({
    load: loadClip,
    play: playClip,
    fallback: speakWithSynthesis,
    hash: sha256Hex,
    duck: (on) => ducker?.(on),
  })
  return herald
}

/** Queue a line for the herald (never overlaps; stale lines are dropped). */
export const speak = (line: string | VoiceLine): void => heraldVoice().speak(line)
/** Fetch and decode lines that are likely next, so they play at once. */
export const prefetchVoice = (lines: readonly (string | VoiceLine)[]): void => heraldVoice().prefetch(lines)
/** Silence the herald now and drop anything queued. */
export const stopVoice = (): void => heraldVoice().stop()
/** Create / resume the voice's AudioContext: call it inside a click or key handler. */
export const unlockVoice = (): void => void audioContext().resume()
/** The game music's ducking hook: called with true while the herald speaks, false after (null: none). */
export const setVoiceDucker = (duck: ((on: boolean) => void) | null): void => {
  ducker = duck
}
