import { describe, expect, it } from 'vitest'
import { menuStep } from './menuNav'

describe('menuStep', () => {
  it('moves forward and back, wrapping around', () => {
    expect(menuStep(0, 3, 'ArrowDown')).toBe(1)
    expect(menuStep(2, 3, 'ArrowDown')).toBe(0)
    expect(menuStep(1, 3, 'ArrowRight')).toBe(2)
    expect(menuStep(0, 3, 'ArrowUp')).toBe(2)
    expect(menuStep(2, 3, 'ArrowLeft')).toBe(1)
  })

  it('enters the menu from outside it at the near end', () => {
    expect(menuStep(-1, 4, 'ArrowDown')).toBe(0)
    expect(menuStep(-1, 4, 'ArrowUp')).toBe(3)
  })

  it('jumps to the ends with Home / End', () => {
    expect(menuStep(2, 5, 'Home')).toBe(0)
    expect(menuStep(2, 5, 'End')).toBe(4)
  })

  it('ignores other keys and empty menus', () => {
    expect(menuStep(0, 3, 'Enter')).toBeNull()
    expect(menuStep(0, 3, 'a')).toBeNull()
    expect(menuStep(-1, 0, 'ArrowDown')).toBeNull()
  })
})
