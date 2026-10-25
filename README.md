# Dance Fantasy

*Once upon a time, twelve princesses slipped out every night to dance until their shoes
wore through.* Dance Fantasy turns any song into that ball: upload a track, and the app
analyzes it, generates an original beat-synced dance routine, and plays it as a
Just Dance-style game. A glowing silhouette dancer performs the routine, you dance along in
front of your webcam, and the browser scores every move in real time. Friends in other
homes can join the same room for a live dance-off.

HackTX 2026 · storybook theme.

## Status

| Stage | What | State |
|---|---|---|
| 0 | Scaffold, shared data contract, pose spike, beat spike | ✅ |
| 1 | Audio analysis (`/api/analyze`) + debug timeline | ✅ |
| 2 | Move library (50 moves + mirrors) + choreography generator | ✅ |
| 3 | Glowing coach, smooth motion, `#/play` with cue strip + audio-clock sync | ✅ |
| 4 | Calibration, per-beat webcam scoring, HUD, results (**MVP**, tag `mvp`) | ✅ |
| 5 | Teach mode, judging presets, sound, polish | ✅ |
| 6 | Remote dance-off (rooms, QR join, synced start, live leaderboard, chat) | ✅ |
| 7 | SerpApi signature dances + AI herald (Meta Muse / Gemini) | ✅ |
| 8 | Smarter generation (flagged) | |
| 9 | Deploy + demo hardening | |

## Run it locally

Prerequisites (macOS shown; Linux works the same):

- **Node.js 22+** (Vite 8 needs `^20.19 || >=22.12`)
- **uv**, which also installs Python 3.12 for you: `brew install uv`
  (or `curl -LsSf https://astral.sh/uv/install.sh | sh`)
- A webcam and Chrome, Edge or Safari

```bash
make setup     # first time: Python venv + npm deps + MediaPipe wasm/models (~60 MB)
make dev       # API on :8000 and web on :5173 together; Ctrl-C stops both
```

Open **http://localhost:5173** in Chrome. It opens on the title menu; choose **Play**
(or **Party** to open a ballroom friends join from their phones):

1. Pick a song, difficulty (easy/normal/hard), standing or seated, and press **Start the ball**.
2. **Magic mirror (calibration):** stand back until your whole body is in view (upper body
   when seated), hold a star pose (both hands up and out) for a second, then clap along
   with 8 clicks so the game can measure your camera's delay. `K` skips it.
3. **Dance:** copy the glowing coach like a mirror. Every beat is judged
   **Perfect / Good / OK / Miss** from your limb angles; keep the combo going for bonus
   points. Upcoming moves slide in at the bottom with a 3 · 2 · 1 countdown.
4. **Results:** score, stars, accuracy, your hardest and best moves, then play again or
   get a new routine.

**Before the ball** (lobby): *Just play*, *Watch first* (the coach performs the whole routine
with music, no camera; ←/→ jump a bar, "Skip → I'm ready" anytime), or *Practice run* (full run
with your camera and live feedback but no score, then straight into the real round).

Routines generated on the Analysis page (or in Play) appear under **Your routines** in the
lobby; `#/play?routine=<id>` opens one directly. **Regenerate** always rolls a new seed (same
seed = same routine).

**Learn** (`#/teach`, also "Learn it first" in the lobby and "Practice your hardest move" on
results): pick any 8-count and loop it at 0.5× / 0.75× / 1× (pitch preserved) with live
per-limb tips like "left arm late" or "right arm too high". Two good passes suggest the next
speed; two at full speed earn "Nailed it! ✨".

**Judging** in the lobby: Lenient / Standard / Strict. After a round, **Download session log**
saves per-beat scores and timing (no video or poses) for tuning. Sound effects toggle with `S`.

No camera (or judging from across the room)? Turn on **Autoplay (bot)** in the lobby.
Keys: Space pause, R restart, M mirror, C camera window, D debug overlay (FPS, latency,
sync drift), Esc back to the lobby.

How scoring works: each on-beat pose of a move is a checkpoint. Your upper arms, forearms,
thighs, shins and (for leaning moves) torso are compared with the coach's by 2D direction
(100 within 15°, 0 beyond 60°), taking your best frame within ±150 ms after subtracting the
measured camera delay. Beats where the coach is just resting aren't scored, so standing
still earns nothing. Pose detection runs entirely in your browser.

Dev pages:

- `#/pose`: Spike 1. Click **Start camera**, allow access, and you should see your
  skeleton over the video, a normalized "body frame" view, and FPS (green at 24+).
- `#/beats`: Spike 2. Pick a sample song, **Analyze** to beat-track it on the server,
  then **Play** to hear it with a metronome click and a flashing beat circle.
- `#/analysis`: Stage 1 debug timeline. Pick or upload a song to see its BPM, the full
  beat grid (dashed = filled in from the tempo), downbeats, energy, and sections colored
  by repeat group (every chorus shares a color). Play it, or click a section to jump there,
  and watch the live "Chorus · Bar 13 · beat 4" readout. The **Choreography** panel
  generates a routine (difficulty, standing/seated, seed): moves appear as a timeline row
  and a stick-figure preview dances along during playback.
- `#/moves`: the move library. Every move loops on a stick figure (gold limbs are scored);
  filter by style, difficulty, intensity or seated-friendly.

Without `make`:

```bash
cd server && uv sync && uv run uvicorn app.main:app --reload --reload-dir app --port 8000
cd web && npm install && npm run dev        # in a second terminal
```

