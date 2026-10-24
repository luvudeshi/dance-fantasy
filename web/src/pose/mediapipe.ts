// Creates a MediaPipe PoseLandmarker in VIDEO mode, loading the wasm runtime and model
// from this app's origin when scripts/setup-mediapipe.mjs has put them in public/, and
// from the CDN otherwise. Works with any HTMLVideoElement (webcam or a video file).

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { abortReason, errorMessage } from '../lib/errors'
import {
  cdnModelUrl,
  cdnWasmBase,
  isRealFileResponse,
  localModelUrl,
  localWasmBase,
  WASM_PROBE_FILES,
  type AssetSource,
  type Delegate,
  type PoseModel,
} from './mediapipeAssets'

export type { AssetSource, Delegate, PoseModel } from './mediapipeAssets'

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>

export interface CreatePoseLandmarkerOptions {
  /** Default 'lite'. */
  model?: PoseModel
  /** Requested delegate; default 'GPU'. GPU failures fall back to CPU. */
  delegate?: Delegate
  /** Aborting rejects the promise and closes a landmarker that finished loading anyway. */
  signal?: AbortSignal
  minPoseDetectionConfidence?: number
  minPosePresenceConfidence?: number
  minTrackingConfidence?: number
}

export interface PoseLandmarkerHandle {
  landmarker: PoseLandmarker
  model: PoseModel
  /** The delegate actually in use (CPU when GPU creation failed). */
  delegate: Delegate
  wasmSource: AssetSource
  modelSource: AssetSource
}

/** HEAD-probes a same-origin static file; see isRealFileResponse for why status isn't enough. */
async function isServed(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal })
    return isRealFileResponse(res)
  } catch {
    return false
  }
}

async function resolveWasm(signal?: AbortSignal): Promise<{ fileset: WasmFileset; source: AssetSource }> {
  const local = localWasmBase()
  const probes = await Promise.all(WASM_PROBE_FILES.map((f) => isServed(`${local}/${f}`, signal)))
  const source: AssetSource = probes.every(Boolean) ? 'local' : 'cdn'
  const fileset = await FilesetResolver.forVisionTasks(source === 'local' ? local : cdnWasmBase())
  return { fileset, source }
}

async function resolveModel(model: PoseModel, signal?: AbortSignal): Promise<{ url: string; source: AssetSource }> {
  const local = localModelUrl(model)
  return (await isServed(local, signal)) ? { url: local, source: 'local' } : { url: cdnModelUrl(model), source: 'cdn' }
}

export async function createPoseLandmarker(opts: CreatePoseLandmarkerOptions = {}): Promise<PoseLandmarkerHandle> {
  const { signal } = opts
  const model = opts.model ?? 'lite'
  const requested = opts.delegate ?? 'GPU'
  const check = (): void => {
    if (signal?.aborted) throw abortReason(signal)
  }
  check()

  const [wasm, modelAsset] = await Promise.all([resolveWasm(signal), resolveModel(model, signal)])
  check()

  const create = (delegate: Delegate): Promise<PoseLandmarker> =>
    PoseLandmarker.createFromOptions(wasm.fileset, {
      baseOptions: { modelAssetPath: modelAsset.url, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: opts.minPoseDetectionConfidence ?? 0.5,
      minPosePresenceConfidence: opts.minPosePresenceConfidence ?? 0.5,
      minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
      outputSegmentationMasks: false,
    })

  let landmarker: PoseLandmarker
  let delegate: Delegate = requested
  try {
    landmarker = await create(requested)
  } catch (gpuErr) {
    check()
    if (requested !== 'GPU') {
      throw new Error(`Could not load pose model (${model}, ${requested}): ${errorMessage(gpuErr)}`, { cause: gpuErr })
    }
    console.warn('[pose] GPU delegate failed; retrying on CPU.', gpuErr)
    try {
      landmarker = await create('CPU')
      delegate = 'CPU'
    } catch (cpuErr) {
      check()
      throw new Error(`Could not load pose model (${model}): ${errorMessage(cpuErr)}`, { cause: cpuErr })
    }
  }

  if (signal?.aborted) {
    landmarker.close()
    throw abortReason(signal)
  }
  return { landmarker, model, delegate, wasmSource: wasm.source, modelSource: modelAsset.source }
}
