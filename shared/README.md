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
| GET | `/api/moves?source=classic\|aist&mirrors=1` | `MoveLibraryResponse` (`shared/moves.ts`): the compiled moves (classic moves with their L/R variants, real-dancer clips); both parameters optional, see below |
| GET | `/api/moves/sources` | `MoveSourcesResponse`: move counts per source (`library`, `aist`) + the data attribution |
| POST | `/api/choreograph` (JSON `ChoreographRequest`: `analysisId`, `difficulty`, `mode`, `seed`, `moveSource`) | a `routine.json` (`Routine`); 404 if the analysis isn't cached yet |
| GET | `/api/routines/{routineId}` | a previously generated routine (for share links / multiplayer later) |

Generated routines put `routineId`, `generator`, `libraryVersion`, `analysisId`,
`analysisVersion`, `moveSource` and `aistMoves` (how many moves are real-dancer clips; plus `credit`
when there are any) in `meta`. The same request always returns the same routine (cached by
`routineId` = hash of analysis id + versions + difficulty + mode + seed + move source); a new seed
gives a new routine. `moveSource` is `classic` (default: the angle-based library), `aist`
(real-dancer clips from AIST++, library moves only as a fallback and for the closing bow) or `mix`.
Library moves carry `source` (`library` / `aist`) and `credit`; real-dancer clips have
`startAnchor` / `endAnchor` `"free"` and mirrored twins `<id>_m`. Keyframes may carry `root` (rendering-only hip offset, see the schema).

`GET /api/moves` payload (Vercel caps a function response at 4.5 MB):
- By default the real-dancer clips' mirrored twins `<id>_m` are **left out** and each clip that has one
  carries `hasMirror: true`. The twin is the exact geometric mirror of its clip: id `<id>_m`, name
  `<name> (mirrored)`, `mirrorOf: "<id>"`, `side` L <-> R (`both` stays), `scoredJoints` with `l_` / `r_`
  swapped, every keyframe pose `twin[j] = [-clip[mirror(j)][0], clip[mirror(j)][1]]` (`mirror` swaps
  `l_` / `r_`, `skeleton.json`) and `root = [-x, y]`; every other field is the clip's. Routines always
  carry the poses of the moves they use, twins included, so only a move browser needs this.
- `?mirrors=1` lists every move, twins included (about twice the bytes). `?source=classic` (or `library`)
  / `?source=aist` keeps one source; anything else is 400. The classic moves' own L/R variants (`_L` / `_R`)
  are always listed.
- Coordinates are rounded to 3 decimals (0.001 body units); `t` is exact.
- Big JSON responses (`/api/moves`, `/api/choreograph`, `/api/routines/{id}`) are gzip-encoded for
  clients that send `Accept-Encoding: gzip` (browsers do): ~2.7 MB -> ~0.54 MB for the default listing.

