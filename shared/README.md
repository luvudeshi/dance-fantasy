# Shared data formats

Everything the web app and the server must agree on lives here. These formats are
**stable**: change the schema, the TypeScript types and the Pydantic models together,
and run `make test` (contract tests fail if they drift).

| File | What |
|---|---|
| `skeleton.json` | Canonical joint list, MediaPipe index map, mirror map, bones, scored limbs |
| `skeleton.ts` | Same, as typed TS constants (web) |
| `routine.schema.json` | JSON Schema (draft 2020-12) for `routine.json` |
| `routine.ts` | TS types for `routine.json` (web) |
| `analysis.schema.json`, `analysis.ts` | Song analysis returned by the server (Stage 1) |
| `moves.ts` | Move library + choreograph request types (Stage 2); server side in `server/app/moves/types.py` |
| `examples/routine.example.json` | Small valid routine used by tests |
| `../server/app/skeleton.py`, `../server/app/routine.py` | Python side (Pydantic v2) |

## Skeleton

17 COCO-style joints, always in this order:

```
nose, l_eye, r_eye, l_ear, r_ear, l_shoulder, r_shoulder, l_elbow, r_elbow,
l_wrist, r_wrist, l_hip, r_hip, l_knee, r_knee, l_ankle, r_ankle
```

`l_`/`r_` are the **dancer's anatomical** left/right. MediaPipe PoseLandmarker's 33
landmarks map onto these by `mediapipeIndex` (nose 0, eyes 2/5, ears 7/8, shoulders
11/12, elbows 13/14, wrists 15/16, hips 23/24, knees 25/26, ankles 27/28). MediaPipe's
left/right are also anatomical, so no swap is needed when mapping.

## Body frame (all stored poses)

Every pose in a routine, and every player pose before scoring, is in this frame:

- **Origin**: mid-hip = midpoint of `l_hip` and `r_hip`.
- **Scale**: the mid-shoulder to mid-hip distance is 1 (so `mid_shoulder ≈ (0, -1)`).
- **+x**: toward the dancer's anatomical **right** (`r_shoulder.x > 0` when facing front).
- **+y**: down, like canvas (feet have positive y, head negative).
- No rotation normalization: a lean stays a lean.

Typical neutral standing pose: shoulders `(±0.45, -1)`, hips `(±0.22, 0)`, nose
`(0, -1.45)`, ankles `(±0.22, 1.85)`. See `examples/routine.example.json`.

### From MediaPipe to the body frame

MediaPipe returns `x, y` normalized to the **raw** (unmirrored) camera frame. Convert to
pixels first so both axes use the same unit, then:

```
p        = (lm.x * videoWidth, lm.y * videoHeight)
midHip   = (p[l_hip] + p[r_hip]) / 2
midSh    = (p[l_shoulder] + p[r_shoulder]) / 2
torsoPx  = |midSh - midHip|
body.x   = -(p.x - midHip.x) / torsoPx      // camera faces the dancer: their right is image-left
body.y   =  (p.y - midHip.y) / torsoPx
```

### Drawing a body-frame pose

```
mirrored (default, coach dancer and webcam self-view): screenX = cx + x * s
true view (dancer seen from the front):               screenX = cx - x * s
screenY = cy + y * s
```

"Mirrored" means the figure looks like the player's reflection: when the routine says
`r_wrist` goes up, the arm on the **right side of the screen** goes up, and the player
raises their right arm. This matches Just Dance, where the coach mirrors the player.

## routine.json

See `routine.schema.json` for the exact contract. Semantics beyond the schema (enforced by
the Pydantic models and tests):

- `song.beats` and `song.downbeats` are ascending seconds; `downbeats ⊂ beats`.
- `move.startBeat` indexes `song.beats`; `move.startTime == song.beats[startBeat]`.
- `move.endTime > move.startTime`; moves are in playback order and don't overlap.
- `keyframes` are ascending by `t ∈ [0, 1]` (fraction of the move). Generated routines
  include all 17 joints in every keyframe.
- `scoredJoints`: a limb (see `skeleton.json → limbs`) is scored when its distal joint
  is listed. `torso` runs from `mid_hip` to `mid_shoulder`. Seated mode ignores
  `legJoints`.
- `meta` is free-form and optional.
- Python: serialize with `Routine.to_json_dict()` (drops unset optionals).

## HTTP API

Dev: the Vite server proxies `/api/*` and `/ws/*` to the FastAPI server on port 8000.

