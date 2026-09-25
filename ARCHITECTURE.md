# Jev Fight Coach - Build Spec

Status: spec only, nothing built yet. This document is written to be implementable by any AI coding agent or developer, not tied to a specific tool. Read it fully before writing code.

## 1. What this is

A web app that watches a sparring/training partner through a phone camera and calls out fight cues in your ear in real time, using the Jev model (TypeSafe AI) as the decision layer.

**Core concept, stated precisely because it drives every design choice below: this reads tells, it does not dodge punches for you.**

A trained fighter reacts to the shoulder drop and hip coil before a punch is thrown, not to the punch itself. That is the skill this app replicates: read the pre-strike signal and call it out a beat before the strike commits. It is explicitly NOT a reflex system that reacts to a punch already in flight. That framing is not a limitation to apologize for, it is the actual product: borrowed trained-eye pattern recognition, delivered as an audio cue.

### Non-goals (do not build these, they do not work at this latency)
- Reacting to a punch after it has been thrown ("duck now" as the fist is already moving). Physically impossible at the latency budget below.
- Full-speed, unscripted sparring or competition use. This is a drilling/training tool.
- Multi-style classification ("that's Muay Thai vs Boxing"). Not in scope, needs a labeled dataset this project does not have.
- Leg/kick reading in v1. Single phone camera at typical filming distance reliably tracks upper body tells; full-body kick tracking is a v2 problem.

## 2. Why the latency budget forces this framing

Jev's own published numbers plus known network/vision overhead:

| Stage | Estimate |
|---|---|
| Phone camera capture (sensor + browser buffer) | 30-80ms |
| Pose extraction in-browser (MediaPipe BlazePose) | 20-40ms |
| Feature snapshot encode | under 5ms |
| Network round trip + Jev inference | 150-400ms (dominant, geography-dependent) |
| Audio playback start (prefetched clip) | 10-20ms |
| **Total** | **roughly 250-550ms, typically 300-450ms** |

A jab lands in about 150-200ms, a hook/cross in 250-400ms. The pipeline cannot beat a punch already thrown. It CAN beat the moment a punch is fully committed, if the trigger is the wind-up (shoulder/hip load, hand pullback), not the punch itself. Demo and real usage should be at drilling pace (partner loads and holds briefly before throwing), which is how tell-reading is actually trained anyway, not a demo shortcut.

## 3. What Jev actually is (verified against public docs, September 2026)

Jev is TypeSafe AI's "System 1" model. Key facts that constrain the design:

- **It does not accept images, video, or audio.** Text and structured JSON only, capped around 32,000 tokens per request. All vision work must happen before Jev is called.
- **Three output primitives:**
  - `Choice`: picks one of up to 255 named options, returns per-option probabilities plus a confidence score.
  - `Score`: rates state on a 2-10 ordered rubric, returns a numeric score with confidence.
  - `Boolean`: tests a statement, returns a single 0-1 probability.
