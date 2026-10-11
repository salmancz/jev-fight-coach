import { PoseLandmarker, FilesetResolver, DrawingUtils } from 'mediapipe/tasks-vision';
import { createDetector, CUE_IDS } from './spider-detector.js';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODELS = {
  lite: './models/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

const CUES = {
  duck:  { label: 'DUCK',  pan: 0,  tone: [1500, 600], pulses: 1 },
  left:  { label: 'LEFT',  pan: -1, tone: [950, 950],  pulses: 1 },
  right: { label: 'RIGHT', pan: 1,  tone: [950, 950],  pulses: 1 },
  back:  { label: 'BACK',  pan: 0,  tone: [650, 650],  pulses: 2 },
  jump:  { label: 'JUMP',  pan: 0,  tone: [300, 700],  pulses: 1 },
};

const ULTRA_WIDE = /ultra ?wide|ultra grand|ultraweit|gran angular|grandangolare|ultra-amplo|超广角|超廣角|超広角|초광각|ультраширок/i;
const FRONT = /front|avant|vorder|frontal|anterior|前面|前置|전면|фронт/i;

const SETTINGS_KEY = 'spider-sense-settings-v3';
const CHECKLIST_KEY = 'spider-sense-checklist-day';
const settings = loadSettings({
  speedThreshold: 3.5,
  minGapMs: 200,
  confirmFrames: 3,
  voiceRate: 1.0,
  gyroGate: 150,
  model: 'lite',
  deviceId: '',
  callout: 'move',
});

const $ = (id) => document.getElementById(id);
const el = {
  video: $('video'), overlay: $('overlay'), start: $('start'), status: $('status'),
  cue: $('cue'), fps: $('fps'), proc: $('proc'), lat: $('lat'), audioLat: $('audio-lat'),
  speed: $('speed'), gyro: $('gyro'), log: $('log'), camera: $('camera'), model: $('model'),
  sens: $('sens'), sensVal: $('sens-val'), gap: $('gap'), gapVal: $('gap-val'),
  confirm: $('confirm'), voice: $('voice'), voiceVal: $('voice-val'), callout: $('callout'),
  gyroGate: $('gyro-gate'), gyroGateVal: $('gyro-gate-val'), tests: $('tests'),
  panel: $('panel'), togglePanel: $('toggle-panel'), warnings: $('warnings'),
  checklist: $('checklist'), checklistDone: $('checklist-done'), openChecklist: $('open-checklist'),
};

let landmarker = null;
let loadedModel = null;
let detector = null;
let drawing = null;
let ctx2d = null;
let running = false;
let startedAt = 0;
let stream = null;
let audio = null;
const voices = {};
let gyroMag = 0;
let lastMotionT = 0;
let motionListening = false;
let wakeLock = null;
let frameCount = 0;
let fpsT0 = performance.now();
let fps = 0;
let lastLogged = [];
let lastLostToneT = 0;
const wobble = [];
const lumaCanvas = document.createElement('canvas');
lumaCanvas.width = 32;
lumaCanvas.height = 18;
const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./spider-sw.js').catch((err) => console.warn('[sw]', err));
}

bindControls();
initChecklist();

el.start.addEventListener('click', () => {
  if (running) return stop();
  if (!checklistDoneToday()) return openChecklist();
  // iOS only grants motion + audio when requested synchronously inside the tap.
  const motion = requestMotion();
  unlockAudio();
  el.start.disabled = true;
  start(motion)
    .catch((err) => {
      setStatus(`Error: ${err.message}`, 'err');
      console.error(err);
      stop();
    })
    .finally(() => {
      el.start.disabled = false;
    });
});

async function start(motion) {
  setStatus('Loading voices...', 'busy');
  await Promise.all([loadVoices(), motion]);
  await requestWakeLock();

  if (!landmarker || loadedModel !== settings.model) {
    setStatus('Loading pose model...', 'busy');
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODELS[settings.model], delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    loadedModel = settings.model;
  }

  setStatus('Opening camera...', 'busy');
  await openCamera(settings.deviceId);
  await populateCameras();

  ctx2d = el.overlay.getContext('2d');
  drawing = new DrawingUtils(ctx2d);
  detector = createDetector(detectorOpts());
  running = true;
  startedAt = performance.now();
  el.start.textContent = 'Stop';
  el.start.classList.add('live');
  showStatus('no-person');
  scheduleFrame();
}