Stage 6 endpoints (remote dance-off rooms; models in `server/app/rooms/models.py`):

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/api/rooms` | none | `{ name }` | `{ code, playerId, token }`; the creator is the host |
| POST | `/api/rooms/{code}/join` | none | `{ name }` | `{ playerId, token }`; 409 when 8 players are in |
| GET | `/api/rooms/{code}?chatAfter=<id>` | optional | | with a seat token: `RoomView`, and marks that player seen (401 for a token not in this room); without one only `{ code, state, playerCount, mode }` (no players, no chat) |
| POST | `/api/rooms/{code}/routine` | host | `{ routineId, analysisId, title, difficulty, mode }` | `RoomView`; the routine must be one this server generated for that `analysisId` (else 404); lobby or finished only (else 409); back to lobby, scores, ready and crew sync reset |
| POST | `/api/rooms/{code}/ready` | player | `{ ready: bool }` | `RoomView` |
| POST | `/api/rooms/{code}/start` | host | none | `RoomView` in `countdown`, `startAt = serverNow + 5000`; lobby or finished only, needs a routine (else 409); resets scores, ready and crew sync |
| POST | `/api/rooms/{code}/score` | player | `{ score, combo, maxCombo, accuracy, progress, finished }` | `RoomView`; ignored (no error) unless `playing` |
| POST | `/api/rooms/{code}/chat` | player | `{ text }` | `RoomView`; 429 after 5 messages in 10 s |
| POST | `/api/rooms/{code}/leave` | player | none | `{ ok: true }`; the host role passes to the next player, an empty room closes |
| POST | `/api/rooms/{code}/mode` | host | `{ mode: "versus" \| "crew" }` | `RoomView`; lobby or finished only (else 409); kept across routines and rematches; new rooms are `versus` |
| POST | `/api/rooms/{code}/beats` | player | `{ beats: [{ beat, score, grade }] }` (0-64) | `RoomView`; per-beat judgements, about once a second; ignored (no error) unless `playing` and you haven't posted `finished: true` |
| POST | `/api/rooms/{code}/rematch` | host | none | `RoomView` in `countdown`, `startAt = serverNow + 5000`, same routine and mode; finished only (else 409); scores, ready, beats and sync reset |
| GET | `/api/songs/{analysisId}/heatmap` | none | | `{ analysisId, beats: [{ beat, avgScore, samples }] }` by beat: each room round's average score on the beat (clamped to 0-100), averaged over rounds, so every round weighs the same; `samples` is the number of rounds. The song's hardest moments are the lowest `avgScore` |

Guessing codes: 20 lookups of unknown codes (404 on `GET /api/rooms/{code}` or `/join`) in a minute make
every lookup from that client answer 429 (with `Retry-After`) until the minute is up.

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
  `startAt`) and the heatmap reads `df_round_heat`, a real-time continuous aggregate of clamped
  score sums per (song, room round, beat) refreshed every 15 minutes; elsewhere it reads
  `df_room_beats` directly.

AI endpoints (sponsor tracks; server/app/ai, keys in `.env.example`). Meta Muse answers first, Gemini is the
fallback (`AI_PROVIDER=gemini` swaps them). Prompts and model output are never logged.

| Method | Path | Returns |
|---|---|---|
| POST | `/api/announcer` (JSON `AnnouncerRequest`) | `{ lines: string[], items: { id, text }[], source: "muse" \| "gemini" \| "canned" }`: 1-3 lines, each ≤ 90 chars; `items` are the same lines with ids. 429 over 120 requests/min per client |
| GET | `/api/announcer/voice/{id}` | `audio/wav` (16-bit mono, 24 kHz): the line voiced by the herald (Gemini TTS, cached forever). 404 unless `/api/announcer` gave that line out, 429 over 40 requests/min per client, 503 not cached and no `GEMINI_API_KEY` (or TTS down) |
| GET | `/api/songs/signature?analysisId=` (or `?file=` for a library song) | `Signature` (below), for a song the server knows: title and artist come from its analysis (or the library), never the caller. 404 unknown song, or without `SERPAPI_API_KEY` + an LLM key (unless cached); 502 search failed; 503 no usable AI answer, 2 lookups already running, or the day's 150 lookups used |

A line's `id` is the sha256 hex of its UTF-8 text, so a client holding only the text can compute it
(web/src/voice). The voice route never takes text: it only voices lines the announcer returned (fixed canned
lines are pre-voiced by `server/scripts/pregen_voice.py`; `GEMINI_TTS_VOICE` picks the voice).

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

// GET /api/songs/signature. Cached per analysis, so a repeat costs no searches.
interface Signature {
  found: boolean               // false: no well-known dance; summary says so
  summary: string              // 2-3 plain sentences on the signature moves
  keyMoments: { label: string; approxTimeSec?: number }[]   // ≤ 5
  suggestedMoveIds: string[]   // ≤ 8, always ids in GET /api/moves (re-checked on every read)
  sources: { title: string; link: string; thumbnail?: string; source: string }[]  // ≤ 6, http(s) links
}
```

Accounts endpoints (guest accounts, optional login, profiles, friends, history; models in
`server/app/accounts/models.py`). Auth is the `df_session` cookie; every non-GET request also
sends the header `X-DF: 1` (403 without it).

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/session` | none | `Me`; the cookie's account, or a new guest (sets the cookie). Call it once at app start |
| POST | `/api/account/claim` | `{ username, password }` | `Me` with `isGuest: false`; 409 if this account already has one or the username is taken |
| POST | `/api/login` | `{ username, password }` | `Me`; this browser switches to that account. 401 wrong username or password, 429 when locked out |
| POST | `/api/logout` | none | `Me` of a fresh guest (new cookie) |
| GET | `/api/me` | | `Me` |
| PATCH | `/api/me` | `{ name?, avatar?, color? }` | `Me` |
| POST | `/api/me/heartbeat` | none | `{ ok: true }`; marks you online (any authenticated call does too) |
| GET | `/api/friends` | | `Friend[]`, online first, then by name |
| POST | `/api/friends` | `{ code }` (a friend code) | `Friend`; mutual right away. 404 unknown code, 400 your own, 409 already friends, 429 after 10 unknown codes in 10 min |
| DELETE | `/api/friends/{id}` | | `{ ok: true }`; removes both sides; 404 if not friends |
| POST | `/api/friends/{id}/invite` | `{ roomCode }` | `{ ok: true }`; must be friends (404) and the room live (404); 429 after 20 invites in 10 min. Re-inviting renews the same invite |
| GET | `/api/me/invites` | | `Invite[]`, newest first: not dismissed and under 10 min old |
| POST | `/api/me/invites/{id}/dismiss` | none | `{ ok: true }`; 404 unless it was sent to you |
| POST | `/api/me/rooms` | `{ roomCode, playerToken }` | `{ ok: true }`; records that you played in that room. The token is the one from create/join (401 if it isn't a player of that room, 404 unknown room) |
| GET | `/api/me/partners` | | `Partner[]`: accounts that recorded a room you recorded, last 30 days, most recent first (max 20) |
| POST | `/api/me/rounds` | `{ analysisId, songTitle, score, accuracy, maxCombo, stars, mode }` | `{ ok: true }`; `score` and `maxCombo` integers, `accuracy` 0-100, `stars` 0-5 (fractions ok), `mode` `solo`, `party` or `room`; 429 after 120 rounds in an hour |
| GET | `/api/me/history?tzOffset=<min>` | | `History`: last 20 rounds and totals. `tzOffset` is `new Date().getTimezoneOffset()` (for the day streak), default 0 |

```jsonc
// Me
{ "id": "q3V9kZ2xAb1c", "name": "Twirling Pumpkin", "avatar": "pumpkin", "color": "rasp",
  "friendCode": "K7QX2M", "isGuest": true, "username": null,
  "stats": { "rounds": 12, "bestScore": 48210, "friends": 3 } }
