// Typed client for the Hall of Fame API (shared/README.md, "Leaderboard endpoints"). Same-origin GETs: the
// df_session cookie (when there is one) marks your own row, and scope=friends needs it.

import { ApiError, SERVER_UNREACHABLE_MESSAGE, isNum, isRecord, isStr } from '../api'
import { isColor, isIconName, type AccountColor } from '../account/client'
import { isAbortError } from '../lib/errors'
import type { IconName } from '../theme/icons'

export type SongScope = 'all' | 'week' | 'today' | 'friends'
export type TopScope = 'all' | 'week'

interface Dancer {
  rank: number
  accountId: string
  name: string
  avatar: IconName
  color: AccountColor
  isYou: boolean
}
export interface BoardEntry extends Dancer {
  score: number
  accuracy: number
  maxCombo: number
  stars: number
  at: number
}
export interface SongBoard {
  scope: SongScope
  song: { analysisId: string; title: string | null }
  entries: BoardEntry[]
  you: { rank: number; score: number } | null
}
export interface TopEntry extends Dancer {
  total: number
  rounds: number
  bestCombo: number
}
export interface TopBoard {
  scope: TopScope
  entries: TopEntry[]
}
export interface BoardSong {
  analysisId: string
  title: string
  dancers: number
}

const isDancer = (v: Record<string, unknown>): boolean =>
  isNum(v.rank) && isStr(v.accountId) && isStr(v.name) && isIconName(v.avatar) && isColor(v.color) && typeof v.isYou === 'boolean'
const isEntry = (v: unknown): v is BoardEntry =>
  isRecord(v) && isDancer(v) && isNum(v.score) && isNum(v.accuracy) && isNum(v.maxCombo) && isNum(v.stars) && isNum(v.at)
const isTopEntry = (v: unknown): v is TopEntry =>
  isRecord(v) && isDancer(v) && isNum(v.total) && isNum(v.rounds) && isNum(v.bestCombo)

export function isSongBoard(v: unknown): v is SongBoard {
  if (!isRecord(v) || !isRecord(v.song) || !Array.isArray(v.entries)) return false
  const you = v.you
  return (
    isStr(v.scope) &&
    isStr(v.song.analysisId) &&
    (v.song.title === null || isStr(v.song.title)) &&
    v.entries.every(isEntry) &&
    (you === null || (isRecord(you) && isNum(you.rank) && isNum(you.score)))
  )
}
export const isTopBoard = (v: unknown): v is TopBoard =>
  isRecord(v) && isStr(v.scope) && Array.isArray(v.entries) && v.entries.every(isTopEntry)
const isBoardSong = (v: unknown): v is BoardSong =>
  isRecord(v) && isStr(v.analysisId) && isStr(v.title) && isNum(v.dancers)
const isBoardSongs = (v: unknown): v is BoardSong[] => Array.isArray(v) && v.every(isBoardSong)

async function get<T>(path: string, guard: (v: unknown) => v is T, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError(SERVER_UNREACHABLE_MESSAGE, 0, true, { cause: err })
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = isRecord(body) && isStr(body.detail) ? body.detail : null
    throw new ApiError(detail ?? `HTTP ${res.status}`, res.status, !detail && res.status >= 500)
  }
  if (!guard(body)) throw new ApiError(`Unexpected response from ${path}`, res.status, false)
  return body
}

export const getSongBoard = (analysisId: string, scope: SongScope, limit: number, signal?: AbortSignal): Promise<SongBoard> =>
  get(`/api/leaderboard/song/${encodeURIComponent(analysisId)}?scope=${scope}&limit=${limit}`, isSongBoard, signal)

export const getTopBoard = (scope: TopScope, limit: number, signal?: AbortSignal): Promise<TopBoard> =>
  get(`/api/leaderboard/top?scope=${scope}&limit=${limit}`, isTopBoard, signal)

export const getBoardSongs = (signal?: AbortSignal): Promise<BoardSong[]> => get('/api/leaderboard/songs', isBoardSongs, signal)

// --- pure helpers --------------------------------------------------------------------

/** The picker's songs: the server's list (library + most danced), then your recent songs it didn't have. */
export function songOptions(board: readonly BoardSong[], recent: readonly { analysisId: string; songTitle: string }[]): BoardSong[] {
  const seen = new Set(board.map((s) => s.analysisId))
  const out = [...board]
  for (const r of recent) {
    if (seen.has(r.analysisId)) continue
    seen.add(r.analysisId)
    out.push({ analysisId: r.analysisId, title: r.songTitle, dancers: 0 })
  }
  return out
}

/** "You placed #3 on Vibe Ace!" once your round is on the board. */
export function placementLine(you: SongBoard['you'], title: string | null): string | null {
  if (!you) return null
  return `You placed #${you.rank} on ${title ?? 'this song'}!`
}

/** The initial song from "#/hall?song=<id>". */
export function songFromHash(hash: string): string | null {
  const id = new URLSearchParams(hash.split('?')[1] ?? '').get('song')
  return id && /^[0-9a-f]{64}$/.test(id) ? id : null
}