Stage 0 endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ "status": "ok", "version": str }` |
| GET | `/api/songs` | `[{ "file": str, "title": str, "sizeBytes": int }]` — audio files in `assets/songs/` |
| GET | `/api/songs/{file}` | the audio file (for playback) |
| GET | `/api/spike/beats?song={file}` | `BeatResult` for a file in `assets/songs/` |
| POST | `/api/spike/beats` (multipart field `file`) | `BeatResult` for an uploaded file |

```jsonc
// BeatResult
{ "song": "synth_120bpm.wav", "durationSec": 64.0, "sampleRate": 22050,
  "tempo": 120.2,          // librosa's global tempo estimate (BPM)
  "bpmFromBeats": 120.0,   // 60 / median inter-beat interval (more precise)
  "beats": [0.51, 1.01],   // beat times in seconds
  "elapsedMs": 412.3 }
```

Stage 1 endpoints (song analysis; responses match `analysis.schema.json` / `analysis.ts`):

| Method | Path | Returns |
|---|---|---|
| POST | `/api/analyze` (multipart `file`, optional form field `title`) | `Analysis`; the upload is stored by content hash |
| GET | `/api/songs/{file}/analysis` | `Analysis` for a library song |
| GET | `/api/analysis/{id}` | cached `Analysis` (404 if never analyzed) |
| GET | `/api/audio/{id}` | an uploaded song's audio, by content hash (on Vercel: may redirect to its Blob URL) |
| POST | `/api/blob/upload` | Vercel only: `@vercel/blob` client `upload()` token endpoint (`handleUploadUrl`) |
| POST | `/api/analyze/blob` `{ url, filename?, title? }` | Vercel only: like `/api/analyze`, for a song the browser uploaded to Blob |

Vercel caps request bodies at 4.5 MB, so deployed builds (`VITE_BLOB_UPLOADS=1`) upload to Blob
first; the two Blob routes answer 404 when `BLOB_READ_WRITE_TOKEN` is unset (local dev).

Add `?refresh=1` to the first two to bypass the cache. Results are cached on disk by
`sha256(audio bytes)` + `analysisVersion`, so the same file is analyzed once.

`Analysis` essentials: `beats` cover the whole song (gaps filled from the tempo grid,
listed in `filledBeats`); `downbeats = beats[downbeatPhase::4]` (4/4 assumed);
`sections` are contiguous, bar-aligned, labeled `intro | verse | chorus | bridge | outro`,
and carry a `group` letter: sections with the same letter repeat the same music, so the
choreographer reuses their moves. A routine's `song` is derived from an `Analysis` by
keeping `id, title, artist, durationSec, bpm, beats, downbeats` and each section's
`start, end, label, energy`.

Stage 2 endpoints (moves + choreography):

| Method | Path | Returns |
|---|---|---|
| GET | `/api/moves` | `MoveLibraryResponse` (`shared/moves.ts`): every compiled move incl. mirrored variants |
| POST | `/api/choreograph` (JSON `ChoreographRequest`: `analysisId`, `difficulty`, `mode`, `seed`) | a `routine.json` (`Routine`); 404 if the analysis isn't cached yet |
| GET | `/api/routines/{routineId}` | a previously generated routine (for share links / multiplayer later) |

Generated routines put `routineId`, `generator`, `libraryVersion`, `analysisId` and
`analysisVersion` in `meta`. The same request always returns the same routine (cached by
`routineId` = hash of analysis id + versions + difficulty + mode + seed); a new seed gives a
new routine. Keyframes may carry `root` (rendering-only hip offset, see the schema).

Errors use FastAPI's `{ "detail": str }` with 400 (bad input), 404 (unknown song) or
413 (upload too large).

## Signature dances (flagged: `?signature=1` or localStorage `mb.signature` = `"1"`)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/signature/lookup?title=&artist=` | `SignatureLookup` (below); 400 without a title |
| GET | `/api/signature/moves` | `{ version, moves }`: `LibraryMove`s from `assets/moves/signature/` plus `signatureDance`, `songs`, `creator` |

`POST /api/choreograph` takes an optional `pinnedMoves: [{ moveId, placement: "chorus" | "drop" | "finale" }]`
(signature move ids, at most 4). Each pinned move starts on the first downbeat of every matching section (no
labeled chorus: every occurrence of the highest-energy repeated section group); the beam search fills the
rest. Pinned moves carry `signatureDance: { name, creator? }` in the routine, and `meta.pinnedMoves` echoes the
request. Without `pinnedMoves` the routine and its `routineId` are exactly what they were before.

```jsonc
// SignatureLookup. Bundled table first, then SerpApi (SERPAPI_API_KEY) + Gemini (GEMINI_API_KEY), cached 24 h.
{ "title": "Lottery (Renegade)", "artist": "", "found": true,
  "danceName": "The Renegade", "creator": "Jalaiah Harmon",   // creator "" when unknown (never guessed)
  "year": null, "confidence": 1.0,
  "links": [{ "title": str, "url": "https://…", "source": "YouTube" }],  // links only, never downloaded
  "source": "table",            // table | serpapi | gemini | library | none
  "moveId": null, "moveName": null }  // a signature move to pin, when one exists
```