function stop() {
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  el.video.srcObject = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  el.start.textContent = 'Start';
  el.start.classList.remove('live');
  el.warnings.replaceChildren();
  setStatus('Stopped', 'idle');
}

function detectorOpts() {
  return {
    speedThreshold: settings.speedThreshold,
    minGapMs: settings.minGapMs,
    confirmFrames: settings.confirmFrames,
  };
}

// ── Camera ───────────────────────────────────────────────────────────────────

async function openCamera(deviceId) {
  stream?.getTracks().forEach((t) => t.stop());
  const video = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 60 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    if (!deviceId) throw err;
    settings.deviceId = '';
    saveSettings();
    return openCamera('');
  }
  el.video.srcObject = stream;
  await el.video.play();
  detector?.reset();

  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => {
    if (running && document.visibilityState === 'visible') recoverCamera();
  });
}

async function populateCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  el.camera.replaceChildren();
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${el.camera.length + 1}`;
    el.camera.appendChild(opt);
  }

  // At punching range the regular back lens can't fit shoulders + arms; prefer ultra wide once.
  const track = stream.getVideoTracks()[0];
  const activeId = track?.getSettings().deviceId;
  if (!settings.deviceId) {
    const ultra = devices.find((d) => ULTRA_WIDE.test(d.label) && !FRONT.test(d.label));
    if (ultra && ultra.deviceId !== activeId) {
      settings.deviceId = ultra.deviceId;
      saveSettings();
      await openCamera(ultra.deviceId);
    } else if (!ultra) {
      await zoomOut(track);
    }
  }
  el.camera.value = stream.getVideoTracks()[0]?.getSettings().deviceId ?? '';
}

async function zoomOut(track) {
  const zoom = track?.getCapabilities?.().zoom;
  if (!zoom || zoom.min >= 1) return;
  try {
    await track.applyConstraints({ advanced: [{ zoom: zoom.min }] });
  } catch (err) {
    console.warn('[camera] zoom out failed', err);
  }
}

let recovering = false;
async function recoverCamera() {
  if (recovering) return;
  recovering = true;
  try {
    setStatus('Camera was interrupted, reopening...', 'busy');
    await openCamera(settings.deviceId);
    scheduleFrame();
  } catch (err) {
    setStatus(`Camera lost: ${err.message}. Tap Stop, then Start.`, 'err');
  } finally {
    recovering = false;
  }
}

// ── Frame loop ───────────────────────────────────────────────────────────────

let frameScheduled = false;
function scheduleFrame() {
  if (!running || frameScheduled) return;
  frameScheduled = true;
  const run = (now, meta) => {
    frameScheduled = false;
    onFrame(now, meta);
  };
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) el.video.requestVideoFrameCallback(run);
  else requestAnimationFrame((now) => run(now, null));
}

function onFrame(_now, meta) {
  if (!running) return;
  if (el.video.readyState < 2) return scheduleFrame();

  const t0 = performance.now();
  const result = landmarker.detectForVideo(el.video, t0);
  const procMs = performance.now() - t0;

  const w = el.video.videoWidth;
  const h = el.video.videoHeight;
  if (el.overlay.width !== w || el.overlay.height !== h) {
    el.overlay.width = w;
    el.overlay.height = h;
  }
  ctx2d.clearRect(0, 0, w, h);

  const selfMotion = gyroAlive() && gyroMag > settings.gyroGate;
  wobble.push({ t: t0, moving: selfMotion });
  while (wobble.length && t0 - wobble[0].t > 3000) wobble.shift();

  const lm = result.landmarks?.[0];
  const world = result.worldLandmarks?.[0];
  const r = lm ? detector.frame(lm, world, t0, w / h, selfMotion) : detector.noPose(t0);

  if (lm && r.locked) {
    drawing.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: 'rgba(48,209,88,0.6)', lineWidth: 3 });
    drawing.drawLandmarks([lm[13], lm[14], lm[15], lm[16], lm[27], lm[28]], { color: '#ff3b30', fillColor: '#ff3b30', radius: 6 });
  }
  if (r.gainedLock) playTone('locked');
  if (r.lostLock && t0 - lastLostToneT > 1500) {
    lastLostToneT = t0;
    playTone('lost');
  }
  el.speed.textContent = r.debug ? `${r.debug.speed} (${r.debug.joint})` : '-';
  if (r.cue) fire(r.cue, t0, meta?.captureTime, r.debug);
  else showStatus(r.status);

  el.proc.textContent = `${procMs.toFixed(0)} ms`;
  frameCount++;
  if (t0 - fpsT0 >= 1000) {
    fps = Math.round((frameCount * 1000) / (t0 - fpsT0));
    el.fps.textContent = String(fps);
    frameCount = 0;
    fpsT0 = t0;
    updateWarnings();
  }
  el.gyro.textContent = gyroAlive() ? `${Math.round(gyroMag)}°/s` : 'sensor off';
  scheduleFrame();
}

const STATUS = {
  'no-person': ['Looking for a person...', 'warn'],
  'no-head': ['Need his face in frame', 'warn'],
  'no-arms': ['Need both his arms in frame', 'warn'],
  'too-small': ['Person too far away: move closer', 'warn'],
  'tracking-jump': ['Lost him, re-locking...', 'warn'],
  'switched': ['Different person? Re-locking...', 'warn'],
  'locking-on': ['Locking on...', 'busy'],
  'holding': ['Locked on: tracking flickered, holding', 'busy'],
  'self-motion': ['Locked on: you are moving, needs a harder swing', 'busy'],
};

function showStatus(status) {
  const [text, kind] = STATUS[status] ?? ['Locked on: watching him', 'live'];
  setStatus(text, kind);
}

function spoken(cue) {
  if (settings.callout !== 'threat') return cue;
  if (cue === 'left') return 'right';
  if (cue === 'right') return 'left';
  return cue;
}

function fire(rawCue, frameT0, captureTime, debug) {
  const cue = spoken(rawCue);
  playCue(cue);
  const now = performance.now();
  const sinceCapture = captureTime ? now - captureTime : null;
  const useCapture = sinceCapture !== null && sinceCapture > 0 && sinceCapture < 1000;
  const latency = useCapture ? sinceCapture : now - frameT0;
  const label = useCapture ? 'camera to sound' : 'model to sound';
  el.lat.textContent = `${Math.round(latency)} ms`;
  el.lat.title = label;
  showCue(cue);
  lastLogged.unshift(`${new Date().toLocaleTimeString()}  ${CUES[cue].label.padEnd(5)}  ${Math.round(latency)}ms ${label}  ${debug?.joint ?? '-'} speed ${debug?.speed ?? '-'}`);
  lastLogged = lastLogged.slice(0, 12);
  el.log.textContent = lastLogged.join('\n');
}

let cueTimer = null;
function showCue(cue) {
  el.cue.textContent = CUES[cue].label;
  el.cue.dataset.cue = cue;
  el.cue.classList.add('flash');
  clearTimeout(cueTimer);
  cueTimer = setTimeout(() => {
    el.cue.classList.remove('flash');
    el.cue.textContent = '';
  }, 600);
}

// ── Warnings ─────────────────────────────────────────────────────────────────

function frameLuma() {
  try {
    lumaCtx.drawImage(el.video, 0, 0, lumaCanvas.width, lumaCanvas.height);
    const d = lumaCtx.getImageData(0, 0, lumaCanvas.width, lumaCanvas.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 4);
  } catch {
    return null;
  }
}

function audioDelayMs() {
  if (!audio) return null;
  const out = typeof audio.outputLatency === 'number' ? audio.outputLatency : 0;
  const base = typeof audio.baseLatency === 'number' ? audio.baseLatency : 0;
  return out + base > 0 ? Math.round((out + base) * 1000) : null;
}

function updateWarnings() {
  const warn = [];
  const warmedUp = performance.now() - startedAt > 3000;

  const luma = frameLuma();
  if (luma !== null && luma < 55) warn.push('Too dark. Turn on every light: fast hands blur and get missed.');
  if (warmedUp && fps > 0 && fps < 40) warn.push(`Phone is slowing down (${fps} fps). Low light, Low Power Mode, heat or screen recording. Charge it and add light.`);
  if (warmedUp && !gyroAlive()) warn.push('Motion sensor off: your own ducking is not filtered. Settings > Apps > Safari > Clear History and Website Data, reopen, tap Allow.');
  if (warmedUp && wobble.length > 30 && wobble.filter((s) => s.moving).length / wobble.length > 0.6) warn.push('The phone keeps moving. Tighten the mount (chest is steadier than head).');

  const delay = audioDelayMs();
  el.audioLat.textContent = delay === null ? '-' : `${delay} ms`;
  if (delay !== null && delay > 100) warn.push(`Audio delay ${delay} ms: looks like Bluetooth. Use wired earphones.`);

  el.warnings.replaceChildren(...warn.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

// ── Audio ────────────────────────────────────────────────────────────────────

function unlockAudio() {
  if (navigator.audioSession) {
    try { navigator.audioSession.type = 'playback'; } catch {}
  }
  if (!audio) {
    audio = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  }
  audio.resume();

  // Silent blip inside the tap gesture fully unlocks iOS output.
  const blip = audio.createBufferSource();
  blip.buffer = audio.createBuffer(1, 1, audio.sampleRate);
  blip.connect(audio.destination);
  blip.start();
}

async function loadVoices() {
  await Promise.all(CUE_IDS.map(async (id) => {
    if (voices[id]) return;
    try {
      const res = await fetch(`./spider-audio/${id}.wav`);
      const buf = await decode(await res.arrayBuffer());
      voices[id] = { buf, offset: leadingSilence(buf) };
    } catch (err) {
      console.warn(`[audio] voice ${id} unavailable, tone only`, err);
    }
  }));
}

function decode(arrayBuffer) {
  return new Promise((resolve, reject) => audio.decodeAudioData(arrayBuffer, resolve, reject));
}

function leadingSilence(buf) {
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > 0.02) return Math.max(0, i / buf.sampleRate - 0.005);
  }
  return 0;
}

function beep(start, from, to, dur, gainPeak, dest, type = 'square') {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.linearRampToValueAtTime(to, start + dur);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(dest);
  osc.start(start);
  osc.stop(start + dur + 0.01);
}

function playCue(cue) {
  if (!audio) return;
  if (audio.state !== 'running') audio.resume();
  const spec = CUES[cue];
  const t = audio.currentTime;

  const panner = audio.createStereoPanner();
  panner.pan.value = spec.pan;
  panner.connect(audio.destination);

  for (let p = 0; p < spec.pulses; p++) beep(t + p * 0.07, spec.tone[0], spec.tone[1], 0.05, 0.35, panner);

  const v = voices[cue];
  if (v) {
    const src = audio.createBufferSource();
    src.buffer = v.buf;
    src.playbackRate.value = settings.voiceRate;
    src.connect(panner);
    src.start(t + 0.04 + (spec.pulses - 1) * 0.07, v.offset);
  }
}

// Soft sine tones so a blindfolded wearer knows when the app can and can't see him.
function playTone(kind) {
  if (!audio) return;
  if (audio.state !== 'running') audio.resume();
  const t = audio.currentTime;
  if (kind === 'locked') {
    beep(t, 660, 660, 0.06, 0.15, audio.destination, 'sine');
    beep(t + 0.08, 990, 990, 0.08, 0.15, audio.destination, 'sine');
  } else {
    beep(t, 440, 180, 0.35, 0.25, audio.destination, 'sine');
  }
}

// ── Sensors / device ─────────────────────────────────────────────────────────

function requestMotion() {
  if (typeof DeviceMotionEvent === 'undefined') return Promise.resolve('unsupported');
  const ask = typeof DeviceMotionEvent.requestPermission === 'function'
    ? DeviceMotionEvent.requestPermission()
    : Promise.resolve('granted');
  return ask
    .then((state) => {
      if (state === 'granted' && !motionListening) {
        motionListening = true;
        window.addEventListener('devicemotion', (e) => {
          const r = e.rotationRate;
          if (!r) return;
          gyroMag = Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0);
          lastMotionT = performance.now();
        });
      }
      return state;
    })
    .catch((err) => {
      console.warn('[motion] unavailable', err);
      return 'error';
    });
}

function gyroAlive() {
  return performance.now() - lastMotionT < 1000;
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.visibilityState === 'hidden') {
    detector?.reset();
    return;
  }
  audio?.resume();
  requestWakeLock();
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== 'live' || track.muted) recoverCamera();
  else scheduleFrame();
});

window.addEventListener('resize', () => {
  if (running) detector?.reset();
});

// ── Safety checklist ─────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function checklistDoneToday() {
  try {
    return localStorage.getItem(CHECKLIST_KEY) === today();
  } catch {
    return false;
  }
}

function initChecklist() {
  const boxes = [...el.checklist.querySelectorAll('input[type="checkbox"]')];
  const sync = () => { el.checklistDone.disabled = !boxes.every((b) => b.checked); };
  boxes.forEach((b) => b.addEventListener('change', sync));
  sync();
  el.checklistDone.addEventListener('click', () => {
    try { localStorage.setItem(CHECKLIST_KEY, today()); } catch {}
    el.checklist.close();
  });
  el.openChecklist.addEventListener('click', openChecklist);
  if (!checklistDoneToday()) openChecklist();
}

function openChecklist() {
  if (!el.checklist.open) el.checklist.showModal();
}

// ── Controls ─────────────────────────────────────────────────────────────────

function bindControls() {
  const bindRange = (input, out, key, fmt) => {
    input.value = settings[key];
    out.textContent = fmt(settings[key]);
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      out.textContent = fmt(settings[key]);
      saveSettings();
      if (detector) Object.assign(detector.cfg, detectorOpts());
    });
  };
  bindRange(el.sens, el.sensVal, 'speedThreshold', (v) => v.toFixed(1));
  bindRange(el.gap, el.gapVal, 'minGapMs', (v) => `${v} ms`);
  bindRange(el.voice, el.voiceVal, 'voiceRate', (v) => `${v.toFixed(1)}x`);
  bindRange(el.gyroGate, el.gyroGateVal, 'gyroGate', (v) => `${v}°/s`);

  const bindSelect = (select, key, parse = (v) => v, onChange) => {
    select.value = String(settings[key]);
    select.addEventListener('change', () => {
      settings[key] = parse(select.value);
      saveSettings();
      onChange?.();
    });
  };
  bindSelect(el.confirm, 'confirmFrames', Number, () => {
    if (detector) Object.assign(detector.cfg, detectorOpts());
  });
  bindSelect(el.callout, 'callout');
  bindSelect(el.model, 'model', String, () => {
    if (running) setStatus('Model changes apply on next Start', 'warn');
  });

  el.camera.addEventListener('change', async () => {
    settings.deviceId = el.camera.value;
    saveSettings();
    if (running) await openCamera(settings.deviceId);
  });

  for (const id of CUE_IDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = CUES[id].label;
    b.addEventListener('click', async () => {
      unlockAudio();
      await loadVoices();
      playCue(id);
      showCue(id);
    });
    el.tests.appendChild(b);
  }
  for (const kind of ['locked', 'lost']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = kind === 'locked' ? 'Locked tone' : 'Lost tone';
    b.addEventListener('click', () => {
      unlockAudio();
      playTone(kind);
    });
    el.tests.appendChild(b);
  }

  el.togglePanel.addEventListener('click', () => {
    const open = el.panel.classList.toggle('open');
    el.togglePanel.setAttribute('aria-expanded', String(open));
  });
}

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.dataset.kind = kind;
}

function loadSettings(defaults) {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}
