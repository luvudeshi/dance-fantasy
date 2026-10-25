// Dev page for room modes (web/modes-lab.html, dev server only): the real rooms UI (RoomPage) plus a
// stand-in for the game at #/play, where window.dfLab feeds judged beats and scores through gameLink
// exactly as Play.tsx will. Used by the Playwright check; open two tabs to try it by hand.
// ponytail: delete once App.tsx routes #/room and Play.tsx reports beats.

import { StrictMode, useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHash } from '../../lib/hashRoute'
import { StickerDefs } from '../../theme/StickerDefs'
import { loadSeat, roomWrites } from '../client'
import { reportRoomBeat, reportScore } from '../gameLink'
import RoomLeaderboard from '../RoomLeaderboard'
import RoomPage from '../RoomPage'
import type { Grade } from './api'
import '../../theme/tokens.css'
import '../../theme/base.css'
import '../../theme/sticker.css'
import '../../theme/controls.css'
import '../../theme/pieces.css'

/** Any well-formed ids do: the rooms API doesn't look the routine up. */
const LAB_ROUTINE = { routineId: '0123456789abcdef', analysisId: 'ab'.repeat(32), title: 'Lab song', difficulty: 'normal', mode: 'standing' } as const

declare global {
  interface Window {
    dfLab?: {
      pickLabSong: (code: string) => Promise<unknown>
      reportBeat: (beat: number, score: number, grade: Grade) => void
      score: (score: number, accuracy: number, finished: boolean) => void
    }
  }
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** Stand-in for pages/Play.tsx during a room round. */
function LabStage({ routineId }: { routineId: string }) {
  useEffect(() => {
    if (!window.dfLab) return
    window.dfLab.reportBeat = (beat, score, grade) => reportRoomBeat(routineId, beat, score, grade)
    window.dfLab.score = (score, accuracy, finished) =>
      reportScore(routineId, { score, combo: 0, maxCombo: 0, accuracy, progress: finished ? 1 : 0.5, finished })
  }, [routineId])
  return (
    <div className="df-screen" style={{ padding: 16 }}>
      <div className="df-mirror df-st-live">
        <div className="df-mirror-glass df-mirror-night" style={{ minHeight: 'calc(100dvh - 56px)' }}>
          <p className="df-voice" style={{ color: 'var(--df-on-night)', fontSize: '1.6rem' }}>
            The coach dances here
          </p>
        </div>
      </div>
      <RoomLeaderboard routineId={routineId} />
    </div>
  )
}

export function Lab() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  const { path, params } = parseHash(hash)
  const routineId = params.get('routine')
  return path === '#/play' && routineId ? <LabStage routineId={routineId} /> : <RoomPage />
}

window.dfLab = {
  pickLabSong: (code) => {
    const seat = loadSeat(code)
    return seat ? roomWrites.routine(code, seat.token, LAB_ROUTINE) : Promise.reject(new Error('no seat in this tab'))
  },
  reportBeat: () => undefined,
  score: () => undefined,
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <StickerDefs />
    <Lab />
  </StrictMode>,
)
