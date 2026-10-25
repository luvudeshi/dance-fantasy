# feat/gemini: stopped, a Gemini commentator already exists

**Result:** nothing built. The pre-flight check found an existing Gemini integration and an
in-game commentator on other branches. Following the run rules ("if one exists, don't duplicate
it"), this branch holds only this report. No code changes, no shared-file edits, no new
dependencies.

Checked 2026-10-25, 04:36 CDT, after `git fetch --all`. I grepped `origin/main` and every remote
branch for `gemini|commentator|generativelanguage`.

## What already exists

| Branch | Last commit | What it has |
|---|---|---|
| `origin/main` | — | Only `GEMINI_API_KEY=` in `.env.example` (no code) |
| `origin/feat/ai-server` | 2026-10-25 03:38 CDT | Server side: `server/app/ai/provider.py` (stdlib `urllib`; Meta Muse first, **Gemini `gemini-2.5-flash` via native `generateContent`** as fallback, `AI_PROVIDER=gemini` puts Gemini first), `server/app/ai/prompts.py` (system prompt + canned line bank), `POST /api/announcer` (`server/app/api/announcer.py`), `GET /api/songs/signature` (SerpApi), `server/tests/test_ai.py`, API docs in `shared/README.md` |
| `origin/feat/ai-voice` | same commit | Identical to `feat/ai-server` (no extra commits) |
| `origin/feat/ai-web` | 2026-10-25 04:22 CDT (toyeshhm) | Merges `feat/ai-server`, then adds `web/src/announcer/`: the "Herald" commentator (`announcer.ts`, `Herald.tsx`, `herald.css`, `prefs.ts`, `AiPreview.tsx`, tests). It reacts to intro, combo milestones (10, 25, every 50), broken streaks, perfect runs and results. It prefetches lines, falls back to local canned lines, reads lines aloud with `speechSynthesis`, and has on/off and voice toggles stored in localStorage. |

### How it compares with the requested feature

| Requested | Existing (`feat/ai-server` + `feat/ai-web`) |
|---|---|
| Gemini flash model, stdlib HTTP, key only from `GEMINI_API_KEY` | ✅ `gemini-2.5-flash`, `urllib`, env key (Gemini is the *fallback* to Muse unless `AI_PROVIDER=gemini`) |
| Timeout + canned fallback on every call | ✅ ~2.1 s provider deadline, 2.3 s hard cap, canned bank; client waits 0.9 s in game, 2.8 s for intro/results |
| Live subtitle lines + speechSynthesis + mute | ✅ Herald bubble + "Herald's voice" toggle |
| Pre-written per-routine script (`/api/ai/script`, triggers keyed by section) | ❌ Lines are requested per event and prefetched, not written as one script per routine. No `section_start:<label>` triggers. |
| Captions (`getCaption(meta)`) | Partly: `origin/exp/combo-cam` has its own `web/src/reel/captions.ts` with `getCaption(clip: CaptionMeta): Promise<string>`, a canned fallback and a `setCaptionSource(fn)` seam for plugging in an AI source. No server endpoint. |
| Results blurb | Partly: `/api/announcer` handles a `results` event (1–3 lines) |
| `?commentator=1` flag, off by default | ❌ The Herald uses its own prefs toggles |
| No image data sent | ✅ Requests carry only text context |

## Suggested next step (for a human to decide)

Building `server/app/ai/` + `/api/ai/*` + `web/src/commentator/` as specified would put a second
commentator next to the Herald, and both branches already use `server/app/ai/`, so they would
collide. Instead, extend `feat/ai-server` / `feat/ai-web`:

1. Add the per-routine script and section triggers as a new announcer mode, or a `/api/announcer/script` route that reuses `provider.generate_text` and `prompts.py`.
2. Plug a Gemini-backed source into `exp/combo-cam` through `setCaptionSource(fn)` instead of adding a second `getCaption`.
3. If the MLH "Best Use of Gemini" judging needs Gemini as the primary model, set `AI_PROVIDER=gemini` in the deploy env.

## How to test

Nothing to test on this branch. To see the existing Herald, check out `origin/feat/ai-web`.

## Shared-file lines changed

None.

## Known issues / what was cut

Everything was cut by the "don't duplicate" rule. Tests weren't run because this branch has no
code changes compared with `origin/main`.

Also: the session setup named a different working branch (`claude/sleepy-johnson-fiahou`). I
followed the user's explicit instruction and pushed to `feat/gemini`.
