/** Letter grade on the results medal for a 0..5 star result (same scale as the rank title). */
export function gradeFor(stars: number): 'S' | 'A' | 'B' | 'C' | 'D' {
  const s = Number.isFinite(stars) ? stars : 0
  if (s >= 4.75) return 'S'
  if (s >= 4) return 'A'
  if (s >= 3) return 'B'
  if (s >= 2) return 'C'
  return 'D'
}
