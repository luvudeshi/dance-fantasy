// Arrow-key focus movement for the title menu (pure, unit-tested).

/**
 * The menu entry focus moves to when `key` is pressed with entry `current` focused (-1: none of
 * them). Arrows wrap around; null for keys the menu doesn't handle.
 */
export function menuStep(current: number, count: number, key: string): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return current < 0 ? 0 : (current + 1) % count
    case 'ArrowUp':
    case 'ArrowLeft':
      return current < 0 ? count - 1 : (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
