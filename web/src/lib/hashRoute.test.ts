import { describe, expect, it } from 'vitest'
import { isRoutineId, parseHash, playRoutineHash, routineFromHash } from './hashRoute'

describe('hash routes', () => {
  it('splits the path from the query', () => {
    expect(parseHash('#/play').path).toBe('#/play')
    const r = parseHash('#/play?routine=0123456789abcdef&x=1')
    expect(r.path).toBe('#/play')
    expect(r.params.get('routine')).toBe('0123456789abcdef')
    expect(r.params.get('x')).toBe('1')
    expect(parseHash('').path).toBe('')
  })

  it('reads a well-formed routine id only', () => {
    expect(routineFromHash(playRoutineHash('0123456789abcdef'))).toBe('0123456789abcdef')
    expect(routineFromHash('#/play')).toBeNull()
    expect(routineFromHash('#/play?routine=XYZ')).toBeNull()
    expect(routineFromHash('#/play?routine=0123456789ABCDEF')).toBeNull()
    // Only Play's deep link: the teach page's query must not launch the game on Play.
    expect(routineFromHash('#/teach?routine=0123456789abcdef&start=3')).toBeNull()
    expect(isRoutineId('0123456789abcde')).toBe(false)
    expect(isRoutineId(42)).toBe(false)
  })
})
