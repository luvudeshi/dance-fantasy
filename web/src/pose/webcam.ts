// getUserMedia wrapper with friendly errors. Frames never leave the browser: the stream
// is only attached to a local <video> element.

import { abortReason, errorMessage } from '../lib/errors'

export type WebcamErrorKind = 'insecure' | 'unsupported' | 'denied' | 'not-found' | 'busy' | 'constraints' | 'unknown'

export class WebcamError extends Error {
  readonly kind: WebcamErrorKind

  constructor(kind: WebcamErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WebcamError'
    this.kind = kind
  }
}

export interface WebcamOptions {
  /** Ideal capture size; the browser may pick the closest supported mode. Default 640x480. */
  width?: number
  height?: number
  /** Abort a pending start (e.g. Stop clicked, component unmounted). */
  signal?: AbortSignal
}

function toWebcamError(err: unknown): WebcamError {
  const name = err instanceof Error || err instanceof DOMException ? err.name : ''
  const detail = errorMessage(err)
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new WebcamError(
        'denied',
        'Camera permission was denied. Allow camera access for this site (camera icon in the address bar; on macOS also System Settings > Privacy & Security > Camera) and try again.',
        { cause: err },
      )
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new WebcamError('not-found', 'No camera found. Connect a webcam and try again.', { cause: err })
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new WebcamError(
        'busy',
        'The camera could not be started; it is probably in use by another app or tab (Zoom, FaceTime, Teams...). Close it and try again.',
        { cause: err },
      )
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new WebcamError('constraints', `The camera does not support the requested settings (${detail}).`, { cause: err })
    case 'TypeError':
      return new WebcamError('unsupported', `Camera request rejected by the browser: ${detail}`, { cause: err })
    default:
      return new WebcamError('unknown', `Could not start the camera: ${detail}`, { cause: err })
  }
}

/** Stops all tracks of `stream` and detaches it from `video` (when given and attached). */
export function stopWebcam(stream: MediaStream | null, video?: HTMLVideoElement | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
  if (video && video.srcObject === stream) video.srcObject = null
}

/**
 * Opens the front camera (no audio), attaches it to `video` and waits until it plays.
 * Throws WebcamError with a user-facing message, or the signal's AbortError.
 */
export async function startWebcam(
  video: HTMLVideoElement,
  { width = 640, height = 480, signal }: WebcamOptions = {},
): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new WebcamError(
      'insecure',
      `Camera access needs a secure context: open the app over https:// or on http://localhost (this page is ${window.location.origin}).`,
    )
  }
  const devices: MediaDevices | undefined = navigator.mediaDevices
  if (!devices || typeof devices.getUserMedia !== 'function') {
    throw new WebcamError(
      'unsupported',
      'This browser does not provide camera access (navigator.mediaDevices is missing). Use a recent Chrome, Edge, Firefox or Safari over HTTPS or localhost.',
    )
  }
  if (signal?.aborted) throw abortReason(signal)

  let stream: MediaStream
  try {
    stream = await devices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: width }, height: { ideal: height } },
    })
  } catch (err) {
    throw toWebcamError(err)
  }
  if (signal?.aborted) {
    stopWebcam(stream)
    throw abortReason(signal)
  }

  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  try {
    await video.play()
  } catch (err) {
    stopWebcam(stream, video)
    if (signal?.aborted) throw abortReason(signal)
    throw new WebcamError('unknown', `The camera started but the video could not play: ${errorMessage(err)}`, {
      cause: err,
    })
  }
  if (signal?.aborted) {
    stopWebcam(stream, video)
    throw abortReason(signal)
  }
  return stream
}
