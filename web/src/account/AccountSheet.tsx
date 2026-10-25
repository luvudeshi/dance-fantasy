import { useState, type CSSProperties, type FormEvent } from 'react'
import { errorMessage } from '../lib/errors'
import { Button, Modal, Notice, Segmented } from '../theme/components'
import { claimAccount, cleanUsername, isUsername, logIn, logOut } from './client'
import { setMe, useAccount } from './store'
import './account.css'

const MODES = [
  { value: 'claim', label: 'Save this account' },
  { value: 'login', label: 'Log in' },
] as const
type Mode = (typeof MODES)[number]['value']

const gap = (v: string): CSSProperties => ({ '--df-gap': v }) as CSSProperties

/**
 * "Keep your account on other devices": optional. Guests can do everything; claiming only adds a
 * username + password so this same account can log in elsewhere. Logged in, it offers Log out.
 */
export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useAccount()
  const [mode, setMode] = useState<Mode>('claim')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const user = cleanUsername(username)
  const valid = isUsername(user) && password.length >= 8 && password.length <= 200
  const close = (): void => {
    setPassword('')
    setError(null)
    setDone(null)
    onClose()
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = mode === 'claim' ? await claimAccount(user, password) : await logIn(user, password)
      setMe(next)
      setPassword('')
      setDone(mode === 'claim' ? `Saved. Log in as @${next.username ?? user} on any device.` : `Welcome back, ${next.name}.`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setMe(await logOut())
      setDone('Logged out. This browser is a fresh guest now.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={close} title="Keep your account on other devices" sheet>
      {done && <Notice inline tone="success" icon="key" message={done} />}
      {me && !me.isGuest ? (
        <div className="df-stack" style={gap('14px')}>
          <p className="df-lede acct-sheet-lede">
            Signed in as <b>@{me.username}</b>. Log in with it on your phone or a friend&rsquo;s laptop to bring your
            friends and rounds along.
          </p>
          {error && (
            <p className="df-error" role="alert">
              {error}
            </p>
          )}
          <div className="df-cluster">
            <Button variant="secondary" onClick={() => void signOut()} disabled={busy}>
              Log out
            </Button>
            <Button variant="ghost" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form className="df-stack" style={gap('14px')} onSubmit={(e) => void submit(e)}>
          <p className="df-note acct-sheet-lede">
            Totally optional: as a guest you can already dance, add friends and keep your history on this device.
          </p>
          <Segmented
            label="Save or log in"
            value={mode}
            options={MODES}
            onChange={(m) => {
              setMode(m)
              setError(null)
              setDone(null)
            }}
          />
          <p className="df-note acct-sheet-lede">
            {mode === 'claim'
              ? 'Pick a username and password for this account, then log in with them anywhere.'
              : 'Switch this browser to an account you saved before. This guest’s friends and rounds stay behind.'}
          </p>
          <label className="df-label" htmlFor="acct-user">
            Username
          </label>
          <input
            id="acct-user"
            className="df-field"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={20}
            placeholder="3-20 letters, numbers or _"
            aria-invalid={username !== '' && !isUsername(user) ? true : undefined}
          />
          <label className="df-label" htmlFor="acct-pass">
            Password
          </label>
          <input
            id="acct-pass"
            className="df-field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'claim' ? 'new-password' : 'current-password'}
            minLength={8}
            maxLength={200}
            placeholder="At least 8 characters"
          />
          {error && (
            <p className="df-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" block icon={mode === 'claim' ? 'key' : 'castle'} disabled={!valid || busy}>
            {busy ? 'One moment…' : mode === 'claim' ? 'Save my account' : 'Log in'}
          </Button>
        </form>
      )}
    </Modal>
  )
}
