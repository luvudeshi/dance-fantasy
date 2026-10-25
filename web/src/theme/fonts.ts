// Body Double's two families for canvas text (CSS uses --df-font-display / --df-font-ui from tokens.css):
// Fraunces is the story voice, Figtree the UI and every number.

export const STORY_FONT = "Fraunces, 'Iowan Old Style', Georgia, serif"
export const UI_FONT = "Figtree, 'Avenir Next', system-ui, sans-serif"

/** The faces the canvases draw with (HUD, cue strip, cue cards, teach, results). */
const CANVAS_FACES = ['600 16px Figtree', '800 16px Figtree', '800 16px Fraunces', 'italic 800 16px Fraunces']

/**
 * Resolves once the canvas faces are loaded (or failed, e.g. offline: the fallbacks draw), capped at
 * `timeoutMs` so a slow font CDN never holds the app back. A canvas only draws a webfont that is already
 * loaded and never triggers the download itself, so main.tsx mounts the app after this: no frame or cached
 * cue card is drawn in a fallback face.
 */
export function canvasFontsReady(timeoutMs = 1000): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return Promise.resolve()
  const loaded = Promise.all(CANVAS_FACES.map((f) => document.fonts.load(f)))
    .then(() => document.fonts.ready)
    .then(
      () => undefined,
      (err: unknown) => console.warn('webfonts failed to load; canvases use the fallback faces', err),
    )
  return Promise.race([loaded, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
}
