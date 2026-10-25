// The signed-in (usually guest) account, shared by every screen: useAccount() subscribes, and while
// anything is subscribed (the global InviteToast always is) it bootstraps the session and polls
// invites every 5 s while the tab is visible. Any authenticated call marks you online on the server,
// so that poll doubles as the presence heartbeat.
// ponytail: no separate POST /api/me/heartbeat timer; add one only if the invite poll ever stops while visible.

import { useSyncExternalStore } from 'react'
import { errorMessage } from '../lib/errors'
import * as api from './client'
import type { Invite, Me, RoundRecord } from './client'

export interface AccountState {
  /** idle: not started; unavailable: the accounts API is down or not configured (503 without a database). */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  me: Me | null
  invites: Invite[]
  /** The room this tab is in (set by recordRoomPlayed), for "Invite to my room". */
  room: string | null
  error: string | null
}

const INVITE_POLL_MS = 5000
const ROOM_KEY = 'df.account.room'

function readRoom(): string | null {
  try {
    return sessionStorage.getItem(ROOM_KEY)
  } catch {
    return null
  }
}

let state: AccountState = { status: 'idle', me: null, invites: [], room: readRoom(), error: null }
const listeners = new Set<() => void>()

function set(patch: Partial<AccountState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

const RETRY_UNAVAILABLE_MS = 60_000
let booting: Promise<Me | null> | null = null
let failedAt = Number.NEGATIVE_INFINITY

/** POST /api/session once (shared by every caller); resolves null while the API is unavailable (retried each minute). */
export function ensureSession(): Promise<Me | null> {
  if (state.me) return Promise.resolve(state.me)
  if (!booting && Date.now() - failedAt < RETRY_UNAVAILABLE_MS) return Promise.resolve(null)
  booting ??= (async () => {
    if (state.status !== 'ready') set({ status: 'loading' })
    try {
      const me = await api.startSession()
      set({ status: 'ready', me, error: null })
      return me
    } catch (err) {
      failedAt = Date.now()
      set({ status: 'unavailable', error: errorMessage(err) })
      return null
    } finally {
      booting = null
    }
  })()
  return booting
}

/** Replace the account (login, logout, claim, profile edits): invites belong to the account, so reset them. */
export function setMe(me: Me): void {
  set({ status: 'ready', me, invites: me.id === state.me?.id ? state.invites : [], error: null })
}

async function pollInvites(): Promise<void> {
  if (!(await ensureSession())) return
  try {
    set({ invites: await api.listInvites() })
  } catch (err) {
    console.warn('[account] invite poll failed', err)
  }
}

async function refreshMe(): Promise<void> {
  if (!state.me) return
  try {
    setMe(await api.getMe())
  } catch (err) {
    console.warn('[account] refresh failed', err)
  }
}

let timer: ReturnType<typeof setInterval> | undefined

function startPolling(): void {
  stopPolling()
  if (document.visibilityState !== 'visible') return
  void pollInvites()
  timer = setInterval(() => void pollInvites(), INVITE_POLL_MS)
}

function stopPolling(): void {
  clearInterval(timer)
  timer = undefined
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') {
    void refreshMe() // another tab may have logged in or out
    startPolling()
  } else stopPolling()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibility)
    startPolling()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      document.removeEventListener('visibilitychange', onVisibility)
      stopPolling()
    }
  }
}

export function useAccount(): AccountState {
  return useSyncExternalStore(subscribe, () => state)
}

/** Drop an invite from the toast right away and tell the server (it won't come back). */
export async function dismissInvite(id: number): Promise<void> {
  set({ invites: state.invites.filter((i) => i.id !== id) })
  try {
    await api.dismissInvite(id)
  } catch (err) {
    console.warn('[account] dismiss failed', err)
  }
}

// --- helpers for other features (rooms, Play) ----------------------------------------

/** The profile name, to prefill a room's name field; null before the session has loaded. */
export function getProfileName(): string | null {
  return state.me?.name ?? null
}

/**
 * After POST /api/rooms or /api/rooms/{code}/join succeeds: link this account to the room so friends
 * see you in it and you both show up as dance partners. Never throws.
 */
export async function recordRoomPlayed(roomCode: string, playerToken: string): Promise<void> {
  const code = roomCode.toUpperCase()
  try {
    sessionStorage.setItem(ROOM_KEY, code)
  } catch {
    // only "Invite to my room" in other tabs misses it
  }
  set({ room: code })
  if (!(await ensureSession())) return
  try {
    await api.recordRoom(code, playerToken)
  } catch (err) {
    console.warn('[account] recordRoom failed', err)
  }
}

/** After leaving a room: hide "Invite to my room". */
export function leftRoom(): void {
  try {
    sessionStorage.removeItem(ROOM_KEY)
  } catch {
    // nothing remembered
  }
  set({ room: null })
}

/** Add a finished round to the history (values are clamped to what the server accepts). Never throws. */
export async function recordRound(round: RoundRecord): Promise<void> {
  if (!(await ensureSession())) return
  try {
    await api.postRound(api.normalizeRound(round))
    await refreshMe() // stats.rounds / bestScore
  } catch (err) {
    console.warn('[account] recordRound failed', err)
  }
}
