// Player settings (Settings screen), remembered in localStorage. One small store so screens,
// the game and the 3D coach read the same values; React reads it via useSettings().

import { useSyncExternalStore } from 'react'
import { readJson, writeJson } from './lib/storage'

export const SETTINGS_KEY = 'dance-fantasy:settings'

export interface Settings {
  /** Draw the coach as a 3D character (falls back to the 2D silhouette without WebGL). */
  dancer3d: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  dancer3d: true,
}

let current: Settings = load()
const listeners = new Set<() => void>()

function load(): Settings {
  const saved = readJson(SETTINGS_KEY)
  const merged: Settings = { ...DEFAULT_SETTINGS }
  if (typeof saved === 'object' && saved !== null) {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const value = (saved as Record<string, unknown>)[key]
      if (typeof value === typeof DEFAULT_SETTINGS[key]) Object.assign(merged, { [key]: value })
    }
  }
  return merged
}

export function getSettings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch }
  writeJson(SETTINGS_KEY, current)
  for (const listener of listeners) listener()
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings)
}
