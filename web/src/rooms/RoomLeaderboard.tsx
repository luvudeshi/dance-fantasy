import { loadSeat } from './client'
import { roomRoundFor } from './gameLink'
import { CrewHud, SyncBurst, VersusHud } from './modes/ModeHud'
import { modeLine } from './modes/modeStats'
import { useNow, useRoom } from './useRoom'
import './rooms.css'

/**
 * In-game overlay for a room round of `routineId` (renders nothing in solo play): "everyone
 * starts in N" until the shared song start, then the room's mode HUD (crew: team score and sync
 * streak; versus: beats won and the leader's crown; one summary line on phones), then the final
 * numbers with a way back to the room. Mount it inside the play stage; `inline` puts it in the
 * flow instead (the results card).
 */
export default function RoomLeaderboard({ routineId, inline = false }: { routineId: unknown; inline?: boolean }) {
  // includeDone: the standings stay up after the final score closes the round.
  const round = roomRoundFor(routineId, true)
  return round ? <Overlay key={`${round.code}:${round.serverStartAt}`} code={round.code} songAt={round.songAt} inline={inline} /> : null
}

function Overlay({ code, songAt, inline }: { code: string; songAt: number; inline: boolean }) {
  const seat = loadSeat(code)
  const { room } = useRoom(code, seat?.token ?? null)
  const now = useNow(250)
  const waiting = songAt - now
  const finished = room?.state === 'finished'
  const meId = seat?.playerId ?? null
  return (
    <>
    <aside className={`rm-overlay df-card-sm${inline ? ' rm-overlay-inline' : ''}`} aria-label={`Room ${code}`}>
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
        room && (
          <p className={`rm-overlay-line${room.mode === 'crew' ? ' dfm-phone-only' : ''}`}>
            {finished ? 'Final: ' : ''}
            {modeLine(room, meId)}
          </p>
        )
      )}
      {room && (
        <div className="rm-overlay-board">
          {room.mode === 'crew' ? <CrewHud crew={room.crew} players={room.players} /> : <VersusHud room={room} meId={meId} />}
        </div>
      )}
    </aside>
    {!inline && room?.mode === 'crew' && room.state === 'playing' && <SyncBurst crew={room.crew} />}
    </>
  )
}
