// If/else strike detector, tuned on real footage (tests/fixtures + tests/replay.mjs).
//
// The main tell is the ELBOW COMING UP: in every hook and overhand in the real footage the
// striking elbow rose to (or above) shoulder height, while standing, walking and holding a guard
// kept both elbows low. A strike = elbow up (or fist above his nose) + wrist high + moving, held
// for confirmMs. Single-frame tracker flicker is removed by a 3-frame median first.
//
// Up close (fist flying straight at the lens) the pose model loses the fist, so a second
// channel, looming (a big sudden change in the camera image, see spider-looming.js), fires
// instead. It only runs while locked onto a person who is close; the word comes from the
// skeleton (elbow up = DUCK, otherwise STEP BACK).
//
// Positions are in his body frame: origin = shoulder midpoint, unit = shoulder width,
// y down. So y < 0 is above his shoulder line, |x| > 1 is outside his shoulders.

const I = { NOSE: 0, LS: 11, RS: 12, LE: 13, RE: 14, LW: 15, RW: 16, LH: 23, RH: 24 };
const USED = [I.NOSE, I.LS, I.RS, I.LE, I.RE, I.LW, I.RW, I.LH, I.RH];
const ARMS = [
  { key: 'l', s: I.LS, e: I.LE, w: I.LW },
  { key: 'r', s: I.RS, e: I.RE, w: I.RW },
];

export const DEFAULTS = {
  acquireShoulderVis: 0.7,
  acquireHeadVis: 0.7,
  acquireArmVis: 0.5,
  keepShoulderVis: 0.5,
  keepArmVis: 0.3,
  minJointVis: 0.5,
  minShoulderWidth: 0.05,
  armMs: 400,
  lockGraceMs: 400,
  stillSpeed: 1.5,
  walkSpeed: 3.0,
  walkMs: 200,
  approachRate: 0.35,
  elbowUpY: 0.3,
  wristHighY: 0.6,
  selfTouchDist: 0.5,
  selfTouchDepth: -0.5,
  straightCenter: 0.6,
  highY: 0.5,
  extElbow: 125,
  extReach: 1.05,
  extLateral: 1.1,
  minSpeed: 3.5,
  minDepthSpeed: 4.0,
  velocityWindowMs: 66,
  confirmMs: 40,
  rearmMs: 150,
  otherArmGapMs: 250,
  overheadMargin: 0.05,
  sweepSpeed: 8.0,
  sweepRatio: 1.3,
  gapToleranceMs: 34,
  straightSpeed: 6.0,
  loomFrac: 0.15,
  loomRefractoryMs: 400,
  loomFpsExp: 0.5,
  loomMinShoulder: 0.15,
  loomLockMs: 800,
  loomGapMs: 250,
  poseWordMs: 200,
};

export const CUE_IDS = ['duck', 'back'];

const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

function angleDeg(a, b, c) {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const n = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  if (!n) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / n))) * 180) / Math.PI;
}

