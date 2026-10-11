import { createDetector } from '../frontend/spider-detector.js';

const ASPECT = 16 / 9;
const LEAD = 15;

const BASE_IMG = {
  0: [0.5, 0.28],
  11: [0.55, 0.40], 12: [0.45, 0.40],
  13: [0.57, 0.50], 14: [0.43, 0.50],
  15: [0.53, 0.38], 16: [0.47, 0.38],
};
const BASE_WORLD = {
  11: [0.18, -0.45, 0], 12: [-0.18, -0.45, 0],
  13: [0.22, -0.2, -0.1], 14: [-0.22, -0.2, -0.1],
  15: [0.1, -0.5, -0.3], 16: [-0.1, -0.5, -0.3],
};

function makeFrame({ img = {}, world = {}, shift = [0, 0], rot = 0, scale = 1, vis = 0.95 } = {}) {
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
    lm.push({ x: (px / ASPECT) + cx + shift[0], y: py + cy + shift[1], z: 0, visibility: vis });
    const [wx, wy, wz] = world[i] ?? BASE_WORLD[i] ?? [0, 0, 0];
    wl.push({ x: wx, y: wy, z: wz });
  }
  return { lm, wl };
}

const lerp = (a, b, k) => a + (b - a) * k;

function run(frames, fps) {
  const det = createDetector();
  const fired = [];
  frames.forEach((f, i) => {
    const r = det.frame(f.lm, f.wl, i * (1000 / fps), ASPECT, f.selfMotion ?? false);
    if (r.cue) fired.push({ cue: r.cue, frame: i });
  });
  return fired;
}

function idle(n, noise = 0.002) {
  return Array.from({ length: n }, (_, i) => {
    const j = (k) => Math.sin(i * 7.3 + k) * noise;
    return makeFrame({ img: { 15: [0.53 + j(1), 0.38 + j(2)], 16: [0.47 + j(3), 0.38 + j(4)] } });
  });
}

function path(joint, from, to, n) {
  return Array.from({ length: n }, (_, i) => {
    const k = (i + 1) / n;
    return makeFrame({ img: { [joint]: [lerp(from[0], to[0], k), lerp(from[1], to[1], k)] } });
  });
}

const hold = (joint, at, n) => Array.from({ length: n }, () => makeFrame({ img: { [joint]: at } }));

// m = frames-per-step multiplier so the same swing can be replayed at 60fps.
function hook(m = 1) {
  return [
    ...idle(LEAD * m),
    ...path(16, [0.47, 0.38], [0.36, 0.37], 4 * m),
    ...path(16, [0.36, 0.37], [0.52, 0.38], 4 * m),
    ...hold(16, [0.52, 0.38], 10 * m),
  ];
}

const cases = [];
const test = (name, frames, check, fps = 30, lead = LEAD) => cases.push({ name, frames, check, fps, lead });

test('idle guard with tracking jitter: no cue', idle(90), (f) => f.length === 0);

test('wearer camera shake (translate + roll + zoom): no cue', [
  ...idle(LEAD),
  ...Array.from({ length: 45 }, (_, i) => makeFrame({
    shift: [Math.sin(i * 0.9) * 0.08, Math.cos(i * 1.1) * 0.06],
    rot: Math.sin(i * 0.7) * 0.18,
    scale: 1 + Math.sin(i * 0.5) * 0.12,
  })),
], (f) => f.length === 0);

test('phantom pose on clutter (low visibility, jumping joints): no cue',
  Array.from({ length: 90 }, (_, i) => makeFrame({
    vis: 0.3 + 0.3 * Math.abs(Math.sin(i)),
    img: { 15: [0.5 + Math.sin(i * 3.1) * 0.1, 0.4 + Math.cos(i * 2.3) * 0.1], 16: [0.45 + Math.sin(i * 1.7) * 0.1, 0.4] },
  })),
  (f) => f.length === 0);

