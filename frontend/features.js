/**
 * features.js — Converts raw MediaPipe keypoints into the semantic snapshot
 * that gets sent to the Jev backend proxy.
 *
 * ARCHITECTURE.md Section 5: "Do not send raw keypoint coordinates to Jev.
 * Convert to labeled, human-readable semantic fields first, computed from
 * a short rolling window (last ~5-8 frames)."
 *
 * Landmark index reference (used throughout this file):
 *   0  nose
 *  11  left_shoulder   12  right_shoulder
 *  13  left_elbow      14  right_elbow
 *  15  left_wrist      16  right_wrist
 *  23  left_hip        24  right_hip
 *
 * Coordinate system: x,y normalised [0,1], origin top-left.
 * y INCREASES downward, so lower y = higher on screen.
 * z is depth relative to hip midpoint (negative = closer to camera).
 */

// ─── Rolling frame buffer ─────────────────────────────────────────────────────

const WINDOW_SIZE = 7;    // ~230ms at 30fps — enough for velocity/direction
const frameBuffer  = [];  // array of { landmarks, timestampMs }

// Sustained low-guard timer — only fires the fatigue cue once guard has been
// continuously low for a threshold duration (avoids single-frame false triggers)
let lowGuardSince = null; // timestamp when guard first dropped low

// Previous stance — needed to detect a change
let prevStance = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Push a new frame into the rolling buffer and compute the latest snapshot.
 *
 * @param {Array} landmarks   33-element array from MediaPipe (each: {x,y,z,visibility})
 * @param {number} timestampMs
 * @returns {Object} semantic snapshot (see ARCHITECTURE.md §5)
 */
export function pushFrame(landmarks, timestampMs) {
  frameBuffer.push({ landmarks, timestampMs });
  if (frameBuffer.length > WINDOW_SIZE) frameBuffer.shift();
  return computeSnapshot(timestampMs);
}

/** Reset the buffer and timer state (call when camera stops or resets). */
export function resetFeatures() {
  frameBuffer.length = 0;
  lowGuardSince = null;
  prevStance    = null;
}

// ─── Snapshot computation ─────────────────────────────────────────────────────

function computeSnapshot(nowMs) {
  if (frameBuffer.length < 2) return null; // need at least 2 frames for velocity

  const latest = frameBuffer.at(-1).landmarks;

  // ── 1. Guard height ──────────────────────────────────────────────────────
  const guardHeight = computeGuardHeight(latest);

  // ── 2. Sustained low-guard timer ─────────────────────────────────────────
  if (guardHeight === 'low') {
    if (lowGuardSince === null) lowGuardSince = nowMs;
  } else {
    lowGuardSince = null;
  }
  const sustainedLowGuardMs = lowGuardSince !== null ? (nowMs - lowGuardSince) : 0;

  // ── 3. Lead hand velocity toward camera ──────────────────────────────────
  const leadHandVelocity = computeLeadHandVelocity();

  // ── 4. Rear hand pullback ─────────────────────────────────────────────────
  const rearHandPullback = detectRearHandPullback(latest);

  // ── 5. Hip rotation ───────────────────────────────────────────────────────
  const hipRotationDeg = computeHipRotation(latest);

  // ── 6. Stance ─────────────────────────────────────────────────────────────
  const stance = computeStance(latest);
  const stanceChanged = (prevStance !== null && prevStance !== stance && stance !== 'unclear');
  prevStance = stance;

  // ── 7. Weight shift ───────────────────────────────────────────────────────
  const weightShift = computeWeightShift();

  // ── 8. Arm extension ─────────────────────────────────────────────────────
  const armExtension = computeArmExtension(latest, stance);

  return {
    guard_height:                    guardHeight,
    lead_hand_velocity_toward_camera: leadHandVelocity,
    rear_hand_pullback:              rearHandPullback,
    hip_rotation_deg:                hipRotationDeg,
    stance,
    stance_changed:                  stanceChanged,
    weight_shift:                    weightShift,
    arm_extension:                   armExtension,
    sustained_low_guard_ms:          Math.round(sustainedLowGuardMs),
  };
}

// ─── Feature derivations ──────────────────────────────────────────────────────

/**
 * Guard height: compare average wrist y to shoulder y and head (nose) y.
 * In video coords, y increases downward, so:
 *   wrist_y > shoulder_y → wrists below shoulders → LOW guard
 */
function computeGuardHeight(lm) {
  const lw = lm[15]; // left_wrist
  const rw = lm[16]; // right_wrist
  const ls = lm[11]; // left_shoulder
  const rs = lm[12]; // right_shoulder

  if (!isVisible(lw) || !isVisible(rw) || !isVisible(ls) || !isVisible(rs)) return 'unknown';

  const avgWristY    = (lw.y + rw.y) / 2;
  const avgShoulderY = (ls.y + rs.y) / 2;
  const headY        = lm[0]?.y ?? avgShoulderY - 0.1; // nose as head proxy

  // Thresholds: tune against real footage (these are starting points)
  if (avgWristY > avgShoulderY + 0.05) return 'low';          // wrists well below shoulders
  if (avgWristY < headY + 0.02)         return 'high';         // wrists near or above head
  return 'mid';
}

/**
 * Lead hand velocity toward camera (z-axis, negative = closer).
 * Lead hand = left wrist for orthodox, right wrist for southpaw.
 * Returns 'fast' | 'slow' | 'none'.
 */
