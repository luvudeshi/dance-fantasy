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

Stage 6 endpoints (remote dance-off rooms; models in `server/app/rooms/models.py`):

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/api/rooms` | none | `{ name }` | `{ code, playerId, token }`; the creator is the host |
| POST | `/api/rooms/{code}/join` | none | `{ name }` | `{ playerId, token }`; 409 when 8 players are in |
| GET | `/api/rooms/{code}?chatAfter=<id>` | optional | | `RoomView`; with a token, marks that player seen |
| POST | `/api/rooms/{code}/routine` | host | `{ routineId, analysisId, title, difficulty, mode }` | `RoomView`; lobby or finished only (else 409); back to lobby, scores, ready and crew sync reset |
| POST | `/api/rooms/{code}/ready` | player | `{ ready: bool }` | `RoomView` |
| POST | `/api/rooms/{code}/start` | host | none | `RoomView` in `countdown`, `startAt = serverNow + 5000`; lobby or finished only, needs a routine (else 409); resets scores, ready and crew sync |
| POST | `/api/rooms/{code}/score` | player | `{ score, combo, maxCombo, accuracy, progress, finished }` | `RoomView`; ignored (no error) unless `playing` |
| POST | `/api/rooms/{code}/chat` | player | `{ text }` | `RoomView`; 429 after 5 messages in 10 s |
| POST | `/api/rooms/{code}/leave` | player | none | `{ ok: true }`; the host role passes to the next player, an empty room closes |
| POST | `/api/rooms/{code}/mode` | host | `{ mode: "versus" \| "crew" }` | `RoomView`; lobby or finished only (else 409); kept across routines and rematches; new rooms are `versus` |
| POST | `/api/rooms/{code}/beats` | player | `{ beats: [{ beat, score, grade }] }` (0-64) | `RoomView`; per-beat judgements, about once a second; ignored (no error) unless `playing` and you haven't posted `finished: true` |
| POST | `/api/rooms/{code}/rematch` | host | none | `RoomView` in `countdown`, `startAt = serverNow + 5000`, same routine and mode; finished only (else 409); scores, ready, beats and sync reset |
| GET | `/api/songs/{analysisId}/heatmap` | none | | `{ analysisId, beats: [{ beat, avgScore, samples }] }` by beat: the average judgement score on each beat across every room and round, i.e. the song's hardest moments (lowest `avgScore`) |

```jsonc
// RoomView
{ "code": "KQWX", "state": "lobby",      // lobby | countdown | playing | finished
  "hostId": "Zp3k9QxA", "serverNow": 1761380000000, // epoch ms
  "startAt": null,                        // epoch ms once started, else null
  "routine": null,                        // or { routineId, analysisId, title, difficulty, mode }
  "mode": "versus",                       // versus | crew (the room's; routine.mode is standing | seated)
  "players": [{ "id": "Zp3k9QxA", "name": "Ana", "isHost": true, "ready": false,
                "connected": true,        // seen in the last 10 s
                "score": 0, "combo": 0, "maxCombo": 0, "accuracy": 0, "progress": 0, "finished": false,
                "beatsWon": 0 }],         // versus: beats where this player had the best score
  "leaderId": null,                       // versus: most beatsWon, then score; null on a tie or before any beat
  "crew": { "teamScore": 0,               // everyone's score + syncBonus
            "syncBonus": 0, "syncedBeats": 0, "syncStreak": 0, "bestSyncStreak": 0,
            "lastSyncBeat": null },        // beat index of the latest synced beat
  "chat": [{ "id": 12, "playerId": "Zp3k9QxA", "name": "Ana", "text": "ready?", "at": 1761379990000 }] }
```

- **Polling.** Clients poll `GET` about once a second (no WebSockets: the API runs as stateless
  Vercel Functions). Every write answers with the same `RoomView` as `GET` and accepts the same
  `?chatAfter=`, so a write doubles as that second's poll. `players` are in join order; sort
  them for a leaderboard yourself.
- **Auth.** Writes send the `token` from create/join as the `X-Player-Token` header: 401 when it is
  missing or not a player of this room (e.g. after `leave`), 403 when a non-host tries a host
  action. A `GET` with an invalid token is also 401; without a token it is an anonymous viewer
  (e.g. a big screen) and nobody is marked seen. Keep `playerId`/`token` per room code in
  `sessionStorage` so a reload rejoins as the same player.
- **Codes.** 4 letters from `ABCDEFGHJKMNPQRSTUVWXYZ` (no I, L, O); case-insensitive in paths.
  Unknown, malformed or expired codes are 404. Suggested QR target: `<origin>/#/room?code=KQWX` (the web app owns the route).
- **Names** (1-24 chars) and chat `text` (1-200) are trimmed with inner whitespace collapsed;
  control characters are 400. A taken name gets a suffix (`Ana`, `ana 2`).
- **State is derived from time.** `countdown` while `serverNow < startAt`, then `playing`, then
  `finished` once every connected player has posted `finished: true` or 10 minutes after
  `startAt`; `finished` sticks until the host picks a routine or starts again (a rematch).
  Synced start: start the music at local time `startAt - (serverNow - Date.now() at receipt)`,
  i.e. correct for clock offset using `serverNow`; half the request's round trip is the error.
