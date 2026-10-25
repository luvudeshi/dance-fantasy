// The prince: the princess' storybook counterpart on the same rig and pose mapping (rig.ts) and the
// same toon/porcelain material. Broad shoulders with gold epaulettes, a fitted doublet with gold
// trim, a diagonal sash in the section's accent colour, pale breeches, tall boots, short hair and a
// small crown.

import { ConeGeometry, CylinderGeometry, Group, Mesh, Scene, SphereGeometry } from 'three'
import { mixHex, type CoachTheme } from '../render/coach'
import { bandGeometry, Kit, lathe, limbGeometry, paint, profileRadius, type Body, type Look } from './parts3d'
import { RADIUS, type RigPart } from './rig'

type MatName = 'skin' | 'doublet' | 'trousers' | 'boot' | 'cuff' | 'sash' | 'gold' | 'hair' | 'brow' | 'eye' | 'shine' | 'accent' | 'gem'

function looks(t: CoachTheme): Record<MatName, Look> {
  const ink = '#1d1640'
  const skin = mixHex(t.body, '#ffe0d2', 0.55)
  const hair = mixHex(t.glow, '#33204f', 0.55)
  return {
    skin: { base: skin, shade: mixHex(mixHex(skin, t.glow, 0.32), ink, 0.12), spec: 0.32 },
    doublet: { base: mixHex(t.glow, '#ffffff', 0.18), shade: mixHex(t.glow, ink, 0.42), spec: 0.12 },
    trousers: { base: mixHex(t.body, '#ffffff', 0.25), shade: mixHex(mixHex(t.body, t.glow, 0.42), ink, 0.12), spec: 0.12 },
    boot: { base: mixHex(t.glow, '#2b1d48', 0.66), shade: mixHex(t.glow, '#0f0a20', 0.82), spec: 0.55, rimK: 0.6 },
    cuff: { base: mixHex(t.glow, '#2b1d48', 0.45), shade: mixHex(t.glow, '#0f0a20', 0.7), spec: 0.4, rimK: 0.5 },
    sash: { base: mixHex(t.glow, ink, 0.3), shade: mixHex(t.glow, ink, 0.62), spec: 0.3 },
    gold: { base: '#ffd98a', shade: '#c8892f', spec: 0.6, rimK: 0.25 },
    hair: { base: hair, shade: mixHex(t.glow, '#100a22', 0.78), spec: 0.4 },
    brow: { base: mixHex(hair, '#140c2c', 0.3), shade: mixHex(hair, '#140c2c', 0.5), spec: 0, rimK: 0 },
    eye: { base: '#2a1c40', shade: '#160e26', spec: 0.5, rimK: 0 },
    shine: { base: '#ffffff', shade: '#ffffff', spec: 0, rimK: 0 },
    accent: { base: t.accent, shade: mixHex(t.accent, ink, 0.4), spec: 0.3 },
    gem: { base: mixHex(t.accent, '#ffffff', 0.35), shade: t.accent, spec: 0.9, rimK: 0 },
  }
}

/** The doublet's (radius, height) profile along the torso (0 = mid-hip, 1 = mid-shoulder): V-shaped, hem below the hips. */
export const DOUBLET: ReadonlyArray<readonly [number, number]> = [
  [0.001, -0.15],
  [0.35, -0.15],
  [0.368, -0.12],
  [0.358, 0.0],
  [0.335, 0.15],
  [0.305, 0.3],
  [0.3, 0.42],
  [0.315, 0.55],
  [0.35, 0.7],
  [0.375, 0.82],
  [0.385, 0.92],
  [0.365, 0.99],
  [0.3, 1.04],
  [0.2, 1.07],
  [0.12, 1.08],
  [0.001, 1.085],
]
const DEPTH = 0.62
/** The sash: shoulder to opposite hip across the doublet (centre height, tilt, width; torso units). */
const SASH = { y: 0.6, tilt: 0.36, width: 0.12 } as const

/** The doublet's [half-width, half-depth] at torso height t (null outside it): what the arms keep clear of. */
export function doubletSection(t: number): [number, number] | null {
  if (!(t >= DOUBLET[0][1] && t <= DOUBLET[DOUBLET.length - 1][1])) return null
  const r = profileRadius(DOUBLET, t)
  return [r, r * DEPTH]
}