function computeLeadHandVelocity() {
  if (frameBuffer.length < 3) return 'none';

  const stance = computeStance(frameBuffer.at(-1).landmarks);
  const wristIdx = (stance === 'southpaw') ? 16 : 15; // right or left wrist

  // Compute z-delta over last 3 frames
  const recent = frameBuffer.slice(-3);
  const zDelta = recent.at(-1).landmarks[wristIdx]?.z - recent[0].landmarks[wristIdx]?.z;

  if (zDelta === undefined || zDelta === null) return 'none';

  // Negative delta = moving toward camera = extending forward
  if (zDelta < -0.04) return 'fast';
  if (zDelta < -0.015) return 'slow';
  return 'none';
}

/**
 * Rear hand pullback: rear wrist moving away from its guard position toward
 * the hip/ribs. Classic pre-cross/hook tell.
 */
function detectRearHandPullback(lmNow) {
  if (frameBuffer.length < 3) return false;

  const stance   = computeStance(lmNow);
  const rearIdx  = (stance === 'southpaw') ? 15 : 16; // left wrist for orthodox rear
  const hipIdx   = (stance === 'southpaw') ? 23 : 24; // matching hip

  const oldest  = frameBuffer[0].landmarks;
  const wNow    = lmNow[rearIdx];
  const wOld    = oldest[rearIdx];
  const hip     = lmNow[hipIdx];

  if (!isVisible(wNow) || !isVisible(wOld) || !isVisible(hip)) return false;

  // Wrist moving toward the hip: y increases (downward), x toward midline
  const movingDown    = wNow.y > wOld.y + 0.02;
  const nearHipY      = Math.abs(wNow.y - hip.y) < 0.12;

  return movingDown && nearHipY;
}

/**
 * Hip rotation: angle between the two hip landmarks relative to camera-facing
 * baseline. A larger angle = torso is coiling into a power shot.
 */
function computeHipRotation(lm) {
  const lh = lm[23]; // left_hip
  const rh = lm[24]; // right_hip

  if (!isVisible(lh) || !isVisible(rh)) return 0;

  // Use x-distance vs z-distance to compute rotation angle
  const dx = rh.x - lh.x;
  const dz = rh.z - lh.z;

  // Angle from camera-facing baseline (0° = both hips equidistant from camera)
  const angleRad = Math.atan2(Math.abs(dz), Math.abs(dx));
  return Math.round(angleRad * (180 / Math.PI));
}

/**
 * Stance: orthodox (left side forward) or southpaw (right side forward).
 * Derived from relative shoulder x-positions: the forward shoulder has
 * smaller x in a typical front-facing camera setup.
 */
function computeStance(lm) {
  const ls = lm[11]; // left_shoulder
  const rs = lm[12]; // right_shoulder

  if (!isVisible(ls) || !isVisible(rs)) return 'unclear';

  // For a front-facing camera, orthodox = left shoulder closer (smaller x)
  // than right shoulder. Give a small deadband to avoid flickering.
  const diff = Math.abs(ls.x - rs.x);
  if (diff < 0.03) return 'unclear'; // too square to call

  // If z-coords available, use depth; otherwise fall back to x-order
  if (Math.abs(ls.z - rs.z) > 0.03) {
    return ls.z < rs.z ? 'orthodox' : 'southpaw'; // smaller z = closer to camera
  }
  return ls.x < rs.x ? 'orthodox' : 'southpaw';
}

/**
 * Weight shift: forward lean of the hip/shoulder midpoint versus a rolling
 * baseline of the last N frames.
 */
function computeWeightShift() {
  if (frameBuffer.length < 4) return 'neutral';

  // Use the z-coordinate of the shoulder midpoint as a forward-lean proxy
  const getShoulderMidZ = (lm) => {
    const ls = lm[11]; const rs = lm[12];
    if (!isVisible(ls) || !isVisible(rs)) return null;
    return (ls.z + rs.z) / 2;
  };

  const baseline = getShoulderMidZ(frameBuffer[0].landmarks);
  const current  = getShoulderMidZ(frameBuffer.at(-1).landmarks);

  if (baseline === null || current === null) return 'neutral';

  const delta = current - baseline; // negative = moving toward camera = forward
  if (delta < -0.03) return 'forward';
  if (delta >  0.03) return 'back';
  return 'neutral';
}

/**
 * Arm extension: measure the lead arm's elbow angle.
 * Retracted (tight guard) → partial → full extension.
 */
function computeArmExtension(lm, stance) {
  // Lead arm indices: left for orthodox, right for southpaw
  const shoulderIdx = (stance === 'southpaw') ? 12 : 11;
  const elbowIdx    = (stance === 'southpaw') ? 14 : 13;
  const wristIdx    = (stance === 'southpaw') ? 16 : 15;

  const s = lm[shoulderIdx];
  const e = lm[elbowIdx];
  const w = lm[wristIdx];

  if (!isVisible(s) || !isVisible(e) || !isVisible(w)) return 'unknown';

  const angle = angleBetween3Points(s, e, w); // degrees at the elbow joint

  if (angle > 155) return 'full';
  if (angle > 120) return 'partial';
  return 'retracted';
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Check if a landmark has enough visibility to be trusted. */
function isVisible(lm, threshold = 0.5) {
  return lm && (lm.visibility ?? 1) >= threshold;
}

/**
 * Compute the interior angle at point B, formed by A-B-C.
 * Returns degrees.
 */
function angleBetween3Points(A, B, C) {
  const BA = { x: A.x - B.x, y: A.y - B.y, z: (A.z ?? 0) - (B.z ?? 0) };
  const BC = { x: C.x - B.x, y: C.y - B.y, z: (C.z ?? 0) - (B.z ?? 0) };

  const dot      = BA.x * BC.x + BA.y * BC.y + BA.z * BC.z;
  const magBA    = Math.hypot(BA.x, BA.y, BA.z);
  const magBC    = Math.hypot(BC.x, BC.y, BC.z);

  if (magBA === 0 || magBC === 0) return 0;

  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.acos(cosAngle) * (180 / Math.PI);
}
