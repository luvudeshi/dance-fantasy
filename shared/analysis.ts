// Song analysis returned by POST /api/analyze and GET /api/songs/{file}/analysis.
// Hand-written to match shared/analysis.schema.json (server tests validate responses against it).

export const ANALYSIS_SECTION_LABELS = ['intro', 'verse', 'chorus', 'bridge', 'outro'] as const
export type SectionLabel = (typeof ANALYSIS_SECTION_LABELS)[number]

export interface AnalysisSection {
  /** Seconds. */
  start: number
  /** Seconds. */
  end: number
  label: SectionLabel
  /** 0..1 */
  energy: number
  /** Sections with the same letter repeat the same music (e.g. every chorus). */
  group: string
  /** Index into beats. */
  startBeat: number
  /** Exclusive index into beats. */
  endBeat: number
  bars: number
}

export interface Analysis {
  /** sha256 hex of the audio bytes. */
  id: string
  analysisVersion: number
  title: string
  artist?: string
  source: { kind: 'library' | 'upload'; file?: string }
  /** Same-origin path for the audio: /api/songs/{file} or /api/audio/{id}. */
  audioUrl: string
  durationSec: number
  sampleRate: number
  bpm: number
  beatsPerBar: 4
  /** Seconds, strictly ascending, covering the whole song. */
  beats: number[]
  /** Indices into beats filled in from the tempo grid (not detected). */
  filledBeats: number[]
  /** = beats[downbeatPhase::beatsPerBar] */
  downbeats: number[]
  downbeatPhase: number
  /** Onset strength, ~20 Hz, normalized 0..1. */
  onsetEnvelope: { hopSec: number; values: number[] }
  /** Per-beat loudness, 0..1, same length as beats. */
  beatEnergy: number[]
  /** Contiguous, in order, covering 0..durationSec. */
  sections: AnalysisSection[]
  elapsedMs: number
  cached: boolean
}
