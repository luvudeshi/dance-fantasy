// The 3D coach: a procedural storybook princess or prince (primitives only: no model files, no
// licences) drawn with three.js into one shared offscreen WebGL canvas, then drawImage()d onto the
// caller's 2D context exactly where the 2D coach would be (orthographic camera over the figure's
// screen box). Loaded lazily (dynamic import from ./load), so three.js stays out of the main bundle.
// The dancer (./dancer) switches live: the old body's meshes are disposed and the new one built.

import { BufferAttribute, BufferGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, OrthographicCamera, Scene, SphereGeometry, TorusGeometry, WebGLRenderer, type Object3D } from 'three'
import type { JointName, LimbName, Pose2D, Vec2 } from '@shared/skeleton'
import type { Ctx2D } from '../pose/draw'
import { deviceScale, mixHex, type CoachTheme, type CoachView } from '../render/coach'
import { highlightedLimbs } from '../render/stickFigure'
import { getDancer, type Dancer } from './dancer'
import { Kit, lathe, limbGeometry, paint, type Body, type Look } from './parts3d'
import { buildPrince } from './prince3d'
import { buildRig, RADIUS, SKIRT_RINGS, SKIRT_SEGMENTS, type Basis, type RigPart } from './rig'

export interface Coach3dOptions {
  theme: CoachTheme
  pulse: number
  highlightJoints: readonly JointName[]
  crown: boolean
}

/** Device-pixel cap for the figure (a 2x/3x screen costs 4-9x the pixels). */
const MAX_DPR = 2
const MAX_SIDE = 2048

// --- the princess ------------------------------------------------------------------------------

type MatName = 'skin' | 'gown' | 'puff' | 'accent' | 'gold' | 'hair' | 'eye' | 'shine' | 'cheek' | 'gem'

function looks(t: CoachTheme): Record<MatName, Look> {
  const ink = '#1d1640'
  const skin = mixHex(t.body, '#ffe0d2', 0.55)
  const gown = mixHex(t.glow, '#ffffff', 0.22)
  return {
    skin: { base: skin, shade: mixHex(mixHex(skin, t.glow, 0.32), ink, 0.12), spec: 0.32 },
    gown: { base: gown, shade: mixHex(t.glow, ink, 0.38), back: mixHex(t.body, t.glow, 0.18), spec: 0.1 },
    puff: { base: mixHex(t.glow, '#ffffff', 0.5), shade: mixHex(t.glow, ink, 0.2), spec: 0.25 },
    accent: { base: t.accent, shade: mixHex(t.accent, ink, 0.4), spec: 0.3 },
    gold: { base: '#ffd98a', shade: '#c8892f', spec: 0.6, rimK: 0.25 },
    hair: { base: mixHex(t.glow, '#3a2257', 0.5), shade: mixHex(t.glow, '#140c2c', 0.7), spec: 0.35 },
    eye: { base: '#2a1c40', shade: '#160e26', spec: 0.5, rimK: 0 },
    shine: { base: '#ffffff', shade: '#ffffff', spec: 0, rimK: 0 },
    cheek: { base: mixHex(skin, '#ff8fae', 0.45), shade: mixHex(skin, '#ff8fae', 0.5), spec: 0, rimK: 0 },
    gem: { base: mixHex(t.accent, '#ffffff', 0.35), shade: t.accent, spec: 0.9, rimK: 0 },
  }
}

function skirtGeometry(): { geo: BufferGeometry; pos: BufferAttribute } {
  const geo = new BufferGeometry()
  const pos = new BufferAttribute(new Float32Array(SKIRT_RINGS * SKIRT_SEGMENTS * 3), 3)
  geo.setAttribute('position', pos)
  const idx: number[] = []
  for (let i = 0; i < SKIRT_RINGS - 1; i++) {
    for (let j = 0; j < SKIRT_SEGMENTS; j++) {
      const a = i * SKIRT_SEGMENTS + j
      const b = i * SKIRT_SEGMENTS + ((j + 1) % SKIRT_SEGMENTS)
      const c = a + SKIRT_SEGMENTS
      const d = b + SKIRT_SEGMENTS
      idx.push(a, b, c, b, d, c)
    }
  }
  geo.setIndex(idx)
  return { geo, pos }
}

