#!/usr/bin/env node
// Copies the MediaPipe Tasks Vision wasm runtime out of node_modules and downloads the
// PoseLandmarker models, so the app can load everything from its own origin
// (public/mediapipe/ -> served at <BASE_URL>mediapipe/). Node built-ins only.
//
//   node scripts/setup-mediapipe.mjs                 copy wasm, download lite + full
//   node scripts/setup-mediapipe.mjs --heavy         ... and the 31 MB heavy model
//   node scripts/setup-mediapipe.mjs --force         re-download models even if present
//   node scripts/setup-mediapipe.mjs --if-missing    only do missing work (used by predev/prebuild)
//   node scripts/setup-mediapipe.mjs --quiet         only print warnings (and a one-line
//                                                    notice before a model download starts)
//
// Never fails the build on network problems: src/pose/mediapipe.ts falls back to the CDN
// when a local file is missing. Under --if-missing a download is capped at 60 s so a slow
// network cannot hold `npm run dev` hostage (`npm run setup:mediapipe` has no cap).
// Downloads/copies go to `<name>.download-<pid>` / `<name>.tmp-<pid>` and are renamed into
// place; temp files are removed on failure, on Ctrl+C/SIGTERM, and (if a previous run was
// killed hard) at the start of the next run.
// Keep MODEL_URL in sync with src/pose/mediapipeAssets.ts.

import { createWriteStream, unlinkSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WASM_SRC = path.join(WEB_ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const OUT_ROOT = path.join(WEB_ROOT, 'public', 'mediapipe')
const WASM_OUT = path.join(OUT_ROOT, 'wasm')
const MODELS_OUT = path.join(OUT_ROOT, 'models')

const MIN_MODEL_BYTES = 1024 * 1024
const IF_MISSING_DOWNLOAD_CAP_MS = 60_000
const TEMP_FILE = /\.(?:download|tmp)-(\d+)$/
const MODEL_URL = (m) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/1/pose_landmarker_${m}.task`

const args = new Set(process.argv.slice(2))
const known = ['--if-missing', '--quiet', '--heavy', '--force', '--help', '-h']
for (const a of args) {
  if (!known.includes(a)) {
    console.error(`[setup-mediapipe] unknown option ${a} (known: ${known.join(' ')})`)
    process.exit(2)
  }
}
if (args.has('--help') || args.has('-h')) {
  console.log('usage: node scripts/setup-mediapipe.mjs [--heavy] [--force] [--if-missing] [--quiet]')
  process.exit(0)
}
const IF_MISSING = args.has('--if-missing')
const QUIET = args.has('--quiet')
const FORCE = args.has('--force')
const MODELS = args.has('--heavy') ? ['lite', 'full', 'heavy'] : ['lite', 'full']

const log = (msg) => {
  if (!QUIET) console.log(`[setup-mediapipe] ${msg}`)
}
const warn = (msg) => console.warn(`[setup-mediapipe] WARNING: ${msg}`)
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
/** Error message incl. undici's cause ("fetch failed" alone says nothing). */
const describe = (err) => {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause instanceof Error ? err.cause : null
  const detail = cause ? (cause.code ?? cause.message) : null
  return detail ? `${err.message}: ${detail}` : err.message
}

/** Temp files this process is writing; removed synchronously if we are interrupted. */
const inflightTemps = new Set()
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    for (const tmp of inflightTemps) {
      try {
        unlinkSync(tmp)
      } catch {
        // already gone
      }
    }
    if (inflightTemps.size) warn('interrupted; removed partial files. The app will fall back to the CDN.')
    process.exit(code)
  })
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** Remove temp files left by an earlier run that was killed (SIGKILL, crash, power loss). */
async function removeStaleTemps() {
  await Promise.all(
    [WASM_OUT, MODELS_OUT].map(async (dir) => {
      let names
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      await Promise.all(
        names.map(async (name) => {
          const pid = Number(TEMP_FILE.exec(name)?.[1] ?? NaN)
          // Leave temp files of a concurrent run that is still alive.
          if (!Number.isInteger(pid) || pid === process.pid || pidAlive(pid)) return
          await unlink(path.join(dir, name)).catch(() => {})
          log(`removed stale ${path.relative(WEB_ROOT, path.join(dir, name))}`)
        }),
      )
    }),
  )
}

async function fileSize(p) {
  try {
    const s = await stat(p)
    return s.isFile() ? s.size : -1
  } catch {
    return -1
  }
}

async function copyWasm() {
  let names
  try {
    names = (await readdir(WASM_SRC)).filter((n) => !n.startsWith('.'))
  } catch {
    throw new Error(`${path.relative(WEB_ROOT, WASM_SRC)} not found; run npm install first`)
  }
  await mkdir(WASM_OUT, { recursive: true })
  let copied = 0
  await Promise.all(
    names.map(async (name) => {
      const src = path.join(WASM_SRC, name)
      const dst = path.join(WASM_OUT, name)
      const [srcSize, dstSize] = await Promise.all([fileSize(src), fileSize(dst)])
      if (srcSize < 0 || srcSize === dstSize) return
      // Copy to a temp name first so an interrupted copy never looks complete.
      const tmp = `${dst}.tmp-${process.pid}`
      inflightTemps.add(tmp)
      try {
        await copyFile(src, tmp)
        await rename(tmp, dst)
      } catch (err) {
        await unlink(tmp).catch(() => {})
        throw err
      } finally {
        inflightTemps.delete(tmp)
      }
      copied++
    }),
  )
  log(copied ? `copied ${copied} wasm file(s) -> public/mediapipe/wasm/` : 'wasm files up to date')
}

async function download(url, dst) {
  const tmp = `${dst}.download-${process.pid}`
  // Bounded wait for the response headers, then an idle timeout while the body streams.
  // A total cap applies only under --if-missing (predev/prebuild): a manual run may take as
  // long as a slow network needs.
  const ctrl = new AbortController()
  let timer
  const arm = (ms, why) => {
    clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(new Error(why)), ms)
  }
  const cap = IF_MISSING
    ? setTimeout(
        () =>
          ctrl.abort(
            new Error(
              `gave up after ${IF_MISSING_DOWNLOAD_CAP_MS / 1000} s; run \`npm run setup:mediapipe\` to finish the download`,
            ),
          ),
        IF_MISSING_DOWNLOAD_CAP_MS,
      )
    : undefined
  const started = Date.now()
  inflightTemps.add(tmp)
  try {
    arm(IF_MISSING ? 8_000 : 20_000, 'timed out waiting for a response')
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('text/html')) throw new Error(`unexpected content-type ${type}`)
    const expected = Number(res.headers.get('content-length') ?? NaN)
    arm(30_000, 'download stalled')
    await pipeline(
      Readable.fromWeb(res.body),
      async function* resetIdleTimer(source) {
        for await (const chunk of source) {
          arm(30_000, 'download stalled')
          yield chunk
        }
      },
      createWriteStream(tmp),
    )
    const size = await fileSize(tmp)
    if (size < MIN_MODEL_BYTES) throw new Error(`file too small (${size} bytes)`)
    if (Number.isFinite(expected) && expected > 0 && size !== expected) {
      throw new Error(`truncated download (${size} of ${expected} bytes)`)
    }
    await rename(tmp, dst)
    log(`downloaded ${path.basename(dst)} (${mb(size)} in ${((Date.now() - started) / 1000).toFixed(1)} s)`)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : err
  } finally {
    inflightTemps.delete(tmp)
    clearTimeout(timer)
    clearTimeout(cap)
  }
}

