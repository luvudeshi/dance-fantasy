import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, getSettings, parseSettings, subscribeSettings, updateSettings } from './settings'

describe('parseSettings', () => {
  it('falls back to the defaults for missing or corrupt storage', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid saved values over the defaults', () => {
    const saved = {
      dancer3d: false,
      sfxVolume: 0.4,
      mirror: false,
      cameraWindow: false,
      debugOverlay: true,
      difficulty: 'hard',
      mode: 'seated',
      reducedMotion: true,
    }
    expect(parseSettings(saved)).toEqual(saved)
  })

  it('drops invalid values and unknown keys', () => {
    const parsed = parseSettings({
      dancer3d: 'yes',
      sfxVolume: 3,
      difficulty: 'impossible',
      mode: 'lying down',
      debugOverlay: 1,
      extra: true,
    })
    expect(parsed).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings({ sfxVolume: Number.NaN }).sfxVolume).toBe(DEFAULT_SETTINGS.sfxVolume)
    expect(parseSettings({ sfxVolume: 0 }).sfxVolume).toBe(0)
  })
})

describe('updateSettings', () => {
  it('patches the store and notifies subscribers (works without localStorage)', () => {
    let calls = 0
    const off = subscribeSettings(() => calls++)
    updateSettings({ difficulty: 'easy' })
    expect(getSettings().difficulty).toBe('easy')
    expect(getSettings().dancer3d).toBe(DEFAULT_SETTINGS.dancer3d)
    expect(calls).toBe(1)
    off()
    updateSettings({ difficulty: 'normal' })
    expect(calls).toBe(1)
  })
})
