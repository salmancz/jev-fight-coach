import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { TypeSafeClient, choice } from '@typesafe-ai/sdk';

// ─── Environment & Fallback ──────────────────────────────────────────────────
const hasApiKey = Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY !== 'your_key_here');
let jev = null;

if (hasApiKey) {
  try {
    jev = new TypeSafeClient();
    console.log('[jev-fight-coach] TypeSafe AI client initialized with API key.');
  } catch (err) {
    console.warn('[jev-fight-coach] Failed to initialize TypeSafeClient:', err.message);
  }
} else {
  console.log('[jev-fight-coach] Running in local heuristic mode (no TYPESAFE_API_KEY provided).');
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve frontend directly on port 3001 so everything works out of the box on localhost
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/mediapipe', express.static(path.join(__dirname, 'node_modules/@mediapipe/tasks-vision')));

app.use(cors({ origin: '*' }));

// ─── Cue vocabulary ──────────────────────────────────────────────────────────
// Mirrors ARCHITECTURE.md Section 6. Keep in sync with coach.js on the frontend.
const CUE_OPTIONS = {
  guard_dropping:    null,
  jab_loading:       null,
  right_hand_loading: null,
  stance_switch:     null,
  closing_distance:  null,
  overextended:      null,
  fatigue_low_guard: null,
  all_clear:         null,
};

// ─── POST /analyze ───────────────────────────────────────────────────────────
// Accepts a semantic snapshot from the frontend, calls Jev, returns the
// single most-urgent cue and Jev's confidence score.
//
// Request body: { snapshot: { guard_height, lead_hand_velocity_toward_camera,
//   rear_hand_pullback, hip_rotation_deg, stance, weight_shift,
//   arm_extension, sustained_low_guard_ms } }
//
// Response: { cue: string, confidence: number }
app.post('/analyze', async (req, res) => {
  const { snapshot } = req.body;

  if (!snapshot || typeof snapshot !== 'object') {
    return res.status(400).json({ error: 'Missing or invalid snapshot in request body.' });
  }

  // Serialize the snapshot into a compact, human-readable state string.
  // Jev only sees pre-interpreted semantic fields — never raw pixels or coords.
  const state = buildStateString(snapshot);

  try {
    if (!jev) {
      // Heuristic fallback mode
      let cue = 'all_clear';
      let confidence = 0.85;

      if (snapshot.rear_hand_pullback) {
        cue = 'right_hand_loading';
        confidence = 0.88;
      } else if (snapshot.lead_hand_velocity_toward_camera === 'fast') {
        cue = 'jab_loading';
        confidence = 0.82;
      } else if (snapshot.arm_extension === 'overextended') {
        cue = 'overextended';
        confidence = 0.91;
      } else if (snapshot.sustained_low_guard_ms > 2000) {
        cue = 'fatigue_low_guard';
        confidence = 0.79;
      } else if (snapshot.guard_height === 'low') {
        cue = 'guard_dropping';
        confidence = 0.75;
      } else if (snapshot.weight_shift === 'lunging_forward') {
        cue = 'closing_distance';
        confidence = 0.72;
      }

      return res.json({
        cue,
        confidence,
        mode: 'heuristic_simulation',
      });
    }

    const response = await jev.systemOne({
      state,
      questions: {
        cue: choice(
          'Given the fighter state below, which single coaching cue is most urgent right now, if any? ' +
          'Choose all_clear if no significant tell is present.',
          CUE_OPTIONS,
        ),
      },
    });

    const answer = response.answers.cue;

    return res.json({
      cue:        answer.choice,
      confidence: answer.confidence,
      // Include per-option probabilities so the frontend can render a
      // breakdown panel if needed (useful during tuning / demo recording).
      probabilities: answer.probabilities,
    });

  } catch (err) {
    console.error('[Jev error]', err?.message ?? err);
    return res.status(502).json({ error: 'Jev API call failed.', detail: err?.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[jev-fight-coach] Proxy running on http://0.0.0.0:${PORT}`);
  console.log(`  POST /analyze  — send snapshot, get cue`);
  console.log(`  GET  /health   — liveness check`);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert the semantic snapshot object into a concise, labeled plain-text
 * string that Jev can parse. Jev is text-in, structured-JSON-out — it does
 * not accept raw video, images, or keypoint arrays.
 *
 * Keep this compact: Jev is priced per input token and we call it ~5x/sec.
 */
function buildStateString(snap) {
  const lines = [
    `Guard height: ${snap.guard_height ?? 'unknown'}`,
    `Lead hand velocity toward camera: ${snap.lead_hand_velocity_toward_camera ?? 'none'}`,
    `Rear hand pullback detected: ${snap.rear_hand_pullback ? 'yes' : 'no'}`,
    `Hip rotation (deg from baseline): ${typeof snap.hip_rotation_deg === 'number' ? snap.hip_rotation_deg.toFixed(1) : 'unknown'}`,
    `Stance: ${snap.stance ?? 'unclear'}`,
    `Weight shift: ${snap.weight_shift ?? 'neutral'}`,
    `Arm extension: ${snap.arm_extension ?? 'retracted'}`,
    `Sustained low guard (ms): ${snap.sustained_low_guard_ms ?? 0}`,
  ];
  return lines.join('\n');
}