test('phantom pose with no head above the shoulders: no cue',
  Array.from({ length: 90 }, (_, i) => makeFrame({
    img: { 0: [0.5, 0.45], 16: [0.47 + Math.sin(i * 2.9) * 0.1, 0.38 + Math.cos(i * 2.1) * 0.08] },
  })),
  (f) => f.length === 0);

test('tiny far-away pose: no cue',
  Array.from({ length: 60 }, (_, i) => makeFrame({
    scale: 0.08,
    img: { 16: [0.47 + Math.sin(i * 2.9) * 0.05, 0.38] },
  })),
  (f) => f.length === 0);

test('nothing fires in the first 300ms after a person appears', hook().slice(LEAD - 3), (f) => f.every((x) => x.frame * (1000 / 30) >= 300), 30, 3);

test('hook at head height from image-left: DUCK', hook(), (f) => f.length >= 1 && f[0].cue === 'duck');
test('same hook at 60fps: DUCK', hook(2), (f) => f.length >= 1 && f[0].cue === 'duck', 60, LEAD * 2);

test('mid swing from image-right: LEFT', [
  ...idle(LEAD),
  ...path(15, [0.53, 0.38], [0.60, 0.50], 4),
  ...path(15, [0.60, 0.50], [0.47, 0.50], 4),
  ...hold(15, [0.47, 0.50], 10),
], (f) => f.length >= 1 && f[0].cue === 'left');

test('mid swing from image-left: RIGHT', [
  ...idle(LEAD),
  ...path(16, [0.47, 0.38], [0.40, 0.50], 4),
  ...path(16, [0.40, 0.50], [0.53, 0.50], 4),
  ...hold(16, [0.53, 0.50], 10),
], (f) => f.length >= 1 && f[0].cue === 'right');

test('low swing toward legs: JUMP', [
  ...idle(LEAD),
  ...path(15, [0.53, 0.38], [0.58, 0.64], 5),
  ...path(15, [0.58, 0.64], [0.48, 0.66], 4),
  ...hold(15, [0.48, 0.66], 10),
], (f) => f.length >= 1 && f[0].cue === 'jump');

test('straight push toward camera: BACK', [
  ...idle(LEAD),
  ...Array.from({ length: 4 }, (_, i) => {
    const k = (i + 1) / 4;
    return makeFrame({
      img: { 16: [lerp(0.47, 0.485, k), lerp(0.38, 0.39, k)] },
      world: { 16: [-0.1, -0.5, lerp(-0.3, -0.75, k)] },
    });
  }),
  ...Array.from({ length: 10 }, () => makeFrame({ img: { 16: [0.485, 0.39] }, world: { 16: [-0.1, -0.5, -0.75] } })),
], (f) => f.length >= 1 && f[0].cue === 'back');

test('tracking jump (pose re-acquired elsewhere): no cue', [
  ...idle(LEAD),
  ...hold(16, [0.15, 0.38], 21),
], (f) => f.length === 0);

test('hook while wearer is moving (gyro gate): no cue',
  hook().map((fr, i) => (i >= LEAD ? { ...fr, selfMotion: true } : fr)),
  (f) => f.length === 0);

test('two swings 300ms apart: refractory allows only one cue', [
  ...idle(LEAD),
  ...path(16, [0.47, 0.38], [0.36, 0.37], 4),
  ...path(16, [0.36, 0.37], [0.52, 0.38], 4),
  ...path(16, [0.52, 0.38], [0.36, 0.37], 4),
  ...path(16, [0.36, 0.37], [0.52, 0.38], 4),
  ...hold(16, [0.52, 0.38], 5),
], (f) => f.length === 1);

let failed = 0;
for (const c of cases) {
  const fired = run(c.frames, c.fps);
  const ok = c.check(fired);
  if (!ok) failed++;
  const ms = fired.length ? `${Math.round((fired[0].frame - c.lead) * (1000 / c.fps))}ms after motion start` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  -> ${JSON.stringify(fired.map((x) => x.cue))} ${ms}`);
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
