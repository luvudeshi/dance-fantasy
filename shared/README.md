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
| POST | `/api/rooms/{code}/routine` | host | `{ routineId, analysisId, title, difficulty, mode }` | `RoomView`; lobby or finished only (else 409); back to lobby, scores and ready reset |
| POST | `/api/rooms/{code}/ready` | player | `{ ready: bool }` | `RoomView` |
| POST | `/api/rooms/{code}/start` | host | none | `RoomView` in `countdown`, `startAt = serverNow + 5000`; lobby or finished only, needs a routine (else 409); resets scores and ready |
| POST | `/api/rooms/{code}/score` | player | `{ score, combo, maxCombo, accuracy, progress, finished }` | `RoomView`; ignored (no error) unless `playing` |
| POST | `/api/rooms/{code}/chat` | player | `{ text }` | `RoomView`; 429 after 5 messages in 10 s |
| POST | `/api/rooms/{code}/leave` | player | none | `{ ok: true }`; the host role passes to the next player, an empty room closes |

```jsonc
// RoomView
{ "code": "KQWX", "state": "lobby",      // lobby | countdown | playing | finished
  "hostId": "Zp3k9QxA", "serverNow": 1761380000000, // epoch ms
  "startAt": null,                        // epoch ms once started, else null
  "routine": null,                        // or { routineId, analysisId, title, difficulty, mode }
  "players": [{ "id": "Zp3k9QxA", "name": "Ana", "isHost": true, "ready": false,
                "connected": true,        // seen in the last 10 s
                "score": 0, "combo": 0, "maxCombo": 0, "accuracy": 0, "progress": 0, "finished": false }],
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
- **Chat.** Without `chatAfter`, the latest 50 messages; with it, up to 50 messages with
  `id > chatAfter`, oldest first, so pass the last `id` you have and you never miss one. Rooms
  keep their last 200 messages.
- **Lifetime.** A room expires 3 hours after its last authenticated request.
- **Storage.** Postgres when `DATABASE_URL` is set (Tiger Data on Vercel; TLS is verified unless
  the URL says `sslmode=disable`, or `sslmode=no-verify`); otherwise SQLite at
  `<cache_dir>/rooms.sqlite3`. A Vercel deployment without `DATABASE_URL` answers 503 on every
  rooms route. Tables are `df_rooms`, `df_players`, `df_chat`, created on first use.

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
| POST | `/api/me/rounds` | `{ analysisId, songTitle, score, accuracy, maxCombo, stars, mode }` | `{ ok: true }`; `mode` is `solo`, `party` or `room`; 429 after 120 rounds in an hour |
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
               "maxCombo": 80, "stars": 5, "mode": "solo", "at": 1761380000000 }],
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

Errors use FastAPI's `{ "detail": str }` with 400 (bad input), 404 (unknown song) or
413 (upload too large); the rooms routes add 401, 403, 409, 429 and 503 as above, and the
accounts routes 401, 403, 404, 409 and 429.
