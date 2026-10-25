// "Download session log": one scored round as JSON, for tuning scoring with real play.
// Numbers only: routine id, settings, calibration latency, judging preset and one row per
// checkpoint (time, move, score, judgment, timing offset, per-limb scores). No poses, no
// video, no target poses. It never leaves the browser unless the player downloads it.

import type { Difficulty, Mode, Routine } from '@shared/routine'
import type { LimbName } from '@shared/skeleton'
import type { Calibration } from './calibration'
import type { JudgingPreset } from './judging'
import type { CheckpointResult, Judgment, ResultsSummary, ScoringConfig } from './scoring'

export const SESSION_LOG_FORMAT = 'midnight-ball.session-log'
export const SESSION_LOG_VERSION = 1

export interface SessionLogCheckpoint {
  index: number
  /** Song time (s, ms precision). */
  time: number
  moveIndex: number
  moveId: string
  /** 0..100, one decimal. */
  score: number
  judgment: Judgment
  /** Best frame's offset from the beat (ms, + = late); null when no usable frame. */
  offsetMs: number | null
  /** 0..100 per compared limb (rounded). */
  perLimb: Partial<Record<LimbName, number>>
  unseen: boolean
}

export interface SessionLog {
  format: typeof SESSION_LOG_FORMAT
  version: typeof SESSION_LOG_VERSION
  createdAt: string
  routineId: string | null
  analysisId: string | null
  song: { title: string; durationSec: number; bpm: number }
  settings: { difficulty: Difficulty; mode: Mode; seed: number; autoplay: boolean }
  /** Latency subtracted from webcam frame times (null for the bot). */
  calibration: { latencyMs: number; source: Calibration['source'] } | null
  judging: { preset: JudgingPreset } & Pick<ScoringConfig, 'windowSec' | 'thresholds' | 'perfectDeg' | 'zeroDeg' | 'minVisibility'>
  summary: {
    score: number
    stars: number
    accuracy: number
    maxCombo: number
    counts: Record<Judgment, number>
    checkpoints: number
  }
  checkpoints: SessionLogCheckpoint[]
}

export interface SessionLogInput {
  routine: Pick<Routine, 'moves' | 'difficulty' | 'mode' | 'seed' | 'meta' | 'song'>
  title: string
  durationSec: number
  autoplay: boolean
  calibration: Calibration | null
  preset: JudgingPreset
  config: ScoringConfig
  summary: ResultsSummary
  results: readonly CheckpointResult[]
  now?: Date
}

const round = (v: number, digits = 0): number => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

export function buildSessionLog(i: SessionLogInput): SessionLog {
  const { routine, summary, config } = i
  const meta = routine.meta
  const routineId = typeof meta?.routineId === 'string' ? meta.routineId : null
  const analysisId = typeof meta?.analysisId === 'string' ? meta.analysisId : null
  return {
    format: SESSION_LOG_FORMAT,
    version: SESSION_LOG_VERSION,
    createdAt: (i.now ?? new Date()).toISOString(),
    routineId,
    analysisId,
    song: { title: i.title, durationSec: round(i.durationSec, 3), bpm: round(routine.song.bpm, 2) },
    settings: { difficulty: routine.difficulty, mode: routine.mode, seed: routine.seed, autoplay: i.autoplay },
    calibration: i.calibration ? { latencyMs: round(i.calibration.latencySec * 1000), source: i.calibration.source } : null,
    judging: {
      preset: i.preset,
      windowSec: config.windowSec,
      thresholds: { ...config.thresholds },
      perfectDeg: config.perfectDeg,
      zeroDeg: config.zeroDeg,
      minVisibility: config.minVisibility,
    },
    summary: {
      score: summary.state.score,
      stars: round(summary.state.stars, 2),
      accuracy: round(summary.accuracy, 1),
      maxCombo: summary.state.maxCombo,
      counts: { ...summary.state.counts },
      checkpoints: summary.state.total,
    },
    checkpoints: i.results.map((r) => {
      const perLimb: Partial<Record<LimbName, number>> = {}
      for (const [limb, s] of Object.entries(r.perLimb) as Array<[LimbName, number | undefined]>) {
        if (s !== undefined && Number.isFinite(s)) perLimb[limb] = Math.round(s)
      }
      return {
        index: r.checkpoint.index,
        time: round(r.checkpoint.time, 3),
        moveIndex: r.checkpoint.moveIndex,
        moveId: routine.moves[r.checkpoint.moveIndex]?.id ?? `move_${r.checkpoint.moveIndex}`,
        score: round(r.score, 1),
        judgment: r.judgment,
        offsetMs: r.offsetSec === null ? null : Math.round(r.offsetSec * 1000),
        perLimb,
        unseen: r.unseen === true,
      }
    }),
  }
}

/** "dance-fantasy-session-<routine>-<yyyymmdd-hhmmss>.json" */
export function sessionLogFilename(log: Pick<SessionLog, 'routineId' | 'createdAt'>): string {
  const stamp = log.createdAt.replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')
  return `dance-fantasy-session-${log.routineId ?? 'local'}-${stamp}.json`
}

/** Saves the log as a file (a Blob URL + <a download>): the only way it leaves the page. */
export function downloadSessionLog(log: SessionLog): void {
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = sessionLogFilename(log)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
