import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { getHealth } from './api'
import { teachHash } from './game/flow'
import { loadShelf, SHELF_KEY } from './game/routineShelf'
import { errorMessage, isAbortError } from './lib/errors'
import { isRoutineId, parseHash } from './lib/hashRoute'

const Play = lazy(() => import('./pages/Play'))
const PoseSpike = lazy(() => import('./pages/PoseSpike'))
const BeatSpike = lazy(() => import('./pages/BeatSpike'))
const AnalysisDebug = lazy(() => import('./pages/AnalysisDebug'))
const MoveGallery = lazy(() => import('./pages/MoveGallery'))

const Teach = lazy(() => import('./pages/Teach'))

/** Main nav (Learn is shown separately, only when a routine is known). */
const MAIN_ROUTES = [
  { hash: '#/play', label: '▶ Play' },
  { hash: '#/analysis', label: 'Studio' },
  { hash: '#/moves', label: 'Moves' },
] as const
const DEV_ROUTES = [
  { hash: '#/pose', label: 'Pose spike' },
  { hash: '#/beats', label: 'Beat spike' },
] as const
const ROUTES = [...MAIN_ROUTES, { hash: '#/teach', label: 'Learn' }, ...DEV_ROUTES] as const
type RouteHash = (typeof ROUTES)[number]['hash']
const DEFAULT_ROUTE: RouteHash = '#/play'

const HEALTH_POLL_MS = 5000
/** While offline, back off 5 -> 10 -> 15 s (fewer 502s in the console); re-check on focus. */
const HEALTH_POLL_OFFLINE_MAX_MS = 15000
const HEALTH_TIMEOUT_MS = 3000

/** The page for the hash path; a query ("#/play?routine=…") is the page's business. */
function currentRoute(): RouteHash {
  const { path } = parseHash(window.location.hash)
  return ROUTES.find((r) => r.hash === path)?.hash ?? DEFAULT_ROUTE
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/**
 * Where the Learn link goes: the routine in the current hash (the teach page itself), else the
 * most recent one on the shelf; null hides the link. Re-read on hash / shelf changes and focus.
 */
function learnTarget(): string | null {
  const { path, params } = parseHash(window.location.hash)
  const id = params.get('routine')
  if (path === '#/teach' && isRoutineId(id)) return window.location.hash
  const last = loadShelf()[0]?.routineId
  return last ? teachHash(last) : null
}

function subscribeLearn(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key === SHELF_KEY || e.key === null) onChange()
  }
  window.addEventListener('hashchange', onChange)
  window.addEventListener('focus', onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener('hashchange', onChange)
    window.removeEventListener('focus', onChange)
    window.removeEventListener('storage', onStorage)
  }
}

function useHashRoute(): RouteHash {
  const route = useSyncExternalStore(subscribeHash, currentRoute)
  useEffect(() => {
    if (parseHash(window.location.hash).path !== route) window.history.replaceState(null, '', route)
  }, [route])
  return route
}

type Health = { state: 'checking' } | { state: 'ok'; version: string } | { state: 'offline'; reason: string }

/**
 * Polls GET /api/health every 5 s while the server is up, backing off to 15 s while it is
 * down (and re-checking right away when the window regains focus). Polling cadence only;
 * no app timing depends on it.
 */
function useServerHealth(): Health {
  const [health, setHealth] = useState<Health>({ state: 'checking' })
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inflight: AbortController | null = null
    let failures = 0
    const poll = async (): Promise<void> => {
      clearTimeout(timer)
      const ctrl = new AbortController()
      inflight = ctrl
      const timeout = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS)
      try {
        const h = await getHealth(ctrl.signal)
        failures = h.status === 'ok' ? 0 : failures + 1
        if (!cancelled) setHealth(h.status === 'ok' ? { state: 'ok', version: h.version } : { state: 'offline', reason: h.status })
      } catch (err) {
        failures++
        if (!cancelled) setHealth({ state: 'offline', reason: isAbortError(err) ? 'health check timed out' : errorMessage(err) })
      } finally {
        clearTimeout(timeout)
        inflight = null
        const delay = failures === 0 ? HEALTH_POLL_MS : Math.min(HEALTH_POLL_OFFLINE_MAX_MS, HEALTH_POLL_MS * failures)
        if (!cancelled) timer = setTimeout(() => void poll(), delay)
      }
    }
    const onFocus = (): void => {
      if (failures > 0 && inflight === null && !cancelled) void poll()
    }
    window.addEventListener('focus', onFocus)
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      inflight?.abort()
      window.removeEventListener('focus', onFocus)
    }
  }, [])
  return health
}

export default function App() {
  const route = useHashRoute()
  const health = useServerHealth()
  const learn = useSyncExternalStore(subscribeLearn, learnTarget)
  const devActive = DEV_ROUTES.some((r) => r.hash === route)
  const healthLabel = health.state === 'ok' ? 'server ok' : health.state === 'offline' ? 'server offline' : 'checking…'
  const healthTitle =
    health.state === 'ok' ? `API version ${health.version}` : health.state === 'offline' ? health.reason : undefined

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" href="#/play" aria-label="Midnight Ball: play">
          <span className="brand-moon" aria-hidden="true">
            ☾
          </span>
          <span className="brand-name">Midnight Ball</span>
        </a>
        <nav aria-label="Main">
          {MAIN_ROUTES.map((r) => (
            <a key={r.hash} href={r.hash} className={r.hash === route ? 'active' : undefined}>
              {r.label}
            </a>
          ))}
          {(learn || route === '#/teach') && (
            <a href={learn ?? '#/teach'} className={route === '#/teach' ? 'active' : undefined} title="Learn your latest routine move by move">
              🎓 Learn
            </a>
          )}
        </nav>
        <details className={`dev-menu${devActive ? ' active' : ''}`}>
          <summary>dev</summary>
          <div className="dev-menu-list">
            {DEV_ROUTES.map((r) => (
              <a
                key={r.hash}
                href={r.hash}
                className={r.hash === route ? 'active' : undefined}
                onClick={(e) => e.currentTarget.closest('details')?.removeAttribute('open')}
              >
                {r.label}
              </a>
            ))}
          </div>
        </details>
        <span className={`health ${health.state}`} title={healthTitle}>
          <span className="dot" aria-hidden="true" />
          {healthLabel}
        </span>
      </header>
      <main>
        <Suspense fallback={<p className="status">Loading…</p>}>
          {route === '#/play' ? (
            <Play />
          ) : route === '#/teach' ? (
            <Teach />
          ) : route === '#/pose' ? (
            <PoseSpike />
          ) : route === '#/beats' ? (
            <BeatSpike />
          ) : route === '#/analysis' ? (
            <AnalysisDebug />
          ) : (
            <MoveGallery />
          )}
        </Suspense>
      </main>
    </div>
  )
}
