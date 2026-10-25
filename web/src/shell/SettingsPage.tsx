import { useState, type CSSProperties, type ReactNode } from 'react'
import { AnnouncerToggles } from '../announcer/Herald'
import { DEFAULT_CALIBRATION, loadCalibration, saveCalibration, type Calibration } from '../game/calibration'
import { JUDGING_PRESETS, loadJudging, saveJudging, type JudgingPreset } from '../game/judging'
import { loadSfxEnabled, saveSfxEnabled } from '../game/sfx'
import { updateSettings, useSettings } from '../settings'
import { Button, Corners, Panel, Segmented, Slider, Title, Toggle } from '../theme/components'
import { Icon } from '../theme/Icon'
import { uiSound, unlockUiSound } from './uiSound'
import './shell.css'

// Settings (#/settings). Each control writes to the store that already owns the value: sound on/off
// (game/sfx.ts), judging (game/judging.ts), camera delay (game/calibration.ts), the rest settings.ts.

const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
] as const
const MODES = [
  { value: 'standing', label: 'Standing' },
  { value: 'seated', label: 'Seated' },
] as const
const DEV_PAGES = [
  { href: '#/pose', label: 'Pose spike' },
  { href: '#/beats', label: 'Beat spike' },
  { href: '#/ui', label: 'UI kit' },
  { href: '#/ai', label: 'AI preview' },
] as const

const gap = (px: number): CSSProperties => ({ '--df-gap': `${px}px` }) as CSSProperties

function Field({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="df-stack" style={gap(8)}>
      <span className="df-label">{label}</span>
      {children}
      {note && <p className="df-note shell-note">{note}</p>}
    </div>
  )
}

const measuredOn = (c: Calibration): string =>
  c.source === 'measured' && c.measuredAt ? new Date(c.measuredAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Not yet'

export default function SettingsPage() {
  const settings = useSettings()
  const [sfxOn, setSfxOn] = useState(() => loadSfxEnabled())
  const [judging, setJudging] = useState<JudgingPreset>(() => loadJudging())
  const [cal, setCal] = useState<Calibration>(() => loadCalibration())

  return (
    <div className="df-screen shell-page">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack shell-page-body" style={gap(28)}>
        <header className="df-stack shell-page-head" style={gap(10)}>
          <Title variant="large" kicker="Before the ball">
            Settings
          </Title>
          <p className="df-lede">Saved on this device. The Ballroom starts with these every time you dance.</p>
        </header>

        <div className="shell-panels">
          <Panel title="Sound" kicker="The music box" sticker="music-note">
            <Toggle
              checked={sfxOn}
              onChange={(on) => {
                setSfxOn(on)
                saveSfxEnabled(on)
              }}
              label="Sound effects"
              hint="Chimes for every step, the count-in and the fanfare (S while dancing)."
            />
            <Slider
              label="Effects volume"
              value={Math.round(settings.sfxVolume * 100)}
              onChange={(v) => updateSettings({ sfxVolume: v / 100 })}
              format={(v) => `${v}%`}
              step={5}
              disabled={!sfxOn}
            />
            <div>
              <Button
                variant="secondary"
                size="sm"
                icon="sparkles"
                disabled={!sfxOn}
                onClick={() => {
                  unlockUiSound()
                  uiSound('perfect')
                }}
              >
                Play a chime
              </Button>
            </div>
          </Panel>

          <Panel title="The herald" kicker="A voice at the ball" sticker="crown">
            <AnnouncerToggles />
          </Panel>

          <Panel title="Camera" kicker="The magic mirror" sticker="mirror-cam">
            <Toggle
              checked={settings.mirror}
              onChange={(mirror) => updateSettings({ mirror })}
              label="Mirror my camera"
              hint="See yourself like in a mirror (M while dancing)."
            />
            <Toggle
              checked={settings.cameraWindow}
              onChange={(cameraWindow) => updateSettings({ cameraWindow })}
              label="Camera window while dancing"
              hint="The small picture of you beside the dancer (C while dancing)."
            />
            <div className="df-scroll">
              <dl className="df-dl">
                <dt>Camera delay</dt>
                <dd>
                  <span className="df-num">{Math.round(cal.latencySec * 1000)}</span> ms
                </dd>
                <div className="df-rule" aria-hidden="true" />
                <dt>Measured</dt>
                <dd>{cal.source === 'measured' ? measuredOn(cal) : 'Default'}</dd>
              </dl>
            </div>
            <p className="df-note shell-note">
              The clap test in the mirror measures how late your camera is, and scoring makes up for it. If your steps feel
              judged late, reset it and clap again.
            </p>
            <div className="df-cluster" style={gap(12)}>
              <Button
                variant="secondary"
                size="sm"
                icon="clock-tower"
                disabled={cal.source === 'default'}
                onClick={() => {
                  saveCalibration(DEFAULT_CALIBRATION)
                  setCal(loadCalibration())
                }}
              >
                Reset camera timing
              </Button>
              <a className="df-btn df-btn-ghost df-btn-sm" href="#/play">
                Recalibrate in the Ballroom
              </a>
            </div>
          </Panel>

          <Panel title="The dance" kicker="Your first steps" sticker="dance-shoe">
            <Field label="Difficulty">
              <Segmented
                label="Difficulty"
                value={settings.difficulty}
                options={DIFFICULTIES}
                onChange={(difficulty) => updateSettings({ difficulty })}
              />
            </Field>
            <Field label="Dance" note="Seated routines move only the upper body.">
              <Segmented label="Dance" value={settings.mode} options={MODES} onChange={(mode) => updateSettings({ mode })} />
            </Field>
            <Field label="Judging" note={JUDGING_PRESETS.find((p) => p.value === judging)?.hint}>
              <Segmented
                label="Judging"
                value={judging}
                options={JUDGING_PRESETS}
                onChange={(preset) => {
                  setJudging(preset)
                  saveJudging(preset)
                }}
              />
            </Field>
          </Panel>

          <Panel title="Look and feel" kicker="Spells and charms" sticker="wand">
            <Toggle
              checked={settings.dancer3d}
              onChange={(dancer3d) => updateSettings({ dancer3d })}
              label="3D dancer"
              hint="A storybook dancer instead of the glowing silhouette (needs WebGL)."
            />
            <Toggle
              checked={settings.reducedMotion}
              onChange={(reducedMotion) => updateSettings({ reducedMotion })}
              label="Calm motion"
              hint="Stills floating and twinkling stickers. Your device's reduce-motion setting is always respected."
            />
          </Panel>

          <Panel title="Developer" kicker="Behind the curtain" sticker="gear">
            <Toggle
              checked={settings.debugOverlay}
              onChange={(debugOverlay) => updateSettings({ debugOverlay })}
              label="Debug overlay"
              hint="FPS, camera latency and sync drift while dancing (D while dancing)."
            />
            <Field label="Test pages">
              <div className="df-cluster" style={gap(10)}>
                {DEV_PAGES.map((p) => (
                  <a key={p.href} className="df-btn df-btn-secondary df-btn-sm" href={p.href}>
                    {p.label}
                  </a>
                ))}
              </div>
            </Field>
          </Panel>
        </div>

        <footer className="df-cluster shell-page-foot">
          <a className="df-btn df-btn-primary" href="#/">
            <Icon name="crown" size="xs" cut="none" />
            Back to the menu
          </a>
          <span className="df-note">Esc also takes you back.</span>
        </footer>
      </div>
    </div>
  )
}
