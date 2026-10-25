// Room modes (versus / crew): per-beat judgements and the song heatmap (shared/README.md, "Stage 6
// endpoints"). The mode, beats and rematch writes live with the other room writes in ../client.ts.

import { isNum, isRecord, isStr, requestWithResponse } from '../../api'

export type Grade = 'perfect' | 'good' | 'ok' | 'miss'

export interface BeatJudgement {
  /** the routine's checkpoint index (same on every device), 0..20000 */
  beat: number
  /** 0..100 */
  score: number
  grade: Grade
}

export interface HeatBeat {
  beat: number
  avgScore: number
  samples: number
}

export const MAX_BEATS_PER_POST = 64
export const MAX_BEAT = 20_000
export const GRADES: readonly Grade[] = ['perfect', 'good', 'ok', 'miss']

const isHeatmap = (v: unknown): v is { analysisId: string; beats: HeatBeat[] } =>
  isRecord(v) &&
  isStr(v.analysisId) &&
  Array.isArray(v.beats) &&
  v.beats.every((b) => isRecord(b) && isNum(b.beat) && isNum(b.avgScore) && isNum(b.samples))

/** Average judgement per beat of a song across every room and round (its hardest moments). */
export async function getHeatmap(analysisId: string, signal?: AbortSignal): Promise<HeatBeat[]> {
  const { body } = await requestWithResponse(`/api/songs/${encodeURIComponent(analysisId)}/heatmap`, isHeatmap, { signal })
  return body.beats
}
