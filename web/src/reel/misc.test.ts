import { describe, expect, it } from 'vitest'
import { cannedCaption, getCaption, setCaptionSource } from './captions'
import { reelEnabled } from './flag'
import { fileExtension, pickMimeType } from './mime'

describe('feature flag', () => {
  const storage = (v: string | null) => ({ getItem: () => v })
  it('off by default, on with ?reel=1 in the hash or query, or localStorage', () => {
    expect(reelEnabled({ search: '', hash: '#/play' }, storage(null))).toBe(false)
    expect(reelEnabled({ search: '', hash: '#/play?reel=1' }, storage(null))).toBe(true)
    expect(reelEnabled({ search: '?reel=1', hash: '#/play' }, storage(null))).toBe(true)
    expect(reelEnabled({ search: '', hash: '#/play' }, storage('1'))).toBe(true)
    expect(reelEnabled({ search: '', hash: '#/play?reel=0' }, storage('1'))).toBe(false)
  })
})

describe('mime type', () => {
  it('webm where supported (Chrome), else mp4 (Safari)', () => {
    expect(pickMimeType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9')
    expect(pickMimeType((t) => t.startsWith('video/mp4'))).toBe('video/mp4;codecs=avc1')
    expect(pickMimeType(() => false)).toBe('')
    expect(pickMimeType(null)).toBeNull()
    expect(fileExtension('video/mp4;codecs=avc1')).toBe('mp4')
  })
})

describe('captions', () => {
  const base = { id: 'x', playerName: 'You', comboLength: 10, avgScore: 90, bestMoveId: 'arm_wave', bestMoveName: 'Arm Wave' }
  const js = (codes: string) => [...codes].map((c, i) => ({ time: i, judgment: c === 'P' ? ('perfect' as const) : ('good' as const), score: 90, moveId: 'm', moveIndex: 0 }))

  it('canned storybook lines, deterministic', () => {
    expect(cannedCaption({ ...base, judgments: js('PPPPPPPP') })).toBe('And lo, the dancer did not miss a single beat')
    const line = cannedCaption({ ...base, judgments: js('PPGPPPPP') })
    expect(line).toBe(cannedCaption({ ...base, judgments: js('PPGPPPPP') }))
    expect(cannedCaption({ ...base, bestMoveId: 'star_pose_L', judgments: js('PGPPPPPP') })).toMatch(/statue|guards/)
  })

  it('getCaption is swappable and falls back to the canned line', async () => {
    const clip = { ...base, judgments: js('PPPPPPPP') }
    setCaptionSource(() => Promise.resolve('A generated line'))
    expect(await getCaption(clip)).toBe('A generated line')
    setCaptionSource(() => Promise.reject(new Error('offline')))
    expect(await getCaption(clip)).toBe(cannedCaption(clip))
    setCaptionSource(null)
    expect(await getCaption(clip)).toBe(cannedCaption(clip))
  })
})
