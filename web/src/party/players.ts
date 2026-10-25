// Party mode dancers: 2-4 people in front of one camera, each with a name, a sticker avatar and a colour.
// Colours are Dance Fantasy tokens (theme/tokens.css) picked to stay readable as skeleton strokes on the
// night-glass camera view; the hex values are repeated here because canvas strokes can't use CSS vars.

import { parseHash } from '../lib/hashRoute'
import type { IconName } from '../theme/icons'

export const MIN_PARTY = 2
export const MAX_PARTY = 4
export const DEFAULT_PARTY = 3

export interface PartyColor {
  id: string
  label: string
  /** Canvas + CSS colour (a --df- token's value). */
  hex: string
  /** Text colour on a fill of `hex` (>= 4.5:1). */
  on: string
}

export const PARTY_COLORS: readonly PartyColor[] = [
  { id: 'rasp', label: 'Raspberry', hex: '#c04f66', on: '#fff8ec' },
  { id: 'gold', label: 'Gold', hex: '#dbb35e', on: '#3e2c0c' },
  { id: 'blue', label: 'Powder blue', hex: '#a3c3d8', on: '#263a55' },
  { id: 'sage', label: 'Sage', hex: '#a8bc8b', on: '#2e2421' },
  { id: 'rose', label: 'Rose', hex: '#e6939f', on: '#2e2421' },
  { id: 'cream', label: 'Cream', hex: '#fffaf0', on: '#2e2421' },
]

export const PARTY_AVATARS: readonly IconName[] = [
  'crown',
  'slipper',
  'frog-prince',
  'red-hood',
  'pumpkin',
  'wand',
  'potion',
  'apple',
  'wolf',
  'dance-shoe',
  'lantern',
  'golden-egg',
]

const DEFAULT_NAMES = ['Aurora', 'Ella', 'Rapunzel', 'Gretel'] as const

export const MAX_NAME_LENGTH = 16

export interface PartyPlayer {
  /** Slot 0..3 = left to right in the mirror at the start. */
  slot: number
  name: string
  icon: IconName
  colorId: string
}

export function colorOf(p: Pick<PartyPlayer, 'colorId'>): PartyColor {
  return PARTY_COLORS.find((c) => c.id === p.colorId) ?? PARTY_COLORS[0]
}

export function defaultPlayer(slot: number): PartyPlayer {
  return {
    slot,
    name: DEFAULT_NAMES[slot % DEFAULT_NAMES.length],
    icon: PARTY_AVATARS[slot % PARTY_AVATARS.length],
    colorId: PARTY_COLORS[slot % PARTY_COLORS.length].id,
  }
}

/** A trimmed, single-line name of at most MAX_NAME_LENGTH characters ("" stays "", the UI falls back). */
export function cleanName(raw: string): string {
  const printable = [...raw].filter((ch) => ch >= ' ' && ch !== '\u007f').join('')
  return printable.replace(/\s+/g, ' ').trimStart().slice(0, MAX_NAME_LENGTH)
}

/** The shown name: the typed one, else "Dancer N". */
export const displayName = (p: PartyPlayer): string => p.name.trim() || `Dancer ${p.slot + 1}`

/** `count` players: the saved ones where valid, defaults for the rest. */
export function partyPlayers(count: number, saved: readonly PartyPlayer[] = []): PartyPlayer[] {
  const n = clampCount(count)
  return Array.from({ length: n }, (_, slot) => {
    const s = saved[slot]
    return s ? { ...s, slot } : defaultPlayer(slot)
  })
}

export const clampCount = (n: number): number => Math.min(MAX_PARTY, Math.max(MIN_PARTY, Math.round(Number.isFinite(n) ? n : DEFAULT_PARTY)))

/**
 * "#/play?party=3" -> 3 (clamped to 2..4; a non-number such as "?party" alone means the default 3).
 * null when the hash is another page or has no party parameter.
 */
export function partyCountFromHash(hash: string): number | null {
  const { path, params } = parseHash(hash)
  if (path !== '#/play' && path !== '#/party-dev') return null
  const raw = params.get('party')
  if (raw === null) return null
  const n = Number.parseInt(raw, 10)
  return clampCount(Number.isNaN(n) ? DEFAULT_PARTY : n)
}

// --- remembered on this device (names, avatars, colours) -------------------------------------

export const PARTY_STORAGE_KEY = 'dance-fantasy.party.v1'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function safeStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function isPlayer(v: unknown): v is PartyPlayer {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.slot === 'number' &&
    typeof o.name === 'string' &&
    typeof o.icon === 'string' &&
    (PARTY_AVATARS as readonly string[]).includes(o.icon) &&
    typeof o.colorId === 'string' &&
    PARTY_COLORS.some((c) => c.id === o.colorId)
  )
}

export function loadPartyPlayers(storage: StorageLike | null = safeStorage()): PartyPlayer[] {
  try {
    const raw = storage?.getItem(PARTY_STORAGE_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(list)) return []
    return list.filter(isPlayer).slice(0, MAX_PARTY).map((p, slot) => ({ slot, name: cleanName(p.name), icon: p.icon, colorId: p.colorId }))
  } catch {
    return []
  }
}

export function savePartyPlayers(players: readonly PartyPlayer[], storage: StorageLike | null = safeStorage()): void {
  try {
    storage?.setItem(PARTY_STORAGE_KEY, JSON.stringify(players.map(({ slot, name, icon, colorId }) => ({ slot, name, icon, colorId }))))
  } catch {
    // ponytail: storage is a per-device convenience; private windows simply forget the names
  }
}
