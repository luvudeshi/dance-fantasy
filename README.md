# Dance Fantasy

*Once upon a time, twelve princesses slipped out every night to dance until their slippers
wore through.* **Dance Fantasy** turns any song into that ball. Bring a track and the game
analyzes it, choreographs an original beat-synced routine, and plays it Just Dance-style: a
3D princess (or prince) performs the routine, you dance along in front of your webcam, and
the browser scores every move in real time. Dance alone, with friends on one camera, or in an
online ballroom with friends on their own phones and laptops.

**Play it:** https://midnight-ball.vercel.app · HackTX 2026 · storybook theme

- [What you can do](#what-you-can-do)
- [How it works](#how-it-works)
- [Built with](#built-with)
- [Run it locally](#run-it-locally)
- [Tests](#tests)
- [Deploy (Vercel)](#deploy-vercel)
- [Project layout](#project-layout)
- [Team](#team) · [Privacy](#privacy) · [Music](#music) · [AI tools used](#ai-tools-used)

## What you can do

**Dance any song.** Pick a song from the library or upload your own (MP3, WAV, FLAC, OGG).
The server finds its beats, bars and sections (intro, verse, chorus, bridge, outro) and
choreographs a routine that never existed before: moves land on the downbeats, every chorus
repeats the same moves, and difficulty (easy / normal / hard) and standing or seated mode change
which moves it picks.

**Follow the 3D dancer.** A storybook princess or prince (your choice in Settings) dances the
routine in the middle of a midnight ballroom. Upcoming moves slide in at the bottom as 3D cue
cards with a 3 · 2 · 1 countdown, and the limbs that count for points wear gold gloves.

**Get scored on every beat.** Your webcam pose is compared with the dancer's on every beat:
**Perfect / Good / OK / Miss**, combos multiply your points, and the results screen shows your
score, stars, accuracy, best combo, and your best and hardest moves (with a button to practice
the hardest one).

**Signature dances.** If a song has a famous dance (YMCA arms, a TikTok challenge), the game
looks it up and **builds those moves into your routine**: they land on the chorus, a banner
announces them, and they score double. The lookup uses a bundled table first, then SerpApi web
and YouTube search with Gemini naming the dance, cached per song.

**The Royal Herald.** An over-the-top announcer cheers your intro, combo milestones, broken
streaks, perfect runs and results, in a speech bubble and out loud (Gemini text-to-speech, the
"Fenrir" voice, with the browser's voice as a fallback). The music dips while it speaks.

**Highlight reel.** The combo cam records your best streaks during the round and plays them
back as a reel on the results screen, ready to download or share.

**Learn mode.** Loop any 8-count at 0.5× / 0.75× / 1× (pitch preserved) with live per-limb tips
such as "left arm late" or "right arm too high". Two good passes suggest the next speed; two at
full speed earn "Nailed it!". Open it from the menu (Learn), the lobby ("Learn it first") or
results ("Practice your hardest move").

**Party mode: friends on one camera.** 2 to 4 dancers in front of the same laptop, each tracked
and scored separately, with their own colour, name and combo, a podium at the end, and titles
such as Belle of the Ball, Most in Sync, Unbroken Spell and Glass Slipper.

**Ballrooms: friends on their own devices.** Open a ballroom and friends join by scanning the QR
code or typing the 4-letter code on their phone or laptop (up to 8 dancers). Chat in the lobby,
pick the song, and everyone starts on the same beat after a shared countdown. Choose a mode:

- **Versus**: who dances best. Each beat goes to whoever scored highest; a live leaderboard and
  a beats-won tally run during the song, and a podium ends it.
- **Crew**: dance as one. A beat counts as *in sync* when everyone hits it, sync streaks grow a
  team bonus, and the team score is the headline.

After a round the host can call a **Rematch**, and a "hardest moments" chart shows which beats
of the song trip dancers up across every ballroom.

**Your dance card (accounts).** Everyone gets a guest account automatically, kept in a cookie, so
there is nothing to sign up for. Your card has a name, a sticker avatar, a colour and a friend
code. Add friends by code, see who's online, invite them to your ballroom with one tap, find the
people you just danced with under *recent partners*, and look back at your play history and
best scores. Want the same card on another device? Optionally keep it with a username and
password and log in there. Accounts, sessions and history live in Tiger Data.

**Everything else.** The **Studio** shows what the game hears (BPM, beat grid, downbeats,
energy, sections) and choreographs any song for you to preview. The **Move Book** shows every
move looping in 3D, with its length, energy (Chill to Cardio) and difficulty, and filters by
style, difficulty, energy or seated-friendly. **Settings** cover the dancer (princess / prince),
3D on/off, the herald and its voice, the highlight reel, difficulty and mode, judging
(Lenient / Standard / Strict / Relaxed) and scoring version, sound, the camera window and
mirroring, recalibration, and calm motion. **How to Play** explains the rules.

## How it works

```
 browser (web/)                                            server (server/, FastAPI)
 ─────────────────────────────────────                     ──────────────────────────────────
 webcam → MediaPipe PoseLandmarker (in browser)            song → librosa: beats, downbeats,
   → 17-joint body-frame pose                                      sections, energy
   → per-beat judging vs the routine ─┐                     analysis + move library
 routine → 3D dancer (three.js)       │   /api/* (HTTPS)      → choreographer (beam search,
 audio clock ← song                   ├──────────────────►      signature pins) → routine.json
 rooms / accounts / herald / reel ────┘                     rooms, accounts, history ─► Tiger Data
                                                            herald + signature ───────► Muse, Gemini,
                                                                                        SerpApi
```

- **Song analysis** (`server/app/audio/`): librosa beat tracking on a tempo grid (gaps filled
  from the tempo), downbeats assuming 4/4, and structure analysis that groups repeated sections
  so every chorus shares a letter. Results are cached by the audio's content hash.
- **Move library** (`assets/moves/`, `server/app/moves/`): moves authored as joint angles
  (shoulders, elbows, hips, knees, lifts, leans, turns, jumps), compiled by forward kinematics
  into 17-joint poses, plus mirrored variants: 87 in all, including the signature moves.
- **Choreographer** (`server/app/choreo/`): beam search over the library, snapped to downbeats,
  reusing moves across repeated sections, respecting difficulty, energy and seated mode, and
  pinning a song's signature moves onto its chorus. The same song, setup and seed always make
  the same routine.
- **Pose and scoring** (`web/src/pose/`, `web/src/game/`): MediaPipe runs entirely in the
  browser and every pose is normalized into a body frame. Classic scoring compares upper arms,
  forearms, thighs, shins and (for leaning moves) the torso by 2D direction (100 within 15°, 0
  beyond 60°), taking your best frame within ±150 ms after subtracting your camera's measured
  delay; beats where the dancer only rests aren't scored, so standing still earns nothing.
  Scoring v2 focuses on each move's hero limbs, softens low-visibility joints, adds timing and
  motion bonuses, and tags hits Early / Late. The magic-mirror calibration measures the camera
  delay with a clap-along.
- **3D dancer** (`web/src/render3d/`): a procedural three.js princess and prince built from
  primitives (no model files). The routine only carries 2D joints, so depth is recovered from
  foreshortening and the body turn from shoulder and hip width. It lazy-loads and falls back to
  the 2D silhouette without WebGL.
- **Multiplayer** (`server/app/rooms/`, `web/src/rooms/`): stateless polling (about once a
  second) that suits serverless functions. Clients sync to the server clock, start from a shared
  `startAt`, and post per-beat judgements in batches; per-player tokens guard every write, and
  an unknown room and a bad token look the same, so codes can't be guessed.
- **Accounts** (`server/app/accounts/`, `web/src/account/`): an httpOnly, SameSite=Lax session
  cookie; passwords hashed with scrypt; a CSRF header on every write; login lockout.
- **Data in Tiger Data** (Postgres + TimescaleDB): rooms, players, chat, accounts, friendships
  and invites in plain tables; rounds and per-beat room scores in **hypertables**; a
  **continuous aggregate** turns per-round beat scores into each song's "hardest moments".
  Without `DATABASE_URL` the same code runs on SQLite locally.
- **AI** (`server/app/ai/`, `server/app/signature/`): the herald's lines come from **Meta Muse**
  first, then **Gemini**, then a hand-written bank, always within 2.5 s. Its voice is **Gemini
  TTS**, cached so each line is synthesized once. Signature dances combine a bundled table,
  **SerpApi** search and **Gemini**. Paid calls only run for songs and lines the server knows,
  with concurrency limits, per-visitor quotas and daily caps.

## Built with

| Area | Tech |
|---|---|
| Web | React 19, TypeScript (strict), Vite 8, three.js, MediaPipe Tasks Vision, Web Audio, plain CSS (Body Double's storybook-sticker design system: Fraunces + Figtree) |
| Server | Python 3.12, FastAPI, librosa, numpy / scipy, pg8000, uv |
| Data | Tiger Data (Postgres + TimescaleDB: hypertables, continuous aggregates); SQLite locally; Vercel Blob for the shared cache and song uploads |
| AI | Meta Muse (Muse Spark), Google Gemini (text + TTS), SerpApi |
| Hosting | Vercel (two services: static web + Python function in `pdx1`) |

## Run it locally

Prerequisites (macOS shown; Linux works the same):

- **Node.js 22+** (Vite 8 needs `^20.19 || >=22.12`)
- **uv**, which also installs Python 3.12 for you: `brew install uv`
  (or `curl -LsSf https://astral.sh/uv/install.sh | sh`)
- A webcam and Chrome, Edge or Safari

```bash
make setup     # first time, and after pulling dependency changes: Python venv + npm deps + MediaPipe wasm/models (~60 MB)
make dev       # API on :8000 and web on :5173 together; Ctrl-C stops both
```

Open **http://localhost:5173** in Chrome. It opens on the title menu:

1. **Play**: pick a song (or upload one), difficulty and standing / seated, then **Start the ball**.
2. **Magic mirror (calibration):** stand back until your whole body is in view (upper body when
   seated), hold a star pose (both hands up and out) for a second, then clap along with 8 clicks
   so the game can measure your camera's delay. `K` skips it.
3. **Dance:** copy the dancer like a mirror and keep the combo going.
4. **Results:** score, stars, highlights, then play again, get a new routine or learn the moves.

**Before the ball** (lobby): *Just play*, *Watch first* (the dancer performs the whole routine
with music, no camera; ←/→ jump a bar, "Skip → I'm ready" anytime), or *Practice run* (a full run
with live feedback but no score, then straight into the real round). Routines you've danced
appear under **Your routines**; `#/play?routine=<id>` opens one directly.

**Keys** while dancing: Space pause, R restart, M mirror, C camera window, S sound effects,
D debug overlay (FPS, latency, sync drift), Esc back to the lobby. No camera, or judging from
across the room? Turn on **Autoplay (bot)** in the lobby.

**Multiplayer locally:** open **Party → Open a ballroom** on one device and join from another on
the same network with the code. For several people on one camera, use **Party → Party in this
room** (`#/play?party=3`; 2 to 4 dancers).

**Pages:** `#/` menu · `#/play` lobby · `#/teach` Learn · `#/analysis` Studio · `#/moves` Move
Book · `#/room`, `#/join?code=ABCD` ballrooms · `#/profile`, `#/friends` dance card ·
`#/settings` · `#/how`. Developer pages (linked from Settings → Developer): `#/pose` (pose
spike), `#/beats` (beat spike), `#/ui` (design system), `#/party-dev` (party harness), `#/ai`
(AI preview).

Without `make`:

```bash
cd server && uv sync && uv run uvicorn app.main:app --reload --reload-dir app --port 8000
cd web && npm install && npm run dev        # in a second terminal
```

Other targets: `make test`, `make server`, `make web`, `make build`, `make songs` (regenerates the
synthetic test songs), `make help`.

**Configuration** lives in a root `.env` (copy [.env.example](.env.example); every variable is
documented there and in [Deploy](#deploy-vercel)). Nothing is required: without keys the herald
uses its own lines, signature dances use the bundled table, and rooms and accounts use a local
SQLite file.

### Troubleshooting

- **Camera blocked:** browsers only allow webcams on `localhost` or HTTPS. On macOS, also check
  System Settings → Privacy & Security → Camera for your browser.
- **"Server offline":** start the API (`make server`) and check port 8000 is free
  (`lsof -i :8000`). After pulling new code, run `make setup` again.
- **Gemini calls fail locally:** a `GEMINI_API_KEY` exported in your shell wins over `.env`.
- **Uploads of .m4a/.aac fail:** those need ffmpeg (`brew install ffmpeg`). WAV, MP3, FLAC and OGG
  work out of the box.
- **MediaPipe model didn't download** (offline setup): the app falls back to the CDN; rerun
  `cd web && npm run setup:mediapipe` when online.

## Tests

```bash
make test      # server: pytest · web: typecheck + vitest
```

The server suite (pytest, about 480 tests) covers analysis, choreography, the move library and
the shared contract, rooms (Versus, Crew, rematch, heatmap), accounts and friends, the herald,
signature dances, rate limits and TLS settings; rooms and accounts tests also run against
Postgres when `DATABASE_URL` is set. The web suite (vitest, about 640 tests) covers pose
normalization, scoring v1 and v2, the routine track, the 3D pose lifting, party tracking and
scoring, the reel, rooms and accounts clients, and the design system. `cd web && npx oxlint src`
lints the web app.

## Deploy (Vercel)

One Vercel project, two services ([vercel.json](vercel.json)): `web/` (a static Vite build) and
`server/` (FastAPI as one Python function on `/api/*`). Deploy with `vercel deploy` from the repo
root (`--prod` for production).

- **Database:** rooms, accounts, friends and history need `DATABASE_URL` (Tiger Data / Timescale
  Postgres), e.g. `postgres://user:pass@host:port/tsdb?sslmode=require`. TLS always checks the
  certificate and host name (Tiger Cloud's certificate is publicly trusted): `verify-ca` skips only
  the host name, `no-verify` is the explicit opt-out, `disable` is plain TCP for a local Postgres.
  `DATABASE_CA_CERT` (PEM text) adds a private CA if a database needs one. Without `DATABASE_URL`
  those routes answer 503 on Vercel.
- **Region:** the Tiger database is in AWS us-west-2, so the function runs in Vercel's `pdx1`
  (Portland) region (`"regions"` in vercel.json): every room poll is a few database round trips.
- **Shared cache:** each function instance has its own temporary disk, so analyses, routines,
  uploaded audio and the herald's recorded lines are mirrored to Vercel Blob
  ([server/app/blob.py](server/app/blob.py)). This is on only when `BLOB_READ_WRITE_TOKEN` is set;
  locally everything stays in `assets/cache/`.
- **Uploads:** Vercel caps request bodies at 4.5 MB, so the deployed web app (`VITE_BLOB_UPLOADS=1`)
  uploads songs straight to Blob and then calls `POST /api/analyze/blob` with the URL.
- **Bundle size:** librosa's numba/llvmlite, scipy and numpy come to ~430 MB, over the 225 MB
  standard limit, so the project sets `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`.
- **Assets:** the function only contains `server/`, so its build copies `assets/songs` and
  `assets/moves` into `server/assets`.
- **Cold starts:** a fresh instance compiles librosa's beat tracker (numba) on its first analysis,
  about 30 s; later analyses take about a second, and cached ones are instant.
- **Environment variables** (Project Settings → Environment Variables):

  | Variable | What it turns on |
  |---|---|
  | `BLOB_READ_WRITE_TOKEN` | the shared cache and direct-to-Blob uploads |
  | `DATABASE_URL`, optional `DATABASE_CA_CERT` | rooms, accounts, friends, history, quotas |
  | `MUSE_API_KEY`, `MUSE_BASE_URL`, `MUSE_TEXT_MODEL` | the herald's lines (Meta Muse first) |
  | `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL` | Gemini: herald fallback, the herald's voice, naming signature dances |
  | `GEMINI_TTS_VOICE` | which Gemini voice the herald speaks with (default Fenrir) |
  | `AI_PROVIDER=gemini` | ask Gemini before Muse |
  | `SERPAPI_API_KEY` | online signature-dance search (without it only the bundled table answers) |
  | `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` | required: the Python bundle is over 225 MB |
- **Pre-voice the herald:** with `GEMINI_API_KEY` and `BLOB_READ_WRITE_TOKEN` in your shell,
  `cd server && uv run python -m scripts.pregen_voice` voices every fixed line into Blob once, so the
  common lines play instantly (a re-run only voices new lines). Re-run it after changing
  `GEMINI_TTS_VOICE`. Gemini's free tier allows only a few TTS requests per day.

Data formats, coordinate conventions and every HTTP endpoint (with limits) are documented in
[shared/README.md](shared/README.md).

## Project layout

```
web/                 Vite + React + TypeScript (strict)
  src/theme/           design system ported from Body Double: tokens, stickers, controls, icons, style guide
  src/shell/           title menu, settings, how to play, top bar
  src/pages/           Play (lobby + game), Teach (Learn), Studio, Move Book, dev spikes
  src/game/            play engine: audio clock, session flow, calibration, scoring v1 + v2, HUD, cue strip
  src/pose/            webcam, MediaPipe landmarker, body-frame normalization, skeleton drawing
  src/render/          2D coach, cue cards, ballroom stage
  src/render3d/        three.js princess and prince, 2D -> 3D pose lifting, dancer choice
  src/routine/         routine sampling: smooth rigid-limb motion track, move library helpers
  src/rooms/           ballrooms: lobby, join, chat, QR, Versus/Crew HUDs, leaderboards, game link
  src/party/           party mode: multi-person tracking, per-player scoring, HUD, podium
  src/account/         guest session, profile, friends, invites, optional login
  src/announcer/       the Royal Herald (bubble, events, prefs)
  src/voice/           herald voice player (Gemini TTS, browser-voice fallback, music ducking)
  src/signature/       signature-dance lookup panel and in-game banner
  src/reel/            combo cam and highlight reel
server/              Python 3.12 + FastAPI + librosa (uv project)
  app/audio/           decoding, beat grid, downbeats, structure (sections) analysis
  app/moves/           move library: angle definitions -> forward kinematics -> 17-joint poses
  app/choreo/          choreographer: beam search over moves, downbeats, chorus reuse, signature pins
  app/rooms/           ballrooms store (Postgres / SQLite), Versus/Crew modes, heatmap
  app/accounts/        guest sessions, optional login, friends, invites, history, quotas
  app/ai/              Muse/Gemini provider, herald prompts and canned lines, Gemini TTS voice
  app/signature/       signature-dance lookup (table, SerpApi, Gemini)
  app/api/             HTTP routes and rate limits
  app/blob.py          Vercel Blob mirror and browser uploads
  scripts/             sample songs, example songs, herald pre-voicing
shared/              the data contract: skeleton, routine.schema.json, TS types, API docs
assets/              songs/ (samples), moves/ (move definitions incl. signature/, see moves/README.md)
scripts/             dev.sh (starts both servers)
```

## Team

Made in one night at HackTX 2026 by **Toyeshh Medikonda**, **Luv Udeshi** and
**Suchay Kommisetty**.

## Privacy

Webcam frames and pose landmarks never leave the browser. The server receives scores, per-beat
judgements, room chat and your dance-card details; highlight reels stay on your device unless you
download or share them. After a round, **Download session log** saves per-beat scores and timing
(no video or poses) for tuning.

## Music

Only user-uploaded audio and royalty-free samples we add. Each sample song in `assets/songs/` has
a `<name>.json` sidecar with its title, artist, license and source.

- `synth_*.wav`: generated by `server/scripts/make_sample_song.py`, CC0. The sidecars hold the true
  section layout, which the analysis tests check against.
- "Vibe Ace" by Kevin MacLeod, CC BY 3.0
  ([source](https://freemusicarchive.org/music/Kevin_MacLeod/Jazz_Sampler/Vibe_Ace)).
- "Let's Go Fishin'" by Karissa Hobbs, CC BY 3.0
  ([source](https://freemusicarchive.org/music/Karissa_Hobbs/Age_of_Flowers/09_Lets_Go_Fishin)).

Both CC BY tracks come from librosa's example data (`server/scripts/fetch_example_songs.py`).

## AI tools used

Required by the hackathon rules.

**To build it:**

- **Claude Code** (Anthropic) helped scaffold and write code, including multi-agent workflows
  that built features in parallel on separate branches, then reviewed and verified them.

**In the game:**

- **MediaPipe PoseLandmarker** (Google) for in-browser pose estimation.
- **librosa** for beat tracking and music structure analysis.
- **Meta Muse** (Muse Spark) writes the Royal Herald's lines, with **Gemini** as the fallback.
- **Gemini TTS** gives the herald its voice; **Gemini** also names a song's signature dance from
  **SerpApi** web and YouTube results.
- **three.js** renders the 3D storybook dancers (built from primitives, no model files).
