import { describe, expect, it } from 'vitest'
import skeletonJson from '@shared/skeleton.json'
import { BONES, JOINTS, LEG_JOINTS, LIMBS, MEDIAPIPE_INDEX, MIRROR, type JointName } from '@shared/skeleton'

// shared/skeleton.ts is hand-written; shared/skeleton.json is the canonical copy the
// server also checks against. These must never drift.
describe('@shared/skeleton matches shared/skeleton.json', () => {
  it('JOINTS', () => {
    expect([...JOINTS]).toEqual(skeletonJson.joints)
  })

  it('MEDIAPIPE_INDEX', () => {
    expect(MEDIAPIPE_INDEX).toEqual(skeletonJson.mediapipeIndex)
    expect(Object.keys(MEDIAPIPE_INDEX)).toEqual(skeletonJson.joints)
  })

  it('MIRROR', () => {
    expect(MIRROR).toEqual(skeletonJson.mirror)
  })

  it('BONES', () => {
    expect(BONES.map((b) => [...b])).toEqual(skeletonJson.bones)
  })

  it('LIMBS', () => {
    const limbs = Object.fromEntries(Object.entries(LIMBS).map(([k, v]) => [k, [...v]]))
    expect(limbs).toEqual(skeletonJson.limbs)
  })

  it('LEG_JOINTS', () => {
    expect([...LEG_JOINTS]).toEqual(skeletonJson.legJoints)
  })
})

describe('skeleton invariants', () => {
  const known = new Set<string>(JOINTS)

  it('MIRROR is an involution that swaps l_/r_', () => {
    for (const j of JOINTS) {
      expect(MIRROR[MIRROR[j]]).toBe(j)
      const m: JointName = MIRROR[j]
      if (j.startsWith('l_')) expect(m).toBe(`r_${j.slice(2)}`)
      else if (j.startsWith('r_')) expect(m).toBe(`l_${j.slice(2)}`)
      else expect(m).toBe(j)
    }
  })

  it('MediaPipe indices are unique and within the 33-landmark model', () => {
    const idx = Object.values(MEDIAPIPE_INDEX)
    expect(new Set(idx).size).toBe(idx.length)
    for (const i of idx) expect(i >= 0 && i < 33).toBe(true)
  })

  it('bones and leg joints reference known joints', () => {
    for (const [a, b] of BONES) {
      expect(known.has(a)).toBe(true)
      expect(known.has(b)).toBe(true)
    }
    for (const j of LEG_JOINTS) expect(known.has(j)).toBe(true)
  })
})
