// Replays landmarks extracted from a real video through the detector and scores it
// against hand-labelled time ranges.
// Usage: node tests/replay.mjs <landmarks.json> <labels.json> [--verbose]
import { readFileSync } from 'node:fs';
import { createDetector } from '../frontend/spider-detector.js';

const [lmFile, labelFile] = process.argv.slice(2);
const verbose = process.argv.includes('--verbose');
const fpsArg = process.argv.find((a) => a.startsWith('--fps='));
const keepEvery = fpsArg ? Math.max(1, Math.round(60 / Number(fpsArg.slice(6)))) : 1;
const data = JSON.parse(readFileSync(lmFile, 'utf8'));
const labels = labelFile ? JSON.parse(readFileSync(labelFile, 'utf8')) : { quiet: [], strikes: [] };

const unpack = (arr) => arr && arr.map(([x, y, z, visibility]) => ({ x, y, z, visibility }));
const aspect = data.width / data.height;
const det = createDetector();
const fires = [];
let lastStatus = '';

for (const [n, f] of data.frames.entries()) {
  if (n % keepEvery) continue;
  const r = f.lm ? det.frame(unpack(f.lm), unpack(f.wl), f.t, aspect, false) : det.noPose(f.t);
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
  console.log(`${fire.t.toFixed(2)}s  ${fire.cue.padEnd(10)} ${verdict}  ${JSON.stringify(fire.debug)}`);
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

console.log(`\nfires ${fires.length} | false alarms ${falseAlarms} | strikes ${labels.strikes.length}, missed ${missed}, wrong word ${wrong}`);
