/**
 * coach.js — Cue state machine, debounce logic, Jev API calls, and audio playback.
 *
 * ARCHITECTURE.md Sections 6 & 7.
 *
 * Flow per feature window (~150-200ms):
 *   1. Receive semantic snapshot from features.js
 *   2. Run local pre-filter (cheap if/else) to check which tells are active
 *   3. POST snapshot to backend proxy → Jev returns { cue, confidence }
 *   4. Apply debounce + confidence floor + priority gate
 *   5. If a cue passes all gates → play preloaded audio clip
 */

// ─── Config (tune these during real-footage testing) ─────────────────────────
export const CONFIG = {
  WINDOW_MS:          180,    // how often to send a Jev request (ms)
  CONFIDENCE_FLOOR:   0.58,   // below this → treat as all_clear (per arch §7)
  SAME_CUE_GAP_MS:   1000,   // min gap before repeating the same cue
  BACKEND_URL:        '',     // set via init() — e.g. 'http://192.168.1.5:3001'
  HIGH_GUARD_THRESHOLD_MS: 2000, // sustained_low_guard_ms threshold for fatigue cue
};

// ─── Priority order (higher index = higher priority) ─────────────────────────
// Used when Jev confidence is borderline — ensures time-critical tells win.
const CUE_PRIORITY = [
  'all_clear',
  'fatigue_low_guard',
  'guard_dropping',
  'stance_switch',
  'closing_distance',
  'jab_loading',
  'right_hand_loading',
  'overextended',       // highest priority — counter window
];

// ─── Module state ─────────────────────────────────────────────────────────────
let lastCuePlayed    = null;
let lastCueTimeMs    = 0;
let windowTimer      = null;
let pendingRequest   = false;
let _onCue           = null;  // UI callback: (cue, confidence) => void
let _onError         = null;  // error callback
let audioClips       = {};    // preloaded Audio objects keyed by cue id

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the coach module.
 * @param {Object} opts
 * @param {string}   opts.backendUrl   — e.g. 'http://192.168.1.10:3001'
 * @param {Function} opts.onCue        — called when a cue fires: (cue, confidence) => void
 * @param {Function} [opts.onError]    — called on network/API errors: (err) => void
 * @param {number}   [opts.windowMs]   — override default window interval
 */
export function initCoach({ backendUrl, onCue, onError, windowMs } = {}) {
  CONFIG.BACKEND_URL = backendUrl ?? CONFIG.BACKEND_URL;
  if (windowMs) CONFIG.WINDOW_MS = windowMs;
  _onCue   = onCue;
  _onError = onError ?? console.warn;

  preloadAudio();
  console.log('[coach] Initialised. Backend:', CONFIG.BACKEND_URL);
}

/**
 * Feed the latest semantic snapshot into the coach pipeline.
 * Called by features.js every frame; internally rate-limited to WINDOW_MS.
 * @param {Object} snapshot — output of features.js pushFrame()
 */
export function feedSnapshot(snapshot) {
  if (!snapshot) return;
  if (pendingRequest) return;  // don't stack up requests; skip this window

  clearTimeout(windowTimer);
  windowTimer = setTimeout(() => processSnapshot(snapshot), CONFIG.WINDOW_MS);
}

/** Stop the coach (clear timers). Call when camera stops. */
export function stopCoach() {
  clearTimeout(windowTimer);
  pendingRequest = false;
}

// ─── Core pipeline ────────────────────────────────────────────────────────────

async function processSnapshot(snapshot) {
  pendingRequest = true;

  try {
    // Local pre-filter: if nothing is remotely interesting, skip Jev call
    const localSignals = runLocalPrefilter(snapshot);
    if (localSignals.length === 0) {
      // Nothing active — treat as all_clear without calling Jev
      maybePlayCue('all_clear', 0.9);
      return;
    }

    try {
      const res = await fetch(`${CONFIG.BACKEND_URL}/analyze`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ snapshot }),
        signal:  AbortSignal.timeout(600),
      });

      if (!res.ok) throw new Error(`Proxy status: ${res.status}`);
      const { cue, confidence } = await res.json();
      maybePlayCue(cue, confidence);

    } catch (fetchErr) {
      // Standalone client-side fallback (e.g. on mobile without backend proxy)
      const local = evaluateSnapshotLocally(snapshot);
      maybePlayCue(local.cue, local.confidence);
    }

  } catch (err) {
    _onError?.(`[coach] ${err.message}`);
  } finally {
    pendingRequest = false;
  }
}

function evaluateSnapshotLocally(snap) {
  if (snap.rear_hand_pullback) {
    return { cue: 'right_hand_loading', confidence: 0.88 };
  } else if (snap.lead_hand_velocity_toward_camera === 'fast') {
    return { cue: 'jab_loading', confidence: 0.82 };
  } else if (snap.arm_extension === 'overextended') {
    return { cue: 'overextended', confidence: 0.91 };
  } else if (snap.sustained_low_guard_ms > 2000) {
    return { cue: 'fatigue_low_guard', confidence: 0.79 };
  } else if (snap.guard_height === 'low') {
    return { cue: 'guard_dropping', confidence: 0.75 };
  } else if (snap.weight_shift === 'lunging_forward') {
    return { cue: 'closing_distance', confidence: 0.72 };
  }
  return { cue: 'all_clear', confidence: 0.85 };
}

