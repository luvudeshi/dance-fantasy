// The "Moves from" choice as a React hook, for every screen that choreographs (lobby, party setup,
// room host, Settings): the remembered choice, what the server offers (GET /api/moves/sources,
// fetched once per page load and shared), and the source routines actually use.

import { useEffect, useState } from 'react'
import { getMoveSources, type MoveSourcesResponse } from '../api'
import { hasRealDancers, loadMoveSource, MOVE_SOURCES, saveMoveSource, type MoveSource } from './moveSource'

let sources: Promise<MoveSourcesResponse | null> | null = null

/** GET /api/moves/sources once per page load; null when it fails (retried on the next call). */
export function loadMoveSources(): Promise<MoveSourcesResponse | null> {
  sources ??= getMoveSources().then(
    (s) => s,
    () => {
      sources = null
      return null
    },
  )
  return sources
}

/** What a choice turns into: classic when the server is known to have no real-dancer clips. */
export const effectiveMoveSource = (choice: MoveSource, realDancers: boolean | null): MoveSource => (realDancers === false ? 'classic' : choice)

/** The hint under a "Moves from" control. */
export function moveSourceHint(value: MoveSource, realDancers: boolean | null): string {
  if (realDancers === false) return 'Real-dancer moves aren’t installed on this server (see the README), so routines use the classic moves.'
  return MOVE_SOURCES.find((m) => m.value === value)?.hint ?? ''
}

export interface MoveSourceChoice {
  /** What the player picked (remembered on this device). */
  choice: MoveSource
  /** What routines are choreographed from (effectiveMoveSource). */
  value: MoveSource
  /** false: the server has no real-dancer clips; null: not known (yet, offline or an older server). */
  realDancers: boolean | null
  /** Picks and remembers a source. */
  choose: (m: MoveSource) => void
}

export function useMoveSource(): MoveSourceChoice {
  const [choice, setChoice] = useState<MoveSource>(() => loadMoveSource())
  const [realDancers, setRealDancers] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void loadMoveSources().then((s) => {
      if (live) setRealDancers(hasRealDancers(s))
    })
    return () => {
      live = false
    }
  }, [])
  const choose = (m: MoveSource): void => {
    setChoice(m)
    saveMoveSource(m)
  }
  return { choice, value: effectiveMoveSource(choice, realDancers), realDancers, choose }
}
