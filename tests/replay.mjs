// Replays landmarks (and optionally small grayscale frames for the looming channel) extracted
// from a real video through the detector, and scores it against hand-labelled time ranges.
// Usage: node tests/replay.mjs <landmarks.json> <labels.json> [--gray=<file.raw> --gray-size=64x85 --gray-start=13]
//        [--fps=30] [--verbose] [--quiet-only-summary]
import { readFileSync } from 'node:fs';
import { createDetector } from '../frontend/spider-detector.js';
import { createLooming } from '../frontend/spider-looming.js';

const [lmFile, labelFile] = process.argv.slice(2);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const verbose = process.argv.includes('--verbose');
// --pause=a-b models the app pausing detection (phone turned sideways) for that time range.
const pause = arg('pause') ? arg('pause').split(',').map((r) => r.split('-').map(Number)) : [];
const keepEvery = arg('fps') ? Math.max(1, Math.round(60 / Number(arg('fps')))) : 1;
const data = JSON.parse(readFileSync(lmFile, 'utf8'));
const labels = labelFile ? JSON.parse(readFileSync(labelFile, 'utf8')) : { quiet: [], strikes: [] };

let gray = null;
if (arg('gray')) {
  const [gw, gh] = (arg('gray-size') ?? '64x85').split('x').map(Number);
  gray = { buf: readFileSync(arg('gray')), w: gw, h: gh, start: Number(arg('gray-start') ?? 0), fps: 60000 / 1001 };
  gray.n = gray.buf.length / (gw * gh);
  gray.loom = createLooming(gw, gh);
}

const unpack = (arr) => arr && arr.map(([x, y, z, visibility]) => ({ x, y, z, visibility }));
const aspect = data.width / data.height;
const det = createDetector();
const fires = [];
let lastStatus = '';

for (const [n, f] of data.frames.entries()) {
  if (n % keepEvery) continue;
  let loom = null;
  if (gray) {
    const k = Math.round((f.t / 1000 - gray.start) * gray.fps);
    if (k >= 0 && k < gray.n) {
      const N = gray.w * gray.h;
      loom = gray.loom.feed(gray.buf.subarray(k * N, (k + 1) * N));
    }
  }
  if (pause.some(([a, b]) => f.t / 1000 >= a && f.t / 1000 <= b)) {
    det.reset();
    gray?.loom.reset();
    continue;
  }
  const r = f.lm ? det.frame(unpack(f.lm), unpack(f.wl), f.t, aspect, false, loom) : det.noPose(f.t, loom);
  if (verbose && r.status !== lastStatus) console.log(`${(f.t / 1000).toFixed(2)}s  ${r.status}`);
  lastStatus = r.status;
  if (r.cue) fires.push({ t: f.t / 1000, cue: r.cue, debug: r.debug });
}

const inRange = (t, [a, b]) => t >= a && t <= b;
let falseAlarms = 0;
for (const fire of fires) {
  const quiet = labels.quiet.find((q) => inRange(fire.t, q.range));
  const strike = labels.strikes.find((s) => inRange(fire.t, s.range));
  let verdict = 'unlabelled';
  if (quiet) {
    verdict = `FALSE ALARM (${quiet.what})`;
    falseAlarms++;
  } else if (strike) {
    verdict = strike.expect.includes(fire.cue) ? `ok (${strike.what})` : `WRONG WORD, expected ${strike.expect.join('/')} (${strike.what})`;
  }
  console.log(`${fire.t.toFixed(2)}s  ${fire.cue.padEnd(5)} ${verdict}  ${JSON.stringify(fire.debug)}`);
}

let missed = 0;
let wrong = 0;
for (const s of labels.strikes) {
  const hits = fires.filter((f) => inRange(f.t, s.range));
  if (!hits.length) {
    missed++;
    console.log(`MISSED  ${s.range[0]}-${s.range[1]}s  ${s.what}`);
  } else if (!s.expect.includes(hits[0].cue)) {
    wrong++;
  }
}

console.log(`\nfires ${fires.length} | false alarms ${falseAlarms} | strikes ${labels.strikes.length}, caught ${labels.strikes.length - missed}, missed ${missed}, wrong word ${wrong}`);
