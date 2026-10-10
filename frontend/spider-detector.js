// Pure if/else strike detector for a chest/head-mounted POV camera.
// All motion is measured in the attacker's own body frame (origin = shoulder midpoint,
// unit = shoulder width, rotated by shoulder-line roll), so camera shake from the wearer
// moving cancels out instead of looking like a strike.

const J = { LS: 11, RS: 12, LE: 13, RE: 14, LW: 15, RW: 16 };

export const DEFAULTS = {
  speedThreshold: 3.5,
  confirmFrames: 2,
  refractoryMs: 700,
  lookaheadS: 0.08,
  highZone: 0.3,
  lowZone: 1.0,
  minShoulderVis: 0.5,
  minJointVis: 0.3,
  glitchSpeed: 40,
  minHistory: 3,
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

  function reset() {
    hist.length = 0;
    pending = null;
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

    if (ls.v < cfg.minShoulderVis || rs.v < cfg.minShoulderVis) {
      reset();
      return { cue: null, status: 'no-shoulders' };
    }

    const [a, b] = ls.x <= rs.x ? [ls, rs] : [rs, ls];
    const sRaw = Math.hypot(b.x - a.x, b.y - a.y);
    if (scaleEma === null) scaleEma = sRaw;
    const frontal = sRaw > 0.6 * scaleEma;
    if (frontal) {
      scaleEma = scaleEma * 0.9 + sRaw * 0.1;
      roll = Math.atan2(b.y - a.y, b.x - a.x);
    }
    const mx = (ls.x + rs.x) / 2;
    const my = (ls.y + rs.y) / 2;

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
    if (hist.length > 8) hist.shift();
    if (hist.length < cfg.minHistory) {
      pending = null;
      return { cue: null, status: 'warming-up' };
    }

    const now = hist[hist.length - 1];
    const then = hist[hist.length - 3];
    const first = hist[0];
    const dt = (now.t - then.t) / 1000;
    if (dt <= 0) return { cue: null, status: 'bad-dt' };

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
      if (mag > cfg.glitchSpeed) {
        reset();
        return { cue: null, status: 'tracking-jump' };
      }
      if (!best || mag > best.mag) {
        best = { name, j, vx, vy, s2, sz, mag, startX: first.joints[name].x };
      }
    }

    const debug = best
      ? { joint: best.name, speed: +best.mag.toFixed(2), s2: +best.s2.toFixed(2), sz: +best.sz.toFixed(2), y: +best.j.y.toFixed(2) }
      : null;

    if (selfMotion) {
      pending = null;
      return { cue: null, status: 'self-motion', debug };
    }

    if (!best || best.mag < cfg.speedThreshold) {
      pending = null;
      return { cue: null, status: 'calm', debug };
    }

    const cue = classify(best, cfg);
    debug.zone = cue;
    if (!cue) {
      pending = null;
      return { cue: null, status: 'undecided', debug };
    }

    if (pending && pending.cue === cue) pending.count += 1;
    else pending = { cue, count: 1 };

    if (pending.count < cfg.confirmFrames) return { cue: null, status: 'confirming', debug };
    if (t - lastFireT < cfg.refractoryMs) return { cue: null, status: 'refractory', debug };

    lastFireT = t;
    pending = null;
    return { cue, status: 'fired', debug };
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
