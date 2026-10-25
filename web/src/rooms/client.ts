// Typed client for the multiplayer rooms API (shared/README.md, "Stage 6 endpoints"). Every
// response is validated like src/api.ts does; writes send the seat token as X-Player-Token and
// answer with the same RoomView as a poll.

import type { Difficulty, Mode } from '@shared/routine'
import { isBool, isNum, isRecord, isStr, requestWithResponse } from '../api'
import type { IconName } from '../theme/icons'
import type { BeatJudgement } from './modes/api'

export type RoomState = 'lobby' | 'countdown' | 'playing' | 'finished'
/** versus: who dances best (beats won); crew: dance as one (team score + sync bonus) */
export type RoomMode = 'versus' | 'crew'

export interface RoomRoutine {
  routineId: string
  analysisId: string
  title: string
  difficulty: Difficulty
  mode: Mode
}

export interface RoomPlayer {
  id: string
  name: string
  isHost: boolean
  ready: boolean
  connected: boolean
  score: number
  combo: number
  maxCombo: number
  /** 0-100 (percent). */
  accuracy: number
  /** 0-1 through the song. */
  progress: number
  finished: boolean
  /** versus: beats where this player had the best score this round (ties shared) */
  beatsWon: number
}

/** Crew mode numbers (computed in every room; shown when mode is 'crew'). */
export interface CrewStats {
  /** everyone's score + syncBonus */
  teamScore: number
  syncBonus: number
  syncedBeats: number
  syncStreak: number
  bestSyncStreak: number
  /** beat index of the latest synced beat */
  lastSyncBeat: number | null
}

export interface ChatMessage {
  id: number
  playerId: string
  name: string
  text: string
  /** epoch ms (server clock) */
  at: number
}

export interface RoomView {
  code: string
  state: RoomState
  hostId: string
  /** epoch ms (server clock) when the server answered */
  serverNow: number
  /** epoch ms (server clock) the round starts, once started */
  startAt: number | null
  routine: RoomRoutine | null
  mode: RoomMode
  /** join order */
  players: RoomPlayer[]
  /** versus: most beats won, then score; null on a tie or before any beat */
  leaderId: string | null
  crew: CrewStats
  chat: ChatMessage[]
}

export interface ScoreBody {
  score: number
  combo: number
  maxCombo: number
  accuracy: number
  progress: number
  finished: boolean
}

/** Who this browser is in a room (kept per code in sessionStorage). */
export interface Seat {
  playerId: string
  token: string
}

const ROOM_STATES: readonly RoomState[] = ['lobby', 'countdown', 'playing', 'finished']
const isRoomState = (v: unknown): v is RoomState => ROOM_STATES.some((s) => s === v)
export const isRoomMode = (v: unknown): v is RoomMode => v === 'versus' || v === 'crew'

function isRoomRoutine(v: unknown): v is RoomRoutine {
  return (
    isRecord(v) &&
    isStr(v.routineId) &&
    isStr(v.analysisId) &&
    isStr(v.title) &&
    (v.difficulty === 'easy' || v.difficulty === 'normal' || v.difficulty === 'hard') &&
    (v.mode === 'standing' || v.mode === 'seated')
  )
}

function isRoomPlayer(v: unknown): v is RoomPlayer {
  return (
    isRecord(v) &&
    isStr(v.id) &&
    isStr(v.name) &&
    isBool(v.isHost) &&
    isBool(v.ready) &&
    isBool(v.connected) &&
    isNum(v.score) &&
    isNum(v.combo) &&
    isNum(v.maxCombo) &&
    isNum(v.accuracy) &&
    isNum(v.progress) &&
    isBool(v.finished) &&
    isNum(v.beatsWon)
  )
}

function isCrewStats(v: unknown): v is CrewStats {
  return (
    isRecord(v) &&
    isNum(v.teamScore) &&
    isNum(v.syncBonus) &&
    isNum(v.syncedBeats) &&
    isNum(v.syncStreak) &&
    isNum(v.bestSyncStreak) &&
    (v.lastSyncBeat === null || isNum(v.lastSyncBeat))
  )
}

function isChatMessage(v: unknown): v is ChatMessage {
  return isRecord(v) && isNum(v.id) && isStr(v.playerId) && isStr(v.name) && isStr(v.text) && isNum(v.at)
}

export function isRoomView(v: unknown): v is RoomView {
  return (
    isRecord(v) &&
    isStr(v.code) &&
    isRoomState(v.state) &&
    isStr(v.hostId) &&
    isNum(v.serverNow) &&
    (v.startAt === null || isNum(v.startAt)) &&
    (v.routine === null || isRoomRoutine(v.routine)) &&
    isRoomMode(v.mode) &&
    Array.isArray(v.players) &&
    v.players.every(isRoomPlayer) &&
    (v.leaderId === null || isStr(v.leaderId)) &&
    isCrewStats(v.crew) &&
    Array.isArray(v.chat) &&
    v.chat.every(isChatMessage)
  )
}

const isSeat = (v: unknown): v is Seat => isRecord(v) && isStr(v.playerId) && isStr(v.token)
const isCreated = (v: unknown): v is Seat & { code: string } => isSeat(v) && isRecord(v) && isStr(v.code)
const isOk = (v: unknown): v is { ok: true } => isRecord(v) && v.ok === true

/** Room codes: 4 letters without I, L, O (case-insensitive). */
export function normalizeCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase()
  return /^[A-HJKMNP-Z]{4}$/.test(code) ? code : null
}

