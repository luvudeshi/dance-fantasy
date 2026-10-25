import { Avatar } from './AccountChip'
import { dismissInvite, useAccount } from './store'
import './account.css'

/** Where "Join" goes by default: the rooms page's join link (shared/README.md suggests #/room?code=). */
const joinHash = (code: string): string => `#/room?code=${encodeURIComponent(code)}`

/**
 * "Maya invited you to room ABCD · Join". Mount once, globally: it also keeps the session and the
 * invite poll alive. `onJoin` defaults to opening #/room?code=<code>.
 */
export function InviteToast({ onJoin }: { onJoin?: (roomCode: string) => void }) {
  const { invites, room } = useAccount()
  // the newest invite, except to the room you're already in
  const invite = invites.find((i) => i.roomCode !== room)
  return (
    <div aria-live="polite" className="df-notice-region acct-toast-region">
      {invite && (
        <div key={invite.id} role="status" className="df-notice acct-toast">
          <Avatar icon={invite.fromAvatar} color={invite.fromColor} size="sm" />
          <span className="acct-toast-text">
            <b>{invite.fromName}</b> invited you to room{' '}
            <span className="acct-code" translate="no">
              {invite.roomCode}
            </span>
          </span>
          <button
            type="button"
            className="df-btn df-btn-primary df-btn-sm"
            onClick={() => {
              void dismissInvite(invite.id)
              if (onJoin) onJoin(invite.roomCode)
              else window.location.hash = joinHash(invite.roomCode)
            }}
          >
            Join
          </button>
          <button
            type="button"
            className="df-btn df-btn-icon df-btn-sm"
            aria-label={`Dismiss ${invite.fromName}'s invite`}
            onClick={() => void dismissInvite(invite.id)}
          >
            <svg viewBox="0 0 20 20" className="df-glyph" aria-hidden="true">
              <path d="M5 5 L15 15 M15 5 L5 15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