- **Reported end-to-end response time: 70-500ms** (their own benchmark, likely measured US-to-US; treat as optimistic for any other region).
- **Pricing:** input $0.042 per million tokens ($42/billion), output currently free.
- **Access:** limited early access since 2026-09-15. This project assumes a valid API key is already held by the project owner.
- **Known usage pattern from their own demos** (Minecraft bot, driving sim, drone nav, Subway Surfers): a game/simulator sends a compact structured JSON snapshot of state (e.g. "player health, enemy positions"), Jev returns one decision from a fixed menu of allowed actions (e.g. "jump, duck, lane-change"). This project follows the exact same shape.
- **Example call shape** (from a Vercel AI SDK integration example seen in public docs; verify current syntax against https://docs.typesafe.ai/ before implementing, this may have changed since early access is new and evolving):

```javascript
const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: '<compact JSON or text description of current situation>',
  questions: {
    cue: {
      type: 'choice',
      options: ['guard_dropping', 'jab_loading', 'right_hand_loading', /* ... */],
      instructions: 'Given the fighter state below, which single coaching cue is most urgent right now, if any?',
    },
  },
});
```

**Important implementation note:** Jev only ever gets pre-interpreted semantic state, never raw pixel or joint coordinates. Its job is the judgment call between several already-detected signals (which one is most urgent, or none), not inferring meaning from raw numbers. Section 5 defines exactly what "pre-interpreted" means here.

## 4. High-level architecture

```
[Phone browser]
   |
   |-- getUserMedia() --> <video> element
   |
   |-- MediaPipe BlazePose (client-side, WASM/GPU delegate)
   |         produces 33 keypoints per frame, ~20-40ms
   |
   |-- Local feature engine (plain JS, runs every ~150-200ms window)
   |         raw keypoints -> semantic snapshot (see Section 5)
   |
   |-- fetch() POST snapshot --> [Backend proxy, same LAN or small hosted service]
                                       |
                                       |-- holds the Jev API key (never sent to browser)
                                       |-- calls Jev `Choice` endpoint with snapshot + cue menu
                                       |-- returns { cue: string, confidence: number } to browser
   |
   |<-- response
   |
   |-- Debounce / priority state machine (Section 6)
   |
   |-- Play prerecorded audio clip (2x speed) mapped to chosen cue, via earpiece/bone-conduction headset
```

**Why a backend proxy is required, not optional:** the Jev API key must never be embedded in client-side JS, it would be visible to anyone who opens devtools on the page. The proxy can be a minimal Node (Express) or Python (Flask/FastAPI) service, a handful of lines, running locally on the same machine/network as the phone during filming, or on a small always-on host if remote demoing is needed.

## 5. Pose to semantic snapshot (the hard, important part)

Do not send raw keypoint coordinates to Jev. Convert to labeled, human-readable semantic fields first, computed from a short rolling window (last ~5-8 frames, roughly 150-250ms at 30fps) so velocity/direction can be derived, not just a single static frame.

Suggested snapshot schema (tune thresholds empirically during testing, these are starting points, not final):

```json
{
  "guard_height": "low | mid | high",
  "lead_hand_velocity_toward_camera": "none | slow | fast",
  "rear_hand_pullback": true,
  "hip_rotation_deg": 0,
  "stance": "orthodox | southpaw | unclear",
  "weight_shift": "forward | neutral | back",
  "arm_extension": "retracted | partial | full",
  "sustained_low_guard_ms": 0
}
```

Field derivation notes:
- `guard_height`: compare wrist-y to shoulder-y and head-y landmarks. Low = wrists below shoulder line.
- `rear_hand_pullback`: rear wrist moving away from the guard position toward the hip/ribs over the window, a classic pre-cross/hook tell.
- `hip_rotation_deg`: angle between the two hip landmarks relative to the camera-facing baseline, tracks torso coiling before a power shot.
- `stance`: relative left/right foot or shoulder ordering.
- `weight_shift`: forward lean of the hip/shoulder midpoint versus a short rolling baseline.
- `sustained_low_guard_ms`: running timer, only fire the fatigue cue once guard has been low continuously past a threshold (avoid false triggers on a single dropped frame or a deliberate feint).

This snapshot, not raw video, not raw coordinates, is what gets serialized into the `state` field sent to Jev.

## 6. Cue vocabulary and decision logic

Eight cues, matching the "tell not reflex" framing. One additional "all clear" cue keeps the audio loop feeling alive and gives positive feedback rather than only ever warning.

| Cue id | Trigger condition (local, before Jev call) | Audio line (script for a 2x-sped recorded clip) |
|---|---|---|
| `guard_dropping` | `guard_height` low, not already in a fatigue state | "Guard up" |
| `jab_loading` | lead hand retracts slightly then holds, or lead shoulder cocks | "Jab" |
| `right_hand_loading` | `rear_hand_pullback` true plus `hip_rotation_deg` past threshold | "Right hand, duck" |
| `stance_switch` | `stance` changes value from previous window | "Southpaw" |
| `closing_distance` | forward `weight_shift` sustained across windows | "Distance" |
| `overextended` | `arm_extension` full plus subsequent off-balance signal (hip drop, recovery lean) | "Counter now" |
| `fatigue_low_guard` | `sustained_low_guard_ms` exceeds threshold (e.g. 2000ms) | "Hands up, stay sharp" |
| `all_clear` | none of the above fired for N consecutive windows | (silent, or a subtle single tone, not a spoken line, to avoid noise) |

**Why Jev, not just local if/else rules:** several tells can be true simultaneously (e.g. guard dropping AND right hand loading at once). Local rules can detect each condition, but deciding which single cue is most urgent right now, and suppressing noisy or conflicting ones, is exactly the `Choice` decision Jev is built for. Local code does detection (cheap, instant, deterministic), Jev does prioritization/arbitration (the one call per window that needs judgment).

Call cadence: send one Jev request per feature window (~150-250ms), not per video frame. This bounds API cost and matches how fast the underlying pose state can meaningfully change.

## 7. Debounce and playback state machine

- Do not replay the same cue on consecutive windows. Require either a different cue or a minimum gap (e.g. 800ms-1200ms) before repeating the same one, so the audio does not stutter-spam one word.
- Maintain a small priority order for the rare case Jev's confidence is low or ambiguous: `right_hand_loading` and `overextended` outrank `guard_dropping` and `fatigue_low_guard`, since the former are time-critical strike tells and the latter are steady-state coaching notes.
- If Jev's returned confidence is below a set floor (tune during testing, start around 0.55-0.6), treat as `all_clear` rather than acting on a low-confidence guess.

## 8. Tech stack

Per project conventions: vanilla HTML/CSS/JS on the frontend, no build tooling unless it becomes genuinely necessary.

- **Frontend:** plain HTML/CSS/JS. MediaPipe Pose (or `@mediapipe/tasks-vision` BlazePose) loaded from CDN. CSS custom properties for any on-screen UI tokens (confidence meter, cue log for the demo recording).
- **Pose runtime:** MediaPipe BlazePose, "lite" or "full" model depending on measured on-device frame time, prefer GPU delegate where the phone browser supports it.
- **Backend proxy:** minimal Node/Express or Python/FastAPI service. Single responsibility: accept a snapshot JSON, hold the Jev API key server-side, call Jev, return `{ cue, confidence }`. No database, no auth needed for a local demo.
- **Audio:** prerecord all 8 clips (7 spoken cues + optional all-clear tone) at 2x speed, preload as `Audio` objects in the browser so `.play()` has no decode delay at cue time. Output routed to a bone-conduction or in-ear Bluetooth headset worn by the fighter, not the phone's own speaker (a phone shouting from a tripod breaks the "private assistant" illusion the demo depends on).

## 9. Suggested file structure

```
jev-fight-coach/
  ARCHITECTURE.md          (this file)
  frontend/
    index.html
    style.css
    pose.js                 (MediaPipe setup, keypoint capture loop)
    features.js              (Section 5: keypoints -> semantic snapshot)
    coach.js                  (Section 6/7: cue state machine, debounce, audio playback)
    audio/
      guard_dropping.mp3
      jab_loading.mp3
      right_hand_loading.mp3
      stance_switch.mp3
      closing_distance.mp3
      overextended.mp3
      fatigue_low_guard.mp3
      all_clear.mp3 (optional tone)
  backend/
    server.js (or server.py)  (Jev proxy, holds API key via env var, never committed)
    .env.example
  README.md                  (setup/run instructions once built)
```

## 10. Demo/production notes

- **Camera placement:** fixed tripod/stand, not handheld, not body-mounted, for v1. Camera points at the opponent (the person being read), not at the fighter wearing the earpiece. Position roughly chest height on the opponent, 6-10 feet away, as front-on as space allows (BlazePose needs both shoulders and both hips visible, a hard side profile loses the far arm), even lighting with no backlight. Camera shake directly corrupts the Section 5 feature computation (hip rotation, hand velocity, guard height all become noisy), so stability matters more than an interesting angle for the first working build. A chest/head-mounted POV camera on the fighter is a stronger "wow" shot for the video but is a v2 stretch once the pipeline is proven on a stable camera, not the first build.
- Film at drilling pace: partner loads a strike and holds briefly before throwing. This is how tell-reading is actually trained, not a shortcut for the demo, so it is honest as well as necessary.
- Use an earpiece/bone-conduction headset on the fighter, audio not audible to camera/mic in a way that spoils the "private power" framing.
- Consider a slow-motion replay overlay in post-production showing the exact frame the tell appeared versus the frame the audio cue fired, as visual proof the system called it early. Strong, honest way to sell the concept without needing the live take to look flawless.
- Good candidate line for the video: it does not dodge the punch for you, it hears the punch coming before you do.

## 11. Open items before implementation starts

- [ ] Confirm current Jev API syntax/endpoint directly against https://docs.typesafe.ai/ with the held API key. This document's code example is reconstructed from public secondary sources (blog posts, dev writeups), not the primary docs, and early-access APIs change fast.
- [ ] Decide where the backend proxy runs during filming (localhost on the same machine as the phone's Wi-Fi network, vs a small hosted instance) based on measured latency from the filming location.
- [ ] Tune all thresholds in Section 5 against real recorded footage of the actual sparring partner before the shoot, thresholds will not be right on the first guess.
- [ ] Record the 8 audio clips (talent, tone, 2x speed export) before frontend wiring, so `coach.js` can be built and tested against final files, not placeholders.
- [ ] Decide phone model/browser for filming and verify `getUserMedia` + MediaPipe performance on that specific device ahead of the shoot day, not on the day itself.

## 12. Do / Don't quick reference

**Do:**
- Run pose extraction (MediaPipe) entirely client-side, in the browser.
- Convert raw keypoints into the labeled semantic snapshot (Section 5) before anything is sent over the network.
- Send only that small JSON snapshot to a backend proxy you control.
- Hold the Jev API key only in the backend proxy's environment, never in frontend JS, never committed to a file.
- Call Jev once per feature window (about every 150-250ms), not once per video frame.
- Use Jev's `Choice` primitive to arbitrate between multiple simultaneously-true local tells, picking the single most urgent cue.
- Debounce repeated cues and treat low-confidence responses as `all_clear`.
- Prerecord all audio clips ahead of time and preload them in the browser so playback has no decode delay.
- Route audio to an earpiece/bone-conduction headset, not the phone speaker.
- Film demo strikes at drilling pace (partner loads and holds before throwing).
- Verify the current Jev API syntax against https://docs.typesafe.ai/ before writing the proxy code, this spec's example call is reconstructed from secondary sources.
- Tune all Section 5 thresholds against real footage of the actual sparring partner before the shoot.

**Don't:**
- Don't send raw video, images, or raw keypoint coordinates to Jev, it does not accept visual input and should only ever see pre-interpreted semantic fields.
- Don't call Jev on every frame, it's unnecessary cost and the pose state can't meaningfully change that fast anyway.
- Don't put the Jev API key in any client-side file, network request the browser makes, or public repo.
- Don't build or promise a reflex system that reacts to a punch already thrown, the latency budget makes that impossible regardless of model choice.
- Don't build multi-style classification, kick/leg tracking, or anything beyond the 8-cue upper-body tell vocabulary for v1, none of that is scoped or validated here.
- Don't use unscripted full-speed sparring for the first working demo, that's a reliability and safety problem, not just a nice-to-have.
- Don't use text-to-speech at runtime, prerecorded clips only, TTS adds latency this budget doesn't have.
- Don't ship without a confidence floor check, an unfiltered low-confidence guess played as a confident cue will erode trust in the tool fast.
