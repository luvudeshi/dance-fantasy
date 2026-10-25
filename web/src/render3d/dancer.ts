// Which 3D dancer the coach is: the princess or the prince. Remembered in localStorage; a
// "?dancer=prince" in the URL hash query ("#/moves?dancer=prince") overrides it for the session
// (dev / demo links) until the player picks one in Settings.

import { parseHash } from '../lib/hashRoute'
import { readJson, writeJson } from '../lib/storage'

export type Dancer = 'princess' | 'prince'

export const DANCERS: readonly Dancer[] = ['princess', 'prince']
export const DANCER_KEY = 'dance-fantasy:dancer'

const isDancer = (v: unknown): v is Dancer => v === 'princess' || v === 'prince'

/** The dancer a hash asks for ("#/play?dancer=prince"), null when it doesn't name one. */
export function dancerFromHash(hash: string): Dancer | null {
  const d = parseHash(hash).params.get('dancer')
  return isDancer(d) ? d : null
}

const hash = (): string => (typeof location === 'undefined' ? '' : location.hash)
const saved = readJson(DANCER_KEY)
let current: Dancer = dancerFromHash(hash()) ?? (isDancer(saved) ? saved : 'princess')
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getDancer(): Dancer {
  return current
}

/** Picks (and remembers) the dancer; this also ends a URL override. */
export function setDancer(d: Dancer): void {
  writeJson(DANCER_KEY, d)
  if (d === current) return
  current = d
  emit()
}

export function subscribeDancer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// A link opened in a running app ("#/moves?dancer=prince") switches live, without remembering it.
if (typeof addEventListener === 'function') {
  addEventListener('hashchange', () => {
    const d = dancerFromHash(hash())
    if (d && d !== current) {
      current = d
      emit()
    }
  })
}