- **Scores.** `score`, `combo`, `maxCombo` are non-negative integers, `accuracy` is 0-100 (percent,
  like the results screen), `progress` 0-1 through the song; post about once a second while
  playing and once with `finished: true` at the end (it never goes back to false). Someone who
  joins mid-song sits it out (`finished: true`, score 0) and plays the next one.
- **Beats.** `beat` is the routine's beat/checkpoint index (an integer 0-20000, the same numbering
  on every dancer's device), `score` 0-100, `grade` `perfect | good | ok | miss`. Send each
  judgement once it is final, batched about once a second (at most 64 per call), and the last
  batch *before* the `finished: true` score. Idempotent per player and beat: a beat you already
  sent keeps its first judgement, so retrying a failed call is safe. Beats further than the song
  can have reached (8 a second since `startAt`, plus 32) are dropped. Both modes' numbers are
  computed in every room; `mode` says which one to show.
- **Versus.** Each beat goes to the best score on it (ties count for everyone tied; a beat everyone
  scored 0 goes to nobody); `beatsWon` counts them this round. `leaderId` is the player with the
  most beats won, then the higher `score`.
- **Crew.** A beat is in sync when every *active* dancer (connected and not finished; so not
  someone who left, dropped out for 10 s, or joined mid-song) judged it `good` or `perfect`.
  Beats are decided in order once every active dancer has sent that far, or the furthest one is
  16 beats ahead (whoever hasn't sent it then breaks the sync), and never change after that. A
  beat nobody active judged is skipped. Each synced beat adds `25 x min(syncStreak, 8)` to
  `syncBonus` (so a long streak is worth 200 a beat); any other beat resets `syncStreak`.
- **Chat.** Without `chatAfter`, the latest 50 messages; with it, up to 50 messages with
  `id > chatAfter`, oldest first, so pass the last `id` you have and you never miss one. Rooms
  keep their last 200 messages.
- **Lifetime.** A room expires 3 hours after its last authenticated request.
- **Storage.** Postgres when `DATABASE_URL` is set (Tiger Data on Vercel; TLS is verified unless
  the URL says `sslmode=disable`, or `sslmode=no-verify`); otherwise SQLite at
  `<cache_dir>/rooms.sqlite3`. A Vercel deployment without `DATABASE_URL` answers 503 on every
  rooms route. Tables are `df_rooms`, `df_players`, `df_chat`, `df_room_beats`, created (and new
  columns added) on first use. Beat judgements outlive their room, for the heatmap. On Postgres
  with the `timescaledb` extension, `df_room_beats` is a hypertable on `round_ms` (the round's
  `startAt`) and the heatmap reads `df_beat_heat`, a real-time continuous aggregate of score sums
  per (song, beat, day) refreshed every 15 minutes; elsewhere it reads `df_room_beats` directly.

AI endpoints (sponsor tracks; server/app/ai, keys in `.env.example`). Meta Muse answers first, Gemini is the
fallback (`AI_PROVIDER=gemini` swaps them). Prompts and model output are never logged.

| Method | Path | Returns |
|---|---|---|
| POST | `/api/announcer` (JSON `AnnouncerRequest`) | `{ lines: string[], source: "muse" \| "gemini" \| "canned" }`: 1-3 lines, each ≤ 90 chars |
| GET | `/api/songs/signature?title=&artist=` | `Signature` (below); 404 without `SERPAPI_API_KEY` + an LLM key (unless cached), 502 search failed, 503 no usable AI answer |

```ts
// POST /api/announcer. Always 200 within ~2.5 s: no key, a slow model or a bad reply gives canned lines
// (source "canned"). Identical requests within 30 s get the same answer.
interface AnnouncerRequest {
  event: 'intro' | 'combo' | 'streak_broken' | 'perfect_run' | 'results'
  context: {
    songTitle: string          // required, ≤ 200 chars
    playerName?: string        // ≤ 40
    score?: number             // int ≥ 0
    accuracy?: number          // percent 0..100, like the results screen
    combo?: number; maxCombo?: number
    grade?: string             // e.g. the rank title, "Belle of the Ball"
    stars?: number             // 0..5
    bestMove?: string; hardestMove?: string   // display names
    difficulty?: string
  }
}

// GET /api/songs/signature. Cached by title + artist (case-insensitive), so a repeat costs no searches.
interface Signature {
  found: boolean               // false: no well-known dance; summary says so
  summary: string              // 2-3 plain sentences on the signature moves
  keyMoments: { label: string; approxTimeSec?: number }[]   // ≤ 5
  suggestedMoveIds: string[]   // ≤ 8, always ids in GET /api/moves (re-checked on every read)
  sources: { title: string; link: string; thumbnail?: string; source: string }[]  // ≤ 6, http(s) links
}
```

Errors use FastAPI's `{ "detail": str }` with 400 (bad input), 404 (unknown song) or
413 (upload too large); the rooms routes add 401, 403, 409, 429 and 503 as above.
