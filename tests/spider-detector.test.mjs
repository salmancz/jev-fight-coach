import { createDetector } from '../frontend/spider-detector.js';

const ASPECT = 16 / 9;
const FPS = 30;

const BASE_IMG = {
  11: [0.55, 0.40], 12: [0.45, 0.40],
  13: [0.57, 0.50], 14: [0.43, 0.50],
  15: [0.53, 0.38], 16: [0.47, 0.38],
};
const BASE_WORLD = {
  11: [0.18, -0.45, 0], 12: [-0.18, -0.45, 0],
  13: [0.22, -0.2, -0.1], 14: [-0.22, -0.2, -0.1],
  15: [0.1, -0.5, -0.3], 16: [-0.1, -0.5, -0.3],
};

function makeFrame({ img = {}, world = {}, shift = [0, 0], rot = 0, scale = 1 } = {}) {
  const lm = [];
  const wl = [];
  const cx = 0.5;
  const cy = 0.4;
  for (let i = 0; i < 33; i++) {
    let [x, y] = img[i] ?? BASE_IMG[i] ?? [0.5, 0.6];
    let px = (x - cx) * ASPECT * scale;
    let py = (y - cy) * scale;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    [px, py] = [px * c - py * s, px * s + py * c];
    lm.push({ x: (px / ASPECT) + cx + shift[0], y: py + cy + shift[1], z: 0, visibility: 0.95 });
    const [wx, wy, wz] = world[i] ?? BASE_WORLD[i] ?? [0, 0, 0];
    wl.push({ x: wx, y: wy, z: wz });
  }
  return { lm, wl };
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}

function run(frames, opts = {}) {
  const det = createDetector(opts);
  const fired = [];
  frames.forEach((f, i) => {
    const t = i * (1000 / FPS);
    const r = det.frame(f.lm, f.wl, t, ASPECT, f.selfMotion ?? false);
    if (r.cue) fired.push({ cue: r.cue, frame: i });
  });
  return fired;
}

function idle(n, noise = 0.002) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (k) => (Math.sin(i * 7.3 + k) * noise);
    out.push(makeFrame({
      img: {
        15: [0.53 + j(1), 0.38 + j(2)],
        16: [0.47 + j(3), 0.38 + j(4)],
      },
    }));
  }
  return out;
}

function path(joint, from, to, n, extra = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    out.push(makeFrame({ img: { [joint]: [lerp(from[0], to[0], k), lerp(from[1], to[1], k)] }, ...extra }));
  }
  return out;
}

function hold(joint, at, n) {
  return Array.from({ length: n }, () => makeFrame({ img: { [joint]: at } }));
}

const cases = [];
const test = (name, frames, check, opts) => cases.push({ name, frames, check, opts });

test('idle guard with tracking jitter: no cue', idle(90), (f) => f.length === 0);

test('wearer camera shake (translate + roll + zoom): no cue', (() => {
  const out = idle(10);
  for (let i = 0; i < 45; i++) {
    out.push(makeFrame({
      shift: [Math.sin(i * 0.9) * 0.08, Math.cos(i * 1.1) * 0.06],
      rot: Math.sin(i * 0.7) * 0.18,
      scale: 1 + Math.sin(i * 0.5) * 0.12,
    }));
  }
  return out;
})(), (f) => f.length === 0);

test('hook at head height from image-left: DUCK', [
  ...idle(10),
  ...path(16, [0.47, 0.38], [0.36, 0.37], 4),
  ...path(16, [0.36, 0.37], [0.52, 0.38], 4),
  ...hold(16, [0.52, 0.38], 10),
], (f) => f.length >= 1 && f[0].cue === 'duck');

test('mid swing from image-right: LEFT', [
  ...idle(10),
  ...path(15, [0.53, 0.38], [0.60, 0.50], 4),
  ...path(15, [0.60, 0.50], [0.47, 0.50], 4),
  ...hold(15, [0.47, 0.50], 10),
], (f) => f.length >= 1 && f[0].cue === 'left');

test('mid swing from image-left: RIGHT', [
  ...idle(10),
  ...path(16, [0.47, 0.38], [0.40, 0.50], 4),
  ...path(16, [0.40, 0.50], [0.53, 0.50], 4),
  ...hold(16, [0.53, 0.50], 10),
], (f) => f.length >= 1 && f[0].cue === 'right');

test('low swing toward legs: JUMP', [
  ...idle(10),
  ...path(15, [0.53, 0.38], [0.58, 0.64], 5),
  ...path(15, [0.58, 0.64], [0.48, 0.66], 4),
  ...hold(15, [0.48, 0.66], 10),
], (f) => f.length >= 1 && f[0].cue === 'jump');

test('straight push toward camera: BACK', (() => {
  const out = idle(10);
  for (let i = 1; i <= 4; i++) {
    const k = i / 4;
    out.push(makeFrame({
      img: { 16: [lerp(0.47, 0.485, k), lerp(0.38, 0.39, k)] },
      world: { 16: [-0.1, -0.5, lerp(-0.3, -0.75, k)] },
    }));
  }
  for (let i = 0; i < 10; i++) {
    out.push(makeFrame({ img: { 16: [0.485, 0.39] }, world: { 16: [-0.1, -0.5, -0.75] } }));
  }
  return out;
})(), (f) => f.length >= 1 && f[0].cue === 'back');

test('tracking jump (pose re-acquired elsewhere): no cue', [
  ...idle(10),
  ...hold(16, [0.15, 0.38], 1),
  ...hold(16, [0.15, 0.38], 20),
], (f) => f.length === 0);

test('hook while wearer is moving (gyro gate): no cue', [
  ...idle(10),
  ...path(16, [0.47, 0.38], [0.36, 0.37], 4),
  ...path(16, [0.36, 0.37], [0.52, 0.38], 4),
].map((fr, i) => (i >= 10 ? { ...fr, selfMotion: true } : fr)), (f) => f.length === 0);

test('two swings 300ms apart: refractory allows only one cue', [
  ...idle(10),
  ...path(16, [0.47, 0.38], [0.36, 0.37], 4),
  ...path(16, [0.36, 0.37], [0.52, 0.38], 4),
  ...path(16, [0.52, 0.38], [0.36, 0.37], 4),
  ...path(16, [0.36, 0.37], [0.52, 0.38], 4),
  ...hold(16, [0.52, 0.38], 5),
], (f) => f.length === 1);

let failed = 0;
for (const c of cases) {
  const fired = run(c.frames, c.opts);
  const ok = c.check(fired);
  if (!ok) failed++;
  const firstMs = fired.length ? `${Math.round((fired[0].frame - 10) * (1000 / FPS))}ms after motion start` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  -> ${JSON.stringify(fired.map((x) => x.cue))} ${firstMs}`);
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