function buildPrincess(): Body {
  const kit = new Kit()
  const keep = kit.keep.bind(kit)
  const mesh = kit.mesh.bind(kit)
  const ellip = kit.ellip.bind(kit)
  const scene = new Scene()
  const mats = kit.mats(['skin', 'gown', 'puff', 'accent', 'gold', 'hair', 'eye', 'shine', 'cheek', 'gem'] as const, ['gown'])
  const sphere = keep(new SphereGeometry(1, 28, 18))
  const parts: Body['parts'] = {}
  const primary: Body['primary'] = {}
  const add = (part: RigPart, obj: Mesh | Group): void => {
    obj.matrixAutoUpdate = false
    obj.frustumCulled = false
    parts[part] = obj
    if (obj instanceof Mesh) primary[part] = obj
    scene.add(obj)
  }

  const upper = keep(limbGeometry(RADIUS.shoulder, RADIUS.elbow))
  const fore = keep(limbGeometry(RADIUS.elbow, RADIUS.wrist))
  const thigh = keep(limbGeometry(RADIUS.hip, RADIUS.knee))
  const shin = keep(limbGeometry(RADIUS.knee, RADIUS.ankle))
  const neck = keep(limbGeometry(RADIUS.neck, RADIUS.neck * 0.92))
  for (const side of ['l', 'r'] as const) {
    add(`${side}_upper_arm`, mesh(upper, mats.skin))
    add(`${side}_forearm`, mesh(fore, mats.skin))
    add(`${side}_thigh`, mesh(thigh, mats.skin))
    add(`${side}_shin`, mesh(shin, mats.skin))
    for (const j of ['shoulder', 'elbow', 'hip', 'knee', 'ankle', 'hand', 'foot'] as const) add(`${side}_${j}`, mesh(sphere, mats.skin))
  }
  add('neck', mesh(neck, mats.skin))

  // Torso: gown bodice over a porcelain chest / shoulder line (off-shoulder neckline).
  const torso = new Group()
  const chest = keep(
    lathe(
      [
        [0.001, 0.6],
        [0.3, 0.66],
        [0.35, 0.82],
        [0.385, 0.93],
        [0.36, 1.0],
        [0.27, 1.05],
        [0.12, 1.08],
        [0.001, 1.09],
      ],
      0.6,
    ),
  )
  const bodice = keep(
    lathe(
      [
        [0.001, -0.07],
        [0.27, -0.05],
        [0.305, 0.06],
        [0.29, 0.2],
        [0.25, 0.4],
        [0.26, 0.52],
        [0.315, 0.68],
        [0.355, 0.8],
        [0.365, 0.835],
        [0.33, 0.85],
      ],
      0.62,
    ),
  )
  torso.add(mesh(chest, mats.skin), mesh(bodice, mats.gown))
  add('torso', torso)
  const torus = keep(new TorusGeometry(1, 0.2, 8, 40))
  torus.rotateX(Math.PI / 2)
  add('sash', mesh(torus, mats.gold))

  const { geo: skirtGeo, pos: skirtPos } = skirtGeometry()
  keep(skirtGeo)
  const skirt = mesh(skirtGeo, mats.gown)
  skirt.matrixAutoUpdate = false
  scene.add(skirt)

  // Head (frame radius 1): porcelain face, hair cap + back + bun, eyes, cheeks, tiara.
  const head = new Group()
  const capTop = keep(new SphereGeometry(1.07, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.38))
  const capBack = keep(new SphereGeometry(1.08, 32, 16, Math.PI / 2 + 0.75, Math.PI * 2 - 1.5, 0, Math.PI * 0.82))
  head.add(
    ellip(sphere, mats.skin, 0.9, 1.04, 0.95),
    ellip(capTop, mats.hair, 0.92, 1.04, 0.97),
    ellip(capBack, mats.hair, 0.93, 1.04, 0.98),
    ellip(sphere, mats.hair, 0.46, 0.42, 0.44, 0, 0.78, -0.55),
    // Long hair falling down the back, peeking out beside the neck from the front.
    ellip(sphere, mats.hair, 0.86, 1.25, 0.5, 0, -0.75, -0.42),
    ellip(sphere, mats.eye, 0.1, 0.15, 0.05, -0.33, -0.08, 0.87),
    ellip(sphere, mats.eye, 0.1, 0.15, 0.05, 0.33, -0.08, 0.87),
    ellip(sphere, mats.shine, 0.035, 0.04, 0.02, -0.3, -0.03, 0.915),
    ellip(sphere, mats.shine, 0.035, 0.04, 0.02, 0.36, -0.03, 0.915),
    ellip(sphere, mats.cheek, 0.15, 0.09, 0.05, -0.5, -0.3, 0.74),
    ellip(sphere, mats.cheek, 0.15, 0.09, 0.05, 0.5, -0.3, 0.74),
  )
  const tiara = new Group()
  const band = keep(new CylinderGeometry(0.6, 0.64, 0.16, 32, 1, true))
  tiara.add(mesh(band, mats.gold))
  const spike = keep(new ConeGeometry(0.1, 1, 10))
  spike.translate(0, 0.5, 0)
  for (const [a, h] of [
    [-0.75, 0.24],
    [-0.38, 0.34],
    [0, 0.5],
    [0.38, 0.34],
    [0.75, 0.24],
  ] as const) {
    const m = mesh(spike, mats.gold)
    m.position.set(0.6 * Math.sin(a), 0.06, 0.6 * Math.cos(a))
    m.scale.set(1, h, 1)
    tiara.add(m)
  }
  tiara.add(ellip(sphere, mats.gem, 0.1, 0.12, 0.08, 0, 0.2, 0.64))
  tiara.position.set(0, 0.86, 0.1)
  tiara.rotation.x = 0.22
  head.add(tiara)
  add('head', head)

  return {
    scene,
    parts,
    primary,
    // ponytail: the waist torus has no base entry, so it draws in skin as it always has.
    base: { l_shoulder: mats.puff, r_shoulder: mats.puff, l_foot: mats.puff, r_foot: mats.puff },
    skin: mats.skin,
    accent: mats.accent,
    crown: tiara,
    skirt: { mesh: skirt, pos: skirtPos },
    mats: Object.values(mats),
    setTheme: (t) => paint(mats, looks(t), t),
    disposables: kit.disposables,
  }
}

