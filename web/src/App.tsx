import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { getHealth } from './api'
import { teachHash } from './game/flow'
import { loadShelf, SHELF_KEY } from './game/routineShelf'
import { errorMessage, isAbortError } from './lib/errors'
import { isRoutineId, parseHash } from './lib/hashRoute'
import { InviteToast } from './account/InviteToast'
import { usePartyCount } from './party/usePartyCount'
import { useSettings } from './settings'
import { ShellBar, type ServerState } from './shell/ShellBar'

const Play = lazy(() => import('./pages/Play'))
const PoseSpike = lazy(() => import('./pages/PoseSpike'))
const BeatSpike = lazy(() => import('./pages/BeatSpike'))
const AnalysisDebug = lazy(() => import('./pages/AnalysisDebug'))
const MoveGallery = lazy(() => import('./pages/MoveGallery'))

const Teach = lazy(() => import('./pages/Teach'))
const Menu = lazy(() => import('./shell/Menu'))
const SettingsPage = lazy(() => import('./shell/SettingsPage'))
const HowToPlay = lazy(() => import('./shell/HowToPlay'))
const Credits = lazy(() => import('./shell/Credits'))
const StyleGuide = lazy(() => import('./theme/StyleGuide'))
const RoomPage = lazy(() => import('./rooms/RoomPage'))
const AiPreview = lazy(() => import('./announcer/AiPreview'))
const PartyPlay = lazy(() => import('./party/PartyPlay'))
const PartyHarness = lazy(() => import('./party/PartyHarness'))
const ProfilePage = lazy(() => import('./account/ProfilePage'))
const FriendsPage = lazy(() => import('./account/FriendsPage'))

/**
 * Every page. `shell`: a full-page Dance Fantasy screen (else the legacy .app column);
 * `bar`: the sticky header shows (with `title` beside the brand); `esc`: Esc goes back to the menu.
 * Dev pages (#/pose, #/beats, #/ui, #/ai, #/party-dev) are linked from Settings > Developer.
 */
const ROUTES = [
  { hash: '#/', shell: true, bar: false, esc: false },
  { hash: '#/play', shell: false, bar: true, esc: false, title: 'The Ballroom' },
  { hash: '#/teach', shell: false, bar: true, esc: false, title: 'Dance lesson' },
  { hash: '#/analysis', shell: false, bar: true, esc: false, title: 'Studio' },
  { hash: '#/moves', shell: false, bar: true, esc: false },
  { hash: '#/settings', shell: true, bar: true, esc: true },
  { hash: '#/how', shell: true, bar: true, esc: true },
  { hash: '#/credits', shell: true, bar: true, esc: true },
  { hash: '#/pose', shell: false, bar: true, esc: false, title: 'Pose spike' },
  { hash: '#/beats', shell: false, bar: true, esc: false, title: 'Beat spike' },
  { hash: '#/ui', shell: true, bar: false, esc: true },
  { hash: '#/room', shell: true, bar: true, esc: false },
  { hash: '#/join', shell: true, bar: true, esc: false },
  { hash: '#/ai', shell: true, bar: false, esc: true },
  { hash: '#/profile', shell: true, bar: true, esc: true },
  { hash: '#/friends', shell: true, bar: true, esc: true },
  { hash: '#/party-dev', shell: false, bar: true, esc: false, title: 'Party harness' },
] as const
type RouteHash = (typeof ROUTES)[number]['hash']
const DEFAULT_ROUTE: RouteHash = '#/'

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
  // App's route store follows the hash path only; "#/play?party=N" needs the query too.
  const party = usePartyCount()
  const health = useServerHealth()
  const learn = useSyncExternalStore(subscribeLearn, learnTarget)
  const { reducedMotion } = useSettings()
  const page = ROUTES.find((r) => r.hash === route) ?? ROUTES[0]
  const server: ServerState = {
    state: health.state,
    detail: health.state === 'ok' ? `API version ${health.version}` : health.state === 'offline' ? health.reason : undefined,
  }

  // Settings > Calm motion (CSS in shell/shell.css), on top of the device's prefers-reduced-motion.
  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduced-motion', reducedMotion)
  }, [reducedMotion])

  // Esc on a shell page goes back to the menu (an open dialog takes Esc first).
  useEffect(() => {
    if (!page.esc) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return
      window.location.hash = '#/'
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page.esc])

  const content = (
    <Suspense fallback={<p className="status shell-loading">Loading…</p>}>
      {route === '#/' ? (
        <Menu learn={learn} server={server} />
      ) : route === '#/play' ? (
        party ? <PartyPlay count={party} /> : <Play />
      ) : route === '#/party-dev' ? (
        <PartyHarness />
      ) : route === '#/profile' ? (
        <ProfilePage />
      ) : route === '#/friends' ? (
        <FriendsPage />
      ) : route === '#/teach' ? (
        <Teach />
      ) : route === '#/pose' ? (
        <PoseSpike />
      ) : route === '#/beats' ? (
        <BeatSpike />
      ) : route === '#/settings' ? (
        <SettingsPage />
      ) : route === '#/how' ? (
        <HowToPlay />
      ) : route === '#/credits' ? (
        <Credits />
      ) : route === '#/ui' ? (
        <StyleGuide />
      ) : route === '#/room' || route === '#/join' ? (
        <RoomPage />
      ) : route === '#/ai' ? (
        <AiPreview />
      ) : route === '#/analysis' ? (
        <AnalysisDebug />
      ) : (
        <MoveGallery />
      )}
    </Suspense>
  )

  return (
    <>
      {page.bar && <ShellBar server={server} title={'title' in page ? page.title : undefined} />}
      {page.shell ? (
        <main>{content}</main>
      ) : (
        <div className="app">
          <main className="shell-main">{content}</main>
        </div>
      )}
      <InviteToast />
    </>
  )
}