Other targets: `make test`, `make server`, `make web`, `make build`, `make songs`
(regenerates the synthetic test songs), `make help`.

Configuration lives in a root `.env` (copy `.env.example`). Nothing is required for
Stages 0–6.

### Troubleshooting

- **Camera blocked**: browsers only allow webcams on `localhost` or HTTPS. On macOS,
  also check System Settings → Privacy & Security → Camera for your browser.
- **"Server offline" in the header**: start the API (`make server`) and check port 8000
  is free (`lsof -i :8000`).
- **Uploads of .m4a/.aac fail**: those need ffmpeg (`brew install ffmpeg`). WAV, MP3,
  FLAC and OGG work out of the box.
- **MediaPipe model didn't download** (offline setup): the app falls back to the CDN;
  rerun `cd web && npm run setup:mediapipe` when online.

## Layout

```
web/       Vite + React + TypeScript (strict). MediaPipe PoseLandmarker runs in the browser.
  src/pose/      webcam, landmarker, MediaPipe → body-frame normalization, skeleton drawing
  src/game/      play screen engine: audio clock, session flow, cue strip, sync meter
  src/render/    coach silhouette, move pictograms, ballroom stage
  src/routine/   routine sampling: smooth rigid-limb motion track
  src/pages/     Play, AnalysisDebug, MoveGallery, PoseSpike, BeatSpike
server/    Python 3.12 + FastAPI + librosa (uv project)
  app/audio/     decoding, beat grid, downbeats, structure (sections) analysis
  app/moves/     move library: angle-based definitions → forward kinematics → 17-joint poses
  app/choreo/    choreographer: beam search over moves, snapped to downbeats, chorus reuse
  app/api/       HTTP routes
  scripts/       make_sample_song.py (synthetic CC0 songs), fetch_example_songs.py
shared/    The data contract: skeleton, routine.schema.json, TS types, docs
assets/    songs/ (samples), moves/ (move definitions, see moves/README.md), routines/
scripts/   dev.sh (starts both servers)
```

Data formats, coordinate conventions and the HTTP API are documented in
[shared/README.md](shared/README.md).

## Deploy (Vercel)

One Vercel project, two services ([vercel.json](vercel.json)): `web/` (static Vite build) and
`server/` (FastAPI as one Python function, `/api/*`). Deploy with `vercel deploy` from the repo root.

- **Database:** rooms and accounts need `DATABASE_URL` (Tiger Data / Timescale Postgres), e.g.
  `postgres://user:pass@host:port/tsdb?sslmode=require`. `sslmode` works like libpq: `require`
  encrypts without checking the certificate (Tiger Cloud signs with its own CA), `verify-full` also
  checks it against `DATABASE_CA_CERT` (the PEM chain from the Tiger console; the public roots
  without it). Without `DATABASE_URL` the rooms and accounts routes answer 503.
- **Region:** the Tiger database is in AWS us-west-2, so the function runs in Vercel's `pdx1`
  (Portland) region (`"regions"` in vercel.json): every room poll is a few database round trips.

- **Shared cache:** each function instance has its own temporary disk, so analyses, routines and
  uploaded audio are mirrored to Vercel Blob ([server/app/blob.py](server/app/blob.py)). This is
  on only when `BLOB_READ_WRITE_TOKEN` is set; locally everything stays in `assets/cache/`.
- **Uploads:** Vercel caps request bodies at 4.5 MB, so the deployed web app (`VITE_BLOB_UPLOADS=1`)
  uploads songs straight to Blob and then calls `POST /api/analyze/blob` with the URL.
- **Bundle size:** librosa's numba/llvmlite, scipy and numpy come to ~430 MB, over the 225 MB
  standard limit, so the project sets `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`.
- **Assets:** the function only contains `server/`, so its build copies `assets/songs` and
  `assets/moves` into `server/assets`.
- **Cold starts:** a fresh instance compiles librosa's beat tracker (numba) on its first analysis,
  ~30 s; later analyses take about a second, and cached ones are instant.

## Privacy

Webcam frames and pose landmarks never leave the browser. Only scores are sent to the
server.

## Music

Only user-uploaded audio and royalty-free samples we add. Each sample song in
`assets/songs/` has a `<name>.json` sidecar with its title, artist, license and source.

- `synth_*.wav`: generated by `server/scripts/make_sample_song.py`, CC0. The sidecars hold
  the true section layout, which the analysis tests check against.
- "Vibe Ace" by Kevin MacLeod, CC BY 3.0
  ([source](https://freemusicarchive.org/music/Kevin_MacLeod/Jazz_Sampler/Vibe_Ace)).
- "Let's Go Fishin'" by Karissa Hobbs, CC BY 3.0
  ([source](https://freemusicarchive.org/music/Karissa_Hobbs/Age_of_Flowers/09_Lets_Go_Fishin)).

Both CC BY tracks come from librosa's example data (`server/scripts/fetch_example_songs.py`).

## AI tools used

Required by the hackathon rules; kept up to date as we go.

- **Claude Code** (Anthropic) helped scaffold and write code.
- **MediaPipe PoseLandmarker** (Google) for in-browser pose estimation.
- **librosa** for beat tracking and music structure analysis.
- **Meta Muse** (Gemini as fallback) writes the royal herald's lines and summarises a song's
  famous dance; **SerpApi** finds the web and YouTube sources for it.
- **three.js** renders the 3D storybook dancer (built from primitives, no model files).
