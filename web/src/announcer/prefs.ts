// The herald's own two switches, remembered in localStorage. Kept here (not in settings.ts) until the
// integrator folds them into the Settings screen: then move `enabled` / `voice` into Settings and delete this.

import { useSyncExternalStore } from 'react'
import { readJson, writeJson } from '../lib/storage'

export const ANNOUNCER_PREFS_KEY = 'dance-fantasy:announcer'

export interface AnnouncerPrefs {
  /** The herald calls out the intro, combos, a broken streak and the results. */
  enabled: boolean
  /** ... and reads them aloud (speechSynthesis). */
  voice: boolean
}

export const DEFAULT_ANNOUNCER_PREFS: AnnouncerPrefs = { enabled: true, voice: true }

function load(): AnnouncerPrefs {
  const saved = readJson(ANNOUNCER_PREFS_KEY)
  const rec = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {}
  return {
    enabled: typeof rec.enabled === 'boolean' ? rec.enabled : DEFAULT_ANNOUNCER_PREFS.enabled,
    voice: typeof rec.voice === 'boolean' ? rec.voice : DEFAULT_ANNOUNCER_PREFS.voice,
  }
}

let current: AnnouncerPrefs = load()
const listeners = new Set<() => void>()

export function getAnnouncerPrefs(): AnnouncerPrefs {
  return current
}

export function setAnnouncerPrefs(patch: Partial<AnnouncerPrefs>): void {
  current = { ...current, ...patch }
  writeJson(ANNOUNCER_PREFS_KEY, current)
  for (const listener of listeners) listener()
}

export function subscribeAnnouncerPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAnnouncerPrefs(): AnnouncerPrefs {
  return useSyncExternalStore(subscribeAnnouncerPrefs, getAnnouncerPrefs)
}
