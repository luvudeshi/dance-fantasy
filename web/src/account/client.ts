// Typed client for the accounts API (shared/README.md, "Accounts endpoints").
// Same origin only: the df_session cookie is httpOnly + SameSite=Lax, so these calls use relative
// /api URLs (the Vite proxy in dev, one Vercel deployment in production), never VITE_API_BASE.
// Every non-GET request sends `X-DF: 1` (the server's CSRF check).

import { ApiError, SERVER_UNREACHABLE_MESSAGE } from '../api'
import { isMyBadges, newBadgesOf, type EarnedBadge, type MyBadges } from '../badges/model'
import { isAbortError } from '../lib/errors'
import { ICON_NAMES, type IconName } from '../theme/icons'

export const COLORS = ['rasp', 'gold', 'blue', 'sage', 'burg', 'night'] as const
export type AccountColor = (typeof COLORS)[number]
export type RoundMode = 'solo' | 'party' | 'room'

export interface Me {
  id: string
  name: string
  avatar: IconName
  color: AccountColor
  friendCode: string
  isGuest: boolean
  username: string | null
  stats: { rounds: number; bestScore: number; friends: number }
}

export interface Friend {
  id: string
  name: string
  avatar: IconName
  color: AccountColor
  online: boolean
  /** Room code while they are connected to a room they recorded, else null. */
  inRoom: string | null
}

export interface Partner {
  id: string
  name: string
  avatar: IconName
  color: AccountColor
  friendCode: string
  online: boolean
  isFriend: boolean
  lastPlayedAt: number
}

export interface Invite {
  id: number
  fromId: string
  fromName: string
  fromAvatar: IconName
  fromColor: AccountColor
  roomCode: string
  at: number
}

export interface RoundRecord {
  analysisId: string
  songTitle: string
  score: number
  accuracy: number
  maxCombo: number
  stars: number
  mode: RoundMode
}

export interface History {
  rounds: (RoundRecord & { at: number })[]
  totalRounds: number
  bestScore: number
  avgAccuracy: number
  dayStreak: number
}

// --- response validation -------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const ICONS: ReadonlySet<string> = new Set(ICON_NAMES)
const COLOR_SET: ReadonlySet<string> = new Set(COLORS)
export const isIconName = (v: unknown): v is IconName => isStr(v) && ICONS.has(v)
export const isColor = (v: unknown): v is AccountColor => isStr(v) && COLOR_SET.has(v)
const isMode = (v: unknown): v is RoundMode => v === 'solo' || v === 'party' || v === 'room'
const listOf =
  <T,>(guard: (v: unknown) => v is T) =>
  (v: unknown): v is T[] =>
    Array.isArray(v) && v.every(guard)

export function isMe(v: unknown): v is Me {
  if (!isRecord(v) || !isRecord(v.stats)) return false
  const s = v.stats
  return (
    isStr(v.id) &&
    isStr(v.name) &&
    isIconName(v.avatar) &&
    isColor(v.color) &&
    isStr(v.friendCode) &&
    isBool(v.isGuest) &&
    (v.username === null || isStr(v.username)) &&
    isNum(s.rounds) &&
    isNum(s.bestScore) &&
    isNum(s.friends)
  )
}

export function isFriend(v: unknown): v is Friend {
  return (
    isRecord(v) &&
    isStr(v.id) &&
    isStr(v.name) &&
    isIconName(v.avatar) &&
    isColor(v.color) &&
    isBool(v.online) &&
    (v.inRoom === null || isStr(v.inRoom))
  )
}

export function isPartner(v: unknown): v is Partner {
  return (
    isRecord(v) &&
    isStr(v.id) &&
    isStr(v.name) &&
    isIconName(v.avatar) &&
    isColor(v.color) &&
    isStr(v.friendCode) &&
    isBool(v.online) &&
    isBool(v.isFriend) &&
    isNum(v.lastPlayedAt)
  )
}

export function isInvite(v: unknown): v is Invite {
  return (
    isRecord(v) &&
    isNum(v.id) &&
    isStr(v.fromId) &&
    isStr(v.fromName) &&
    isIconName(v.fromAvatar) &&
    isColor(v.fromColor) &&
    isStr(v.roomCode) &&
    isNum(v.at)
  )
}

function isRound(v: unknown): v is History['rounds'][number] {
  return (
    isRecord(v) &&
    isStr(v.analysisId) &&
    isStr(v.songTitle) &&
    isNum(v.score) &&
    isNum(v.accuracy) &&
    isNum(v.maxCombo) &&
    isNum(v.stars) &&
    isMode(v.mode) &&
    isNum(v.at)
  )
}

export function isHistory(v: unknown): v is History {
  return (
    isRecord(v) &&
    listOf(isRound)(v.rounds) &&
    isNum(v.totalRounds) &&
    isNum(v.bestScore) &&
    isNum(v.avgAccuracy) &&
    isNum(v.dayStreak)
  )
}

const isOk = (v: unknown): v is { ok: true } => isRecord(v) && v.ok === true
const isRoomPeek = (v: unknown): v is { code: string; state: string } => isRecord(v) && isStr(v.code) && isStr(v.state)

// --- transport -----------------------------------------------------------------------

function detailOf(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text)
    if (!isRecord(body)) return null
    if (isStr(body.detail)) return body.detail
    if (Array.isArray(body.detail)) return body.detail.map((d) => (isRecord(d) && isStr(d.msg) ? d.msg : '')).join('; ')
  } catch {
    // not JSON: fall through to the status line
  }
  return null
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

async function send(method: Method, path: string, body: unknown, signal: AbortSignal | undefined): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') headers['X-DF'] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    return await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError(SERVER_UNREACHABLE_MESSAGE, 0, true, { cause: err })
  }
}

