import { useEffect, useState, type ChangeEvent, type CSSProperties } from 'react'
import type { Analysis } from '@shared/analysis'
import type { Difficulty, Mode } from '@shared/routine'
import { analyzeLibrarySong, analyzeUpload, choreograph, listSongs, type SongInfo } from '../api'
import { loadShelf } from '../game/routineShelf'
import { errorMessage, isAbortError } from '../lib/errors'
import { isRoutineId } from '../lib/hashRoute'
import { AIST_CREDIT, MOVE_SOURCES, moveSourceSuffix } from '../routine/moveSource'
import { moveSourceHint, useMoveSource } from '../routine/useMoveSource'
import { Icon } from '../theme/Icon'
import { Segmented } from '../theme/components'
import type { RoomRoutine } from './client'

// Host only: choose the room's routine from a library song, an upload (analyzed, then
// choreographed here) or one of "Your routines" on this device.

const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
] as const satisfies readonly { value: Difficulty; label: string }[]

const MODES = [
  { value: 'standing', label: 'Standing' },
  { value: 'seated', label: 'Seated' },
] as const satisfies readonly { value: Mode; label: string }[]

const randomSeed = (): number => Math.floor(Math.random() * 1_000_000)

export default function RoutinePicker({ current, onPick, disabled }: { current: RoomRoutine | null; onPick: (r: RoomRoutine) => Promise<void>; disabled: boolean }) {
  const [songs, setSongs] = useState<SongInfo[] | null>(null)
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const [mode, setMode] = useState<Mode>('standing')
  const moves = useMoveSource()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shelf] = useState(() => loadShelf().slice(0, 4))

  useEffect(() => {
    const ac = new AbortController()
    listSongs(ac.signal).then(setSongs, (err: unknown) => {
      if (!isAbortError(err)) setError(`Couldn't load the songs: ${errorMessage(err)}`)
    })
    return () => ac.abort()
  }, [])

  const run = async (label: string, work: () => Promise<RoomRoutine>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await onPick(await work())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  /** analysis -> a fresh routine with this setup (a new seed each pick). */
  const fromAnalysis = async (analysis: Analysis): Promise<RoomRoutine> => {
    setBusy('Choreographing…')
    const { routine } = await choreograph({ analysisId: analysis.id, difficulty, mode, seed: randomSeed(), moveSource: moves.value })
    const routineId = routine.meta?.routineId
    if (!isRoutineId(routineId)) throw new Error('The server did not return a saved routine id')
    return { routineId, analysisId: analysis.id, title: analysis.title.slice(0, 200) || 'Untitled song', difficulty, mode }
  }

  const pickSong = (s: SongInfo): Promise<void> => run('Listening to the song…', async () => fromAnalysis(await analyzeLibrarySong(s.file)))

  const onUpload = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) void run('Listening to your song…', async () => fromAnalysis(await analyzeUpload(file)))
  }

  const off = disabled || busy !== null
  return (
    <div className="df-stack rm-picker" style={{ '--df-gap': '14px' } as CSSProperties}>
      <div className="df-cluster" style={{ '--df-gap': '10px' } as CSSProperties}>
        <Segmented label="Difficulty" value={difficulty} options={DIFFICULTIES} onChange={setDifficulty} disabled={off} />
        <Segmented label="Mode" value={mode} options={MODES} onChange={setMode} disabled={off} />
        <Segmented label="Moves from" value={moves.value} options={MOVE_SOURCES} onChange={moves.choose} disabled={off || moves.realDancers === false} />
      </div>
      <p className="df-note">
        Moves from {MOVE_SOURCES.find((m) => m.value === moves.value)?.label}: {moveSourceHint(moves.value, moves.realDancers)}
        {moves.value !== 'classic' && <span className="rm-credit"> {AIST_CREDIT}</span>}
      </p>
      {busy && (
        <p className="df-notice rm-busy" role="status">
          <Icon name="music-note" size="sm" cut="none" className="df-bob-fast" />
          <span>{busy}</span>
        </p>
      )}
      {error && <p className="df-error">{error}</p>}
      <ul className="df-list rm-songs" aria-label="Songs">
        {songs === null && !error && <li className="df-note">Tuning the orchestra…</li>}
        {songs?.map((s) => (
          <li key={s.file}>
            <button
              type="button"
              className="df-item"
              disabled={off}
              aria-pressed={current?.title === s.title}
              onClick={() => void pickSong(s)}
            >
              <Icon name="music-note" size="sm" cut="sm" className="df-item-icon" />
              <span className="df-item-body">
                <span className="df-item-title">{s.title}</span>
                <span className="df-item-meta">Library song</span>
              </span>
            </button>
          </li>
        ))}
        {shelf.map((e) => (
          <li key={e.routineId}>
            <button
              type="button"
              className="df-item"
              disabled={off}
              aria-pressed={current?.routineId === e.routineId}
              onClick={() => void run('Choosing…', async () => ({ routineId: e.routineId, analysisId: e.analysisId, title: e.title, difficulty: e.difficulty, mode: e.mode }))}
            >
              <Icon name="scroll" size="sm" cut="sm" className="df-item-icon" />
              <span className="df-item-body">
                <span className="df-item-title">{e.title}</span>
                <span className="df-item-meta">
                  Your routine · {e.difficulty} · {e.mode}
                  {moveSourceSuffix(e.moveSource)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <label className={`df-btn df-btn-secondary df-btn-sm rm-upload${off ? ' is-off' : ''}`} aria-disabled={off}>
        <input type="file" accept="audio/*" className="df-sr-only" onChange={onUpload} disabled={off} />
        <Icon name="upload" size="xs" cut="none" />
        Bring your own song
      </label>
    </div>
  )
}
