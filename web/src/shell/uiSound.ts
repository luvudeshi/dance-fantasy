// Menu hover / click sounds, played with the game's own recipes (game/sfx.ts) and its on/off
// preference. ponytail: one AudioContext for the whole shell, created on the first gesture
// (browsers block audio before one); the game keeps its own context on its clock.

import { loadSfxEnabled, Sfx, type SfxName } from '../game/sfx'

let ctx: AudioContext | null = null
const sfx = new Sfx(() => ctx)

/** Creates / resumes the shell's AudioContext. Call from a user gesture (pointerdown, keydown). */
export function unlockUiSound(): void {
  if (typeof AudioContext === 'undefined') return
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
}

/** Plays a game sound when sound effects are on and audio has been unlocked; otherwise nothing. */
export function uiSound(name: SfxName): void {
  if (ctx && loadSfxEnabled()) sfx.play(name)
}