/**
 * One JSON call. A 401 means the cookie is missing or expired: start a session and retry once
 * (not for /api/login, whose 401 means a wrong password).
 */
async function call<T>(
  method: Method,
  path: string,
  guard: (v: unknown) => v is T,
  opts: { body?: unknown; signal?: AbortSignal; retry?: boolean } = {},
): Promise<T> {
  let res = await send(method, path, opts.body, opts.signal)
  if (res.status === 401 && opts.retry !== false) {
    await startSession(opts.signal)
    res = await send(method, path, opts.body, opts.signal)
  }
  const text = await res.text()
  if (!res.ok) {
    const detail = detailOf(text)
    const unreachable = !detail && (res.status === 502 || res.status === 504 || (res.status === 500 && !text))
    throw new ApiError(detail ?? (unreachable ? SERVER_UNREACHABLE_MESSAGE : `HTTP ${res.status}`), res.status, unreachable)
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // validated below
  }
  if (!guard(parsed)) throw new ApiError(`Unexpected response from ${path}`, res.status, false)
  return parsed
}

// --- endpoints -----------------------------------------------------------------------

/** POST /api/session: this cookie's account, or a new guest (sets the cookie). */
export function startSession(signal?: AbortSignal): Promise<Me> {
  return call('POST', '/api/session', isMe, { signal, retry: false })
}

export const getMe = (signal?: AbortSignal): Promise<Me> => call('GET', '/api/me', isMe, { signal })

export const updateMe = (patch: { name?: string; avatar?: IconName; color?: AccountColor }): Promise<Me> =>
  call('PATCH', '/api/me', isMe, { body: patch })

export const claimAccount = (username: string, password: string): Promise<Me> =>
  call('POST', '/api/account/claim', isMe, { body: { username, password } })

export const logIn = (username: string, password: string): Promise<Me> =>
  call('POST', '/api/login', isMe, { body: { username, password }, retry: false })

export const logOut = (): Promise<Me> => call('POST', '/api/logout', isMe, { retry: false })

export const listFriends = (signal?: AbortSignal): Promise<Friend[]> => call('GET', '/api/friends', listOf(isFriend), { signal })

export const addFriend = (code: string): Promise<Friend> => call('POST', '/api/friends', isFriend, { body: { code } })

export const removeFriend = (id: string): Promise<{ ok: true }> =>
  call('DELETE', `/api/friends/${encodeURIComponent(id)}`, isOk)

export const inviteFriend = (id: string, roomCode: string): Promise<{ ok: true }> =>
  call('POST', `/api/friends/${encodeURIComponent(id)}/invite`, isOk, { body: { roomCode } })

export const listInvites = (signal?: AbortSignal): Promise<Invite[]> => call('GET', '/api/me/invites', listOf(isInvite), { signal })

export const dismissInvite = (id: number): Promise<{ ok: true }> => call('POST', `/api/me/invites/${id}/dismiss`, isOk)

export const recordRoom = (roomCode: string, playerToken: string): Promise<{ ok: true }> =>
  call('POST', '/api/me/rooms', isOk, { body: { roomCode, playerToken } })

/** The rooms API's public peek (GET /api/rooms/{code} without a seat token): 404 once the room has closed or expired. */
export const peekRoom = (code: string, signal?: AbortSignal): Promise<{ code: string; state: string }> =>
  call('GET', `/api/rooms/${encodeURIComponent(code)}`, isRoomPeek, { signal, retry: false })

export const listPartners = (signal?: AbortSignal): Promise<Partner[]> =>
  call('GET', '/api/me/partners', listOf(isPartner), { signal })

/** Resolves the badges this round newly earned. */
export const postRound = async (round: RoundRecord): Promise<EarnedBadge[]> =>
  newBadgesOf(await call('POST', '/api/me/rounds', isOk, { body: round })) ?? []

export const getMyBadges = (signal?: AbortSignal): Promise<MyBadges> => call('GET', '/api/me/badges', isMyBadges, { signal })

export const getHistory = (signal?: AbortSignal): Promise<History> =>
  call('GET', `/api/me/history?tzOffset=${new Date().getTimezoneOffset()}`, isHistory, { signal })

// --- input helpers -------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)

/** A round as the server accepts it: integer score/combo, accuracy 0-100, stars 0-5, a 1-200 char title. */
export function normalizeRound(r: RoundRecord): RoundRecord {
  const title = r.songTitle.replace(/\s+/g, ' ').trim().slice(0, 200)
  return {
    analysisId: r.analysisId,
    songTitle: title || 'Untitled',
    score: Math.round(clamp(r.score, 0, 100_000_000)),
    accuracy: clamp(r.accuracy, 0, 100),
    maxCombo: Math.round(clamp(r.maxCombo, 0, 100_000)),
    stars: clamp(r.stars, 0, 5),
    mode: r.mode,
  }
}

/** Friend codes as people type them: case, spaces and dashes don't matter. */
export const cleanFriendCode = (raw: string): string => raw.toUpperCase().replace(/[\s-]+/g, '')

/** 6 characters from the server's alphabet (no I, L, O, 0, 1). */
export const isFriendCode = (code: string): boolean => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code)

/** Usernames are lowercased for you: 3-20 of a-z 0-9 _. */
export const cleanUsername = (raw: string): string => raw.trim().toLowerCase()
export const isUsername = (u: string): boolean => /^[a-z0-9_]{3,20}$/.test(u)

/** "clock-tower" -> "Clock tower", for alt text and the avatar picker. */
export const iconLabel = (name: IconName): string => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/-/g, ' ')
