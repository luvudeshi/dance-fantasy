# feat/signature-dances: signature dances on the chorus (flagged)

Branch `feat/signature-dances`, cut from `origin/main` at `772e995`. Nothing was merged into `main`, and
no PR was opened. Built overnight on 2026-10-25 without a human in the loop; every judgment call is in
[Decisions](#decisions).

When a player picks a famous song that has a viral dance, the routine puts that dance's signature move on
every chorus and credits its creator. The move scores 2× and a banner shows while it plays. If the dance is
known but there's no move for it (the Renegade, for example), the lobby shows "Learn the real dance" with the
creator credit and video links, and nothing is pinned.

**Flag:** `?signature=1` (page query, or the hash query, e.g. `#/moves?signature=1`) or
`localStorage["mb.signature"] = "1"`. It's off by default. `?signature=0` overrides localStorage. With the
flag off, the lobby panel isn't rendered, the gallery doesn't fetch signature moves, `/api/choreograph`
receives the same request body as before, and the routine is byte-for-byte unchanged (tested on both
sides, and checked in the browser).

## Pre-flight check (`git fetch --all`, grep for signature / pinnedMoves / renegade)

- `origin/main`: nothing related. Its only hits were unrelated uses of the word "signature" (HMAC in
  `blob.py`, "signature shapes" in the move README).
- `origin/feat/ai-server`, `feat/ai-voice` and `feat/ai-web` (unmerged) have an **overlapping but different**
  feature: `GET /api/songs/signature`, where an LLM (Muse, then Gemini) summarizes a song's dance from
  SerpApi results and suggests *existing* library moves, plus a `SignatureCard` on a dev page (`#/ai`).
  They have no pinned moves, bundled table, signature move library, banner, 2× scoring or flag.
- `origin/feat/gemini` holds only a report pointing at those branches.

The requested work wasn't complete anywhere, so I built it. Because the user said to branch from
`origin/main`, I didn't build on top of the unmerged branches. To keep a later merge painless, nothing here
reuses their paths: the server code is in `server/app/signature/` (theirs is `server/app/api/signature.py`),
and the web helpers are `web/src/signature/dances.ts` / `dances.css` (theirs are `signature.ts` /
`signature.css` in the same folder). The one expected conflict is the import line in
`server/app/api/__init__.py`. The two features could be merged later: their LLM summary card could sit
in my lobby panel.

## What I built

### Server (`server/app/signature/`, routes under `/api/signature/*`)

| File | What it does |
|---|---|
| `table.py` | The bundled table (the 8 songs from the brief, creators only for Lottery → Jalaiah Harmon and Savage → Keara Wilson). It also has title normalization: case, accents, punctuation, dotted acronyms (`Y.M.C.A.` → `ymca`), file extensions, `(Official Video)`/`[Lyrics]`/`feat.` noise and `Artist - Title` file names. When an artist is given, it must agree with the table's artist, so "Savage" by someone else isn't credited to Megan Thee Stallion. |
| `search.py` | SerpApi, using stdlib `urllib`. I checked SerpApi's official docs: `https://serpapi.com/search.json`, `engine=google` + `q`, `engine=youtube` + `search_query`, and results in `organic_results` / `inline_videos` / `short_videos` / `video_results`. It runs 4 queries in parallel (Google and YouTube × "<song> dance" and "<song> TikTok dance"), de-duplicates the results and keeps only https links. Then **Gemini** (`gemini-2.5-flash` `generateContent`, key in the `x-goog-api-key` header, **5 s timeout**, text-only prompt of result titles and snippets, JSON response mode, thinking off) returns `{danceName, creator, year, confidence, links}` or `{danceName: null}`. The answer is validated: types are checked, year must be in 1900–2100, confidence is clamped, below 0.4 counts as "no dance", and **links that weren't in the search results are dropped**, so no URL is invented. |
| `lookup.py` | Order: table → SerpApi (+ Gemini). Network results are cached on disk at `<cache_dir>/signature/lookup-*.json` for **24 h**. A failed search isn't cached, and neither is a failed Gemini call, so they're retried next time. With no SerpApi key, a table hit links to YouTube and TikTok **search pages**, which are always valid. Videos are only ever returned as links and never downloaded. |
| `moves.py` | Loads the signature move library from `assets/moves/signature/*.json`. It reuses `app.moves.library.build_library`, so the format, FK and validators are the same as the main library. Before compiling, it strips the two extra per-move fields (`signatureDance`, `songs`) and checks that ids start with `sig_` and that moves last 4 or 8 beats (whole bars). It has its own mtime cache. **These moves are not in the main library** (`/api/moves`, the beam search, the library version), so routines can't change unless something is pinned. |
| `pins.py` | `PinnedMove`, `pinned_sections()` (placement rules) and `with_pinned_moves()`. |
| `router.py` | `GET /api/signature/lookup?title=&artist=`, `GET /api/signature/moves`, and `resolve_pins()` for `/api/choreograph`, which returns 400 for unknown ids and for non-upper-body moves in seated mode. |

**Pinned placement** (`app/choreo/generator.py`): `pinnedMoves: [{moveId, placement}]`, at most 4.

- **chorus**: every section labeled `chorus`. If there's none, every occurrence of the highest-energy
  *repeated* section group. If nothing repeats, the single highest-energy section.
- **drop**: sections labeled `drop`. The analyzer never emits that label today, so in practice this is the
  first highest-energy section.
- **finale**: the last section with bars.

The pinned move starts on the section's **first downbeat**, and the existing beam search fills the rest of the
section, continuing from the pin's end pose. Choruses still mirror each other because the group plan is keyed
by (group, pins). The pinned moves are added to the prepared library but excluded from the search pool, so the
search never picks them on its own. Each placed pinned move gets `signatureDance: {name, creator?}`, and
`meta.pinnedMoves` echoes the request. The routine id includes the pins and the signature library version only
when there are pins.

### Signature move library (`assets/moves/signature/signature.json`)

There are five angle-keyframe approximations, all upper-body only (so seated players get them too), styled
`signature` and tagged `signatureDance` with their `songs`:

| id | Dance | Beats | Songs |
|---|---|---|---|
| `sig_ymca_arms` | YMCA arms | 8 (Y M C A, twice) | Y.M.C.A. |
| `sig_macarena` | Macarena | 8 (arms out, palms, shoulders, head, hips) | Macarena |
| `sig_whip` | the Whip | 4 | Watch Me (Whip/Nae Nae) |
| `sig_horse_dance` | the horse dance | 4 (reins, bounce, lasso) | Gangnam Style |
| `sig_floss` | the floss | 4 | none (matched by dance name, e.g. via Gemini) |

I rendered all five as contact sheets and checked them by eye. They show as cards in `#/moves?signature=1`
with a "★ inspired by <dance>" tag. The UI always says "inspired by" and never claims they're exact.

### Web (`web/src/signature/`)

- `flag.ts`: the flag.
- `dances.ts`: the lookup and moves API, response validation, `pinsFor()`, banner text,
  `signatureAt()` and `withSignatureMultiplier()`.
- `id3.ts`: reads the title and artist from an uploaded file's ID3v2 tag (TIT2/TPE1, v2.2–2.4) in the
  browser with no dependency, and falls back to the file name.
- `SignaturePanel.tsx`: the lobby panel. It has "Song title" and "Artist" fields, pre-filled from the library
  song, the ID3 tag or the file name, and does a debounced lookup. It shows one of three results:
  - "★ YMCA Arms (inspired by YMCA arms) lands on every chorus. Its points count double!" (pins
    `{moveId, placement: "chorus"}`)
  - **"Learn the real dance:** The Renegade, created by Jalaiah Harmon" with video links (nothing pinned)
  - "No famous dance found".
- `SignatureBanner.tsx`: shows "★ SIGNATURE: <dance>, created by <creator>" or
  "★ SIGNATURE: inspired by <dance>", plus a "2× points" badge. When there's a creator, a small
  line underneath says the move is "inspired by" the dance.
- **2× scoring**: `Checkpoint.multiplier` (new, optional) is set to 2 only on checkpoints that belong to a
  signature move. `ScoreKeeper` multiplies only that checkpoint's points. Combo, judgments, stars
  (`basePoints`) and every other checkpoint are unchanged (tested).
- "New routine" on the results screen keeps the pins: `recipeFromRoutine` reads `meta.pinnedMoves`.

## How to test locally

```bash
make setup         # first time only
make dev           # API :8000 + web :5173
```

Keys are optional. To try the live search, put `SERPAPI_API_KEY=` and `GEMINI_API_KEY=` in the root `.env`.
Without them, everything works from the bundled table.

**Y.M.C.A. on every chorus, with the banner (no keys needed):**

1. Open **http://localhost:5173/?signature=1#/play** (or run `localStorage.setItem('mb.signature','1')` in the
   console and open `#/play`).
