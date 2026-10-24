import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { getHealth } from './api'
import { errorMessage, isAbortError } from './lib/errors'

const PoseSpike = lazy(() => import('./pages/PoseSpike'))
const BeatSpike = lazy(() => import('./pages/BeatSpike'))

const ROUTES = [
  { hash: '#/pose', label: 'Pose spike' },
  { hash: '#/beats', label: 'Beat spike' },
] as const
type RouteHash = (typeof ROUTES)[number]['hash']
const DEFAULT_ROUTE: RouteHash = '#/pose'

const HEALTH_POLL_MS = 5000
/** While offline, back off 5 -> 10 -> 15 s (fewer 502s in the console); re-check on focus. */
const HEALTH_POLL_OFFLINE_MAX_MS = 15000
const HEALTH_TIMEOUT_MS = 3000

function currentRoute(): RouteHash {
  return ROUTES.find((r) => r.hash === window.location.hash)?.hash ?? DEFAULT_ROUTE
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function useHashRoute(): RouteHash {
  const route = useSyncExternalStore(subscribeHash, currentRoute)
  useEffect(() => {
    if (window.location.hash !== route) window.history.replaceState(null, '', route)
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
  const healthLabel = health.state === 'ok' ? 'server ok' : health.state === 'offline' ? 'server offline' : 'checking…'
  const healthTitle =
    health.state === 'ok' ? `API version ${health.version}` : health.state === 'offline' ? health.reason : undefined

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          Midnight Ball <span className="dim">· dev spikes</span>
        </h1>
        <nav>
          {ROUTES.map((r) => (
            <a key={r.hash} href={r.hash} className={r.hash === route ? 'active' : undefined}>
              {r.label}
            </a>
          ))}
        </nav>
        <span className={`health ${health.state}`} title={healthTitle}>
          <span className="dot" aria-hidden="true" />
          {healthLabel}
        </span>
      </header>
      <main>
        <Suspense fallback={<p className="status">Loading…</p>}>
          {route === '#/beats' ? <BeatSpike /> : <PoseSpike />}
        </Suspense>
      </main>
    </div>
  )
}
