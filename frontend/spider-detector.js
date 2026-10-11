// Pure if/else strike detector for a chest/head-mounted POV camera.
// All motion is measured in the attacker's own body frame (origin = shoulder midpoint,
// unit = shoulder width, rotated by shoulder-line roll), so camera shake from the wearer
// moving cancels out instead of looking like a strike.

const J = { NOSE: 0, LS: 11, RS: 12, LE: 13, RE: 14, LW: 15, RW: 16 };

export const DEFAULTS = {
  speedThreshold: 3.5,
  confirmFrames: 3,
  refractoryMs: 700,
  lookaheadS: 0.08,
  highZone: 0.3,
  lowZone: 1.0,
  minShoulderVis: 0.7,
  minHeadVis: 0.7,
  minArmVis: 0.5,
  minJointVis: 0.5,
  minShoulderWidth: 0.05,
  armMs: 300,
  velocityWindowMs: 45,
  glitchSpeed: 40,
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

  function reset() {
    hist.length = 0;
    pending = null;
    armStart = null;
    scaleEma = null;
    worldScaleEma = null;
    roll = 0;
  }

  function lost(status) {
    reset();
    return { cue: null, status, locked: false };
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

    // A real person has a visible face, both shoulders and arms; phantom poses on clutter don't.
    if (ls.v < cfg.minShoulderVis || rs.v < cfg.minShoulderVis) return lost('no-person');
    if (nose.v < cfg.minHeadVis) return lost('no-head');
    const armVis = [J.LE, J.RE, J.LW, J.RW].reduce((s, i) => s + (lm[i].visibility ?? 1), 0) / 4;
    if (armVis < cfg.minArmVis) return lost('no-arms');

    const [a, b] = ls.x <= rs.x ? [ls, rs] : [rs, ls];
    const sRaw = Math.hypot(b.x - a.x, b.y - a.y);
    if (sRaw < cfg.minShoulderWidth) return lost('too-small');
    if (scaleEma === null) {
      scaleEma = sRaw;
      roll = Math.atan2(b.y - a.y, b.x - a.x);
    }
    if (sRaw > 0.6 * scaleEma) {
      scaleEma = scaleEma * 0.9 + sRaw * 0.1;
      roll = Math.atan2(b.y - a.y, b.x - a.x);
    }
    const mx = (ls.x + rs.x) / 2;
    const my = (ls.y + rs.y) / 2;

    if (toBody(nose, mx, my, scaleEma).y > -0.15) return lost('no-head');

    let wShoulderZ = null;
    if (world) {
      const wl = world[J.LS];
      const wr = world[J.RS];
      const ws = Math.hypot(wl.x - wr.x, wl.y - wr.y, wl.z - wr.z);
      if (ws > 0.05) worldScaleEma = worldScaleEma === null ? ws : worldScaleEma * 0.9 + ws * 0.1;
      wShoulderZ = (wl.z + wr.z) / 2;
    }

    const joints = {};
    for (const [name, idx] of [['lw', J.LW], ['rw', J.RW], ['le', J.LE], ['re', J.RE]]) {
      const p = pt(idx);
      const body = toBody(p, mx, my, scaleEma);
      const depth = world && wShoulderZ !== null ? world[idx].z - wShoulderZ : null;
      joints[name] = { ...body, vis: p.v, depth };
    }

    hist.push({ t, joints });
    while (hist.length > 2 && t - hist[0].t > 250) hist.shift();

    if (armStart === null) armStart = t;
    if (t - armStart < cfg.armMs) {
      pending = null;
      return { cue: null, status: 'locking-on', locked: false };
    }

    const now = hist[hist.length - 1];
    let then = null;
    for (let i = hist.length - 2; i >= 0; i--) {
      if (now.t - hist[i].t >= cfg.velocityWindowMs) {
        then = hist[i];
        break;
      }
    }
    if (!then) return { cue: null, status: 'warming-up', locked: true };
    const first = hist[0];
    const dt = (now.t - then.t) / 1000;

    let best = null;
    for (const name of ['lw', 'rw', 'le', 're']) {
      const j = now.joints[name];
      const jp = then.joints[name];
      if (j.vis < cfg.minJointVis || jp.vis < cfg.minJointVis) continue;
      const vx = (j.x - jp.x) / dt;
      const vy = (j.y - jp.y) / dt;
      const s2 = Math.hypot(vx, vy);
      let sz = 0;
      if (j.depth !== null && jp.depth !== null && worldScaleEma) {
        sz = -((j.depth - jp.depth) / dt) / worldScaleEma;
      }
      const mag = Math.max(s2, sz);
      if (mag > cfg.glitchSpeed) return lost('tracking-jump');
      if (!best || mag > best.mag) {
        best = { name, j, vx, vy, s2, sz, mag, startX: first.joints[name].x };
      }
    }

    const debug = best
      ? { joint: best.name, speed: +best.mag.toFixed(2), s2: +best.s2.toFixed(2), sz: +best.sz.toFixed(2), y: +best.j.y.toFixed(2) }
      : null;

    if (selfMotion) {
      pending = null;
      return { cue: null, status: 'self-motion', debug, locked: true };
    }

    if (!best || best.mag < cfg.speedThreshold) {
      pending = null;
      return { cue: null, status: 'calm', debug, locked: true };
    }

    const cue = classify(best, cfg);
    debug.zone = cue;
    if (!cue) {
      pending = null;
      return { cue: null, status: 'undecided', debug, locked: true };
    }

    if (pending && pending.cue === cue) pending.count += 1;
    else pending = { cue, count: 1 };

    if (pending.count < cfg.confirmFrames) return { cue: null, status: 'confirming', debug, locked: true };
    if (t - lastFireT < cfg.refractoryMs) return { cue: null, status: 'refractory', debug, locked: true };

    lastFireT = t;
    pending = null;
    return { cue, status: 'fired', debug, locked: true };
  }

  return { frame, reset, cfg };
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
