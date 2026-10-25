// Lazy gate for the 3D coach. three.js loads on first use (its own chunk, out of the main bundle);
// until then, without WebGL, after a failure or while Settings > dancer3d is off, the caller draws
// the 2D silhouette. Turning the setting off frees the WebGL context.

import type { JointName, Pose2D, Vec2 } from '@shared/skeleton'
import type { Ctx2D } from '../pose/draw'
import type { CoachTheme, CoachView } from '../render/coach'
import { getSettings } from '../settings'

type Coach3dModule = typeof import('./coach3d')

let mod: Coach3dModule | null = null
let state: 'idle' | 'loading' | 'ready' | 'off' = 'idle'

function load(): void {
  if (state !== 'idle') return
  if (typeof document === 'undefined' || typeof WebGL2RenderingContext === 'undefined') {
    state = 'off'
    return
  }
  state = 'loading'
  import('./coach3d').then(
    (m) => {
      mod = m
      state = 'ready'
      if (getSettings().dancer3d) m.warmCoach3d()
    },
    (err: unknown) => {
      console.warn('3D coach unavailable, using the 2D coach:', err)
      state = 'off'
    },
  )
}

// Fetch three.js and compile the shader while the browser is idle, before any coach is drawn.
if (typeof requestIdleCallback === 'function' && getSettings().dancer3d) requestIdleCallback(load, { timeout: 4000 })

/** True while the 3D coach is what drawCoach draws (cached pictograms key on it). */
export function coach3dActive(): boolean {
  return state === 'ready' && getSettings().dancer3d
}

/** Draws the 3D coach if it is enabled and loaded; false = draw the 2D coach instead. */
export function tryDrawCoach3d(
  ctx: Ctx2D,
  pose: Pose2D,
  root: Vec2,
  view: CoachView,
  opts: { theme: CoachTheme; pulse: number; highlightJoints: readonly JointName[]; crown: boolean },
): boolean {
  if (!getSettings().dancer3d) {
    mod?.disposeCoach3d()
    return false
  }
  load()
  if (state !== 'ready' || !mod) return false
  try {
    return mod.drawCoach3d(ctx, pose, root, view, opts)
  } catch (err) {
    console.warn('3D coach failed, using the 2D coach:', err)
    mod.disposeCoach3d()
    state = 'off'
    return false
  }
}