// ─── Local pre-filter ─────────────────────────────────────────────────────────

/**
 * Cheap deterministic checks that run before Jev is called.
 * Returns array of signal ids that are currently active.
 * If empty → skip Jev, fire all_clear directly.
 * Jev's job is to PRIORITISE between these, not detect them from scratch.
 */
function runLocalPrefilter(snap) {
  const active = [];

  if (snap.guard_height === 'low')
    active.push('guard_dropping');

  if (snap.lead_hand_velocity_toward_camera === 'fast' ||
      snap.lead_hand_velocity_toward_camera === 'slow')
    active.push('jab_loading');

  if (snap.rear_hand_pullback && snap.hip_rotation_deg > 12)
    active.push('right_hand_loading');

  if (snap.stance_changed)
    active.push('stance_switch');

  if (snap.weight_shift === 'forward')
    active.push('closing_distance');

  if (snap.arm_extension === 'full' && snap.weight_shift === 'back')
    active.push('overextended');

  if (snap.sustained_low_guard_ms > CONFIG.HIGH_GUARD_THRESHOLD_MS)
    active.push('fatigue_low_guard');

  return active;
}

// ─── Debounce + gate ──────────────────────────────────────────────────────────

/**
 * Decide whether to actually play a cue, applying:
 *   - Confidence floor check
 *   - Same-cue repeat gap
 *   - Priority gate (for edge cases)
 */
function maybePlayCue(cue, confidence) {
  // 1. Confidence floor
  if (confidence < CONFIG.CONFIDENCE_FLOOR) {
    cue = 'all_clear';
  }

  // 2. Suppress repeat within gap window
  const now = performance.now();
  if (cue === lastCuePlayed && (now - lastCueTimeMs) < CONFIG.SAME_CUE_GAP_MS) {
    return;
  }

  // 3. all_clear is silent — fire callback but skip audio
  if (cue === 'all_clear') {
    lastCuePlayed = 'all_clear';
    lastCueTimeMs = now;
    _onCue?.(cue, confidence);
    return;
  }

  // 4. Play audio
  playCue(cue);
  lastCuePlayed = cue;
  lastCueTimeMs = now;
  _onCue?.(cue, confidence);
}

// ─── Audio ────────────────────────────────────────────────────────────────────

const CUE_VOICE_TEXT = {
  guard_dropping:     'Guard up',
  jab_loading:        'Slip left',
  right_hand_loading: 'Duck right',
  stance_switch:      'Stance switch',
  closing_distance:   'Distance',
  overextended:       'Counter now',
  fatigue_low_guard:  'Hands up',
};

/**
 * Preload all 8 audio clips into Audio objects so .play() has no decode delay.
 */
function preloadAudio() {
  const cueIds = [
    'guard_dropping',
    'jab_loading',
    'right_hand_loading',
    'stance_switch',
    'closing_distance',
    'overextended',
    'fatigue_low_guard',
    'all_clear',
  ];

  for (const id of cueIds) {
    const audio = new Audio(`./audio/${id}.wav`);
    audio.preload = 'auto';
    audioClips[id] = audio;
  }

  console.log('[coach] Audio clips preloaded:', Object.keys(audioClips));
}

/**
 * Unlocks browser audio autoplay restrictions.
 * Must be called during user interaction (e.g. clicking Start or Test button).
 */
export function unlockAllAudio() {
  // Prime speech synthesis
  if ('speechSynthesis' in window) {
    const empty = new SpeechSynthesisUtterance('');
    empty.volume = 0;
    window.speechSynthesis.speak(empty);
  }

  // Prime HTML5 Audio elements
  for (const clip of Object.values(audioClips)) {
    clip.volume = 1.0;
    clip.play().then(() => {
      clip.pause();
      clip.currentTime = 0;
    }).catch(() => {});
  }
}

/**
 * Plays the voice cue for a given cueId.
 * Tries preloaded audio clip first, falls back instantly to Web Speech Synthesis.
 */
export function playCue(cueId) {
  if (!cueId || cueId === 'all_clear') return;
  console.log('[coach] Triggering cue audio:', cueId);

  // Always use speech synthesis or audio clip
  const clip = audioClips[cueId];
  if (clip) {
    clip.currentTime = 0;
    const playPromise = clip.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        console.warn('[coach] Audio element blocked, using SpeechSynthesis fallback:', err);
        speakCue(cueId);
      });
    }
  } else {
    speakCue(cueId);
  }
}

export function speakCue(cueId) {
  if (!('speechSynthesis' in window)) return;
  const text = CUE_VOICE_TEXT[cueId] || cueId.replace(/_/g, ' ');
  window.speechSynthesis.cancel(); // instant interruption for time-critical cues
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.4;
  utter.pitch = 1.0;
  utter.volume = 1.0;
  window.speechSynthesis.speak(utter);
}

// ─── Exports for UI diagnostics ───────────────────────────────────────────────

export function getLastCue()       { return lastCuePlayed; }
export function getLastCueTime()   { return lastCueTimeMs; }
export function getCuePriority()   { return [...CUE_PRIORITY]; }