2. Either **upload** a file named `Y.M.C.A..mp3` (an MP3 whose ID3 title is "Y.M.C.A." works with any file
   name), or pick a library song (e.g. *Vibe Ace*) and type `Y.M.C.A.` into **Song title** in the new
   "★ Signature dance" box under the song list.
3. The box says "★ **YMCA Arms** (inspired by YMCA arms) lands on every chorus. Its points count double!"
4. Optionally tick **Autoplay (bot)** to watch without a camera, then press **Start the ball**.
5. On every chorus, the first move is **YMCA Arms** (it's also in the cue strip). While it plays, the banner
   **"★ SIGNATURE: inspired by YMCA arms · 2× points"** shows at the top, and each of its checkpoints scores
   double.

**"Lottery (Renegade)": Jalaiah Harmon credited, with video links:**

1. In the same box, type `Lottery (Renegade)`. `Lottery` or `K CAMP - Lottery (Renegade) [Official Video].mp3`
   also match.
2. It shows **"Learn the real dance:** The Renegade, created by Jalaiah Harmon", followed by "We don't have a
   move for it yet, so your routine is original" and the **Videos** links. Without keys these are YouTube and
   TikTok search pages. With `SERPAPI_API_KEY`, they're the actual videos SerpApi found. Nothing is pinned.

**API directly:**

```bash
curl 'localhost:8000/api/signature/lookup?title=Lottery%20(Renegade)'
curl 'localhost:8000/api/signature/lookup?title=Y.M.C.A.'          # moveId: sig_ymca_arms
curl 'localhost:8000/api/signature/moves'
# pinned routine (use an analysis id from #/analysis or POST /api/analyze):
curl -X POST localhost:8000/api/choreograph -H 'content-type: application/json' \
  -d '{"analysisId":"<id>","pinnedMoves":[{"moveId":"sig_ymca_arms","placement":"chorus"}]}'
```

**Gallery:** **http://localhost:5173/#/moves?signature=1** shows the five signature moves (search "sig_" or
filter style `signature`). Without the flag, they aren't there.