export function createDetector(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  let raw = [];
  let hist = [];
  let scale = null;
  let worldScale = null;
  let roll = 0;
  let locked = false;
  let armStart = null;
  let lastValidT = -Infinity;
  let lastFireT = -Infinity;
  let walkSince = null;
  let lastFrameT = null;
  let frameMs = 16.7;
  let lastLockedT = -Infinity;
  let lastShoulder = 0;
  const loomState = { frames: 0, latched: false, firedT: -Infinity };
  const arm = {};

  function freshArms() {
    walkSince = null;
    for (const a of ARMS) arm[a.key] = { since: null, frames: 0, lastThreatT: -Infinity, fired: false, calmSince: null, firedT: -Infinity, lastPoseT: -Infinity };
  }
  freshArms();

  function reset() {
    const was = locked;
    raw = [];
    hist = [];
    scale = null;
    worldScale = null;
    roll = 0;
    locked = false;
    armStart = null;
    freshArms();
    return was;
  }

  function dropout(t, status) {
    raw = [];
    hist = [];
    for (const a of ARMS) arm[a.key].since = null;
    if (locked && t - lastValidT <= cfg.lockGraceMs) {
      lastLockedT = t;
      return { cue: null, status: 'holding', locked: true };
    }
    const lostLock = reset();
    return { cue: null, status, locked: false, lostLock };
  }

  const noPose = (t, loom = null, selfMotion = false) => withLoom(dropout(t, 'no-person'), t, loom, selfMotion);

  // 3-frame median per coordinate: kills one-frame tracker flicker for ~1 frame of delay.
  // Below ~40fps three frames span too long a strike, so the 2-frame confirm handles flicker instead.
  function smooth(lm, world) {
    raw.push({ lm, world });
    if (raw.length > 3) raw.shift();
    if (raw.length < 3 || frameMs > 25) return { lm, world };
    const [a, b, c] = raw;
    const out = { lm: [], world: world ? [] : null };
    for (const i of USED) {
      const pa = a.lm[i], pb = b.lm[i], pc = c.lm[i];
      out.lm[i] = {
        x: median3(pa.x, pb.x, pc.x),
        y: median3(pa.y, pb.y, pc.y),
        visibility: median3(pa.visibility ?? 1, pb.visibility ?? 1, pc.visibility ?? 1),
      };
      if (world && a.world && b.world && c.world) {
        const wa = a.world[i], wb = b.world[i], wc = c.world[i];
        out.world[i] = { x: median3(wa.x, wb.x, wc.x), y: median3(wa.y, wb.y, wc.y), z: median3(wa.z, wb.z, wc.z) };
      } else if (out.world) {
        out.world = null;
      }
    }
    return out;
  }

  function frame(lmIn, worldIn, t, aspect = 1, selfMotion = false, loom = null) {
    return withLoom(poseFrame(lmIn, worldIn, t, aspect, selfMotion), t, loom, selfMotion);
  }

  function withLoom(r, t, loom, selfMotion) {
    if (!loom) return r;
    const ls = loomState;
    // One cue per punch: the fist pulling back is as big a change as it coming in, so after a cue
    // looming stays off for loomRefractoryMs, then needs a fresh rise above the threshold.
    if (ls.latched && t - ls.firedT >= cfg.loomRefractoryMs && loom.frac < cfg.loomFrac * Math.max(1, frameMs / 16.7)) ls.latched = false;
    const eligible = t - lastLockedT <= cfg.loomLockMs && lastShoulder >= cfg.loomMinShoulder
      && !loom.global && r.status !== 'walking';
    // More of the picture changes between frames at a lower frame rate; scale the bar to match.
    const loomNeed = cfg.loomFrac * (selfMotion ? 1.6 : 1) * Math.pow(Math.max(1, frameMs / 16.7), cfg.loomFpsExp);
    if (eligible && loom.frac >= loomNeed) ls.frames++;
    else ls.frames = 0;

    const out = { ...r, loom: +loom.frac.toFixed(3) };
    if (r.cue) {
      ls.latched = true;
      ls.firedT = t;
      return out;
    }
    if (!eligible || ls.latched || ls.frames < 2 || t - lastFireT < cfg.loomGapMs) return out;

    const posed = ARMS.find((d) => t - arm[d.key].lastPoseT <= cfg.poseWordMs);
    const side = posed ? posed.key : loom.cx !== null && loom.cx < 0.5 ? 'r' : 'l';
    ls.latched = true;
    ls.firedT = t;
    lastFireT = t;
    for (const d of ARMS) {
      if (t - arm[d.key].lastPoseT <= 300) {
        arm[d.key].fired = true;
        arm[d.key].firedT = t;
      }
    }
    return { ...out, cue: posed ? 'duck' : 'back', side, status: 'fired', debug: { why: 'looming', frac: out.loom, arm: side } };
  }

  function poseFrame(lmIn, worldIn, t, aspect, selfMotion) {
    if (lastFrameT !== null && t > lastFrameT) frameMs = frameMs * 0.8 + Math.min(100, t - lastFrameT) * 0.2;
    lastFrameT = t;
    const vis = (i) => lmIn[i].visibility ?? 1;
    const armVis = (vis(I.LE) + vis(I.RE) + vis(I.LW) + vis(I.RW)) / 4;
    if (!locked) {
      if (vis(I.LS) < cfg.acquireShoulderVis || vis(I.RS) < cfg.acquireShoulderVis) return dropout(t, 'no-person');
      if (vis(I.NOSE) < cfg.acquireHeadVis) return dropout(t, 'no-head');
      if (armVis < cfg.acquireArmVis) return dropout(t, 'no-arms');
    } else {
      if ((vis(I.LS) + vis(I.RS)) / 2 < cfg.keepShoulderVis) return dropout(t, 'no-person');
      if (armVis < cfg.keepArmVis) return dropout(t, 'no-arms');
    }

    const { lm, world } = smooth(lmIn, worldIn);
    const P = (i) => ({ x: lm[i].x * aspect, y: lm[i].y, v: lm[i].visibility ?? 1 });
    const ls = P(I.LS);
    const rs = P(I.RS);
    const [a, b] = ls.x <= rs.x ? [ls, rs] : [rs, ls];
    const sRaw = Math.hypot(b.x - a.x, b.y - a.y);
    if (!locked && sRaw < cfg.minShoulderWidth) return dropout(t, 'too-small');
    lastShoulder = sRaw;

    // Only learn scale/roll while he faces the camera; turning sideways shrinks the shoulder line.
    if (scale === null) {
      scale = sRaw;
      roll = Math.atan2(b.y - a.y, b.x - a.x);
    } else if (sRaw > 0.75 * scale) {
      scale = scale * 0.9 + sRaw * 0.1;
      roll = Math.atan2(b.y - a.y, b.x - a.x);
    }
    const mx = (ls.x + rs.x) / 2;
    const my = (ls.y + rs.y) / 2;
    const c = Math.cos(-roll);
    const s = Math.sin(-roll);
    const body = (p) => {
      const rx = p.x - mx;
      const ry = p.y - my;
      return { x: (rx * c - ry * s) / scale, y: (rx * s + ry * c) / scale };
    };

    const noseY = body(P(I.NOSE)).y;
    if (!locked && noseY > -0.15) return dropout(t, 'no-head');
    const hipsOk = lm[I.LH].visibility >= 0.5 && lm[I.RH].visibility >= 0.5;
    const anchor = hipsOk
      ? { x: (lm[I.LH].x + lm[I.RH].x) / 2 * aspect, y: (lm[I.LH].y + lm[I.RH].y) / 2 }
      : { x: mx, y: my };

    if (world) {
      const ws = Math.hypot(world[I.LS].x - world[I.RS].x, world[I.LS].y - world[I.RS].y, world[I.LS].z - world[I.RS].z);
      if (ws > 0.05) worldScale = worldScale === null ? ws : worldScale * 0.9 + ws * 0.1;
    }
    const shoulderZ = world ? (world[I.LS].z + world[I.RS].z) / 2 : null;

    const arms = {};
    for (const d of ARMS) {
      const w = body(P(d.w));
      const elbowY = body(P(d.e)).y;
      const ok = lm[d.w].visibility >= cfg.minJointVis && lm[d.e].visibility >= cfg.minJointVis;
      let elbow = null;
      let reach = null;
      let depth = null;
      if (world && worldScale) {
        elbow = angleDeg(world[d.s], world[d.e], world[d.w]);
        const ws = world[d.s];
        const ww = world[d.w];
        reach = Math.hypot(ww.x - ws.x, ww.y - ws.y, ww.z - ws.z) / worldScale;
        depth = (ww.z - shoulderZ) / worldScale;
      }
      arms[d.key] = { x: w.x, y: w.y, elbowY, ok, elbow, reach, depth };
    }

    // Body speed from the hips: shoulders rotate with every big punch, hips only move when he walks.
    hist.push({ t, mx: anchor.x / scale, my: anchor.y / scale, size: sRaw, arms });
    while (hist.length > 2 && t - hist[0].t > 400) hist.shift();
    lastValidT = t;

    let then = null;
    for (let i = hist.length - 2; i >= 0; i--) {
      if (t - hist[i].t >= cfg.velocityWindowMs) {
        then = hist[i];
        break;
      }
    }
    const dt = then ? (t - then.t) / 1000 : 0;
    const bodySpeed = then ? Math.hypot(hist[hist.length - 1].mx - then.mx, hist[hist.length - 1].my - then.my) / dt : 0;

    // Lock only once he is roughly still, so walking into place never arms the detector.
    let gainedLock = false;
    if (!locked) {
      if (!then || bodySpeed > cfg.stillSpeed) armStart = null;
      else if (armStart === null) armStart = t;
      if (armStart === null || t - armStart < cfg.armMs) return { cue: null, status: 'locking-on', locked: false };
      locked = true;
      gainedLock = true;
    }
    lastLockedT = t;
    if (!then) return { cue: null, status: 'warming-up', locked: true, gainedLock };

    // Walking = hips moving sideways, or him growing in frame (walking at the camera), for walkMs.
    // A lunge into a punch is shorter and doesn't count.
    const approach = then ? (sRaw / then.size - 1) / dt : 0;
    if (bodySpeed > cfg.walkSpeed || approach > cfg.approachRate) walkSince ??= t;
    else walkSince = null;
    const walking = walkSince !== null && t - walkSince >= cfg.walkMs;
    const speedNeed = cfg.minSpeed * (selfMotion ? 1.6 : 1);
    let best = null;
    let debug = null;

    for (const d of ARMS) {
      const now = arms[d.key];
      const prev = then.arms[d.key];
      const st = arm[d.key];
      if (!now.ok || !prev.ok) {
        st.since = null;
        continue;
      }
      const vx = (now.x - prev.x) / dt;
      const vy = (now.y - prev.y) / dt;
      const speed = Math.hypot(vx, vy);
      const towardCam = now.depth !== null && prev.depth !== null ? -(now.depth - prev.depth) / dt : 0;

      const elbowUp = now.elbowY < cfg.elbowUpY;
      // Overhand: fist above his own nose. A guard sits at the chin, never above the nose.
      const overhead = now.y < noseY - cfg.overheadMargin;
      const wristHigh = now.y < cfg.wristHighY;
      // Straight punch: arm snapping open straight down his centre line toward the camera.
      const straight = now.elbow !== null && prev.elbow !== null
        && now.elbow > cfg.extElbow && now.elbow - prev.elbow > 20
        && towardCam >= cfg.straightSpeed && towardCam > 2 * speed
        && Math.abs(now.x) < cfg.straightCenter && now.y > -0.6 && now.y < 0.6;
      // Touching his own head lifts the elbow too, but the hand stops at his head, level with his
      // body, instead of going out wide or coming forward at the camera.
      const selfTouch = !straight && now.depth !== null && now.depth > cfg.selfTouchDepth && towardCam < 3
        && Math.hypot(now.x, now.y - noseY) < cfg.selfTouchDist;
      const strikePose = ((elbowUp && wristHigh) || overhead) && !selfTouch;
      if (strikePose) st.lastPoseT = t;
      const moving = speed >= speedNeed || towardCam >= cfg.minDepthSpeed * (selfMotion ? 1.6 : 1);
      const threat = !walking && ((strikePose && moving) || straight);

      const info = { arm: d.key, x: +now.x.toFixed(2), y: +now.y.toFixed(2), ey: +now.elbowY.toFixed(2), nose: +noseY.toFixed(2), why: [elbowUp && 'elbow', overhead && 'over', straight && 'straight'].filter(Boolean).join('+'), speed: +speed.toFixed(1), toward: +towardCam.toFixed(1), elbow: now.elbow === null ? null : Math.round(now.elbow), reach: now.reach === null ? null : +now.reach.toFixed(2) };
      if (!debug || speed > debug.speed) debug = info;

      // After firing, an arm re-arms only once it has been out of the strike pose for rearmMs.
      if (st.fired) {
        if (strikePose) st.calmSince = null;
        else if (st.calmSince === null) st.calmSince = t;
        if (st.calmSince !== null && t - st.calmSince >= cfg.rearmMs) {
          st.fired = false;
          st.calmSince = null;
        }
      }

      if (!threat) {
        if (t - st.lastThreatT > Math.max(cfg.gapToleranceMs, frameMs * 1.5)) {
          st.since = null;
          st.frames = 0;
        }
        continue;
      }
      st.lastThreatT = t;
      if (st.since === null) st.since = t;
      st.frames++;
      // Held long enough: the span covered by these frames (incl. this one) and at least 2 frames.
      if (st.fired || st.frames < 2 || t - st.since + frameMs < cfg.confirmMs + 10) continue;

      const cue = straight && !overhead ? 'back' : 'duck';
      if (!best || speed > best.speed) best = { cue, side: d.key, speed, info };
    }

    if (!best) return { cue: null, status: walking ? 'walking' : selfMotion ? 'self-motion' : 'calm', debug, locked: true, gainedLock };
    const otherFiredRecently = ARMS.some((d) => d.key !== best.side && t - arm[d.key].firedT < cfg.otherArmGapMs);
    if (otherFiredRecently || t - lastFireT < 120) return { cue: null, status: 'gap', debug, locked: true, gainedLock };

    const st = arm[best.side];
    st.fired = true;
    st.firedT = t;
    st.calmSince = null;
    lastFireT = t;
    return { cue: best.cue, side: best.side, status: 'fired', debug: best.info, locked: true, gainedLock };
  }

  return { frame, noPose, reset, cfg, isLocked: () => locked };
}
