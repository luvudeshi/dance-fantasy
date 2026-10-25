// Judging strictness: the lobby's Lenient / Standard / Strict switch, remembered on this
// device. Each preset is a ScoringConfig (scoring.ts); the bot simulation
// (scoring.sim.test.ts) checks that every preset stays fair: standing still always misses,
// a perfect dancer is always perfect, and a sloppy dancer does better on Lenient.

import { defaultStorage, readJson, writeJson, type StorageLike } from '../lib/storage'
import { DEFAULT_SCORING, LENIENT_SCORING, STRICT_SCORING, type ScoringConfig } from './scoring'

export type JudgingPreset = 'lenient' | 'standard' | 'strict'

export const JUDGING_KEY = 'midnight-ball.judging.v1'
export const DEFAULT_JUDGING: JudgingPreset = 'standard'

export const JUDGING_PRESETS: readonly { value: JudgingPreset; label: string; hint: string }[] = [
  { value: 'lenient', label: 'Lenient', hint: 'Forgiving angles and timing: great for first-timers and kids.' },
  { value: 'standard', label: 'Standard', hint: 'The intended balance: close enough counts.' },
  { value: 'strict', label: 'Strict', hint: 'Sharp angles, tight timing: for show-offs.' },
]

const CONFIGS: Readonly<Record<JudgingPreset, ScoringConfig>> = {
  lenient: LENIENT_SCORING,
  standard: DEFAULT_SCORING,
  strict: STRICT_SCORING,
}

export const isJudgingPreset = (v: unknown): v is JudgingPreset => v === 'lenient' || v === 'standard' || v === 'strict'

export const scoringFor = (preset: JudgingPreset): ScoringConfig => CONFIGS[preset]

export const judgingLabel = (preset: JudgingPreset): string => JUDGING_PRESETS.find((p) => p.value === preset)?.label ?? preset

export function loadJudging(storage: StorageLike | null = defaultStorage()): JudgingPreset {
  const v = readJson(JUDGING_KEY, storage)
  return isJudgingPreset(v) ? v : DEFAULT_JUDGING
}

export function saveJudging(preset: JudgingPreset, storage: StorageLike | null = defaultStorage()): void {
  writeJson(JUDGING_KEY, preset, storage)
}
