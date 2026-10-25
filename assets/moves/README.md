# Move library

Every `*.json` file here is a family of dance moves written as **angle keyframes**. The server
(`server/app/moves/library.py`) compiles them with forward kinematics (`server/app/moves/fk.py`) into
`CompiledMove`s (17-joint body-frame poses per keyframe + a rendering-only root offset), generates mirrored
variants, validates everything, and serves the result at `GET /api/moves` (`shared/moves.ts`). The
choreographer only ever sees compiled moves.

Edit a file and the next `load_library()` call picks it up (cached per file mtimes). The library
`version` is the first 12 hex chars of a sha256 over a compiler tag and the anchor table plus the sorted
(file name, content) pairs, so it changes whenever a definition, an anchor or the FK changes.

Preview your work: `cd server && uv run python scripts/render_moves.py --png [--only <id> ...]` writes
contact sheets to `assets/cache/move_previews/` (one SVG/PNG per move + `overview*.svg`). Always look at them:
the tests check geometry, not taste.

## File format

```jsonc
{
  "notes": "free text (optional)",
  "defaults": { "styles": ["pop"] },          // optional: merged under every move in this file
  "moves": [
    {
      "id": "hello_wave",                     // base id: snake_case, no _L/_R suffix
      "name": "Hello Wave",                   // display name (mirrored pairs get " Left"/" Right")
      "lengthBeats": 4,                       // 1 | 2 | 4 | 8
      "intensity": 1,                         // 1 (chill) .. 5 (cardio)
      "difficulty": "easy",                   // easy | normal | hard
      "styles": ["pop"],                      // pop, hiphop, latin, disco, country, storybook, freeze, aerobic ...; "finale" = routine-ending move (choreographer)
      "side": "R",                            // L | R | both (default both): which side leads
      "mirror": true,                         // default false; needs side L/R; see Mirroring
      "startAnchor": "neutral",               // default neutral; see Anchors
      "endAnchor": "neutral",
      "scoredJoints": ["r_elbow", "r_wrist"], // optional; derived when omitted (see below)
      "upperBodyOnly": false,                 // optional override; derived when omitted
      "notes": "free text (optional)",
      "keyframes": [
        { "beat": 0 },
        { "beat": 1, "angles": { "r_shoulder": 135, "r_elbow": 35 } },
        { "beat": 2, "angles": { "r_elbow": -10 } },
        { "beat": 3, "angles": { "r_elbow": 35 } },
        { "beat": 4, "from": "neutral" }
      ]
    }
  ]
}
```

Unknown fields are errors (typos fail loudly, naming the file and move id).

### Keyframes

- Time: `"beat"` (0..lengthBeats, beats from the move start) **or** `"t"` (0..1 fraction), not both.
- Strictly ascending; the first is at 0 and the last at the end (`t = 1`).
- **Every beat needs a keyframe** (`t = k / lengthBeats` for k = 0..lengthBeats): those are the scoring
  checkpoints. Extra in-between keyframes (half/quarter beats) are allowed to shape the motion; the renderer
  interpolates joint positions linearly, so add in-betweens for rotations (arm circles, spins).
- `"angles"` only lists what changes: every other angle **inherits from the previous keyframe** (neutral = all
  zero for the first keyframe).
- `"from": "<anchor>"` resets all angles to that anchor's angles first (then `angles` applies on top).
- Convention: beats 0 and `lengthBeats` are the chaining boundaries (they sit on the anchors); the move's
  signature shapes are on the interior beats. Every move starts and ends with the root at home (no net travel).
- Only on-beat keyframes are scored, so (tests enforce these): the biggest shape must land on a beat, not on
  an "and"; consecutive beats must ask for different poses (except `freeze` moves, which hold on purpose);
  a 1-beat move starts and ends on the same anchor (its beat pose is that anchor, e.g. a clap), because easy
  and normal routines only use it as an identical pair filling 2 beats.

## Angles

Degrees unless noted; every key is optional and defaults to 0. All zero = the neutral standing pose of
`shared/examples/routine.example.json` exactly. Body frame (`shared/README.md`): origin mid-hip, unit = torso
length, +x = the dancer's anatomical right, +y down. "Left/right" always means the **dancer's** side.

