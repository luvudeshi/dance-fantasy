// The coach (3D rig and 2D silhouette) on real-dancer routines (Stage 8: AIST++ clips): arbitrary limb
// angles, bones longer or shorter than the neutral ones, sideways travel and small jumps. Every frame
// must draw (finite geometry), and the body turn must not snap from one side to the other.

import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import aistJson from '../game/__fixtures__/routine_synth120_normal_aist.json'
import aistSeatedJson from '../game/__fixtures__/routine_synth120_normal_aist_seated.json'
import mixJson from '../game/__fixtures__/routine_synth120_normal_mix.json'
import { coachShape } from '../render/coach'
import { fitFigureView, stageRoot } from '../render/stickFigure'
import { buildMotionTrack } from '../routine/track'
import { liftPose } from './lift'
import { buildRig } from './rig'

const ROUTINES: Record<string, Routine> = {
  aist: aistJson as unknown as Routine,
  'aist seated': aistSeatedJson as unknown as Routine,
  mix: mixJson as unknown as Routine,
}

const VIEW = { cx: 400, floorY: 900, scale: 180, mirrored: true }

function numbers(o: unknown, out: number[] = []): number[] {
  if (typeof o === 'number') out.push(o)
  else if (Array.isArray(o) || o instanceof Float32Array) for (const v of o) numbers(v, out)
  else if (o && typeof o === 'object') for (const v of Object.values(o)) numbers(v, out)
  return out
}

describe.each(Object.entries(ROUTINES))('coach on a real-dancer routine: %s', (_name, routine) => {
  const track = buildMotionTrack(routine)
  const frames = Array.from({ length: Math.floor(routine.song.durationSec * 30) }, (_, i) => track.sample(i / 30))

  it('builds finite 3D and 2D geometry for every frame', () => {
    for (const s of frames) {
      const rig = buildRig(s.pose, s.root, VIEW, 0, 0)
      expect(Object.keys(rig.parts).length).toBeGreaterThan(20)
      expect(numbers(rig).every(Number.isFinite)).toBe(true)
      expect(numbers(coachShape(s.pose, s.root, VIEW)).every(Number.isFinite)).toBe(true)
    }
  })

  it('turns the body smoothly (no left/right snaps between frames)', () => {
    let prev: number | null = null
    let worst = 0
    for (const s of frames) {
      const yaw = liftPose(s.pose).yaw
      if (prev !== null) {
        let d = Math.abs(yaw - prev)
        if (d > Math.PI) d = 2 * Math.PI - d
        worst = Math.max(worst, d)
      }
      prev = yaw
    }
    // ~30° in one 1/30 s frame at most (a fast real turn), never a 50°+ side flip.
    expect(worst).toBeLessThan(0.55)
  })

  it('keeps the dancer on a phone-sized stage', () => {
    const phone = fitFigureView(390, 700)
    for (const s of frames) {
      const [x] = stageRoot(s.root, phone, 0, 390)
      expect(Math.abs(x) * phone.scale + 1.15 * phone.scale).toBeLessThanOrEqual(195 + 1e-6)
    }
  })
})
