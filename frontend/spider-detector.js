// Pure if/else strike detector for a chest/head-mounted POV camera.
// All motion is measured in the attacker's own body frame (origin = shoulder midpoint,
// unit = shoulder width, rotated by shoulder-line roll), so camera shake from the wearer
// moving cancels out instead of looking like a strike.

const J = { NOSE: 0, LS: 11, RS: 12, LE: 13, RE: 14, LW: 15, RW: 16, LH: 23, RH: 24, LA: 27, RA: 28 };

const JOINTS = [
  { name: 'lw', idx: J.LW, limb: 'la', parent: J.LE, kind: 'wrist', side: 'l', shoulder: J.LS },
  { name: 'rw', idx: J.RW, limb: 'ra', parent: J.RE, kind: 'wrist', side: 'r', shoulder: J.RS },
  { name: 'le', idx: J.LE, limb: 'la', parent: J.LS, kind: 'elbow', side: 'l', shoulder: J.LS },
  { name: 're', idx: J.RE, limb: 'ra', parent: J.RS, kind: 'elbow', side: 'r', shoulder: J.RS },
  { name: 'lf', idx: J.LA, limb: 'll', kind: 'foot', other: 'rf' },
  { name: 'rf', idx: J.RA, limb: 'rl', kind: 'foot', other: 'lf' },
];

export const DEFAULTS = {
  speedThreshold: 3.5,
  confirmFrames: 3,
  minGapMs: 200,
  lookaheadS: 0.08,
  highZone: 0.3,
  lowZone: 1.0,
  acquireShoulderVis: 0.7,
  acquireHeadVis: 0.7,
  acquireArmVis: 0.5,
  keepShoulderVis: 0.5,
  keepArmVis: 0.3,
  minJointVis: 0.5,
  minShoulderWidth: 0.05,
  armMs: 250,
  lockGraceMs: 400,
  velocityWindowMs: 45,
  glitchSpeed: 40,
  maxLimbRatio: 1.6,
  switchJump: 1.2,
  selfMotionFactor: 1.6,
  legSpeedFactor: 1.6,
  kickLift: 0.4,
  selfTouchDist: 0.5,
  selfTouchDepth: 0.15,
  latchQuietMs: 120,
};

export const CUE_IDS = ['duck', 'left', 'right', 'back', 'jump'];