// --- the figure --------------------------------------------------------------------------------

interface Figure {
  renderer: WebGLRenderer
  canvas: HTMLCanvasElement
  camera: OrthographicCamera
  /** The current dancer's meshes (rebuilt when the dancer changes). */
  body: Body
  dancer: Dancer
  themeKey: string
  lost: boolean
}

let fig: Figure | null = null
let failed = false

const buildBody = (d: Dancer): Body => (d === 'prince' ? buildPrince() : buildPrincess())

function disposeBody(b: Body): void {
  for (const d of b.disposables) d.dispose()
}

function create(): Figure | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' })
  } catch {
    return null
  }
  // A shader that fails to compile draws nothing: give up and let the 2D coach draw.
  renderer.debug.onShaderError = () => {
    failed = true
  }
  renderer.setPixelRatio(1)
  renderer.autoClear = false
  renderer.setClearColor(0x000000, 0)
  const camera = new OrthographicCamera(0, 1, 0, -1, 0, 10)
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    if (fig) fig.lost = true
  })
  canvas.addEventListener('webglcontextrestored', () => {
    if (fig) fig.lost = false
  })
  const dancer = getDancer()
  return { renderer, canvas, camera, body: buildBody(dancer), dancer, themeKey: '', lost: false }
}

/** Swaps in the current dancer's body when the choice changed (same shader program: no recompile). */
function syncDancer(f: Figure): void {
  const d = getDancer()
  if (d === f.dancer) return
  disposeBody(f.body)
  f.body = buildBody(d)
  f.dancer = d
  f.themeKey = ''
}

function setTheme(f: Figure, theme: CoachTheme, pulse: number): void {
  const key = `${theme.body}|${theme.glow}|${theme.accent}`
  if (f.themeKey !== key) {
    f.themeKey = key
    f.body.setTheme(theme)
  }
  for (const m of f.body.mats) m.uniforms.uPulse.value = pulse
}

/** Accent gloves / sleeves / boots: the parts a highlighted (scored) limb paints in the accent colour. */
const HL_PARTS: ReadonlyArray<readonly [LimbName, readonly RigPart[]]> = [
  ['l_upper_arm', ['l_upper_arm', 'l_elbow']],
  ['r_upper_arm', ['r_upper_arm', 'r_elbow']],
  ['l_forearm', ['l_forearm', 'l_hand']],
  ['r_forearm', ['r_forearm', 'r_hand']],
  ['l_thigh', ['l_thigh', 'l_knee']],
  ['r_thigh', ['r_thigh', 'r_knee']],
  ['l_shin', ['l_shin', 'l_ankle', 'l_foot']],
  ['r_shin', ['r_shin', 'r_ankle', 'r_foot']],
]

