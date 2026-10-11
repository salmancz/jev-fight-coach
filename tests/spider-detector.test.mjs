import { createDetector } from '../frontend/spider-detector.js';

const ASPECT = 16 / 9;
const LEAD = 15;

const BASE_IMG = {
  0: [0.5, 0.28],
  11: [0.55, 0.40], 12: [0.45, 0.40],
  13: [0.57, 0.50], 14: [0.43, 0.50],
  15: [0.53, 0.38], 16: [0.47, 0.38],
  23: [0.53, 0.62], 24: [0.47, 0.62],
  25: [0.53, 0.80], 26: [0.47, 0.80],
  27: [0.53, 0.97], 28: [0.47, 0.97],
};
const BASE_WORLD = {
  11: [0.18, -0.45, 0], 12: [-0.18, -0.45, 0],
  13: [0.22, -0.2, -0.1], 14: [-0.22, -0.2, -0.1],
  15: [0.1, -0.5, -0.3], 16: [-0.1, -0.5, -0.3],
};

function makeFrame({ img = {}, world = {}, shift = [0, 0], rot = 0, scale = 1, vis = 0.95, visOver = {} } = {}) {
  const lm = [];
  const wl = [];
  const cx = 0.5;
  const cy = 0.4;
  for (let i = 0; i < 33; i++) {
    const [x, y] = img[i] ?? BASE_IMG[i] ?? [0.5, 0.6];
    let px = (x - cx) * ASPECT * scale;
    let py = (y - cy) * scale;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    [px, py] = [px * c - py * s, px * s + py * c];
    lm.push({ x: (px / ASPECT) + cx + shift[0], y: py + cy + shift[1], z: 0, visibility: visOver[i] ?? vis });
    const [wx, wy, wz] = world[i] ?? BASE_WORLD[i] ?? [0, 0, 0];
    wl.push({ x: wx, y: wy, z: wz });
  }
  return { lm, wl };
}

const lerp = (a, b, k) => a + (b - a) * k;

function run(frames, fps) {
  const det = createDetector();
  const fired = [];
  const statuses = new Set();
  const byFrame = [];
  frames.forEach((f, i) => {
    const t = i * (1000 / fps);
    const r = f.noPose ? det.noPose(t) : det.frame(f.lm, f.wl, t, ASPECT, f.selfMotion ?? false);
    statuses.add(r.status);
    byFrame.push(r.status);
    if (r.cue) fired.push({ cue: r.cue, frame: i });
  });
  return { fired, statuses, byFrame };
}

function idle(n, img = {}, opts = {}) {
  return Array.from({ length: n }, (_, i) => {
    const j = (k) => Math.sin(i * 7.3 + k) * 0.002;
    return makeFrame({ img: { 15: [0.53 + j(1), 0.38 + j(2)], 16: [0.47 + j(3), 0.38 + j(4)], ...img }, ...opts });
  });
}

function path(joint, from, to, n, opts = {}) {
  return Array.from({ length: n }, (_, i) => {
    const k = (i + 1) / n;
    return makeFrame({ img: { [joint]: [lerp(from[0], to[0], k), lerp(from[1], to[1], k)] }, ...opts });
  });
}

const hold = (joint, at, n, opts = {}) => Array.from({ length: n }, () => makeFrame({ img: { [joint]: at }, ...opts }));
const mark = (frames, props) => frames.map((f) => ({ ...f, ...props }));

// m = frames-per-step multiplier so the same swing can be replayed at 60fps.
function hookFrames(m = 1, opts = {}) {
  return [
    ...path(16, [0.47, 0.38], [0.36, 0.37], 4 * m, opts),
    ...path(16, [0.36, 0.37], [0.52, 0.38], 4 * m, opts),
  ];
}
const hook = (m = 1) => [...idle(LEAD * m), ...hookFrames(m), ...hold(16, [0.52, 0.38], 10 * m)];

const cases = [];
const test = (name, frames, check, fps = 30, lead = LEAD) => cases.push({ name, frames, check, fps, lead });
const none = ({ fired }) => fired.length === 0;
const firstIs = (cue) => ({ fired }) => fired.length >= 1 && fired[0].cue === cue;

// ── False alarms ────────────────────────────────────────────────────────────
test('idle guard with tracking jitter: no cue', idle(90), none);

test('wearer camera shake (translate + roll + zoom): no cue', [
  ...idle(LEAD),
  ...Array.from({ length: 45 }, (_, i) => makeFrame({
    shift: [Math.sin(i * 0.9) * 0.08, Math.cos(i * 1.1) * 0.06],
    rot: Math.sin(i * 0.7) * 0.18,
    scale: 1 + Math.sin(i * 0.5) * 0.12,
  })),
], none);

