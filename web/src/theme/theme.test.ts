import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ICON_NAMES } from './icons'

// Guards the design-system contract other screens build on: every documented icon exists on disk,
// every df- class the components use is defined in the CSS, and every var(--df-*) has a token.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const CSS = ['tokens.css', 'base.css', 'sticker.css', 'controls.css', 'pieces.css'].map(read).join('\n')
const ICON_DIR = new URL('../../public/art/icons/', import.meta.url)

describe('icon kit', () => {
  it('has exactly one 256x256 sticker SVG per ICON_NAMES entry', () => {
    const files = readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg'))
    expect(files.map((f) => f.replace(/\.svg$/, '')).sort()).toEqual([...ICON_NAMES].sort())
    for (const f of files) {
      const svg = readFileSync(new URL(f, ICON_DIR), 'utf8')
      expect(svg, f).toMatch(/^<svg [^>]*viewBox="0 0 256 256"/)
      expect(svg, f).toMatch(/<title>[^<]+<\/title>/)
    }
  })
})

describe('class contract', () => {
  const defined = new Set([...CSS.matchAll(/\.(df-[a-z0-9-]+)/g)].map((m) => m[1]))

  it('defines every df- class the components and style guide use', () => {
    const tsx = ['components.tsx', 'Icon.tsx', 'StyleGuide.tsx'].map(read).join('\n')
    const used = new Set([...tsx.matchAll(/(?<![-\w])(df-[a-z0-9-]*[a-z0-9])\b(?!-\$)/g)].map((m) => m[1]))
    // classes built from props: df-btn-${variant}, df-badge-${tone}, df-token-${size}, df-notice-${tone}
    const dynamic = [
      ...['primary', 'secondary', 'ghost', 'icon', 'sm', 'lg', 'block'].map((v) => `df-btn-${v}`),
      ...['gold', 'rasp', 'sage', 'blue', 'night'].map((v) => `df-badge-${v}`),
      ...['sm', 'lg', 'xl', 'picked', 'off'].map((v) => `df-token-${v}`),
      ...['error', 'success'].map((v) => `df-notice-${v}`),
    ]
    const missing = [...used, ...dynamic].filter((c) => !defined.has(c))
    expect(missing).toEqual([])
  })

  it('has a token for every var(--df-*) the CSS reads', () => {
    const tokens = new Set([...read('tokens.css').matchAll(/(--df-[a-z0-9-]+):/g)].map((m) => m[1]))
    // per-element knobs, set where they are used
    for (const knob of ['--df-gap', '--df-min', '--df-fill', '--df-medal-size', '--df-token-size']) tokens.add(knob)
    const read_ = new Set([...CSS.matchAll(/var\((--df-[a-z0-9-]+)/g)].map((m) => m[1]))
    expect([...read_].filter((v) => !tokens.has(v))).toEqual([])
  })
})
