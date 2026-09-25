import { TypeSafeClient, choice } from '@typesafe-ai/sdk';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { snapshot } = req.body || {};
  if (!snapshot || typeof snapshot !== 'object') {
    return res.status(400).json({ error: 'Missing or invalid snapshot in request body.' });
  }

  const hasApiKey = Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY !== 'your_key_here');

  if (!hasApiKey) {
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

  try {
    const jev = new TypeSafeClient();
    const state = buildStateString(snapshot);
    const response = await jev.systemOne({
      state,
      questions: {
        cue: choice(
          'Given the fighter state below, which single coaching cue is most urgent right now, if any? Choose all_clear if no significant tell is present.',
          CUE_OPTIONS,
        ),
      },
    });

    const answer = response.answers.cue;
    return res.json({
      cue: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    });
  } catch (err) {
    console.error('[Jev error]', err?.message ?? err);
    return res.status(502).json({ error: 'Jev API call failed', detail: err?.message });
  }
}
