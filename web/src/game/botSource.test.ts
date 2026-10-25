import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import type { LimbName, Pose2D } from '@shared/skeleton'
import { mirrorPose, NEUTRAL_POSE } from '../routine/pose'
import { buildMotionTrack } from '../routine/track'
import routineJson from './__fixtures__/routine_synth120_normal.json'
import { BOT_MAX_BACKFILL_SEC, BotPoseSource, perturbPose, smoothNoise } from './botSource'
import type { PlayerFrame } from './poseSource'
import { angleBetweenDeg, limbVector } from './scoring'

const ROUTINE = routineJson as unknown as Routine
const TRACK = buildMotionTrack(ROUTINE)
const ARM_LEG_LIMBS: LimbName[] = ['l_upper_arm', 'l_forearm', 'r_upper_arm', 'r_forearm', 'l_thigh', 'l_shin', 'r_thigh', 'r_shin', 'torso']

function limbError(a: Pose2D, b: Pose2D, limb: LimbName): number {
  const va = limbVector(a, limb)
  const vb = limbVector(b, limb)
  if (!va || !vb) throw new Error(`no ${limb}`)
  return angleBetweenDeg(va, vb)
}

async function started(bot: BotPoseSource): Promise<BotPoseSource> {
  await bot.start()
  return bot
}

