// Prints per-frame arm features from extracted landmarks, tagged with labels, to design rules from real data.
// Usage: node tests/features.mjs <landmarks.json> <labels.json> [from] [to] [step]
import { readFileSync } from 'node:fs';

const [lmFile, labelFile, from = '0', to = '999', step = '2'] = process.argv.slice(2);
const data = JSON.parse(readFileSync(lmFile, 'utf8'));
const labels = JSON.parse(readFileSync(labelFile, 'utf8'));
const aspect = data.width / data.height;

const tag = (t) => {
  const s = labels.strikes.findIndex((x) => t >= x.range[0] && t <= x.range[1]);
  if (s >= 0) return `S${s + 1}`;
  return labels.quiet.some((x) => t >= x.range[0] && t <= x.range[1]) ? '  .' : '  ?';
};

const P = (f, i) => ({ x: f.lm[i][0] * aspect, y: f.lm[i][1], v: f.lm[i][3] });
const W = (f, i) => ({ x: f.wl[i][0], y: f.wl[i][1], z: f.wl[i][2] });
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const angle = (a, b, c) => {
  const u = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const cos = (u.x * v.x + u.y * v.y + u.z * v.z) / (Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};

function feats(f) {
  const ls = P(f, 11);
  const rs = P(f, 12);
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  const mx = (ls.x + rs.x) / 2;
  const my = (ls.y + rs.y) / 2;
  const wsw = d3(W(f, 11), W(f, 12));
  const out = { sw, mx, my };
  for (const [k, w, e, s] of [['L', 15, 13, 11], ['R', 16, 14, 12]]) {
    const p = P(f, w);
    out[k] = {
      x: (p.x - mx) / sw,
      y: (p.y - my) / sw,
      v: p.v,
      reach: d3(W(f, w), W(f, s)) / wsw,
      elbow: angle(W(f, s), W(f, e), W(f, w)),
      depth: (W(f, w).z - (W(f, 11).z + W(f, 12).z) / 2) / wsw,
    };
  }
  return out;
}

const frames = data.frames.filter((f) => f.lm && f.t / 1000 >= Number(from) && f.t / 1000 <= Number(to));
const F = frames.map((f) => ({ t: f.t / 1000, ...feats(f) }));
const lag = 3;
console.log('t      tag | arm  x     y     spd   reach elbow depth vis | arm  x     y     spd   reach elbow depth vis | hipspd');
for (let i = lag; i < F.length; i += Number(step)) {
  const a = F[i];
  const b = F[i - lag];
  const dt = a.t - b.t;
  const row = [`${a.t.toFixed(2)} ${tag(a.t)}`];
  for (const k of ['L', 'R']) {
    const spd = Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y) / dt;
    row.push(`${k} ${a[k].x.toFixed(2).padStart(5)} ${a[k].y.toFixed(2).padStart(5)} ${spd.toFixed(1).padStart(5)} ${a[k].reach.toFixed(2).padStart(5)} ${a[k].elbow.toFixed(0).padStart(5)} ${a[k].depth.toFixed(2).padStart(5)} ${a[k].v.toFixed(2)}`);
  }
  const hs = Math.hypot(a.mx - b.mx, a.my - b.my) / a.sw / dt;
  row.push(hs.toFixed(1));
  console.log(row.join(' | '));
}
