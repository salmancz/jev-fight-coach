import { createDetector } from '../frontend/spider-detector.js';

// Poses are written in his body frame (shoulder-width units, origin = shoulder midpoint,
// y down) and projected into a 720x1280 portrait camera frame at 60fps.
const ASPECT = 720 / 1280;
const SW = 0.1125;
const FPS = 60;
const LEAD = 40;

const NEUTRAL = {
  0: [0, -0.65, 0],
  11: [0.5, 0, 0], 12: [-0.5, 0, 0],
  13: [0.6, 0.8, 0], 14: [-0.6, 0.8, 0],
  15: [0.65, 1.5, -0.1], 16: [-0.65, 1.5, -0.1],
  23: [0.35, 1.45, 0], 24: [-0.35, 1.45, 0],
};
const GUARD = {
  13: [0.45, 0.75, -0.3], 14: [-0.45, 0.75, -0.3],
  15: [0.25, -0.15, -0.6], 16: [-0.25, -0.15, -0.6],
};

function frame(pose = {}, { shift = [0, 0], rot = 0, zoom = 1, vis = 0.95, visOver = {} } = {}) {
  const p = { ...NEUTRAL, ...pose };
  const lm = [];
  const wl = [];
  for (let i = 0; i < 33; i++) {
    const [bx, by, bz] = p[i] ?? [0, 2.5, 0];
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const rx = (bx * c - by * s) * SW * zoom;
    const ry = (bx * s + by * c) * SW * zoom;
    lm.push({ x: 0.5 + rx / ASPECT + shift[0], y: 0.4 + ry + shift[1], z: 0, visibility: visOver[i] ?? vis });
    wl.push({ x: bx * 0.36, y: by * 0.36, z: bz * 0.36 });
  }
  return { lm, wl };
}

const lerp = (a, b, k) => a + (b - a) * k;
const lerpPose = (a, b, k) => Object.fromEntries(Object.keys({ ...a, ...b }).map((i) => {
  const pa = a[i] ?? NEUTRAL[i];
  const pb = b[i] ?? NEUTRAL[i];
  return [i, pa.map((v, n) => lerp(v, pb[n], k))];
}));

function move(from, to, n, opts) {
  return Array.from({ length: n }, (_, i) => frame(lerpPose(from, to, (i + 1) / n), opts));
}
const hold = (pose, n, opts) => Array.from({ length: n }, (_, i) => {
  const j = (k) => Math.sin(i * 7.3 + k) * 0.01;
  return frame(Object.fromEntries(Object.entries({ ...NEUTRAL, ...pose }).map(([k, v]) => [k, [v[0] + j(+k), v[1] + j(+k + 1), v[2]]])), opts);
});

// Right-arm hook: elbow lifts to shoulder height while the fist swings out wide, then across his face.
const HOOK_WIND = { 14: [-1.0, 0.05, -0.2], 16: [-1.5, -0.2, -0.3] };
const HOOK_LAND = { 14: [-0.4, -0.05, -0.6], 16: [0.3, -0.4, -1.0] };
const hook = (n = 1, opts) => [...move({}, HOOK_WIND, 9 * n, opts), ...move(HOOK_WIND, HOOK_LAND, 6 * n, opts)];

// Left-arm overhand: fist rises above his head, then comes down toward the camera.
const OVER_UP = { 13: [0.8, -0.2, -0.2], 15: [0.6, -1.1, -0.4] };
const OVER_LAND = { 13: [0.5, 0.0, -0.6], 15: [0.0, -0.5, -1.1] };
const overhand = (opts) => [...move({}, OVER_UP, 10, opts), ...move(OVER_UP, OVER_LAND, 6, opts)];

const cases = [];
const test = (name, frames, check, lead = LEAD) => cases.push({ name, frames, check, lead });
const none = ({ fired }) => fired.length === 0;
const firstIs = (cue) => ({ fired }) => fired.length >= 1 && fired[0].cue === cue;

function run(frames) {
  const det = createDetector();
  const fired = [];
  const byFrame = [];
  frames.forEach((f, i) => {
    const t = i * (1000 / FPS);
    const r = f.noPose ? det.noPose(t) : det.frame(f.lm, f.wl, t, ASPECT, f.selfMotion ?? false);
    byFrame.push(r.status);
    if (r.cue) fired.push({ cue: r.cue, frame: i, side: r.side });
  });
  return { fired, byFrame };
}
const mark = (frames, props) => frames.map((f) => ({ ...f, ...props }));