describe('BotPoseSource', () => {
  it('emits every 1/fps frame since the last tick, in order, to subscribers', async () => {
    const bot = await started(new BotPoseSource({ track: TRACK, skill: 'good' }))
    const seen: PlayerFrame[] = []
    const unsub = bot.onFrame((f) => seen.push(f))
    expect(bot.kind).toBe('bot')
    expect(bot.latest()).toBeNull()
    expect(bot.tick(1).map((f) => f.songTime)).toEqual([1])
    const next = bot.tick(1.1).map((f) => f.songTime)
    expect(next.map((t) => Math.round(t * 30))).toEqual([31, 32, 33])
    expect(bot.tick(1.1)).toEqual([])
    expect(seen.map((f) => f.songTime)).toEqual([1, ...next])
    expect(bot.latest()).toBe(seen[seen.length - 1])
    expect(seen.every((f) => f.valid && Object.values(f.visibility).every((v) => v === 1))).toBe(true)
    unsub()
    bot.tick(2)
    expect(seen).toHaveLength(4)
  })

  it('is deterministic however the ticks are spaced (pull model)', async () => {
    const smooth = await started(new BotPoseSource({ track: TRACK, skill: 'sloppy', seed: 7 }))
    const jumpy = await started(new BotPoseSource({ track: TRACK, skill: 'sloppy', seed: 7 }))
    const a: PlayerFrame[] = []
    const b: PlayerFrame[] = []
    for (let i = 0; i <= 600; i++) a.push(...smooth.tick(i / 60))
    for (const t of [0, 0.4, 0.41, 1.9, 2.5, 4.2, 6.1, 8, 10]) b.push(...jumpy.tick(t))
    expect(b).toEqual(a)
    const other = await started(new BotPoseSource({ track: TRACK, skill: 'sloppy', seed: 8 }))
    expect(other.tick(5)[0].pose).not.toEqual(smooth.frameAt(5).pose)
  })

  it(`backfills at most ${BOT_MAX_BACKFILL_SEC} s, restarts when time goes back, and idles until start()`, async () => {
    const bot = new BotPoseSource({ track: TRACK, skill: 'perfect', fps: 30 })
    expect(bot.tick(1)).toEqual([])
    await bot.start()
    bot.tick(0)
    const burst = bot.tick(10)
    expect(burst).toHaveLength(BOT_MAX_BACKFILL_SEC * 30)
    expect(burst[burst.length - 1].songTime).toBe(10)
    expect(bot.tick(3).map((f) => f.songTime)).toEqual([3])
    bot.stop()
    expect(bot.tick(4)).toEqual([])
    await bot.start()
    expect(bot.tick(4).map((f) => f.songTime)).toEqual([4])
  })

  it('perfect (no noise) follows the track, lagSec late; mirrored dances the wrong side', () => {
    const exact = new BotPoseSource({ track: TRACK, skill: 'perfect', noiseDeg: 0, lagSec: 0.1 })
    const mirrored = new BotPoseSource({ track: TRACK, skill: 'mirrored', noiseDeg: 0 })
    for (const t of [3.3, 12.5, 40.02]) {
      const want = TRACK.sample(t - 0.1).pose
      const got = exact.frameAt(t).pose
      for (const limb of ARM_LEG_LIMBS) expect(limbError(got, want, limb)).toBeLessThan(1e-6)
      const m = mirrored.frameAt(t).pose
      const mWant = mirrorPose(TRACK.sample(t).pose)
      for (const limb of ARM_LEG_LIMBS) expect(limbError(m, mWant, limb)).toBeLessThan(1e-6)
    }
  })

  it('idle stands in the resting pose with a small sway', () => {
    const idle = new BotPoseSource({ track: TRACK, skill: 'idle' })
    let max = 0
    for (let t = 0; t < 30; t += 0.1) {
      const p = idle.frameAt(t).pose
      for (const limb of ARM_LEG_LIMBS) max = Math.max(max, limbError(p, NEUTRAL_POSE, limb))
    }
    expect(max).toBeGreaterThan(1)
    expect(max).toBeLessThan(20)
  })

  it('noiseDeg is the RMS per-limb direction error', () => {
    for (const noiseDeg of [12, 30]) {
      const bot = new BotPoseSource({ track: TRACK, skill: 'good', noiseDeg, seed: 3 })
      let sq = 0
      let n = 0
      for (let t = 0; t < 80; t += 0.05) {
        const got = bot.frameAt(t).pose
        const want = TRACK.sample(t).pose
        for (const limb of ARM_LEG_LIMBS) {
          sq += limbError(got, want, limb) ** 2
          n++
        }
      }
      const rms = Math.sqrt(sq / n)
      expect(rms).toBeGreaterThan(noiseDeg * 0.8)
      expect(rms).toBeLessThan(noiseDeg * 1.2)
    }
  })

  it('smoothNoise has unit variance and moves continuously', () => {
    let sq = 0
    let jump = 0
    const n = 20000
    for (let i = 0; i < n; i++) {
      const t = i * 0.01
      const v = smoothNoise(5, 2, t)
      sq += v * v
      jump = Math.max(jump, Math.abs(v - smoothNoise(5, 2, t + 0.001)))
    }
    expect(Math.sqrt(sq / n)).toBeGreaterThan(0.85)
    expect(Math.sqrt(sq / n)).toBeLessThan(1.15)
    expect(jump).toBeLessThan(0.1)
  })

  it('perturbPose turns each limb by exactly its own angle and keeps lengths', () => {
    const deg = [5, 10, 20, 30, 40, 15, 25, 35, 45]
    const p = perturbPose(NEUTRAL_POSE, deg.map((d) => (d * Math.PI) / 180))
    // NOISY order: torso, l_upper_arm, l_forearm, r_upper_arm, r_forearm, l_thigh, l_shin, r_thigh, r_shin
    const order: LimbName[] = ['torso', 'l_upper_arm', 'l_forearm', 'r_upper_arm', 'r_forearm', 'l_thigh', 'l_shin', 'r_thigh', 'r_shin']
    order.forEach((limb, i) => {
      expect(limbError(p, NEUTRAL_POSE, limb)).toBeCloseTo(deg[i], 6)
      const a = limbVector(p, limb)
      const b = limbVector(NEUTRAL_POSE, limb)
      if (!a || !b) throw new Error('missing limb')
      expect(Math.hypot(...a)).toBeCloseTo(Math.hypot(...b), 9)
    })
    expect(p.l_hip).toEqual(NEUTRAL_POSE.l_hip)
  })
})
