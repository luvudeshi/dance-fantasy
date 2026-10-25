import type { CSSProperties } from 'react'
import { Corners, Panel, Title } from '../theme/components'
import { Icon } from '../theme/Icon'
import type { IconName } from '../theme/icons'
import './shell.css'

// How to Play (#/how): the four steps of the ball, judging, the ways to rehearse, and the keys.

const STEPS: readonly { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'music-note',
    title: 'Pick a song',
    text: 'Choose a song from the shelf or bring your own. We find its beats and write an original routine for it.',
  },
  {
    icon: 'mirror-cam',
    title: 'Step into the mirror',
    text: 'Stand back until your whole body shows, raise both arms in a star, then clap along with eight clicks so we can time your camera.',
  },
  {
    icon: 'dance-shoe',
    title: 'Dance!',
    text: 'Copy the glowing dancer like a mirror. Upcoming moves slide in at the bottom with a 3 · 2 · 1 countdown.',
  },
  {
    icon: 'trophy',
    title: 'Take a bow',
    text: 'See your score, your stars, your best and hardest moves. Then dance it again, or learn the tricky part.',
  },
]

const JUDGMENTS = [
  { label: 'Perfect', tone: 'df-badge-gold', text: 'Your limbs match the dancer within a few degrees.' },
  { label: 'Good', tone: 'df-badge-sage', text: 'Close enough to count.' },
  { label: 'OK', tone: 'df-badge-blue', text: 'The right idea, a little off.' },
  { label: 'Miss', tone: 'df-badge-rasp', text: 'Not this time. Standing still always misses.' },
] as const

const WAYS: readonly { icon: IconName; title: string; text: string }[] = [
  { icon: 'sparkles', title: 'Just play', text: 'Straight onto the floor.' },
  { icon: 'crystal-ball', title: 'Watch first', text: 'The dancer performs the whole routine with the music; no camera.' },
  { icon: 'lantern', title: 'Practice run', text: 'A full run with hints and no score, then the real round.' },
  { icon: 'storybook', title: 'Learn', text: 'Loop any 8-count at half, three-quarter or full speed with tips per limb.' },
  { icon: 'party', title: 'Party', text: 'Open a ballroom and friends in other homes join with its code for a dance-off.' },
]

const KEYS = [
  ['Space', 'Pause'],
  ['R', 'Restart'],
  ['M', 'Mirror the camera'],
  ['C', 'Camera window'],
  ['S', 'Sound effects'],
  ['D', 'Debug overlay'],
  ['K', 'Skip calibration'],
  ['← →', 'Jump a bar (watching)'],
  ['Esc', 'Back'],
] as const

const gap = (px: number): CSSProperties => ({ '--df-gap': `${px}px` }) as CSSProperties

export default function HowToPlay() {
  return (
    <div className="df-screen shell-page">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack shell-page-body" style={gap(32)}>
        <header className="df-stack shell-page-head" style={gap(10)}>
          <Title variant="large" kicker="Once upon a midnight">
            How to Play
          </Title>
          <p className="df-lede df-display df-dropcap shell-story">
            Every night the twelve princesses slipped away to dance until their slippers
            wore through. Tonight you join them: follow the dancer, keep the beat, and keep up until the clock strikes the
            final note.
          </p>
        </header>

        <ol className="shell-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="df-card shell-step df-pop-in" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="df-spread">
                <span className="df-medal df-medal-sm">{i + 1}</span>
                <Icon name={s.icon} size={72} cut="sm" />
              </div>
              <h2 className="df-title shell-step-title">{s.title}</h2>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>

        <div className="shell-panels shell-panels-3">
          <Panel title="How every beat is judged" kicker="The clock is watching" sticker="clock-tower">
            <ul className="df-list">
              {JUDGMENTS.map((j) => (
                <li key={j.label} className="shell-judge">
                  <span className={`df-badge ${j.tone}`}>{j.label}</span>
                  <span>{j.text}</span>
                </li>
              ))}
            </ul>
            <p className="df-note shell-note">
              Each move has checkpoints on the beat. Your arms, legs and (for leaning moves) torso are compared with the
              dancer&apos;s by direction, taking your best frame just after the beat. Keep a combo going for bonus points.
            </p>
          </Panel>

          <Panel title="Ways to dance" kicker="Before the ball" sticker="slipper">
            <ul className="df-list">
              {WAYS.map((w) => (
                <li key={w.title} className="df-item">
                  <Icon name={w.icon} className="df-item-icon" cut="none" />
                  <span className="df-item-body">
                    <span className="df-item-title">{w.title}</span>
                    <span className="df-item-meta shell-wrap">{w.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Keys" kicker="For the keyboard" sticker="key">
            <div className="df-scroll">
              <dl className="df-dl shell-keys">
                {KEYS.map(([k, what]) => (
                  <div key={k} className="shell-key-row">
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <p className="df-note shell-note">
              No camera? Turn on Autoplay in the Ballroom and a bot dances for you. Your camera never leaves this browser;
              only scores reach the server.
            </p>
          </Panel>
        </div>

        <footer className="df-cluster shell-page-foot">
          <a className="df-btn df-btn-primary df-btn-lg" href="#/play">
            <Icon name="sparkles" size="sm" cut="none" />
            Begin the dance
          </a>
          <a className="df-btn df-btn-secondary" href="#/">
            <Icon name="castle" size="xs" cut="none" />
            Back to the menu
          </a>
        </footer>
      </div>
    </div>
  )
}
