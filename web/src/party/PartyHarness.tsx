// Dev page "#/party-dev": party mode without a room full of dancers. Synthetic dancers (bots placed
// side by side in a fake camera image, see synthetic.ts) feed the real tracker, scoring and UI.
//   #/party-dev?view=setup     the setup sheet with a live mirror
//   #/party-dev?view=game&t=20 the stage with the party overlay (t: song second to start at)
//   #/party-dev?view=results   the podium after a simulated full song
// ?party=2..4 sets the number of dancers (default 3).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Difficulty, Routine } from '@shared/routine'
import routineJson from '../game/__fixtures__/routine_synth120_normal.json'
import { buildGameTimeline } from '../game/cues'
import { renderPlayFrame } from '../game/render'
import { buildCheckpoints, DEFAULT_SCORING } from '../game/scoring'
import { prepareCanvas } from '../lib/canvas'
import { parseHash } from '../lib/hashRoute'
import type { MoveSource } from '../routine/moveSource'
import { buildMotionTrack } from '../routine/track'
import '../pages/play.css'
import PartyHud from './PartyHud'
import { PartyRun } from './partyRun'
import PartyResults from './PartyResults'
import PartySetup from './PartySetup'
import { clampCount, DEFAULT_PARTY, partyPlayers, type PartyPlayer } from './players'
import { SyntheticPeopleFeed, type SyntheticDancer } from './synthetic'
import { PartyTracker } from './tracker'

const routine = routineJson as unknown as Routine
const track = buildMotionTrack(routine)
const timeline = buildGameTimeline(routine)
const SONGS = [{ file: 'synth', title: routine.song.title, sizeBytes: 0 }]

const DANCERS: SyntheticDancer[] = [
  { skill: 'perfect', screenX: 0.16, swayPx: 10 },
  { skill: 'good', screenX: 0.39, swayPx: 14 },
  { skill: 'sloppy', screenX: 0.62, swayPx: 8, away: [[30, 33]] },
  { skill: 'mirrored', screenX: 0.85, swayPx: 10 },
]

function params(): { view: string; t: number; count: number } {
  const { params: p } = parseHash(window.location.hash)
  const t = Number(p.get('t') ?? '20')
  return { view: p.get('view') ?? 'setup', t: Number.isFinite(t) ? t : 20, count: clampCount(Number(p.get('party') ?? DEFAULT_PARTY)) }
}

/** Replays the feed from song second `from` in real time (looping over the song). */
function useSyntheticClock(feed: SyntheticPeopleFeed, from: number): { songTime(): number } {
  const clock = useMemo(() => {
    let t0: number | null = null
    const dur = routine.song.durationSec
    return {
      songTime: (): number => {
        const now = performance.now()
        t0 ??= now
        return (from + (now - t0) / 1000) % dur
      },
    }
  }, [from])
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      feed.emit(clock.songTime())
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [feed, clock])
  return clock
}

function SetupView({ count }: { count: number }) {
  const feed = useMemo(() => new SyntheticPeopleFeed(track, DANCERS.slice(0, Math.max(0, count - 1))), [count])
  const tracker = useMemo(() => new PartyTracker(feed, count), [feed, count])
  useEffect(() => tracker.attach(), [tracker])
  const [players, setPlayers] = useState<PartyPlayer[]>(() => partyPlayers(count))
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const [moveSource, setMoveSource] = useState<MoveSource>('mix')
  useSyntheticClock(feed, 12)
  return (
    <PartySetup
      players={players}
      onPlayers={setPlayers}
      onCount={(n) => setPlayers(partyPlayers(n))}
      tracker={tracker}
      songs={SONGS}
      song="synth"
      onSong={() => undefined}
      difficulty={difficulty}
      onDifficulty={setDifficulty}
      moveSource={moveSource}
      onMoveSource={setMoveSource}
      realDancers={null}
      onStart={() => undefined}
    />
  )
}

function GameView({ count, from }: { count: number; from: number }) {
  const feed = useMemo(() => new SyntheticPeopleFeed(track, DANCERS.slice(0, count)), [count])
  const tracker = useMemo(() => new PartyTracker(feed, count), [feed, count])
  useEffect(() => tracker.attach(), [tracker])
  const run = useMemo(
    () => new PartyRun({ tracker, players: partyPlayers(count), checkpoints: buildCheckpoints(routine, routine.mode), config: DEFAULT_SCORING, isPlaying: () => true }),
    [tracker, count],
  )
  const clock = useSyntheticClock(feed, from)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const p = prepareCanvas(canvas, 1.5)
      if (p) renderPlayFrame(p.ctx, p.width, p.height, { t: clock.songTime(), routine, track, timeline, durationSec: routine.song.durationSec, mirrored: true })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [clock])
  return (
    <div className="df-screen">
      <div className="play-stage">
        <canvas ref={canvasRef} className="play-canvas" aria-label="Dance stage" />
        <header className="play-topbar">
          <div className="play-title">
            <span className="play-song">{routine.song.title}</span>
            <span className="play-meta">Party harness · synthetic dancers</span>
          </div>
        </header>
        <PartyHud run={run} tracker={tracker} clock={clock} />
      </div>
    </div>
  )
}

function ResultsView({ count }: { count: number }) {
  const standings = useMemo(() => {
    const feed = new SyntheticPeopleFeed(track, DANCERS.slice(0, count))
    const tracker = new PartyTracker(feed, count)
    tracker.attach()
    const run = new PartyRun({ tracker, players: partyPlayers(count), checkpoints: buildCheckpoints(routine, routine.mode), config: DEFAULT_SCORING, isPlaying: () => true, now: () => 0 })
    for (let k = 0; k <= routine.song.durationSec * 30; k++) {
      feed.emit(k / 30)
      run.tick(k / 30)
    }
    return run.finish(routine, routine.song.durationSec)
  }, [count])
  return <PartyResults standings={standings} songTitle={routine.song.title} onAgain={() => undefined} onSetup={() => undefined} />
}

export default function PartyHarness() {
  const [p, setP] = useState(params)
  useEffect(() => {
    const on = (): void => setP(params())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  if (p.view === 'game') return <GameView key={`${p.count}-${p.t}`} count={p.count} from={p.t} />
  if (p.view === 'results') return <ResultsView count={p.count} />
  return <SetupView key={p.count} count={p.count} />
}
