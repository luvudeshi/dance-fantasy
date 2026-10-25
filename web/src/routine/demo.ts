// Small built-in move library + naive routine builder. Test fixtures, and a clearly labelled
// offline fallback for the gallery / analysis page while the Stage 2 endpoints are missing.
// The real library and choreographer live on the server (GET /api/moves, POST /api/choreograph).

import type { Analysis } from '@shared/analysis'
import type { LibraryMove, MoveKeyframe, MoveLibraryResponse } from '@shared/moves'
import type { Difficulty, Mode, Move, Routine } from '@shared/routine'
import { MIRROR, type JointName, type Pose2D, type Vec2 } from '@shared/skeleton'
import { mirrorPose, NEUTRAL_POSE } from './pose'

type Overrides = Partial<Record<JointName, Vec2>>
type KfSpec = [t: number, overrides: Overrides, root?: Vec2]

interface MoveSpec extends Omit<LibraryMove, 'id' | 'name' | 'keyframes' | 'mirrorOf' | 'startAnchor' | 'endAnchor'> {
  name: string
  /** Name of the mirrored (_L) variant for one-sided moves. */
  mirrorName?: string
  keyframes: KfSpec[]
}

const kf = ([t, o, root = [0, 0]]: KfSpec): MoveKeyframe => ({ t, pose: { ...NEUTRAL_POSE, ...o } as Pose2D, root })

const SPECS: MoveSpec[] = [
  {
    baseId: 'arm_raise',
    name: 'Right Arm Up',
    mirrorName: 'Left Arm Up',
    lengthBeats: 2,
    intensity: 1,
    difficulty: 'easy',
    bodyParts: ['arms'],
    upperBodyOnly: true,
    styles: ['pop', 'storybook'],
    scoredJoints: ['r_elbow', 'r_wrist'],
    side: 'R',
    keyframes: [[0, {}], [0.5, { r_elbow: [0.55, -1.55], r_wrist: [0.6, -2.1] }], [1, {}]],
  },
  {
    baseId: 'royal_wave',
    name: 'Royal Wave (R)',
    mirrorName: 'Royal Wave (L)',
    lengthBeats: 4,
    intensity: 2,
    difficulty: 'easy',
    bodyParts: ['arms'],
    upperBodyOnly: true,
    styles: ['storybook'],
    scoredJoints: ['r_elbow', 'r_wrist'],
    side: 'R',
    keyframes: [
      [0, {}],
      [0.25, { r_elbow: [1.0, -1.1], r_wrist: [1.2, -1.62] }],
      [0.5, { r_elbow: [1.0, -1.1], r_wrist: [0.82, -1.66] }],
      [0.75, { r_elbow: [1.0, -1.1], r_wrist: [1.2, -1.62] }],
      [1, {}],
    ],
  },
  {
    baseId: 'squat_clap',
    name: 'Squat Clap',
    lengthBeats: 2,
    intensity: 3,
    difficulty: 'normal',
    bodyParts: ['arms', 'legs'],
    upperBodyOnly: false,
    styles: ['pop', 'hiphop'],
    scoredJoints: ['l_wrist', 'r_wrist', 'l_knee', 'r_knee'],
    side: 'both',
    keyframes: [
      [0, {}],
      [
        0.5,
        {
          l_elbow: [-0.5, -0.6],
          r_elbow: [0.5, -0.6],
          l_wrist: [-0.04, -0.78],
          r_wrist: [0.04, -0.78],
          l_knee: [-0.48, 0.75],
          r_knee: [0.48, 0.75],
          l_ankle: [-0.3, 1.5],
          r_ankle: [0.3, 1.5],
        },
        [0, 0.35],
      ],
      [1, {}],
    ],
  },
  {
    baseId: 'star_jump',
    name: 'Star Jump',
    lengthBeats: 2,
    intensity: 5,
    difficulty: 'hard',
    bodyParts: ['arms', 'legs'],
    upperBodyOnly: false,
    styles: ['pop', 'storybook'],
    scoredJoints: ['l_elbow', 'l_wrist', 'r_elbow', 'r_wrist', 'l_knee', 'l_ankle', 'r_knee', 'r_ankle'],
    side: 'both',
    keyframes: [
      [0, {}],
      [0.2, { l_knee: [-0.35, 0.8], r_knee: [0.35, 0.8], l_ankle: [-0.25, 1.65], r_ankle: [0.25, 1.65] }, [0, 0.2]],
      [
        0.5,
        {
          l_elbow: [-0.95, -1.55],
          r_elbow: [0.95, -1.55],
          l_wrist: [-1.35, -2.05],
          r_wrist: [1.35, -2.05],
          l_knee: [-0.5, 0.9],
          r_knee: [0.5, 0.9],
          l_ankle: [-0.75, 1.75],
          r_ankle: [0.75, 1.75],
        },
        [0, -0.45],
      ],
      [0.8, { l_knee: [-0.35, 0.8], r_knee: [0.35, 0.8], l_ankle: [-0.25, 1.65], r_ankle: [0.25, 1.65] }, [0, 0.2]],
      [1, {}],
    ],
  },
  {
    baseId: 'step_touch',
    name: 'Step Touch Right',
    mirrorName: 'Step Touch Left',
    lengthBeats: 2,
    intensity: 2,
    difficulty: 'easy',
    bodyParts: ['legs', 'arms'],
    upperBodyOnly: false,
    styles: ['pop', 'latin'],
    scoredJoints: ['l_knee', 'l_ankle', 'r_wrist'],
    side: 'R',
    keyframes: [
      [0, {}],
      [
        0.5,
        { l_knee: [-0.08, 0.92], l_ankle: [0.05, 1.8], r_elbow: [0.95, -0.7], r_wrist: [1.3, -1.1], l_elbow: [-0.6, -0.45], l_wrist: [-0.2, -0.65] },
        [0.35, 0],
      ],
      [1, {}],
    ],
  },
  {
    baseId: 'disco_point',
    name: 'Disco Point (R)',
    mirrorName: 'Disco Point (L)',
    lengthBeats: 4,
    intensity: 4,
    difficulty: 'normal',
    bodyParts: ['arms', 'torso'],
    upperBodyOnly: true,
    styles: ['disco', 'pop'],
    scoredJoints: ['r_elbow', 'r_wrist', 'l_wrist'],
    side: 'R',
    keyframes: [
      [0, {}],
      [0.25, { r_elbow: [0.85, -1.5], r_wrist: [1.2, -2.0], l_elbow: [-0.85, -0.45], l_wrist: [-0.38, -0.05] }],
      [0.5, { r_elbow: [0.3, -0.35], r_wrist: [-0.3, 0.25], l_elbow: [-0.85, -0.45], l_wrist: [-0.38, -0.05] }],
      [0.75, { r_elbow: [0.85, -1.5], r_wrist: [1.2, -2.0], l_elbow: [-0.85, -0.45], l_wrist: [-0.38, -0.05] }],
      [1, {}],
    ],
  },
]