export function buildPrince(): Body {
  const kit = new Kit()
  const keep = kit.keep.bind(kit)
  const mesh = kit.mesh.bind(kit)
  const ellip = kit.ellip.bind(kit)
  const scene = new Scene()
  const mats = kit.mats(['skin', 'doublet', 'trousers', 'boot', 'cuff', 'sash', 'gold', 'hair', 'brow', 'eye', 'shine', 'accent', 'gem'] as const, ['gold'])
  const sphere = keep(new SphereGeometry(1, 28, 18))
  const parts: Body['parts'] = {}
  const primary: Body['primary'] = {}
  const add = (part: RigPart, obj: Mesh | Group, main: Mesh | null = obj instanceof Mesh ? obj : null): void => {
    obj.matrixAutoUpdate = false
    obj.frustumCulled = false
    parts[part] = obj
    if (main) primary[part] = main
    scene.add(obj)
  }

  // Limbs: sleeves with gold cuffs, breeches, tall boots with a turned-down cuff.
  const upper = keep(limbGeometry(0.138, 0.102))
  const fore = keep(limbGeometry(0.102, 0.084))
  const wristCuff = keep(new CylinderGeometry(0.104, 0.092, 0.17, 20, 1, true))
  const thigh = keep(limbGeometry(0.138, 0.11))
  const shaft = keep(limbGeometry(0.118, 0.09))
  const bootCuff = keep(new CylinderGeometry(0.124, 0.14, 0.2, 20, 1, true))
  const elbowBall = keep(new SphereGeometry(1.04, 24, 16))
  const hipBall = keep(new SphereGeometry(0.82, 24, 16))
  const ankleBall = keep(new SphereGeometry(1.12, 20, 14))
  const bootBall = keep(new SphereGeometry(1.14, 24, 16))
  const neck = keep(limbGeometry(RADIUS.neck * 1.06, RADIUS.neck))
  const domeGeo = keep(new SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2))
  const tassel = keep(new CylinderGeometry(0.075, 0.06, 0.5, 6, 1))
  for (const side of ['l', 'r'] as const) {
    add(`${side}_upper_arm`, mesh(upper, mats.doublet))
    add(`${side}_elbow`, mesh(elbowBall, mats.doublet))
    const forearm = new Group()
    const sleeve = mesh(fore, mats.doublet)
    const cuff = mesh(wristCuff, mats.gold)
    cuff.position.y = 0.9
    forearm.add(sleeve, cuff)
    add(`${side}_forearm`, forearm, sleeve)
    add(`${side}_hand`, mesh(sphere, mats.skin))
    add(`${side}_hip`, mesh(hipBall, mats.trousers))
    add(`${side}_thigh`, mesh(thigh, mats.trousers))
    add(`${side}_knee`, mesh(sphere, mats.trousers))
    const shin = new Group()
    const boot = mesh(shaft, mats.boot)
    const fold = mesh(bootCuff, mats.cuff)
    fold.position.y = 0.11
    shin.add(boot, fold)
    add(`${side}_shin`, shin, boot)
    add(`${side}_ankle`, mesh(ankleBall, mats.boot))
    add(`${side}_foot`, mesh(bootBall, mats.boot))
    // Shoulder (frame: the puff radius, world-aligned): doublet ball under a gold epaulette with tassels.
    const shoulder = new Group()
    shoulder.add(ellip(sphere, mats.doublet, 0.92, 0.92, 0.92), ellip(domeGeo, mats.gold, 1.12, 0.5, 1.06, 0, 0.3, 0))
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2
      shoulder.add(ellip(tassel, mats.gold, 1, 1, 1, 1.06 * Math.sin(a), 0.1, 1.0 * Math.cos(a)))
    }
    add(`${side}_shoulder`, shoulder, null)
  }
  add('neck', mesh(neck, mats.skin))

  // Torso: the doublet with a gold belt and hem, a diagonal sash, gold buttons and a standing collar.
  const torso = new Group()
  const frontZ = (y: number): number => profileRadius(DOUBLET, y) * DEPTH
  torso.add(
    mesh(keep(lathe(DOUBLET, DEPTH)), mats.doublet),
    mesh(keep(bandGeometry(DOUBLET, DEPTH, 0.25, 0, 0.075)), mats.gold),
    mesh(keep(bandGeometry(DOUBLET, DEPTH, -0.115, 0, 0.04)), mats.gold),
    mesh(keep(bandGeometry(DOUBLET, DEPTH, SASH.y, SASH.tilt, SASH.width, 0.022)), mats.sash),
    mesh(keep(bandGeometry(DOUBLET, DEPTH, SASH.y - SASH.width / 2, SASH.tilt, 0.018, 0.028)), mats.gold),
    mesh(keep(bandGeometry(DOUBLET, DEPTH, SASH.y + SASH.width / 2, SASH.tilt, 0.018, 0.028)), mats.gold),
    ellip(sphere, mats.gold, 0.075, 0.06, 0.03, 0, 0.25, frontZ(0.25) + 0.022),
    ellip(sphere, mats.gem, 0.035, 0.035, 0.02, 0, 0.25, frontZ(0.25) + 0.048),
  )
  // The sash's knot and tails at the hip.
  const ku = Math.PI * 0.8
  const ky = SASH.y + SASH.tilt * Math.cos(ku)
  const kr = profileRadius(DOUBLET, ky) + 0.045
  const [kx, kz] = [kr * Math.cos(ku), kr * DEPTH * Math.sin(ku) + 0.03]
  const tail = (dx: number, rz: number): Mesh => {
    const m = ellip(sphere, mats.sash, 0.045, 0.15, 0.025, kx + dx, ky - 0.14, kz)
    m.rotation.z = rz
    return m
  }
  torso.add(tail(-0.035, -0.18), tail(0.04, 0.24), ellip(sphere, mats.sash, 0.07, 0.06, 0.045, kx, ky, kz + 0.01))
  for (const y of [0.4, 0.48, 0.74, 0.83]) torso.add(ellip(sphere, mats.gold, 0.024, 0.024, 0.014, 0, y, frontZ(y) + 0.008))
  const collar = keep(
    lathe(
      [
        [0.125, 1.03],
        [0.138, 1.12],
        [0.15, 1.15],
      ],
      1,
    ),
  )
  torso.add(mesh(collar, mats.doublet))
  add('torso', torso)

  // Head (frame radius 1): face, ears, short side-parted hair, brows, eyes, small crown.
  const head = new Group()
  const capTop = keep(new SphereGeometry(1.07, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.36))
  const capSide = keep(new SphereGeometry(1.07, 32, 14, Math.PI / 2 + 1.0, Math.PI * 2 - 2.0, 0, Math.PI * 0.53))
  const capBack = keep(new SphereGeometry(1.08, 32, 18, Math.PI / 2 + 1.65, Math.PI * 2 - 3.3, 0, Math.PI * 0.78))
  const brow = (x: number, tilt: number): Mesh => {
    const m = ellip(sphere, mats.brow, 0.13, 0.034, 0.03, x, 0.16, 0.86)
    m.rotation.z = tilt
    return m
  }
  // Hair cap tipped forward and to one side: a lower, side-swept fringe.
  const top = ellip(capTop, mats.hair, 0.94, 1.08, 0.99, 0, 0.03, 0)
  top.rotation.set(0.15, 0, -0.14)
  head.add(
    ellip(sphere, mats.skin, 0.88, 1.05, 0.95),
    ellip(sphere, mats.skin, 0.13, 0.22, 0.12, -0.86, -0.12, -0.02),
    ellip(sphere, mats.skin, 0.13, 0.22, 0.12, 0.86, -0.12, -0.02),
    top,
    ellip(capSide, mats.hair, 0.93, 1.04, 0.98),
    ellip(capBack, mats.hair, 0.93, 1.04, 0.98),
    brow(-0.32, -0.1),
    brow(0.32, 0.1),
    ellip(sphere, mats.eye, 0.09, 0.13, 0.05, -0.32, -0.06, 0.87),
    ellip(sphere, mats.eye, 0.09, 0.13, 0.05, 0.32, -0.06, 0.87),
    ellip(sphere, mats.shine, 0.032, 0.036, 0.02, -0.29, -0.02, 0.915),
    ellip(sphere, mats.shine, 0.032, 0.036, 0.02, 0.35, -0.02, 0.915),
  )
  const crown = new Group()
  crown.add(mesh(keep(new CylinderGeometry(0.6, 0.63, 0.22, 32, 1, true)), mats.gold))
  const point = keep(new ConeGeometry(0.085, 1, 8))
  point.translate(0, 0.5, 0)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const h = i % 2 === 0 ? 0.28 : 0.18
    const p = mesh(point, mats.gold)
    p.position.set(0.6 * Math.sin(a), 0.09, 0.6 * Math.cos(a))
    p.scale.set(1, h, 1)
    crown.add(p, ellip(sphere, mats.gold, 0.05, 0.05, 0.05, 0.6 * Math.sin(a), 0.11 + h, 0.6 * Math.cos(a)))
  }
  crown.add(ellip(sphere, mats.gem, 0.08, 0.1, 0.06, 0, 0, 0.63))
  crown.position.set(0, 1.0, 0)
  crown.rotation.x = 0.1
  head.add(crown)
  add('head', head)

  return {
    scene,
    parts,
    primary,
    base: {
      l_upper_arm: mats.doublet,
      r_upper_arm: mats.doublet,
      l_elbow: mats.doublet,
      r_elbow: mats.doublet,
      l_forearm: mats.doublet,
      r_forearm: mats.doublet,
      l_hip: mats.trousers,
      r_hip: mats.trousers,
      l_thigh: mats.trousers,
      r_thigh: mats.trousers,
      l_knee: mats.trousers,
      r_knee: mats.trousers,
      l_shin: mats.boot,
      r_shin: mats.boot,
      l_ankle: mats.boot,
      r_ankle: mats.boot,
      l_foot: mats.boot,
      r_foot: mats.boot,
    },
    skin: mats.skin,
    accent: mats.accent,
    crown,
    section: doubletSection,
    skirt: null,
    mats: Object.values(mats),
    setTheme: (t) => paint(mats, looks(t), t),
    disposables: kit.disposables,
  }
}
