import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { errorMessage } from '../lib/errors'
import { ApiError } from '../api'
import { Button, Corners, Modal, Notice, Panel, Title } from '../theme/components'
import { Avatar, OnlineDot } from './AccountChip'
import {
  addFriend,
  cleanFriendCode,
  iconLabel,
  inviteFriend,
  isFriendCode,
  listFriends,
  listPartners,
  removeFriend,
  type Friend,
  type Partner,
} from './client'
import { ensureSession, useAccount } from './store'
import './account.css'

// Friends (#/friends): add by friend code, who's online and in which room, invite them to yours,
// and recent dance partners to add back.

const FRIENDS_POLL_MS = 15_000
const gap = (v: string): CSSProperties => ({ '--df-gap': v }) as CSSProperties
const joinHash = (code: string): string => `#/room?code=${encodeURIComponent(code)}`

/** Friendlier words for the add-friend errors (the server's detail otherwise). */
function addError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'No dancer has that code. Check the letters and try again.'
    if (err.status === 400 && /own/i.test(err.message)) return 'That is your own code!'
    if (err.status === 409) return 'You are already friends.'
    if (err.status === 429) return 'Too many tries. Wait a few minutes, then try again.'
  }
  return errorMessage(err)
}

function presence(f: Friend): string {
  if (f.inRoom) return `Dancing in room ${f.inRoom}`
  return f.online ? 'Online' : 'Away'
}

export default function FriendsPage() {
  const { me, room } = useAccount()
  const [friends, setFriends] = useState<Friend[] | null>(null)
  const [partners, setPartners] = useState<Partner[] | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set())
  const [removing, setRemoving] = useState<Friend | null>(null)

  const flash = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400)
  }

  const refresh = useCallback(
    (): Promise<void> =>
      ensureSession()
        .then((ok) => (ok ? Promise.all([listFriends(), listPartners()]) : null))
        .then(
          (lists) => {
            if (!lists) return
            setFriends(lists[0])
            setPartners(lists[1])
            setError(null)
          },
          (err: unknown) => setError(errorMessage(err)),
        ),
    [],
  )

  const meId = me?.id
  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, FRIENDS_POLL_MS)
    return () => clearInterval(t)
  }, [refresh, meId])

  const add = async (raw: string): Promise<void> => {
    const c = cleanFriendCode(raw)
    if (!isFriendCode(c) || busy) {
      setAddErr('Friend codes are 6 letters and numbers, like K7QX2M.')
      return
    }
    setBusy(true)
    setAddErr(null)
    try {
      const f = await addFriend(c)
      setCode('')
      flash(`${f.name} is your friend now.`)
      await refresh()
    } catch (err) {
      setAddErr(addError(err))
    } finally {
      setBusy(false)
    }
  }

  const invite = async (f: Friend, roomCode: string): Promise<void> => {
    try {
      await inviteFriend(f.id, roomCode)
      setInvited((s) => new Set(s).add(f.id))
      flash(`Invited ${f.name} to room ${roomCode}.`)
    } catch (err) {
      flash(errorMessage(err))
    }
  }

  const remove = async (f: Friend): Promise<void> => {
    setRemoving(null)
    try {
      await removeFriend(f.id)
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const strangers = partners?.filter((p) => !p.isFriend) ?? []
  return (
    <div className="df-screen acct-page">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack acct-page-body" style={gap('28px')}>
        <header className="df-stack" style={gap('8px')}>
          <Title variant="large" kicker="Your dance partners">
            Friends
          </Title>
          <p className="df-lede acct-lede">
            Add friends by their code to see who&rsquo;s online and invite them into your room.
          </p>
        </header>

        {error && <Notice inline tone="error" message={error} />}

        <div className="acct-panels">
          <div className="df-stack" style={gap('40px')}>
            <Panel title="Add a friend" kicker="Ask for their 6-letter code" sticker="party">
              <form
                className="acct-name-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  void add(code)
                }}
              >
                <label className="df-label" htmlFor="acct-code">
                  Friend code
                </label>
                <input
                  id="acct-code"
                  className="df-field acct-code-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={9}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="K7QX2M"
                  aria-invalid={addErr ? true : undefined}
                  aria-describedby={addErr ? 'acct-code-err' : undefined}
                />
                <Button type="submit" disabled={busy || cleanFriendCode(code).length === 0}>
                  Add friend
                </Button>
              </form>
              {addErr && (
                <p id="acct-code-err" className="df-error" role="alert">
                  {addErr}
                </p>
              )}
              {me && (
                <p className="df-note acct-note">
                  Your code:{' '}
                  <a href="#/profile" className="acct-code" translate="no">
                    {me.friendCode}
                  </a>
                </p>
              )}
            </Panel>

            <Panel title="Danced with lately" kicker="From rooms in the last 30 days" sticker="dance-shoe">
              {!partners ? (
                <p className="df-note acct-note">Looking through the guest book…</p>
              ) : strangers.length === 0 ? (
                <p className="df-note acct-note">
                  {partners.length ? 'You are friends with everyone you danced with.' : 'Dance in a room and your partners show up here.'}
                </p>
              ) : (
                <ul className="df-list">
                  {strangers.map((p) => (
                    <li key={p.id} className="df-item">
                      <Avatar icon={p.avatar} color={p.color} size="sm" label={iconLabel(p.avatar)} />
                      <span className="df-item-body">
                        <span className="df-item-title">{p.name}</span>
                        <span className="df-item-meta">
                          <OnlineDot online={p.online} /> {p.online ? 'Online' : 'Away'}
                        </span>
                      </span>
                      <Button size="sm" variant="secondary" onClick={() => void add(p.friendCode)} disabled={busy}>
                        Add friend
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel
            title={`Your friends${friends ? ` (${friends.length})` : ''}`}
            kicker={room ? `You are in room ${room}` : 'Online friends first'}
            sticker="crown"
          >
            {!friends ? (
              <p className="df-note acct-note">Calling the court…</p>
            ) : friends.length === 0 ? (
              <p className="df-note acct-note">No friends yet. Trade codes with someone and add them on the left.</p>
            ) : (
              <ul className="df-list">
                {friends.map((f) => (
                  <li key={f.id} className={`df-item acct-friend${f.online ? '' : ' is-away'}`}>
                    <Avatar icon={f.avatar} color={f.color} size="sm" label={iconLabel(f.avatar)} />
                    <span className="df-item-body">
                      <span className="df-item-title">{f.name}</span>
                      <span className="df-item-meta">
                        <OnlineDot online={f.online} /> {presence(f)}
                      </span>
                    </span>
                    <span className="acct-friend-actions">
                      {room && f.inRoom !== room ? (
                        <Button size="sm" onClick={() => void invite(f, room)} disabled={invited.has(f.id)}>
                          {invited.has(f.id) ? 'Invited' : 'Invite to my room'}
                        </Button>
                      ) : f.inRoom && f.inRoom !== room ? (
                        <a className="df-btn df-btn-secondary df-btn-sm" href={joinHash(f.inRoom)}>
                          Join {f.inRoom}
                        </a>
                      ) : null}
                      <button
                        type="button"
                        className="df-btn df-btn-ghost df-btn-sm acct-remove"
                        onClick={() => setRemoving(f)}
                        aria-label={`Remove ${f.name}`}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? 'friend'}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Keep
            </Button>
            <Button onClick={() => removing && void remove(removing)}>Remove</Button>
          </>
        }
      >
        <p className="df-lede">You both drop off each other&rsquo;s list. You can add them again with their code.</p>
      </Modal>
      <Notice message={toast} />
    </div>
  )
}