test('phantom pose on clutter (low visibility, jumping joints): no cue',
  Array.from({ length: 90 }, (_, i) => makeFrame({
    vis: 0.3 + 0.3 * Math.abs(Math.sin(i)),
    img: { 15: [0.5 + Math.sin(i * 3.1) * 0.1, 0.4 + Math.cos(i * 2.3) * 0.1], 16: [0.45 + Math.sin(i * 1.7) * 0.1, 0.4] },
  })),
  none);

test('phantom pose with no head above the shoulders: no cue',
  Array.from({ length: 90 }, (_, i) => makeFrame({
    img: { 0: [0.5, 0.45], 16: [0.47 + Math.sin(i * 2.9) * 0.1, 0.38 + Math.cos(i * 2.1) * 0.08] },
  })),
  none);

test('tiny far-away pose: no cue',
  Array.from({ length: 60 }, (_, i) => makeFrame({ scale: 0.08, img: { 16: [0.47 + Math.sin(i * 2.9) * 0.05, 0.38] } })),
  none);

test('nothing fires in the first 250ms after a person appears', hook().slice(LEAD - 3),
  ({ fired }) => fired.every((x) => x.frame * (1000 / 30) >= 250), 30, 3);

test('he touches his own head fast: no cue', [
  ...idle(LEAD),
  ...path(16, [0.47, 0.38], [0.49, 0.29], 4, { world: { 16: [-0.05, -0.6, 0] } }),
  ...hold(16, [0.49, 0.29], 10, { world: { 16: [-0.05, -0.6, 0] } }),
], none);

const EXT = [-0.3, -0.55, -0.55];
const GUARD = [-0.1, -0.5, -0.3];
test('he pulls his hand back from extended to guard: no cue', [
  ...idle(LEAD, { 16: [0.36, 0.30] }, { world: { 16: EXT } }),
  ...Array.from({ length: 4 }, (_, i) => {
    const k = (i + 1) / 4;
    return makeFrame({
      img: { 16: [lerp(0.36, 0.47, k), lerp(0.30, 0.38, k)] },
      world: { 16: EXT.map((v, n) => lerp(v, GUARD[n], k)) },
    });
  }),
  ...hold(16, [0.47, 0.38], 10),
], none);

test('wearer\'s own hand grafted onto his skeleton: no cue', [
  ...idle(LEAD),
  ...path(16, [0.6, 0.95], [0.3, 0.95], 8),
], none);

test('a second person replaces him in frame: no cue, lock dropped', [
  ...idle(LEAD),
  ...idle(30, {}, { shift: [0.35, 0] }),
], ({ fired, statuses }) => fired.length === 0 && statuses.has('switched'));

test('tracking jump (wrist re-acquired elsewhere): no cue', [
  ...idle(LEAD),
  ...hold(16, [0.15, 0.38], 21),
], none);

test('small step (foot lifts a little): no cue', [
  ...idle(LEAD),
  ...path(28, [0.47, 0.97], [0.49, 0.92], 3),
  ...path(28, [0.49, 0.92], [0.47, 0.97], 3),
  ...idle(5),
], none);

// ── Strikes ─────────────────────────────────────────────────────────────────
test('hook at head height from image-left: DUCK', hook(), firstIs('duck'));
test('same hook at 60fps: DUCK', hook(2), firstIs('duck'), 60, LEAD * 2);

test('one hook (out, across, back to guard): exactly one cue', [
  ...hook().slice(0, LEAD + 8),
  ...path(16, [0.52, 0.38], [0.47, 0.38], 4),
  ...idle(15),
], ({ fired }) => fired.length === 1);

test('combo: right hook then left swing 250ms later: two cues', [
  ...idle(LEAD),
  ...hookFrames(),
  ...path(15, [0.53, 0.38], [0.60, 0.50], 4, { img: { 16: [0.52, 0.38] } }).map((f, i) => makeFrame({ img: { 16: [0.52, 0.38], 15: [lerp(0.53, 0.60, (i + 1) / 4), lerp(0.38, 0.50, (i + 1) / 4)] } })),
  ...Array.from({ length: 4 }, (_, i) => makeFrame({ img: { 16: [0.52, 0.38], 15: [lerp(0.60, 0.47, (i + 1) / 4), 0.50] } })),
  ...Array.from({ length: 10 }, () => makeFrame({ img: { 16: [0.52, 0.38], 15: [0.47, 0.50] } })),
], ({ fired }) => fired.length === 2 && fired[0].cue === 'duck' && fired[1].cue === 'left');

