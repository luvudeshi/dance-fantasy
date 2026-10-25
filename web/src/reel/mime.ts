// The MediaRecorder container this browser can write: webm on Chrome / Firefox, mp4 on Safari.

export const MIME_CANDIDATES: readonly string[] = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
]

/** First supported candidate; '' lets the browser choose; null when there is no MediaRecorder. */
export function pickMimeType(
  isTypeSupported: ((t: string) => boolean) | null = typeof MediaRecorder === 'undefined' ? null : (t) => MediaRecorder.isTypeSupported(t),
): string | null {
  if (!isTypeSupported) return null
  for (const t of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(t)) return t
    } catch {
      // try the next one
    }
  }
  return ''
}

export const fileExtension = (mime: string): string => (mime.includes('mp4') ? 'mp4' : 'webm')