| Key | Range | Meaning |
|---|---|---|
| `l_shoulder`, `r_shoulder` | -180..360 | Upper-arm angle from hanging down, rotating **outward**: 90 = horizontal out to the side, 180 = straight up, >180 continues over the head to the other side, negative = across the front of the body (-90 = horizontal across the chest). 0 is the relaxed rest (arm hangs ~7 deg out); the rest offset fades out by 90, so 90 is exactly horizontal and 180 exactly vertical. |
| `l_elbow`, `r_elbow` | -170..170 | Forearm bend relative to the upper arm. **> 0 swings the forearm the same way the shoulder angle raises the arm**: arm out + 90 = "goalpost" (forearm up), arm up + 40 = hand over the head. **< 0 swings it the other way**: arm out-and-down + -118 = fist on the hip, -125 = hands in front of the chest. |
| `l_hip`, `r_hip` | -30..60 | Thigh angle from straight down in the frontal plane, **> 0 outward** (side kick, wide stance), < 0 crossing in front of/behind the other leg (grapevine, curtsy). |
| `l_knee`, `r_knee` | 0..150 | Knee bend. Front-view squat model: the thigh pitches forward 0.55 x knee, the knee tracks up to 20 deg outward, the shin returns the ankle under the hip line; thigh/shin are foreshortened accordingly. 15-20 = soft knees, 45 = bounce, 80+ = deep squat. |
| `l_lift`, `r_lift` | -30..110 | Extra forward thigh pitch: knee raise / front kick. Knee-up = `knee: 90, lift: 40` (knee to hip height, shin hanging). Negative = thigh back (step back). |
| `torso_lean` | -45..45 | Upper body (head, shoulders, arms) rotates about mid-hip, **+ toward the dancer's right**. Torso length stays 1. |
| `head_tilt` | -40..40 | Head rotates about the neck (mid-shoulder), + toward the dancer's right. |
| `hip_shift` | -0.4..0.4 (body units) | Hips slide sideways over **planted feet** (+ = toward the dancer's right): the legs pivot at the hips so the ankles keep their floor position. |
| `travel` | -1.5..1.5 (body units) | Whole-body sideways displacement (+ = dancer's right). Root only: the body-frame pose is unchanged. |
| `jump` | 0..0.8 (body units) | Airborne height of the lowest foot. |
| `turn` | -2..2 (fraction of a spin) | Spin about the vertical axis, + toward the dancer's right (right shoulder goes back). Rendered as a rotation whose widths scale by cos but never drop below 40% of the front view (`fk.TURN_MIN_WIDTH`; a true side view collapses into a column): the figure flips sides past 90 deg, the face turns into profile. 1 = full turn. Put spin keyframes at turn .2/.3 (.7/.8) around side-on, not on .25/.75 (see `twirl`), so the flip is quick. |

Shorthands (both sides at once): `shoulders`, `elbows`, `hips`, `knees`, `lifts`.

### Root (rendering only)

Each compiled keyframe carries `root` = mid-hip displacement from neutral standing:
`root.x = hip_shift + travel`, `root.y = (1.85 - lowest ankle y) - jump`, so feet stay on the floor in
squats and leave it only when `jump > 0`. Scoring ignores it.

## Mirroring

`"mirror": true` emits two moves: `<id>_R` / `<id>_L` (the definition is the `side` one, its twin gets
`mirrorOf = <original id>`) named "<name> Right" / "<name> Left". The twin swaps every `l_*`/`r_*` angle and
negates the signed lateral parameters (`torso_lean`, `head_tilt`, `hip_shift`, `travel`, `turn`); tests
assert its poses and roots equal the geometric mirror (x -> -x, joint names swapped) of the original.
Non-mirrored moves keep the bare id.

## Anchors

Named poses moves start and end in (`server/app/moves/anchors.py`), all left/right symmetric:

| Anchor | Pose |
|---|---|
| `neutral` | standing tall, arms relaxed (all zero) |
| `ready` | soft knees (18), hands slightly out (shoulders 18, elbows 10) |
| `arms_up` | arms up in a V (shoulders 155) |
| `hands_hips` | fists on hips (shoulders 40, elbows -118) |
| `wide` | wide stance (hips 12, knees 15), arms a little out (shoulders 25) |
| `guard` | boxer's guard, fists in front of the chest (shoulders -27, elbows -150) |
| `clasp` | hands together in front of the chest (shoulders -6, elbows -125) |

A move's first/last keyframe must be within **0.3 body units** (max joint distance, and root distance) of
its `startAnchor`/`endAnchor`; the loader rejects it otherwise. Using `"from": "<anchor>"` on those keyframes
is the easy way to satisfy this.

## Derived fields

- `upperBodyOnly` (seated mode): true when no keyframe uses a leg/root parameter (`*_hip`, `*_knee`,
  `*_lift`, `hip_shift`, `travel`, `jump`, `turn`), i.e. legs stay neutral and root stays (0, 0).
- `bodyParts`: `arms` (shoulder/elbow used), `legs` (hip/knee/lift/hip_shift/jump), `torso` (lean/turn),
  `head` (head_tilt).
- `scoredJoints` (when not given): an arm's `elbow`+`wrist` (a leg's `knee`+`ankle`) when either joint leaves
  its neutral position by > 0.1 in some keyframe; both shoulders (= torso, see `shared/README.md`) when the
  upper body leans or turns.
