# Jev Fight Coach

Real-time sparring partner read tool. Watches an opponent through a phone camera, extracts pose tells using MediaPipe BlazePose, sends a compact semantic snapshot to a Jev (TypeSafe AI) backend proxy, and plays a prerecorded audio cue in your ear before a strike commits.

> **Read the framing.** This reads tells — shoulder drop, hip coil, rear hand pullback — it does not react to a punch already thrown. Total pipeline latency is ~300-450ms. A jab lands in 150-200ms. The system wins by triggering on the wind-up, not the strike.

---

## File structure

```
jev-fight-coach/
  ARCHITECTURE.md          spec and design rationale
  README.md                this file
  frontend/
    index.html             UI, camera, wiring
    style.css              dark glass UI
    pose.js                MediaPipe BlazePose setup + frame loop
    features.js            keypoints → semantic snapshot
    coach.js               cue state machine, Jev calls, audio
    audio/
      guard_dropping.mp3
      jab_loading.mp3
      right_hand_loading.mp3
      stance_switch.mp3
      closing_distance.mp3
      overextended.mp3
      fatigue_low_guard.mp3
      all_clear.mp3
  backend/
    server.js              Express proxy — holds Jev API key
    package.json
    .env.example
```

---

## Prerequisites

- Node.js 20 or newer
- A TypeSafe AI API key — get one at https://console.typesafe.ai
- A phone or tablet with a rear camera accessible via browser
- A bone-conduction or in-ear Bluetooth headset (route audio away from the phone speaker)

---

## 1. Backend setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env — paste your TYPESAFE_API_KEY
```

Start the proxy:

```bash
npm run dev        # development (restarts on save)
npm start          # production
```

The server listens on `0.0.0.0:3001` by default. Change `PORT` in `.env` if needed.

**Check it's running:**
```bash
curl http://localhost:3001/health
# → {"status":"ok","ts":...}
```

---

## 2. Audio clips

Record 7 spoken clips + 1 optional tone **at 2x speed** before wiring up the frontend. Slow recordings add perceived latency. Place them in `frontend/audio/` named exactly as listed above.

| File | Script | Notes |
|------|--------|-------|
| `guard_dropping.mp3` | "Guard up" | Short, sharp |
| `jab_loading.mp3` | "Jab" | Single word |
| `right_hand_loading.mp3` | "Right hand, duck" | 3 syllables max |
| `stance_switch.mp3` | "Southpaw" | |
| `closing_distance.mp3` | "Distance" | |
| `overextended.mp3` | "Counter now" | |
| `fatigue_low_guard.mp3` | "Hands up, stay sharp" | |
| `all_clear.mp3` | *(subtle tone, or silent)* | Not spoken |

---

## 3. Frontend setup

No build step. Serve the `frontend/` directory over HTTPS (required for `getUserMedia` on mobile).

### Option A — local dev (same machine as phone)

```bash
# Using Node serve
npx serve -s frontend --ssl-cert cert.pem --ssl-key key.pem -p 8443
```

Or with Python:
```bash
cd frontend
python -m http.server 8080
# then use an ngrok tunnel for HTTPS on phone
```

### Option B — ngrok tunnel (easiest for phone testing)

```bash
# Terminal 1 — backend
cd backend && npm start

# Terminal 2 — frontend
npx serve frontend -p 8080

# Terminal 3 — expose both
ngrok http 3001   # note the https URL → paste into Backend URL field
ngrok http 8080   # open this on phone
```

---

## 4. Camera placement

- **Fixed tripod**, not handheld — camera shake corrupts velocity/rotation features
- Point at the **opponent** (the person being read), not the fighter wearing the earpiece
- Roughly **chest height**, **6-10 feet away**, as **front-facing as possible**
- BlazePose needs both shoulders and both hips visible — a hard side profile loses the far arm
- **Even lighting, no backlight** — backlighting kills landmark confidence

---

## 5. Running a session

1. Open the frontend HTTPS URL on your phone
2. Enter the backend URL in the UI (e.g. `https://your-ngrok-id.ngrok.io`)
3. Put on your headset
4. Press **Start** — the camera opens and the detection loop begins
5. The **Pose Snapshot** panel shows live feature values — use this to verify the camera angle and lighting before recording
6. Film strikes at **drilling pace**: partner loads and holds briefly before throwing

---

## 6. Tuning thresholds

All thresholds are in `frontend/features.js`. Tune against recorded footage of your actual sparring partner before the shoot — the defaults are starting points only.

| Threshold | Location | What it controls |
|-----------|----------|-----------------|
| Guard height zones | `computeGuardHeight()` | wrist-to-shoulder y-delta |
| Lead velocity bands | `computeLeadHandVelocity()` | z-delta over 3 frames |
| Rear pullback y-delta | `detectRearHandPullback()` | wrist downward movement |
| Hip rotation min angle | `ARCHITECTURE.md §6` | passed into local prefilter |
| Confidence floor | UI slider (default 0.58) | below = treat as all_clear |
| Same-cue gap | `coach.js CONFIG` | default 1000ms |
| Low guard fatigue threshold | `coach.js CONFIG` | default 2000ms |

---

## 7. Open items (from ARCHITECTURE.md §11)

- [ ] Verify current Jev API syntax at https://docs.typesafe.ai — early access APIs evolve fast
- [ ] Decide proxy location: same-LAN laptop vs. hosted instance (affects latency)
- [ ] Record all 8 audio clips at 2x speed before wiring frontend
- [ ] Test `getUserMedia` + MediaPipe frame rate on the specific phone/browser used on shoot day
- [ ] Run a full threshold-tuning session against real footage before the shoot

---

## Cost estimate

Jev is priced at $0.042 per million input tokens. A compact semantic snapshot is ~60-80 tokens. At one call per 180ms window:

- ~5.5 calls/sec × 3600 sec/hour = ~20,000 calls/hour
- ~20,000 × 75 tokens = ~1.5M tokens/hour → **~$0.063/hour**

Effectively free for training sessions.

---

## Do / Don't (quick ref)

**Do:** film at drilling pace · use an earpiece · tune thresholds on real footage · verify Jev API syntax before filming

**Don't:** send raw keypoints or video to Jev · call Jev on every frame · put the API key in frontend code · promise a punch-reflex system · use full-speed unscripted sparring for the first demo
