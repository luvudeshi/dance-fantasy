// The 3D dancers' shared kit: the toon/porcelain material, primitive geometry helpers, and the Body
// every dancer (coach3d.ts: princess, prince3d.ts: prince) is built as. Only coach3d.ts and
// prince3d.ts import this (the lazily loaded three.js chunk).

import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  LatheGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Object3D,
  type Scene,
} from 'three'
import { hexToRgb, mixHex, type CoachTheme } from '../render/coach'
import type { RigPart } from './rig'

// --- material: soft two-tone toon + porcelain highlight + theme rim ----------------------------

const VERT = /* glsl */ `
varying vec3 vN;
void main() {
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uShade;
uniform vec3 uBack;
uniform vec3 uRim;
uniform float uRimK;
uniform float uSpec;
uniform float uPulse;
varying vec3 vN;
void main() {
  vec3 N = normalize(vN);
  vec3 base = uBase;
  if (!gl_FrontFacing) { N = -N; base = uBack; }
  vec3 L = normalize(vec3(-0.42, 0.62, 0.66));
  float d = dot(N, L);
  float lit = smoothstep(-0.12, 0.22, d);
  vec3 col = mix(uShade * (gl_FrontFacing ? 1.0 : 0.82), base, lit);
  col += base * smoothstep(0.62, 0.7, d) * 0.07;
  // Bounce from below-right in the theme colour, porcelain glint, rim glow.
  col += uRim * max(dot(N, normalize(vec3(0.55, -0.45, 0.4))), 0.0) * 0.16;
  float sp = pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 48.0);
  col += vec3(smoothstep(0.35, 0.6, sp)) * uSpec;
  float fr = 1.0 - max(N.z, 0.0);
  col = mix(col, uRim, smoothstep(0.5, 0.95, fr) * uRimK);
  col *= 1.0 + 0.12 * uPulse;
  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
}`

const rgb = (hex: string): Vector3 => {
  const [r, g, b] = hexToRgb(hex)
  return new Vector3(r / 255, g / 255, b / 255)
}

/** A material's colours: lit, shaded, back faces (default: shaded); rim glow strength; glint. */
export interface Look {
  base: string
  shade: string
  back?: string
  rimK?: number
  spec?: number
}

export function material(side = false): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    ...(side ? { side: DoubleSide } : {}),
    uniforms: {
      uBase: { value: new Vector3() },
      uShade: { value: new Vector3() },
      uBack: { value: new Vector3() },
      uRim: { value: new Vector3() },
      uRimK: { value: 0.5 },
      uSpec: { value: 0.3 },
      uPulse: { value: 0 },
    },
  })
}

/** Sets each material's colours from its look, with the theme's rim glow. */
export function paint<K extends string>(mats: Record<K, ShaderMaterial>, looks: Record<K, Look>, theme: CoachTheme): void {
  const rim = rgb(mixHex(theme.glow, '#ffffff', 0.25))
  for (const name of Object.keys(looks) as K[]) {
    const look = looks[name]
    const u = mats[name].uniforms
    ;(u.uBase.value as Vector3).copy(rgb(look.base))
    ;(u.uShade.value as Vector3).copy(rgb(look.shade))
    ;(u.uBack.value as Vector3).copy(rgb(look.back ?? look.shade))
    ;(u.uRim.value as Vector3).copy(rim)
    u.uRimK.value = look.rimK ?? 0.55
    u.uSpec.value = look.spec ?? 0.3
  }
}

// --- a dancer's body ---------------------------------------------------------------------------

/** One dancer's meshes, posed each frame by the rig (coach3d.ts renders it). */
export interface Body {
  scene: Scene
  /** Per rig part: the object whose matrix is set to the part's basis. */
  parts: Partial<Record<RigPart, Object3D>>
  /** Per rig part: the mesh that takes its base material, or the accent when the limb is scored. */
  primary: Partial<Record<RigPart, Mesh>>
  /** Base material per part (default: `skin`). */
  base: Partial<Record<RigPart, ShaderMaterial>>
  skin: ShaderMaterial
  accent: ShaderMaterial
  /** Hidden with crown: false. */
  crown: Object3D
  /** The torso's [half-width, half-depth] at torso height t, for keeping arms clear (default: the princess' bodySection). */
  section?: (t: number) => [number, number] | null
  /** The princess' gown (vertices from the rig), null for the prince. */
  skirt: { mesh: Mesh; pos: BufferAttribute } | null
  mats: ShaderMaterial[]
  setTheme(theme: CoachTheme): void
  disposables: Array<{ dispose(): void }>
}

