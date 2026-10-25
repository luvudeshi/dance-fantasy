// Clip export, behind one function so a server-side "stitch into one shareable video" can
// replace it later without touching the reel UI. v1 saves the clips as files on this device.

import { fileExtension } from './mime'
import type { ClipMeta } from './types'

export interface ExportableClip {
  meta: ClipMeta
  blob: Blob
}

export type ExportResult = { kind: 'files'; count: number } | { kind: 'url'; url: string }

export type ClipExporter = (clips: readonly ExportableClip[], opts: { title: string }) => Promise<ExportResult>

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'midnight-ball'
}

/** Downloads each clip (local only). */
export const downloadClips: ClipExporter = (clips, { title }) => {
  clips.forEach((c, i) => {
    const url = URL.createObjectURL(c.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug(title)}-combo-${i + 1}-x${c.meta.comboLength}.${fileExtension(c.blob.type)}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  })
  return Promise.resolve({ kind: 'files', count: clips.length })
}

let exporter: ClipExporter = downloadClips

export const exportHighlights: ClipExporter = (clips, opts) => exporter(clips, opts)

/** Swap the exporter (e.g. server-side stitching); null restores local downloads. */
export function setClipExporter(fn: ClipExporter | null): void {
  exporter = fn ?? downloadClips
}
