// Title / artist from an uploaded MP3's ID3v2 tag (TIT2 / TPE1), read in the browser. No
// dependency; anything unexpected returns {} and the caller falls back to the file name.

export interface SongTags {
  title?: string
  artist?: string
}

const HEADER = 10

function syncsafe(b: Uint8Array, i: number): number {
  return ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f)
}

function decodeText(b: Uint8Array): string {
  const enc = b[0]
  const body = b.subarray(1)
  let text: string
  try {
    if (enc === 0) text = new TextDecoder('latin1').decode(body)
    else if (enc === 1) text = new TextDecoder(body[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(body.subarray(body[0] === 0xfe || body[0] === 0xff ? 2 : 0))
    else if (enc === 2) text = new TextDecoder('utf-16be').decode(body)
    else text = new TextDecoder('utf-8').decode(body)
  } catch {
    return ''
  }
  return text.split('\0')[0].trim()
}

/** TIT2 / TPE1 from the first bytes of a file (ID3v2.3 / 2.4; v2.2 TT2 / TP1 too). */
export function parseId3(bytes: Uint8Array): SongTags {
  if (bytes.length < HEADER || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return {}
  const version = bytes[3]
  const end = Math.min(bytes.length, HEADER + syncsafe(bytes, 6))
  const idLen = version === 2 ? 3 : 4
  const want: Record<string, keyof SongTags> = version === 2 ? { TT2: 'title', TP1: 'artist' } : { TIT2: 'title', TPE1: 'artist' }
  const out: SongTags = {}
  let i = HEADER
  if (version !== 2 && bytes[5] & 0x40) i += version === 4 ? syncsafe(bytes, i) : 4 + ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3])
  while (i + idLen * 2 < end) {
    const id = String.fromCharCode(...bytes.subarray(i, i + idLen))
    if (!/^[A-Z0-9]+$/.test(id)) break
    const size =
      version === 2
        ? (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5]
        : version === 4
          ? syncsafe(bytes, i + 4)
          : ((bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7]) >>> 0
    const start = i + (version === 2 ? 6 : 10)
    if (size <= 0 || start + size > end) break
    const key = want[id]
    if (key && !out[key]) {
      const text = decodeText(bytes.subarray(start, start + size))
      if (text) out[key] = text
    }
    i = start + size
  }
  return out
}

/** Tags of an uploaded file ({} when there are none or it can't be read). */
export async function readSongTags(file: Blob): Promise<SongTags> {
  try {
    return parseId3(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()))
  } catch {
    return {}
  }
}

/** "Lottery (Renegade).mp3" -> "Lottery (Renegade)". */
export const titleFromFileName = (name: string): string => name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim()
