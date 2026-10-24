/** Human-readable message for anything thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** True for the rejection produced by an aborted AbortSignal / fetch / play(). */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && err.name === 'AbortError'
}

/** The error an aborted signal carries (its reason when it is an Error, else an AbortError). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError')
}
