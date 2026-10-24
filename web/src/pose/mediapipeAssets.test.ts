import { describe, expect, it } from 'vitest'
// The package's "exports" map hides package.json, so import it by path.
import tasksVisionPkg from '../../node_modules/@mediapipe/tasks-vision/package.json'
import {
  cdnModelUrl,
  cdnWasmBase,
  isRealFileResponse,
  localModelUrl,
  localWasmBase,
  TASKS_VISION_VERSION,
} from './mediapipeAssets'

const response = (status: number, contentType: string | null) => ({
  ok: status >= 200 && status < 300,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
})

describe('mediapipe asset locations', () => {
  it('pins the CDN wasm to the installed @mediapipe/tasks-vision version', () => {
    // The JS API (bundled from node_modules) and the wasm binary must match exactly.
    expect(TASKS_VISION_VERSION).toBe(tasksVisionPkg.version)
    expect(cdnWasmBase()).toBe(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${tasksVisionPkg.version}/wasm`)
  })

  it('builds local URLs under BASE_URL with or without a trailing slash', () => {
    expect(localWasmBase('/')).toBe('/mediapipe/wasm')
    expect(localWasmBase('/app')).toBe('/app/mediapipe/wasm')
    expect(localModelUrl('full', '/app/')).toBe('/app/mediapipe/models/pose_landmarker_full.task')
  })

  it('uses the official model URLs', () => {
    expect(cdnModelUrl('lite')).toBe(
      'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    )
  })
})

describe('isRealFileResponse', () => {
  it('rejects the dev-server SPA fallback (index.html with status 200)', () => {
    expect(isRealFileResponse(response(200, 'text/html'))).toBe(false)
    expect(isRealFileResponse(response(200, 'text/html; charset=utf-8'))).toBe(false)
  })

  it('accepts binary files, with or without a content-type', () => {
    expect(isRealFileResponse(response(200, 'application/wasm'))).toBe(true)
    expect(isRealFileResponse(response(200, 'application/octet-stream'))).toBe(true)
    expect(isRealFileResponse(response(200, null))).toBe(true)
  })

  it('rejects error statuses', () => {
    expect(isRealFileResponse(response(404, 'text/plain'))).toBe(false)
  })
})
