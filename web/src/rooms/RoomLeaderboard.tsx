import { formatScore } from '../game/results'
import { loadSeat, rankPlayers } from './client'
import { roomRoundFor } from './gameLink'
import { LiveBoard } from './Standings'
import { useNow, useRoom } from './useRoom'
import './rooms.css'

/**
 * In-game overlay for a room round of `routineId` (renders nothing in solo play): "everyone
 * starts in N" until the shared song start, then the live top 5 (one summary line on phones),
 * then the final standings with a way back to the room. Mount it inside the play stage.
 */
export default function RoomLeaderboard({ routineId }: { routineId: unknown }) {
  // includeDone: the standings stay up after the final score closes the round.
  const round = roomRoundFor(routineId, true)
  return round ? <Overlay key={`${round.code}:${round.serverStartAt}`} code={round.code} songAt={round.songAt} /> : null
}

const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

function Overlay({ code, songAt }: { code: string; songAt: number }) {
  const seat = loadSeat(code)
  const { room } = useRoom(code, seat?.token ?? null)
  const now = useNow(250)
  const waiting = songAt - now
  const finished = room?.state === 'finished'
  const ranked = room ? rankPlayers(room.players) : []
  const myRank = ranked.findIndex((p) => p.id === seat?.playerId) + 1
  const me = ranked[myRank - 1]
  const leader = ranked[0]
  return (
    <aside className="rm-overlay df-card-sm" aria-label={`Room ${code}`}>
      <div className="df-spread rm-overlay-head">
        <span className="df-label">Room {code}</span>
        <a className="df-btn df-btn-ghost df-btn-sm" href={`#/room?code=${code}`}>
          {finished ? 'Back to the room' : 'Room'}
        </a>
      </div>
      {waiting > 0 ? (
        <p className="rm-overlay-wait" role="timer" aria-live="polite">
          Everyone starts together in <span className="df-num">{Math.ceil(waiting / 1000)}</span>
        </p>
      ) : (
        me && (
          <p className="rm-overlay-line">
            {finished ? 'Final: ' : ''}
            <b>{ordinal(myRank)}</b> of {ranked.length} · <span className="df-num">{formatScore(me.score)}</span>
            {leader && leader.id !== me.id && <span className="df-note"> · {leader.name} leads</span>}
          </p>
        )
      )}
      {finished && <p className="df-voice rm-overlay-board">Final standings</p>}
      {room && (
        <div className="rm-overlay-board">
          <LiveBoard players={room.players} meId={seat?.playerId} max={5} compact />
        </div>
      )}
    </aside>
  )
}