export function createDetector(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const hist = [];
  let scaleEma = null;
  let worldScaleEma = null;
  let roll = 0;
  let pending = null;
  let lastFireT = -Infinity;
  let armStart = null;
  let locked = false;
  let lastValidT = -Infinity;
  let lastMid = null;
  const latch = {};

  function reset() {
    const wasLocked = locked;
    hist.length = 0;
    pending = null;
    armStart = null;
    scaleEma = null;
    worldScaleEma = null;
    roll = 0;
    locked = false;
    lastMid = null;
    for (const k of Object.keys(latch)) delete latch[k];
    return wasLocked;
  }

  // Brief tracking dropouts (blur, sideways turn, head leaving frame) keep the lock;
  // only a dropout longer than lockGraceMs forces a full re-acquire.
  function dropout(t, status) {
    hist.length = 0;
    pending = null;
    if (locked && t - lastValidT <= cfg.lockGraceMs) return { cue: null, status: 'holding', locked: true };
    const lostLock = reset();
    return { cue: null, status, locked: false, lostLock };
  }

  function noPose(t) {
    return dropout(t, 'no-person');
  }

  function toBody(p, mx, my, scale) {
    const rx = p.x - mx;
    const ry = p.y - my;
    const c = Math.cos(-roll);
    const s = Math.sin(-roll);
    return { x: (rx * c - ry * s) / scale, y: (rx * s + ry * c) / scale };
  }

  function frame(lm, world, t, aspect = 1, selfMotion = false) {
    const pt = (i) => ({ x: lm[i].x * aspect, y: lm[i].y, v: lm[i].visibility ?? 1 });
    const ls = pt(J.LS);
    const rs = pt(J.RS);
    const nose = pt(J.NOSE);
    const armVis = [J.LE, J.RE, J.LW, J.RW].reduce((s, i) => s + (lm[i].visibility ?? 1), 0) / 4;

    // Acquiring needs a clearly real person (face, both shoulders, arms); phantom poses on
    // clutter fail this. Once locked, a sideways stance or his head leaving frame is tolerated.
    if (!locked) {
      if (ls.v < cfg.acquireShoulderVis || rs.v < cfg.acquireShoulderVis) return dropout(t, 'no-person');
      if (nose.v < cfg.acquireHeadVis) return dropout(t, 'no-head');
      if (armVis < cfg.acquireArmVis) return dropout(t, 'no-arms');
    } else {
      if ((ls.v + rs.v) / 2 < cfg.keepShoulderVis) return dropout(t, 'no-person');
      if (armVis < cfg.keepArmVis) return dropout(t, 'no-arms');
    }

    const [a, b] = ls.x <= rs.x ? [ls, rs] : [rs, ls];
    const sRaw = Math.hypot(b.x - a.x, b.y - a.y);
    if (!locked && sRaw < cfg.minShoulderWidth) return dropout(t, 'too-small');
    const mx = (ls.x + rs.x) / 2;
    const my = (ls.y + rs.y) / 2;

    if (locked && lastMid && !selfMotion && t - lastValidT < 100
        && Math.hypot(mx - lastMid.x, my - lastMid.y) > cfg.switchJump * scaleEma) {
      const lostLock = reset();
      return { cue: null, status: 'switched', locked: false, lostLock };
    }

    if (scaleEma === null) {
      scaleEma = sRaw;
      roll = Math.atan2(b.y - a.y, b.x - a.x);
    } else if (sRaw > 0.6 * scaleEma) {
      scaleEma = scaleEma * 0.9 + sRaw * 0.1;
      roll = Math.atan2(b.y - a.y, b.x - a.x);
    }

    const noseBody = toBody(nose, mx, my, scaleEma);
    if (!locked && noseBody.y > -0.15) return dropout(t, 'no-head');

    let wShoulderZ = null;
    if (world) {
      const wl = world[J.LS];
      const wr = world[J.RS];
      const ws = Math.hypot(wl.x - wr.x, wl.y - wr.y, wl.z - wr.z);
      if (ws > 0.05) worldScaleEma = worldScaleEma === null ? ws : worldScaleEma * 0.9 + ws * 0.1;
      wShoulderZ = (wl.z + wr.z) / 2;
    }

    const bodyOf = (i) => toBody(pt(i), mx, my, scaleEma);
    const shoulders = { l: bodyOf(J.LS), r: bodyOf(J.RS) };
    const hipVis = Math.min(lm[J.LH].visibility ?? 1, lm[J.RH].visibility ?? 1);
    const hipY = hipVis >= 0.5 ? (bodyOf(J.LH).y + bodyOf(J.RH).y) / 2 : 1.3;

    const joints = {};
    for (const d of JOINTS) {
      const body = bodyOf(d.idx);
      let vis = lm[d.idx].visibility ?? 1;
      // A wrist detached from its own elbow is usually the wearer's hand grafted onto his skeleton.
      if (d.parent !== undefined) {
        const p = bodyOf(d.parent);
        if (Math.hypot(body.x - p.x, body.y - p.y) > cfg.maxLimbRatio) vis = 0;
      }
      const depth = world && wShoulderZ !== null ? world[d.idx].z - wShoulderZ : null;
      let reach = null;
      if (world && worldScaleEma && d.shoulder !== undefined) {
        const w = world[d.idx];
        const s = world[d.shoulder];
        reach = Math.hypot(w.x - s.x, w.y - s.y, w.z - s.z) / worldScaleEma;
      }
      joints[d.name] = { ...body, vis, depth, reach };
    }

    hist.push({ t, joints });
    while (hist.length > 2 && t - hist[0].t > 250) hist.shift();

    let gainedLock = false;
    if (!locked) {
      if (armStart === null) armStart = t;
      if (t - armStart < cfg.armMs) {
        lastValidT = t;
        lastMid = { x: mx, y: my };
        return { cue: null, status: 'locking-on', locked: false };
      }
      locked = true;
      gainedLock = true;
    }

    const now = hist[hist.length - 1];
    let then = null;
    for (let i = hist.length - 2; i >= 0; i--) {
      if (now.t - hist[i].t >= cfg.velocityWindowMs) {
        then = hist[i];
        break;
      }
    }
    if (!then) {
      lastValidT = t;
      lastMid = { x: mx, y: my };
      return { cue: null, status: 'warming-up', locked: true, gainedLock };
    }
    const first = hist[0];
    const dt = (now.t - then.t) / 1000;

    const motion = {};
    for (const d of JOINTS) {
      const j = now.joints[d.name];
      const jp = then.joints[d.name];
      if (j.vis < cfg.minJointVis || jp.vis < cfg.minJointVis) continue;
      const vx = (j.x - jp.x) / dt;
      const vy = (j.y - jp.y) / dt;
      const s2 = Math.hypot(vx, vy);
      let sz = 0;
      if (j.depth !== null && jp.depth !== null && worldScaleEma) {
        sz = -((j.depth - jp.depth) / dt) / worldScaleEma;
      }
      const mag = Math.max(s2, sz);
      if (mag > cfg.glitchSpeed) return dropout(t, 'tracking-jump');
      motion[d.name] = { d, j, vx, vy, s2, sz, mag };
    }

    lastValidT = t;
    lastMid = { x: mx, y: my };

    const thr = cfg.speedThreshold * (selfMotion ? cfg.selfMotionFactor : 1);

    // A limb that just fired stays latched until it has been quiet for latchQuietMs, so one
    // swing gives one cue, while the other hand (a combo) can fire right away.
    const limbSpeed = {};
    for (const m of Object.values(motion)) limbSpeed[m.d.limb] = Math.max(limbSpeed[m.d.limb] ?? 0, m.mag);
    for (const limb of Object.keys(latch)) {
      if ((limbSpeed[limb] ?? 0) < 0.5 * thr) {
        latch[limb].quietSince ??= t;
        if (t - latch[limb].quietSince >= cfg.latchQuietMs) delete latch[limb];
      } else {
        latch[limb].quietSince = null;
      }
    }

    let best = null;
    for (const m of Object.values(motion)) {
      const { d, j } = m;
      if (latch[d.limb]) continue;
      let need = thr;

      if (d.kind === 'foot') {
        const o = now.joints[d.other];
        if (o.vis < cfg.minJointVis || o.y - j.y < cfg.kickLift) continue;
        need *= cfg.legSpeedFactor;
      } else {
        // Pulling the hand back toward his own shoulder is a retraction, never a strike.
        // Judged in 3D: in the flat image a hook's sweep also passes back over his shoulder.
        const jp = then.joints[d.name];
        if (j.reach !== null && jp.reach !== null) {
          if ((j.reach - jp.reach) / dt < -0.4 * m.mag) continue;
        } else {
          const sh = shoulders[d.side];
          const rx = jp.x - sh.x;
          const ry = jp.y - sh.y;
          const r = Math.hypot(rx, ry);
          if (r > 0.35 && (rx * m.vx + ry * m.vy) / r < -0.5 * m.s2 && m.sz <= 0.5) continue;
        }
        if (d.kind === 'wrist' && j.depth !== null
            && Math.hypot(j.x - noseBody.x, j.y - noseBody.y) < cfg.selfTouchDist
            && j.depth > -cfg.selfTouchDepth) continue;
      }

      if (m.mag < need) continue;
      const score = m.mag / need;
      if (!best || score > best.score) best = { ...m, score, startX: first.joints[d.name].x };
    }

    const top = Object.values(motion).sort((p, q) => q.mag - p.mag)[0];
    const debug = top
      ? { joint: top.d.name, speed: +top.mag.toFixed(2), s2: +top.s2.toFixed(2), sz: +top.sz.toFixed(2), y: +top.j.y.toFixed(2) }
      : null;

    if (!best) {
      pending = null;
      return { cue: null, status: selfMotion ? 'self-motion' : 'calm', debug, locked: true, gainedLock };
    }

    const cue = best.d.kind === 'foot' ? classifyKick(best, cfg, hipY) : classify(best, cfg);
    if (debug) debug.zone = cue;
    if (!cue) {
      pending = null;
      return { cue: null, status: 'undecided', debug, locked: true, gainedLock };
    }

    // Confirm on the limb, not the zone: a rising foot or sweeping fist crosses zones mid-strike.
    if (pending && pending.key === best.d.limb) pending.count += 1;
    else pending = { key: best.d.limb, count: 1 };

    if (pending.count < cfg.confirmFrames) return { cue: null, status: 'confirming', debug, locked: true, gainedLock };
    if (t - lastFireT < cfg.minGapMs) return { cue: null, status: 'gap', debug, locked: true, gainedLock };

    lastFireT = t;
    pending = null;
    latch[best.d.limb] = { quietSince: null };
    return { cue, status: 'fired', debug, locked: true, gainedLock, limb: best.d.limb };
  }

  return { frame, noPose, reset, cfg, isLocked: () => locked };
}

function classify(m, cfg) {
  if (m.sz > cfg.speedThreshold * 0.8 && m.sz >= m.s2 * 0.9) return 'back';

  const down = m.vy > 0.6 * m.s2;
  const up = m.vy < -0.6 * m.s2;
  const predY = m.j.y + m.vy * cfg.lookaheadS;

  // A hand dropping from guard could become a mid or a low swing; wait until it commits.
  if (down) return predY > cfg.lowZone && m.j.y > cfg.lowZone * 0.5 ? 'jump' : null;
  if (up || m.j.y < cfg.highZone) return 'duck';
  if (m.j.y > cfg.lowZone) return 'jump';

  return m.startX < 0 ? 'right' : 'left';
}

function classifyKick(m, cfg, hipY) {
  const y = Math.min(m.j.y, m.j.y + m.vy * cfg.lookaheadS * 1.25);
  if (y < cfg.highZone) return 'duck';
  if (y < hipY) return 'back';
  return 'jump';
}