// ── Must stay silent ────────────────────────────────────────────────────────
test('standing still with tracker jitter', hold({}, 180), none);
test('holding a guard', [...hold({}, LEAD), ...move({}, GUARD, 15), ...hold(GUARD, 90)], none);
test('raising the guard fast', [...hold({}, LEAD), ...move({}, GUARD, 5), ...hold(GUARD, 30), ...move(GUARD, {}, 5), ...move({}, GUARD, 5), ...hold(GUARD, 30)], none);
test('hand gestures at chest height', [...hold({}, LEAD), ...Array.from({ length: 90 }, (_, i) => frame({ 15: [0.4 + Math.sin(i / 4) * 0.3, 0.6 + Math.cos(i / 3) * 0.2, -0.4], 13: [0.6, 0.8, -0.2] }))], none);
test('scratching his head (elbow up, folded tight, hand at head)', [
  ...hold({}, LEAD),
  ...move({}, { 13: [0.7, -0.1, -0.1], 15: [0.2, -0.85, -0.1] }, 8),
  ...hold({ 13: [0.7, -0.1, -0.1], 15: [0.2, -0.85, -0.1] }, 40),
], none);
test('wearer camera shake (translate + roll + zoom)', [
  ...hold({}, LEAD),
  ...Array.from({ length: 90 }, (_, i) => frame({}, {
    shift: [Math.sin(i * 0.5) * 0.06, Math.cos(i * 0.6) * 0.05],
    rot: Math.sin(i * 0.4) * 0.15,
    zoom: 1 + Math.sin(i * 0.3) * 0.1,
  })),
], none);
test('one-frame tracker flicker throws an elbow up', [
  ...hold({}, LEAD),
  frame({ 14: [-1.0, 0.0, 0], 16: [-1.3, -0.5, 0] }),
  ...hold({}, 30),
], none);
test('phantom pose on clutter (low visibility)', Array.from({ length: 120 }, (_, i) => frame({ 16: [-1 + Math.sin(i) * 0.5, -0.4, 0], 14: [-0.9, 0.0, 0] }, { vis: 0.3 + 0.3 * Math.abs(Math.sin(i)) })), none);
test('phantom pose with no head above the shoulders', Array.from({ length: 120 }, (_, i) => frame({ 0: [0, 0.4, 0], 16: [-1 + Math.sin(i) * 0.5, -0.4, 0], 14: [-0.9, 0.0, 0] })), none);
test('tiny far-away pose', Array.from({ length: 120 }, () => frame({}, { zoom: 0.3 })), none);
test('walking into place, then hooking straight away (still locking on)', [
  ...Array.from({ length: 60 }, (_, i) => frame({}, { shift: [lerp(-0.3, 0, i / 59), 0] })),
  ...hook(),
], ({ fired }) => fired.every((f) => f.frame * (1000 / FPS) >= 60 * (1000 / FPS) + 400));
test('walking across the room swinging his arms', [
  ...hold({}, LEAD),
  ...Array.from({ length: 90 }, (_, i) => frame({
    16: [-0.7 + Math.sin(i / 5) * 0.4, 1.4, 0], 15: [0.7 - Math.sin(i / 5) * 0.4, 1.4, 0],
  }, { shift: [i * 0.006, 0] })),
], none);

// ── Must fire ───────────────────────────────────────────────────────────────
test('right hook at head height: DUCK', [...hold({}, LEAD), ...hook(), ...hold(HOOK_LAND, 20)], firstIs('duck'));
test('left overhand: DUCK', [...hold({}, LEAD), ...overhand(), ...hold(OVER_LAND, 20)], firstIs('duck'));
test('hook from a guard: DUCK', [...hold(GUARD, LEAD), ...move(GUARD, { ...GUARD, ...HOOK_WIND }, 9), ...move({ ...GUARD, ...HOOK_WIND }, { ...GUARD, ...HOOK_LAND }, 6), ...hold(GUARD, 20)], firstIs('duck'));
test('straight punch at the camera: STEP BACK', [
  ...hold(GUARD, LEAD),
  ...move(GUARD, { ...GUARD, 14: [-0.3, 0.3, -0.9], 16: [-0.1, -0.1, -2.2] }, 6),
  ...hold({ ...GUARD, 14: [-0.3, 0.3, -0.9], 16: [-0.1, -0.1, -2.2] }, 20),
], firstIs('back'));
test('one hook, back to guard: exactly one cue', [...hold({}, LEAD), ...hook(), ...move(HOOK_LAND, {}, 10), ...hold({}, 60)], ({ fired }) => fired.length === 1);
test('combo: right hook then left overhand: two cues', [
  ...hold({}, LEAD),
  ...hook(),
  ...move(HOOK_LAND, { ...HOOK_LAND, ...OVER_UP }, 10).map((f) => f),
  ...move({ ...HOOK_LAND, ...OVER_UP }, { ...HOOK_LAND, ...OVER_LAND }, 6),
  ...hold({ ...HOOK_LAND, ...OVER_LAND }, 20),
], ({ fired }) => fired.length === 2 && fired.every((f) => f.cue === 'duck') && fired[0].side !== fired[1].side);
test('lunging into a hook (hips move briefly): DUCK', [
  ...hold({}, LEAD),
  ...hook(1).map((f, i) => {
    const k = i / 15;
    const g = frame(lerpPose({}, i < 9 ? HOOK_WIND : HOOK_LAND, i < 9 ? (i + 1) / 9 : (i - 8) / 6), { shift: [0, k * 0.02] });
    return g;
  }),
  ...hold(HOOK_LAND, 20),
], firstIs('duck'));
test('pose lost for 5 frames of blur, then hook: DUCK without re-locking', [
  ...hold({}, LEAD),
  ...mark(hold({}, 5), { noPose: true }),
  ...hook(),
  ...hold(HOOK_LAND, 20),
], ({ fired, byFrame }) => fired.length >= 1 && !byFrame.slice(LEAD).includes('locking-on'));
test('he turns side-on for a moment (one shoulder hidden), then hooks: DUCK', [
  ...hold({}, LEAD),
  ...hold({}, 10, { visOver: { 11: 0.3, 13: 0.3, 15: 0.3 } }),
  ...hook(),
  ...hold(HOOK_LAND, 20),
], firstIs('duck'));
test('fast hook while the wearer is moving: still DUCK', [...hold({}, LEAD), ...mark(hook(), { selfMotion: true }), ...hold(HOOK_LAND, 20)], firstIs('duck'));

let failed = 0;
for (const c of cases) {
  const out = run(c.frames);
  const ok = c.check(out);
  if (!ok) failed++;
  const ms = out.fired.length ? `  first cue ${Math.round((out.fired[0].frame - c.lead) * (1000 / FPS))}ms after the move starts` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  -> ${JSON.stringify(out.fired.map((x) => x.cue))}${ms}`);
}
console.log(failed ? `\n${failed} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