// Friend
{ "id": "...", "name": "Bo", "avatar": "wolf", "color": "blue",
  "online": true,          // any authenticated call in the last 60 s
  "inRoom": "KQWX" }       // a room they recorded via /api/me/rooms and are connected to (else null)
// Partner
{ "id": "...", "name": "Cy", "avatar": "crown", "color": "gold", "friendCode": "P4RT9Z",
  "online": false, "isFriend": false, "lastPlayedAt": 1761380000000 }  // add with POST /api/friends { code: friendCode }
// Invite
{ "id": 7, "fromId": "...", "fromName": "Ana", "fromAvatar": "slipper", "fromColor": "rasp",
  "roomCode": "KQWX", "at": 1761380000000 }  // join with POST /api/rooms/{roomCode}/join
// History
{ "rounds": [{ "analysisId": "<64 hex>", "songTitle": "Vibe Ace", "score": 48210, "accuracy": 91.5,
               "maxCombo": 80, "stars": 4.5, "mode": "solo", "at": 1761380000000 }],
  "totalRounds": 12, "bestScore": 48210, "avgAccuracy": 84.27,
  "dayStreak": 3 }         // consecutive local days with a round, ending today or yesterday
```

- **Same origin only.** The cookie is httpOnly, `SameSite=Lax`, `Path=/`, 180 days (renewed by
  `POST /api/session`), `Secure` over https. Use relative `/api/...` URLs with
  `credentials: 'same-origin'` (fetch's default): the Vite proxy in dev, one deployment on Vercel.
  A cross-origin `VITE_API_BASE` never carries the cookie. The other routes here, without a
  valid session, answer 401 `"No session: call POST /api/session first."`; call it and retry once.
- **Guests are full accounts.** Everything works without a login; `claim` only adds a username
  (3-20 of `a-z 0-9 _`, lowercased for you) and a password (8-200 chars, scrypt with a per-user
  salt) so the same account can log in elsewhere. Claim and login issue a new session token. A
  login from a guest leaves that guest's data behind (no merge).
- **Login limits.** 5 wrong passwords per username in 15 min lock that username (429, even with
  the right password) until the window passes; 50 per client IP in 15 min likewise. New guests:
  300 per client IP an hour.
- **Profile values.** `name` follows the room-name rules (1-24 chars, whitespace collapsed, no
  control characters). `avatar` is one of the sticker icon names in `web/src/theme/icons.ts`
  (`ICON_NAMES`; guests start on one of the first 28); `color` is one of `rasp`, `gold`, `blue`,
  `sage`, `burg`, `night`, i.e. the `--df-<color>` design tokens. Anything else is 400.
- **Friend codes** are 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I, L, O, 0, 1);
  input ignores case, spaces and dashes.
- **Storage.** Same database as rooms (`df_accounts`, `df_sessions`, `df_friends`, `df_invites`,
  `df_room_members`, `df_hits`, `df_rounds`, created on first use). On Postgres with the
  `timescaledb` extension (Tiger Data), `df_rounds` is a hypertable on `at` (epoch ms, 7-day chunks).
  Like rooms, a Vercel deployment without `DATABASE_URL` answers 503 here.

Errors use FastAPI's `{ "detail": str }` with 400 (bad input), 404 (unknown song) or
413 (upload too large); the rooms routes add 401, 403, 409, 429 and 503 as above, and the
accounts routes 401, 403, 404, 409 and 429.