/** What the QR code and the share line point at. */
export const joinUrl = (code: string, origin = window.location.origin): string => `${origin}/#/join?code=${code}`

const roomPath = (code: string, action = '', chatAfter?: number): string =>
  `/api/rooms/${code}${action ? `/${action}` : ''}${chatAfter !== undefined ? `?chatAfter=${chatAfter}` : ''}`

interface CallOptions {
  token?: string | null
  /** JSON body (implies POST) */
  body?: unknown
  /** POST without a body */
  post?: boolean
  signal?: AbortSignal
}

async function call<T>(path: string, guard: (v: unknown) => v is T, o: CallOptions = {}): Promise<T> {
  const hasBody = o.body !== undefined
  const { body } = await requestWithResponse(
    path,
    guard,
    {
      method: hasBody || o.post ? 'POST' : 'GET',
      ...(hasBody ? { body: JSON.stringify(o.body) } : {}),
      ...(o.token ? { headers: { 'X-Player-Token': o.token } } : {}),
      signal: o.signal,
    },
    hasBody ? 'application/json' : undefined,
  )
  return body
}

export const createRoom = (name: string): Promise<Seat & { code: string }> => call('/api/rooms', isCreated, { body: { name } })

export const joinRoom = (code: string, name: string): Promise<Seat> => call(roomPath(code, 'join'), isSeat, { body: { name } })

export const getRoom = (code: string, token: string | null, chatAfter?: number, signal?: AbortSignal): Promise<RoomView> =>
  call(roomPath(code, '', chatAfter), isRoomView, { token, signal })

/** The writes; each answers with the RoomView (pass the last chat id you have). */
export const roomWrites = {
  routine: (code: string, token: string, r: RoomRoutine, chatAfter?: number): Promise<RoomView> =>
    call(roomPath(code, 'routine', chatAfter), isRoomView, { token, body: r }),
  ready: (code: string, token: string, ready: boolean, chatAfter?: number): Promise<RoomView> =>
    call(roomPath(code, 'ready', chatAfter), isRoomView, { token, body: { ready } }),
  start: (code: string, token: string, chatAfter?: number): Promise<RoomView> =>
    call(roomPath(code, 'start', chatAfter), isRoomView, { token, post: true }),
  score: (code: string, token: string, s: ScoreBody, chatAfter?: number): Promise<RoomView> =>
    call(roomPath(code, 'score', chatAfter), isRoomView, { token, body: s }),
  chat: (code: string, token: string, text: string, chatAfter?: number): Promise<RoomView> =>
    call(roomPath(code, 'chat', chatAfter), isRoomView, { token, body: { text } }),
  mode: (code: string, token: string, mode: RoomMode, chatAfter?: number): Promise<RoomView> =>
    call(roomPath(code, 'mode', chatAfter), isRoomView, { token, body: { mode } }),
  beats: (code: string, token: string, beats: readonly BeatJudgement[], chatAfter?: number): Promise<RoomView> =>
    call(roomPath(code, 'beats', chatAfter), isRoomView, { token, body: { beats } }),
  rematch: (code: string, token: string, chatAfter?: number): Promise<RoomView> =>
    call(roomPath(code, 'rematch', chatAfter), isRoomView, { token, post: true }),
}

export const leaveRoom = (code: string, token: string): Promise<{ ok: true }> => call(roomPath(code, 'leave'), isOk, { token, post: true })

// --- seats (sessionStorage: a reload rejoins as the same player; a new tab is a new player) ---

const seatKey = (code: string): string => `dance-fantasy.room.${code}`

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function loadSeat(code: string): Seat | null {
  try {
    const raw = session()?.getItem(seatKey(code))
    const v: unknown = raw ? JSON.parse(raw) : null
    return isSeat(v) ? { playerId: v.playerId, token: v.token } : null
  } catch {
    return null
  }
}

export function saveSeat(code: string, seat: Seat | null): void {
  try {
    if (seat) session()?.setItem(seatKey(code), JSON.stringify(seat))
    else session()?.removeItem(seatKey(code))
  } catch {
    // not remembered: a reload joins as a new player
  }
}

// --- standings ---

/** Leaderboard order: score, then accuracy, then join order (stable). */
export function rankPlayers(players: readonly RoomPlayer[]): RoomPlayer[] {
  return players
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.score - a.p.score || b.p.accuracy - a.p.accuracy || a.i - b.i)
    .map(({ p }) => p)
}

/** Chat after a poll: new messages appended by id (a write's view may repeat ones we have). */
export function mergeChat(have: readonly ChatMessage[], incoming: readonly ChatMessage[], max = 200): ChatMessage[] {
  const last = have.at(-1)?.id ?? -1
  const fresh = incoming.filter((m) => m.id > last)
  return fresh.length === 0 ? [...have] : [...have, ...fresh].slice(-max)
}

/** A stable storybook sticker per player (by join order; the crown is saved for the versus leader). */
const AVATARS: readonly IconName[] = ['slipper', 'frog-prince', 'red-hood', 'pumpkin', 'wolf', 'lantern', 'golden-egg', 'apple']
export const avatarFor = (players: readonly Pick<RoomPlayer, 'id'>[], id: string): IconName =>
  AVATARS[Math.max(0, players.findIndex((p) => p.id === id)) % AVATARS.length] ?? 'slipper'