function compile(spec: MoveSpec): LibraryMove[] {
  const { mirrorName, keyframes, name, ...rest } = spec
  const base: LibraryMove = {
    ...rest,
    id: spec.side === 'both' ? spec.baseId : `${spec.baseId}_${spec.side}`,
    name,
    keyframes: keyframes.map(kf),
    startAnchor: 'neutral',
    endAnchor: 'neutral',
    mirrorOf: null,
  }
  if (spec.side === 'both') return [base]
  const mirrored: LibraryMove = {
    ...base,
    id: `${spec.baseId}_${spec.side === 'R' ? 'L' : 'R'}`,
    name: mirrorName ?? `${name} (mirrored)`,
    side: spec.side === 'R' ? 'L' : 'R',
    mirrorOf: base.id,
    scoredJoints: base.scoredJoints.map((j) => MIRROR[j]),
    keyframes: base.keyframes.map((k) => ({ t: k.t, pose: mirrorPose(k.pose), root: [-k.root[0] || 0, k.root[1]] })),
  }
  return [base, mirrored]
}

/** Built-in demo library (6 base moves, 10 with mirrored variants). */
export const DEMO_LIBRARY: MoveLibraryResponse = { version: 'demo', moves: SPECS.flatMap(compile) }

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

export type DemoSong = Pick<Analysis, 'id' | 'title' | 'artist' | 'durationSec' | 'bpm' | 'beats' | 'downbeats' | 'sections'>

/**
 * Naive offline routine: random library moves back to back from the first downbeat, filtered
 * by mode (seated -> upper body only) and difficulty (easy skips hard moves). Not the real
 * choreographer; meta.generator says so.
 */
export function demoRoutine(
  song: DemoSong,
  library: MoveLibraryResponse,
  opts: { difficulty: Difficulty; mode: Mode; seed: number },
): Routine {
  const pool = library.moves.filter(
    (m) => (opts.mode === 'standing' || m.upperBodyOnly) && (opts.difficulty !== 'easy' || m.difficulty !== 'hard'),
  )
  const rand = mulberry32(opts.seed)
  const moves: Move[] = []
  const { beats } = song
  let b = Math.max(0, beats.indexOf(song.downbeats[0] ?? beats[0]))
  while (pool.length > 0) {
    const m = pool[Math.floor(rand() * pool.length)]
    const end = beats[b + m.lengthBeats]
    if (end === undefined) break
    moves.push({
      id: m.id,
      name: m.name,
      startBeat: b,
      lengthBeats: m.lengthBeats,
      startTime: beats[b],
      endTime: end,
      intensity: m.intensity,
      scoredJoints: [...m.scoredJoints],
      keyframes: m.keyframes,
    })
    b += m.lengthBeats
  }
  return {
    version: 1,
    song: {
      id: song.id,
      title: song.title,
      ...(song.artist !== undefined ? { artist: song.artist } : {}),
      durationSec: song.durationSec,
      bpm: song.bpm,
      beats: song.beats,
      downbeats: song.downbeats,
      sections: song.sections.map(({ start, end, label, energy }) => ({ start, end, label, energy })),
    },
    difficulty: opts.difficulty,
    mode: opts.mode,
    seed: opts.seed,
    moves,
    meta: { generator: 'web-demo', routineId: `demo-${song.id.slice(0, 8)}-${opts.difficulty}-${opts.mode}-${opts.seed}`, libraryVersion: library.version },
  }
}
