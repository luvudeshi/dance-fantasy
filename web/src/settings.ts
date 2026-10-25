// Player settings (Settings screen), remembered in localStorage. One small store so screens,
// the game and the 3D coach read the same values; React reads it via useSettings().
//
// Settings that already have their own store stay there (no second copy): sound on/off is
// game/sfx.ts (load/saveSfxEnabled), judging is game/judging.ts, "Moves from" is
// routine/moveSource.ts, the camera delay is game/calibration.ts. This store holds the rest.

import { useSyncExternalStore } from 'react'
import type { Difficulty, Mode } from '@shared/routine'
import { readJson, writeJson } from './lib/storage'

export const SETTINGS_KEY = 'dance-fantasy:settings'

export interface Settings {
  /** Draw the coach as a 3D character (falls back to the 2D silhouette without WebGL). */
  dancer3d: boolean
  /** Sound-effect volume, 0..1 (scales game/sfx.ts SFX_VOLUME). */
  sfxVolume: number
  /** Show the webcam mirrored, like a mirror (Play's M key). */
  mirror: boolean
  /** Show the small camera window while dancing (Play's C key). */
  cameraWindow: boolean
  /** Show the FPS / latency / sync overlay while dancing (Play's D key). */
  debugOverlay: boolean
  /** The lobby's starting difficulty. */
  difficulty: Difficulty
  /** The lobby's starting mode. */
  mode: Mode
  /** Calm motion everywhere, even when the device doesn't ask for it. */
  reducedMotion: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  dancer3d: true,
  sfxVolume: 1,
  mirror: true,
  cameraWindow: true,
  debugOverlay: false,
  difficulty: 'normal',
  mode: 'standing',
  reducedMotion: false,
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

const VALID: { [K in keyof Settings]: (v: unknown) => v is Settings[K] } = {
  dancer3d: isBool,
  sfxVolume: (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
  mirror: isBool,
  cameraWindow: isBool,
  debugOverlay: isBool,
  difficulty: (v): v is Difficulty => v === 'easy' || v === 'normal' || v === 'hard',
  mode: (v): v is Mode => v === 'standing' || v === 'seated',
  reducedMotion: isBool,
}

/** Saved (untrusted) JSON over the defaults: unknown keys and invalid values are dropped. */
export function parseSettings(saved: unknown): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS }
  if (typeof saved === 'object' && saved !== null) {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const value = (saved as Record<string, unknown>)[key]
      if (VALID[key](value)) Object.assign(merged, { [key]: value })
    }
  }
  return merged
}

let current: Settings = parseSettings(readJson(SETTINGS_KEY))
const listeners = new Set<() => void>()

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