function setBasis(obj: Object3D, b: Basis): void {
  const { o, x, y, z } = b
  obj.matrix.set(x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2], 0, 0, 0, 1)
  obj.matrixWorldNeedsUpdate = true
}

/** A rendered figure: source rect `sw` x `sh` at the canvas' top-left, to draw at x, y, w, h (CSS px). */
export interface Coach3dImage {
  src: HTMLCanvasElement
  sw: number
  sh: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * Renders the 3D coach for `ctx` (its transform sets the resolution) into the shared canvas; the
 * caller draws the image right away (the next render reuses the canvas). Null when it can't (no
 * WebGL, context lost, nothing to draw): draw the 2D coach instead.
 */
export function renderCoach3d(ctx: Ctx2D, pose: Pose2D, root: Vec2, view: CoachView, opts: Coach3dOptions): Coach3dImage | null {
  if (failed) return null
  fig ??= create()
  const f = fig
  if (!f) {
    failed = true
    return null
  }
  if (f.lost || f.renderer.getContext().isContextLost()) return null
  syncDancer(f)
  const s = view.scale
  const rig = buildRig(pose, root, view, performance.now() / 1000, opts.pulse, f.body.section)
  const { box } = rig
  if (!(s > 0) || !Number.isFinite(box.x0) || !Number.isFinite(box.y1)) return null

  // Viewport: the figure's box in device pixels (capped), top-left of the shared canvas.
  let k = Math.min(MAX_DPR, deviceScale(ctx))
  const bw = box.x1 - box.x0 + 4
  const bh = box.y1 - box.y0 + 4
  k = Math.min(k, MAX_SIDE / bw, MAX_SIDE / bh)
  const pw = Math.max(1, Math.ceil(bw * k))
  const ph = Math.max(1, Math.ceil(bh * k))
  const x0 = box.x0 - 2
  const y0 = box.y0 - 2
  const c = f.canvas
  if (c.width < pw || c.height < ph) f.renderer.setSize(Math.max(c.width, pw), Math.max(c.height, ph), false)
  const H = c.height

  setTheme(f, opts.theme, opts.pulse)
  const body = f.body
  const hl = highlightedLimbs(opts.highlightJoints)
  for (const [part, obj] of Object.entries(body.parts) as Array<[RigPart, Object3D]>) {
    const b = rig.parts[part]
    obj.visible = b !== undefined
    if (b) setBasis(obj, b)
  }
  for (const [part, m] of Object.entries(body.primary) as Array<[RigPart, Mesh]>) m.material = body.base[part] ?? body.skin
  for (const [limb, ps] of HL_PARTS) {
    if (!hl.has(limb)) continue
    for (const p of ps) {
      const m = body.primary[p]
      if (m) m.material = body.accent
    }
  }
  body.crown.visible = opts.crown
  if (body.skirt) {
    const { mesh, pos } = body.skirt
    if (rig.skirt) {
      ;(pos.array as Float32Array).set(rig.skirt)
      pos.needsUpdate = true
      mesh.geometry.computeVertexNormals()
      mesh.visible = true
    } else {
      mesh.visible = false
    }
  }

  const cam = f.camera
  const depth = 20 * s
  cam.left = x0
  cam.right = x0 + pw / k
  cam.top = -y0
  cam.bottom = -(y0 + ph / k)
  cam.near = 0
  cam.far = 2 * depth
  cam.position.set(0, 0, depth)
  cam.updateProjectionMatrix()

  const r = f.renderer
  r.setViewport(0, H - ph, pw, ph)
  r.setScissor(0, H - ph, pw, ph)
  r.setScissorTest(true)
  r.clear()
  r.render(body.scene, cam)
  return { src: c, sw: pw, sh: ph, x: x0, y: y0, w: pw / k, h: ph / k }
}

/** Creates the renderer and compiles the shader ahead of the first draw (no hitch when a round starts). */
export function warmCoach3d(): void {
  if (failed || fig) return
  fig = create()
  if (!fig) failed = true
  else fig.renderer.compile(fig.body.scene, fig.camera)
}

/** Frees the WebGL context and every GPU resource (the next draw rebuilds lazily). */
export function disposeCoach3d(): void {
  if (!fig) return
  disposeBody(fig.body)
  fig.renderer.dispose()
  fig.renderer.forceContextLoss()
  fig = null
}