**Tests:**

```bash
cd server && uv run pytest -q                       # 395 passed (47 new in tests/test_signature.py)
cd web && npm test && npm run typecheck && npm run lint   # 413 passed (12 new in src/signature/dances.test.ts)
```

What I checked in a real browser (headless Chromium driving the dev servers):

- The lobby box for Y.M.C.A. and for Lottery.
- An upload of `Y.M.C.A.ogg`: the title was read from the file name and `sig_ymca_arms` was pinned at the
  chorus's first downbeat.
- The banner appearing during the chorus with Autoplay.
- The gallery with the flag on and off.
- With the flag off, the `/api/choreograph` body is exactly `{analysisId, difficulty, mode, seed}`.

## Shared files changed (all additive; nothing reformatted)

Line numbers are on this branch.

| File | Lines | Diff | What |
|---|---|---|---|
| `server/app/choreo/generator.py` | 43, 52, 138, 141, 150-151, 257-260, 262-263, 298-300, 304, 418-436, 479, 481-485, 490-492, 494-496, 527-534, 537-538, 544-545, 547-550, 552, 560, 608-609, 611, 627 | +69 / -17 | See the list below the table. |
| `server/app/api/choreograph.py` | 22-23, 30-36, 46, 83-84, 90 | +13 / -2 | `PinnedMoveRequest`, optional `ChoreographRequest.pinnedMoves`, pins resolved and passed to `routine_id` / `generate_routine`. |
| `server/app/api/__init__.py` | 6, 15 | +2 | Mount the `/api/signature` router. |
| `server/app/routine.py` | 68-74, 85 | +8 | `SignatureDance` model and optional `Move.signatureDance`. |
| `shared/routine.schema.json` | 147-158 | +12 / -1 | Optional `move.signatureDance` (`$defs/signatureDance`: `name` required, `creator` optional). The "-1" is the closing brace of `keyframes`, which now needs a comma. |
| `shared/routine.ts` | 62-70 | +9 | `Move.signatureDance?` and `SignatureDance`. |
| `shared/moves.ts` | 52-58 | +7 | `ChoreographRequest.pinnedMoves?` and `PinnedMoveRequest`. |
| `shared/README.md` | 150-172 | +23 | New "Signature dances" section at the end (endpoints and response). |
| `web/src/game/scoring.ts` | 129-130, 440 | +3 / -1 | `Checkpoint.multiplier?`, and `finalize` multiplies by `cp.multiplier ?? 1`. |
| `web/src/game/session.ts` | 7, 22-23, 34-35, 123-125, 183-184, 307-308 | +12 / -4 | Optional `pinnedMoves` on `SessionRequest` / `RoutineRecipe`, sent only when non-empty, and read back from `meta.pinnedMoves`. |
| `web/src/pages/Play.tsx` | 13-14, 45, 62-65, 164-166, 279, 525, 749, 773-774, 999, 1297 | +17 / -5 | See the list below the table. |
| `web/src/pages/MoveGallery.tsx` | 19-20, 99, 323 | +4 / -1 | With the flag on, appends `/api/signature/moves`. Adds the "★ inspired by …" tag. |

`generator.py` is the largest edit because the per-section loop has to key plans by (group, pins):

- A `pins` argument on `routine_id`, which leaves the id unchanged when it's empty.
- An `exclude` mask on `_eligible` / `_Planner`.
- A `pinned` argument on `generate_routine`.
- The new `_pinned_search()` helper.
- Rekeying `plans` / `variants` by pins.
- The `signatureDance` tag and `meta.pinnedMoves`.

