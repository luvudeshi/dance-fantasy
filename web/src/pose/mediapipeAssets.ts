// Where the MediaPipe runtime and PoseLandmarker models live. Pure (no MediaPipe import)
// so it can be unit-tested. Local copies are produced by scripts/setup-mediapipe.mjs;
// keep the model URL below in sync with that script.

export type PoseModel = 'lite' | 'full' | 'heavy'
export type Delegate = 'GPU' | 'CPU'
export type AssetSource = 'local' | 'cdn'

export const POSE_MODELS: readonly PoseModel[] = ['lite', 'full', 'heavy']
export const DELEGATES: readonly Delegate[] = ['GPU', 'CPU']

/** Must equal the installed @mediapipe/tasks-vision version (checked by a unit test). */
export const TASKS_VISION_VERSION = '1.1.1'

/** The wasm loader picks one of these at runtime (SIMD or not); both must exist locally. */
export const WASM_PROBE_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'] as const

const withSlash = (base: string): string => (base.endsWith('/') ? base : `${base}/`)

export function localWasmBase(baseUrl: string = import.meta.env.BASE_URL): string {
  return `${withSlash(baseUrl)}mediapipe/wasm`
}

export function cdnWasmBase(): string {
  return `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`
}

export function localModelUrl(model: PoseModel, baseUrl: string = import.meta.env.BASE_URL): string {
  return `${withSlash(baseUrl)}mediapipe/models/pose_landmarker_${model}.task`
}

export function cdnModelUrl(model: PoseModel): string {
  return `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${model}/float16/1/pose_landmarker_${model}.task`
}

/**
 * True when a HEAD response really is the requested static file. Vite's dev server (and
 * `vite preview`) answer unknown paths with index.html and status 200 (SPA fallback), so
 * the status alone is not enough: an HTML content-type means "missing".
 */
export function isRealFileResponse(res: { ok: boolean; headers: { get(name: string): string | null } }): boolean {
  const type = res.headers.get('content-type') ?? ''
  return res.ok && !type.toLowerCase().includes('text/html')
}
