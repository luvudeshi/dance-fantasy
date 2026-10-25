// Polls a room about once a second (every 5 s while the tab is hidden), keeps the chat by id,
// and estimates the server clock from serverNow so every device counts down to the same instant.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api'
import { errorMessage, isAbortError } from '../lib/errors'
import { getRoom, mergeChat, type ChatMessage, type RoomView } from './client'

export const POLL_MS = 1000
export const POLL_HIDDEN_MS = 5000

export interface ClockSample {
  /** serverNow - local midpoint of the request (ms) */
  offset: number
  /** round trip (ms) */
  rtt: number
}

/** serverNow is stamped somewhere inside the round trip: assume the middle of it. */
export const clockSample = (serverNow: number, sentAt: number, receivedAt: number): ClockSample => ({
  offset: serverNow - (sentAt + receivedAt) / 2,
  rtt: receivedAt - sentAt,
})

/** The offset of the quickest recent round trip (its error is at most half that trip). */
export function bestOffset(samples: readonly ClockSample[]): number {
  let best: ClockSample | null = null
  for (const s of samples) if (!best || s.rtt < best.rtt) best = s
  return best?.offset ?? 0
}

const SAMPLES_KEPT = 8

export interface RoomConn {
  room: RoomView | null
  chat: ChatMessage[]
  /** server clock - local clock (ms): local time of server ms S is S - offsetMs */
  offsetMs: number
  /** last request's failure (cleared by the next success) */
  error: string | null
  /** 'left': our seat is gone (401); 'missing': unknown or expired room (404). Polling stops. */
  gone: 'left' | 'missing' | null
  /** Runs a write with the last chat id we have, applies its RoomView (it doubles as this second's poll). */
  act: (write: (chatAfter: number | undefined) => Promise<RoomView>) => Promise<RoomView>
}

/** Key the caller by code: state is not reset when `code` or `token` change. */
export function useRoom(code: string, token: string | null): RoomConn {
  const [room, setRoom] = useState<RoomView | null>(null)
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [offsetMs, setOffsetMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [gone, setGone] = useState<RoomConn['gone']>(null)
  const lastChatId = useRef<number | undefined>(undefined)
  const samples = useRef<ClockSample[]>([])
  const kick = useRef<() => void>(() => undefined)

  const apply = useCallback((view: RoomView, sentAt: number, receivedAt: number): void => {
    samples.current = [...samples.current, clockSample(view.serverNow, sentAt, receivedAt)].slice(-SAMPLES_KEPT)
    setOffsetMs(bestOffset(samples.current))
    const tail = view.chat.at(-1)?.id
    if (tail !== undefined && (lastChatId.current === undefined || tail > lastChatId.current)) lastChatId.current = tail
    setChat((have) => mergeChat(have, view.chat))
    setRoom(view)
    setError(null)
  }, [])

  const fail = useCallback((err: unknown): void => {
    if (err instanceof ApiError && err.status === 401) setGone('left')
    else if (err instanceof ApiError && err.status === 404) setGone('missing')
    else setError(errorMessage(err))
  }, [])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inflight: AbortController | null = null

    const schedule = (): void => {
      clearTimeout(timer)
      if (!stopped) timer = setTimeout(() => void poll(), document.hidden ? POLL_HIDDEN_MS : POLL_MS)
    }
    const poll = async (): Promise<void> => {
      if (stopped || inflight) return
      const ctrl = new AbortController()
      inflight = ctrl
      const sentAt = Date.now()
      try {
        const view = await getRoom(code, token, lastChatId.current, ctrl.signal)
        if (!stopped) apply(view, sentAt, Date.now())
      } catch (err) {
        if (stopped || isAbortError(err)) return
        fail(err)
        if (err instanceof ApiError && (err.status === 401 || err.status === 404)) stopped = true
      } finally {
        if (inflight === ctrl) inflight = null
        schedule()
      }
    }
    kick.current = schedule
    const onVisible = (): void => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      inflight?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [code, token, apply, fail])

  const act = useCallback(
    async (write: (chatAfter: number | undefined) => Promise<RoomView>): Promise<RoomView> => {
      const sentAt = Date.now()
      try {
        const view = await write(lastChatId.current)
        apply(view, sentAt, Date.now())
        kick.current() // the write was this second's poll
        return view
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 404)) fail(err)
        throw err
      }
    },
    [apply, fail],
  )

  return { room, chat, offsetMs, error, gone, act }
}

/** Date.now(), re-rendered every `ms` (countdowns, "starts in"). */
export function useNow(ms = 100): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
