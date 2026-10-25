import { describe, expect, it } from 'vitest'
import { gradeFor } from './grade'

describe('gradeFor', () => {
  it('maps stars to a letter at each boundary', () => {
    expect(gradeFor(5)).toBe('S')
    expect(gradeFor(4.75)).toBe('S')
    expect(gradeFor(4.74)).toBe('A')
    expect(gradeFor(4)).toBe('A')
    expect(gradeFor(3)).toBe('B')
    expect(gradeFor(2.99)).toBe('C')
    expect(gradeFor(2)).toBe('C')
    expect(gradeFor(1.5)).toBe('D')
    expect(gradeFor(0)).toBe('D')
  })

  it('treats a non-finite star count as no stars', () => {
    expect(gradeFor(Number.NaN)).toBe('D')
    expect(gradeFor(Number.POSITIVE_INFINITY)).toBe('D')
  })
})
