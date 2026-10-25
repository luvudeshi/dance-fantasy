import { describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/analysis'
import type { Routine } from '@shared/routine'
import routineExample from '@shared/examples/routine.example.json'
import { buildCheckpoints, JUDGMENT_POINTS, ScoreKeeper } from '../game/scoring'
import { prepareGame, recipeFromRoutine, type SessionDeps, type SessionRequest } from '../game/session'
import { signatureEnabled, SIGNATURE_STORAGE_KEY } from './flag'
import { parseId3, titleFromFileName } from './id3'
import {
  bannerText,
  isSignatureLookup,
  pinsFor,
  safeLink,
  SIGNATURE_MULTIPLIER,
  signatureAt,
  signatureLabel,
  withSignatureMultiplier,
  type SignatureLookup,
} from './dances'

const ROUTINE = routineExample as unknown as Routine

const LOOKUP: SignatureLookup = {
  title: 'Y.M.C.A.',
  artist: '',
  found: true,
  danceName: 'YMCA arms',
  creator: '',
  year: null,
  confidence: 1,
  links: [{ title: 'Search YouTube', url: 'https://www.youtube.com/results?search_query=ymca+dance', source: 'YouTube' }],
  source: 'table',
  moveId: 'sig_ymca_arms',
  moveName: 'YMCA Arms',
}

const storage = (v: string | null) => ({ getItem: () => v, setItem: () => undefined })

describe('flag', () => {
  it('is on by default and off with ?signature=0 or localStorage', () => {
    expect(signatureEnabled({ search: '', hash: '#/play' }, storage(null))).toBe(true)
    expect(signatureEnabled({ search: '', hash: '#/play' }, storage('0'))).toBe(false)
    expect(signatureEnabled({ search: '?signature=1', hash: '' }, storage(null))).toBe(true)
    expect(signatureEnabled({ search: '', hash: '#/moves?signature=1' }, storage(null))).toBe(true)
    expect(signatureEnabled({ search: '', hash: '' }, storage('1'))).toBe(true)
    expect(signatureEnabled({ search: '?signature=0', hash: '' }, storage('1'))).toBe(false)
    expect(SIGNATURE_STORAGE_KEY).toBe('mb.signature')
  })
})

describe('lookup helpers', () => {
  it('validates lookup responses', () => {
    expect(isSignatureLookup(LOOKUP)).toBe(true)
    expect(isSignatureLookup({ ...LOOKUP, links: [{ title: 't', url: 'u' }] })).toBe(false)
    expect(isSignatureLookup({ detail: 'nope' })).toBe(false)
  })

  it('pins the signature move on the chorus only when there is one', () => {
    expect(pinsFor(LOOKUP)).toEqual([{ moveId: 'sig_ymca_arms', placement: 'chorus' }])
    expect(pinsFor({ ...LOOKUP, danceName: 'The Renegade', creator: 'Jalaiah Harmon', moveId: null })).toEqual([])
    expect(pinsFor({ ...LOOKUP, found: false })).toEqual([])
    expect(pinsFor(null)).toEqual([])
  })

  it('only renders https links', () => {
    expect(safeLink('https://www.tiktok.com/search?q=x')).toBe('https://www.tiktok.com/search?q=x')
    expect(safeLink('javascript:alert(1)')).toBeNull()
    expect(safeLink('http://example.com')).toBeNull()
    expect(safeLink('not a url')).toBeNull()
  })

  it('writes the banner with credit, or "inspired by" without a creator', () => {
    expect(bannerText({ name: 'The Renegade', creator: 'Jalaiah Harmon' })).toBe('★ SIGNATURE: The Renegade, created by Jalaiah Harmon')
    expect(bannerText({ name: 'YMCA arms' })).toBe('★ SIGNATURE: inspired by YMCA arms')
  })

  it('labels signature moves "inspired by" in the gallery', () => {
    const move = { id: 'x' } as never
    expect(signatureLabel(move)).toBeNull()
  })
})

describe('id3', () => {
  const frame = (id: string, text: string, enc = 3): number[] => {
    const body = enc === 0 ? [...text].map((c) => c.charCodeAt(0)) : [...new TextEncoder().encode(text)]
    const size = body.length + 1
    return [...id].map((c) => c.charCodeAt(0)).concat([0, 0, 0, size, 0, 0, enc, ...body])
  }
  const tag = (frames: number[], version = 4): Uint8Array => {
    const n = frames.length
    return new Uint8Array([0x49, 0x44, 0x33, version, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f, ...frames, 0xff, 0xfb])
  }

  it('reads TIT2 / TPE1', () => {
    expect(parseId3(tag([...frame('TIT2', 'Y.M.C.A.'), ...frame('TPE1', 'Village People')]))).toEqual({ title: 'Y.M.C.A.', artist: 'Village People' })
    expect(parseId3(tag(frame('TIT2', 'Macarena', 0), 3))).toEqual({ title: 'Macarena' })
  })

  it('returns {} without a tag, and falls back to the file name', () => {
    expect(parseId3(new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({})
    expect(parseId3(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 50, 0x7a]))).toEqual({})
    expect(titleFromFileName('Lottery (Renegade).mp3')).toBe('Lottery (Renegade)')
    expect(titleFromFileName('Gangnam_Style.wav')).toBe('Gangnam Style')
  })
})

const signed: Routine = {
  ...ROUTINE,
  moves: ROUTINE.moves.map((m, i) => (i === 1 ? { ...m, signatureDance: { name: 'YMCA arms' } } : m)),
}

describe('in game', () => {
  it('finds the signature move playing now', () => {
    const m = signed.moves[1]
    expect(signatureAt(signed, m.startTime)?.signatureDance?.name).toBe('YMCA arms')
    expect(signatureAt(signed, (m.startTime + m.endTime) / 2)).toBe(m)
    expect(signatureAt(signed, m.endTime + 0.001)).toBeNull()
    expect(signatureAt(ROUTINE, m.startTime)).toBeNull()
  })

  it('doubles only the signature move’s own points', () => {
    const plain = buildCheckpoints(signed, 'standing')
    const cps = withSignatureMultiplier(plain, signed)
    expect(cps.filter((c) => c.multiplier === SIGNATURE_MULTIPLIER).every((c) => c.moveIndex === 1)).toBe(true)
    expect(cps.some((c) => c.multiplier === SIGNATURE_MULTIPLIER)).toBe(true)
    expect(withSignatureMultiplier(buildCheckpoints(ROUTINE, 'standing'), ROUTINE)).toEqual(buildCheckpoints(ROUTINE, 'standing'))

    // Perfect on every checkpoint: identical to the plain keeper except the signature checkpoints, which are 2x.
    const run = (list: typeof cps) => {
      const k = new ScoreKeeper(list)
      for (const cp of list) k.addFrame({ songTime: cp.time, pose: cp.target, valid: true, visibility: Object.fromEntries(Object.keys(cp.target).map((j) => [j, 1])) })
      k.advanceTo(Infinity)
      return k
    }
    const a = run(plain).results()
    const b = run(cps).results()
    expect(a.map((r) => r.judgment)).toEqual(b.map((r) => r.judgment))
    expect(b.filter((r) => r.checkpoint.moveIndex === 1).every((r) => r.judgment === 'perfect')).toBe(true)
    b.forEach((r, i) => {
      expect(r.points).toBe((a[i].points ?? 0) * (r.checkpoint.moveIndex === 1 ? SIGNATURE_MULTIPLIER : 1))
    })
    expect(run(plain).state.stars).toBe(run(cps).state.stars)
    expect(a.every((r) => r.points === undefined || r.points >= JUDGMENT_POINTS.miss)).toBe(true)
  })
})

describe('session', () => {
  const analysis = { id: 'a'.repeat(64), audioUrl: '/x', title: 'Y.M.C.A.' } as unknown as Analysis
  const deps = () => ({
    analyzeLibrarySong: vi.fn<SessionDeps['analyzeLibrarySong']>(async () => analysis),
    analyzeUpload: vi.fn<SessionDeps['analyzeUpload']>(async () => analysis),
    choreograph: vi.fn<SessionDeps['choreograph']>(async () => ({ routine: ROUTINE })),
    loadAudio: vi.fn<SessionDeps['loadAudio']>(async () => 8),
    getRoutine: vi.fn<SessionDeps['getRoutine']>(async () => ROUTINE),
    getAnalysis: vi.fn<SessionDeps['getAnalysis']>(async () => analysis),
  })
  const req: SessionRequest = { song: { kind: 'library', file: 'ymca.mp3' }, difficulty: 'normal', mode: 'standing', seed: 1 }

  it('sends pinnedMoves only when there are some', async () => {
    const d = deps()
    await prepareGame(req, d, () => undefined, new AbortController().signal)
    expect(d.choreograph.mock.calls[0][0]).toEqual({ analysisId: analysis.id, difficulty: 'normal', mode: 'standing', seed: 1 })
    const p = deps()
    await prepareGame({ ...req, pinnedMoves: pinsFor(LOOKUP) }, p, () => undefined, new AbortController().signal)
    expect(p.choreograph.mock.calls[0][0].pinnedMoves).toEqual([{ moveId: 'sig_ymca_arms', placement: 'chorus' }])
  })

  it('keeps the pins in a routine’s recipe', () => {
    const meta = { analysisId: 'a'.repeat(64), pinnedMoves: [{ moveId: 'sig_ymca_arms', placement: 'chorus' }] }
    expect(recipeFromRoutine({ ...ROUTINE, meta })?.pinnedMoves).toEqual(meta.pinnedMoves)
    expect(recipeFromRoutine({ ...ROUTINE, meta: { analysisId: 'a'.repeat(64) } })).not.toHaveProperty('pinnedMoves')
  })
})