let announced = false
/** One line before the first download, even with --quiet: predev must never stall silently. */
function announceDownload() {
  if (announced) return
  announced = true
  const n = MODELS.length
  console.error(
    `[setup-mediapipe] downloading MediaPipe pose model(s) into public/mediapipe/models/ ` +
      `(one-time, up to ${n === 3 ? '46' : '15'} MB)` +
      (IF_MISSING ? `; gives up after ${IF_MISSING_DOWNLOAD_CAP_MS / 1000} s` : '') +
      '. Ctrl+C is safe: the app falls back to the CDN.',
  )
}

async function remoteSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8_000) })
    const n = Number(res.headers.get('content-length') ?? NaN)
    return res.ok && Number.isFinite(n) ? n : -1
  } catch {
    return -1
  }
}

async function ensureModel(model) {
  const url = MODEL_URL(model)
  const dst = path.join(MODELS_OUT, `pose_landmarker_${model}.task`)
  const local = await fileSize(dst)
  if (!FORCE && local >= MIN_MODEL_BYTES) {
    if (IF_MISSING) return true
    // Full run: also verify the local copy against the server's size, if reachable.
    const remote = await remoteSize(url)
    if (remote < 0 || remote === local) {
      log(`${path.basename(dst)} present (${mb(local)})`)
      return true
    }
    log(`${path.basename(dst)} size ${local} != remote ${remote}; re-downloading`)
  }
  try {
    announceDownload()
    await download(url, dst)
    return true
  } catch (err) {
    warn(
      `could not download pose_landmarker_${model}.task (${describe(err)}). ` +
        'The app will fall back to loading it from the CDN at runtime.',
    )
    return false
  }
}

async function main() {
  await removeStaleTemps()
  await copyWasm()
  await mkdir(MODELS_OUT, { recursive: true })
  const ok = await Promise.all(MODELS.map(ensureModel))
  if (ok.every(Boolean)) log(`models ready: ${MODELS.join(', ')} -> public/mediapipe/models/`)
}

main().catch((err) => {
  warn(`${describe(err)}. The app will fall back to the MediaPipe CDN at runtime.`)
  // Never block `npm run dev` / `npm run build`; a manual run reports failure.
  process.exit(IF_MISSING ? 0 : 1)
})