/** Collects what a body must dispose; `mesh` makes a never-culled mesh. */
export class Kit {
  readonly disposables: Array<{ dispose(): void }> = []
  keep<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x)
    return x
  }
  mats<K extends string>(names: readonly K[], doubleSided: readonly K[] = []): Record<K, ShaderMaterial> {
    const out = {} as Record<K, ShaderMaterial>
    for (const name of names) out[name] = this.keep(material(doubleSided.includes(name)))
    return out
  }
  mesh(geo: BufferGeometry, mat: ShaderMaterial): Mesh {
    const m = new Mesh(geo, mat)
    m.frustumCulled = false
    return m
  }
  /** A mesh scaled (sx, sy, sz) at (x, y, z). */
  ellip(geo: BufferGeometry, mat: ShaderMaterial, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): Mesh {
    const m = this.mesh(geo, mat)
    m.scale.set(sx, sy, sz)
    m.position.set(x, y, z)
    return m
  }
}

// --- geometry ----------------------------------------------------------------------------------

/** Body-unit lathe from (radius, height) pairs, bottom to top; depth scaled for an oval cross-section. */
export function lathe(pts: ReadonlyArray<readonly [number, number]>, depth: number): LatheGeometry {
  const g = new LatheGeometry(
    pts.map(([r, y]) => new Vector2(r, y)),
    36,
  )
  g.scale(1, 1, depth)
  return g
}

/** Unit-length open cylinder along +y (0..1), radius ra at 0 tapering to rb at 1. */
export function limbGeometry(ra: number, rb: number): CylinderGeometry {
  const g = new CylinderGeometry(rb, ra, 1, 20, 1, true)
  g.translate(0, 0.5, 0)
  return g
}

/** A profile's radius at height y (linear between its points; 0 outside it). */
export function profileRadius(pts: ReadonlyArray<readonly [number, number]>, y: number): number {
  for (let i = 1; i < pts.length; i++) {
    const [r0, y0] = pts[i - 1]
    const [r1, y1] = pts[i]
    if (y >= Math.min(y0, y1) && y <= Math.max(y0, y1)) return y1 === y0 ? Math.max(r0, r1) : r0 + ((r1 - r0) * (y - y0)) / (y1 - y0)
  }
  return 0
}

/**
 * Band vertices hugging a lathe surface (profile `pts`, depth scale `depth`), `lift` outside it:
 * `segs` columns around the body (u = 0 at +x, then toward +z), each a bottom and a top vertex,
 * the centre line at height y0 + tilt * cos(u) (tilt != 0: a diagonal sash), `width` tall.
 */
export function bandVertices(pts: ReadonlyArray<readonly [number, number]>, depth: number, y0: number, tilt: number, width: number, lift: number, segs: number): Float32Array {
  const out = new Float32Array(segs * 2 * 3)
  for (let i = 0; i < segs; i++) {
    const u = (i / segs) * Math.PI * 2
    const yc = y0 + tilt * Math.cos(u)
    for (let e = 0; e < 2; e++) {
      const y = yc + (e === 0 ? -width / 2 : width / 2)
      const r = profileRadius(pts, y) + lift
      const o = (i * 2 + e) * 3
      out[o] = r * Math.cos(u)
      out[o + 1] = y
      out[o + 2] = r * depth * Math.sin(u)
    }
  }
  return out
}

/** The band of bandVertices as a closed ribbon (outward-facing). */
export function bandGeometry(pts: ReadonlyArray<readonly [number, number]>, depth: number, y0: number, tilt: number, width: number, lift = 0.012, segs = 72): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(bandVertices(pts, depth, y0, tilt, width, lift, segs), 3))
  const idx: number[] = []
  for (let i = 0; i < segs; i++) {
    const b0 = i * 2
    const b1 = ((i + 1) % segs) * 2
    idx.push(b0, b0 + 1, b1, b0 + 1, b1 + 1, b1)
  }
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}