test('mid swing from image-right: LEFT', [
  ...idle(LEAD),
  ...path(15, [0.53, 0.38], [0.60, 0.50], 4),
  ...path(15, [0.60, 0.50], [0.47, 0.50], 4),
  ...hold(15, [0.47, 0.50], 10),
], firstIs('left'));

test('mid swing from image-left: RIGHT', [
  ...idle(LEAD),
  ...path(16, [0.47, 0.38], [0.40, 0.50], 4),
  ...path(16, [0.40, 0.50], [0.53, 0.50], 4),
  ...hold(16, [0.53, 0.50], 10),
], firstIs('right'));

test('low swing toward legs: JUMP', [
  ...idle(LEAD),
  ...path(15, [0.53, 0.38], [0.58, 0.64], 5),
  ...path(15, [0.58, 0.64], [0.48, 0.66], 4),
  ...hold(15, [0.48, 0.66], 10),
], firstIs('jump'));

test('straight push toward camera: BACK', [
  ...idle(LEAD),
  ...Array.from({ length: 4 }, (_, i) => {
    const k = (i + 1) / 4;
    return makeFrame({ img: { 16: [lerp(0.47, 0.485, k), lerp(0.38, 0.39, k)] }, world: { 16: [-0.1, -0.5, lerp(-0.3, -0.75, k)] } });
  }),
  ...Array.from({ length: 10 }, () => makeFrame({ img: { 16: [0.485, 0.39] }, world: { 16: [-0.1, -0.5, -0.75] } })),
], firstIs('back'));

test('high kick: DUCK', [
  ...idle(LEAD),
  ...path(28, [0.47, 0.97], [0.52, 0.35], 5),
  ...hold(28, [0.52, 0.35], 8),
], firstIs('duck'));

test('low kick: JUMP', [
  ...idle(LEAD),
  ...path(28, [0.47, 0.97], [0.56, 0.82], 6),
  ...hold(28, [0.56, 0.82], 8),
], firstIs('jump'));

// ── Keeping the lock ────────────────────────────────────────────────────────
test('he turns sideways for 200ms (one shoulder hidden), then hooks: DUCK without re-locking', [
  ...idle(LEAD),
  ...idle(6, {}, { visOver: { 11: 0.2, 13: 0.2, 15: 0.2 } }),
  ...hookFrames(),
  ...hold(16, [0.52, 0.38], 10),
], ({ fired, byFrame }) => !byFrame.slice(LEAD).includes('locking-on') && fired.length >= 1 && fired[0].cue === 'duck', 30, LEAD + 6);

test('his head leaves the frame mid-hook: still DUCK', [
  ...idle(LEAD),
  ...hookFrames(1, { visOver: { 0: 0.1 } }),
  ...hold(16, [0.52, 0.38], 10, { visOver: { 0: 0.1 } }),
], firstIs('duck'));

test('pose lost for 5 frames of motion blur, then hook: DUCK without re-locking', [
  ...idle(LEAD),
  ...mark(idle(5), { noPose: true }),
  ...hookFrames(),
  ...hold(16, [0.52, 0.38], 10),
], ({ fired, byFrame }) => byFrame.slice(LEAD).includes('holding') && !byFrame.slice(LEAD).includes('locking-on') && fired.length >= 1 && fired[0].cue === 'duck', 30, LEAD + 5);

test('pose lost for 1 second: lock dropped and reported', [
  ...idle(LEAD),
  ...mark(idle(30), { noPose: true }),
], ({ fired, statuses }) => fired.length === 0 && statuses.has('no-person'));

// ── Wearer moving ───────────────────────────────────────────────────────────
test('fast hook while wearer is moving: still DUCK', mark(hook(), { selfMotion: true }).map((f, i) => (i < LEAD ? { ...f, selfMotion: false } : f)), firstIs('duck'));

const slowSwing = [...idle(LEAD), ...path(16, [0.47, 0.38], [0.41, 0.37], 4), ...hold(16, [0.41, 0.37], 10)];
test('moderate arm motion when wearer is still: fires', slowSwing, ({ fired }) => fired.length >= 1);
test('same moderate arm motion while wearer is moving: no cue', slowSwing.map((f, i) => (i >= LEAD ? { ...f, selfMotion: true } : f)), none);

let failed = 0;
for (const c of cases) {
  const out = run(c.frames, c.fps);
  const ok = c.check(out);
  if (!ok) failed++;
  const ms = out.fired.length ? `${Math.round((out.fired[0].frame - c.lead) * (1000 / c.fps))}ms after motion start` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  -> ${JSON.stringify(out.fired.map((x) => x.cue))} ${ms}${ok ? '' : `  statuses=${[...out.statuses]}`}`);
}
console.log(failed ? `\n${failed} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