Without pins, every code path computes exactly what it did before. The existing 93 choreography tests pass
unchanged, and `test_routine_unchanged_without_pins` / `test_choreograph_with_and_without_pins` compare output
directly.

`Play.tsx` changes:

- Imports.
- Flag and pins state, plus a `songTimeNow` callback.
- `withSignatureMultiplier(...)` around `buildCheckpoints` in `createRun`.
- Pins added to the request in `start()` and `learnFirst()`.
- `newRoutine` keeps the pins.
- `<SignaturePanel>` under the upload tile.
- `<SignatureBanner>` in the stage while running.

No HUD files (`hud.ts` etc.) were changed. The banner is its own component in `web/src/signature/`.

No new dependencies, no lockfile changes (`npm ci` only, `uv.lock` untouched), and no keys committed. The
fixtures' `api_key` fields read `"REDACTED"`.

## Decisions

- **Branch**: the session setup named `claude/serene-einstein-gd5twh`. I followed your explicit instruction and
  pushed only to `feat/signature-dances`. The other branch is untouched.
- **Signature moves live outside the main library.** If I'd added them to `assets/moves/*.json`, the library
  version and the beam search pool would change, and every routine would change with the flag off.
  `assets/moves/signature/` isn't picked up by the main loader (it only globs `*.json` at the top level).
- **Only signature moves can be pinned**: `sig_*` ids from `/api/signature/moves`. Pinning arbitrary library
  moves would have needed duplicate-id handling for no benefit.
- **Several pins with the same placement** go back to back from the section's first downbeat, in request order.
  A pin that doesn't fit a short occurrence is skipped there.
- **Seated mode**: all five moves are upper-body only. A standing-only pin in seated mode gets a 400.
- **Lookup without a table match and without keys** returns `found: false`. A song listed in a signature move's
  `songs` is matched only through the table, since every current move's song is in the table.
- **Floss**: not in the table, so its creator is left empty (as the brief says: don't guess). Its move has no
  `songs` and is found via a Gemini or SerpApi dance name such as "the floss".
- **Banner with a creator** uses the brief's exact text, "★ SIGNATURE: The Renegade, created by Jalaiah
  Harmon". To keep the "always inspired by" rule, a small line underneath says the move is "inspired by" the
  dance. Without a creator, the main line reads "★ SIGNATURE: inspired by <dance>".
- **The 2× applies to checkpoints whose `moveIndex` is the signature move.** The scorer merges a move's first
  beat with the previous move's last beat, and that merged checkpoint belongs to the previous move. So the
  signature move's beat 0 isn't doubled, but its last beat is.
- **Gallery** shows signature moves only with the flag on, consistent with "off by default".
- **Title source**: the analysis title for uploads is just the file name, so the client reads ID3 tags itself
  (`id3.ts`) instead of waiting for the analysis. The player can always edit the title.
- **Fixtures**: there were no API keys in this environment, so `server/tests/fixtures/signature/*.json` are
  hand-built in the documented SerpApi and Gemini response shapes, with placeholder `EXAMPLE…` video URLs. Its
  README explains how to replace them with real saved responses.
- **Tests live in** `server/tests/` (`test_signature.py`, `fixtures/signature/`) and `web/src/signature/`,
  following the repo's layout, since there's no top-level `tests/`.

## Known issues

- **Live SerpApi and Gemini are untested against the real services**, because there were no keys. Parsing is
  tested on payloads in the documented shapes, and the request URLs and params are tested. The first live run
  should be watched. If Gemini rejects `thinkingConfig` for the configured model, remove that one line in
  `search.py` (`gemini_extract`).
- An uncached SerpApi lookup costs **4 searches** (2 engines × 2 queries, as the brief asked). Cached for 24 h.
- The lookup cache is local disk only (`<cache_dir>/signature/`). It isn't mirrored to Vercel Blob like the
  analysis cache, so on Vercel it's per-instance.
- "Generate again" for a shelf routine that the server forgot (`recipeOf` from `routineShelf.ts`) doesn't
  remember the pins. Normal replay (`GET /api/routines/{id}`) and "New routine" do keep them.
- The analyzer labels choruses heuristically, so on some songs "every chorus" means whatever the analyzer
  called chorus. The highest-energy-repeated fallback only applies when no section is labeled chorus.
- A typed title with no artist matches the table entry for generic titles ("Savage" → Megan Thee Stallion). If
  you type a different artist, the match is rejected.
- The results screen doesn't call out the signature bonus separately. It's just in the score.
- The teach page (`#/teach`) plays pinned moves normally, with no banner and no 2×.

## Cut

Nothing. Gemini extraction, the floss and horse-dance moves, and the "Learn the real dance" panel are all in.
