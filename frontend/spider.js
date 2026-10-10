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

const SETTINGS_KEY = 'spider-sense-settings';
const settings = loadSettings({
  speedThreshold: 3.5,
  refractoryMs: 700,
  confirmFrames: 2,
  voiceRate: 1.0,
  gyroGate: 150,
  model: 'lite',
  deviceId: '',
});

const $ = (id) => document.getElementById(id);
const el = {
  video: $('video'), overlay: $('overlay'), start: $('start'), status: $('status'),
  cue: $('cue'), fps: $('fps'), proc: $('proc'), lat: $('lat'),
  speed: $('speed'), gyro: $('gyro'), log: $('log'), camera: $('camera'), model: $('model'),
  sens: $('sens'), sensVal: $('sens-val'), refr: $('refr'), refrVal: $('refr-val'),
  confirm: $('confirm'), voice: $('voice'), voiceVal: $('voice-val'),
  gyroGate: $('gyro-gate'), gyroGateVal: $('gyro-gate-val'), tests: $('tests'),
  panel: $('panel'), togglePanel: $('toggle-panel'),
};

let landmarker = null;
let detector = null;
let drawing = null;
let ctx2d = null;
let running = false;
let stream = null;
let audio = null;
let voices = {};
let gyroMag = 0;
let wakeLock = null;
let frameCount = 0;
let fpsT0 = performance.now();
let lastLogged = [];

bindControls();

el.start.addEventListener('click', async () => {
  if (running) return stop();
  el.start.disabled = true;
  try {
    await start();
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'err');
    console.error(err);
    stop();
  } finally {
    el.start.disabled = false;
  }
});

async function start() {
  setStatus('Unlocking audio...', 'busy');
  await initAudio();
  await requestMotion();
  await requestWakeLock();

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

  setStatus('Opening camera...', 'busy');
  await openCamera(settings.deviceId);
  await populateCameras();

  ctx2d = el.overlay.getContext('2d');
  drawing = new DrawingUtils(ctx2d);
  detector = createDetector(detectorOpts());
  running = true;
  el.start.textContent = 'Stop';
  el.start.classList.add('live');
  setStatus('Live: watching', 'live');
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
  setStatus('Stopped', 'idle');
}

function detectorOpts() {
  return {
    speedThreshold: settings.speedThreshold,
    refractoryMs: settings.refractoryMs,
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

  stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  el.video.srcObject = stream;
  await el.video.play();
  detector?.reset();
}

async function populateCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId;
  el.camera.innerHTML = '';
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${el.camera.length + 1}`;
    el.camera.appendChild(opt);
  }

  // At punching range the regular back lens can't fit shoulders + arms; prefer ultra wide once.
  const ultra = devices.find((d) => /ultra wide/i.test(d.label) && /back/i.test(d.label));
  if (!settings.deviceId && ultra && ultra.deviceId !== activeId) {
    settings.deviceId = ultra.deviceId;
    saveSettings();
    await openCamera(ultra.deviceId);
  }
  el.camera.value = stream.getVideoTracks()[0]?.getSettings().deviceId ?? '';
}

// ── Frame loop ───────────────────────────────────────────────────────────────

function scheduleFrame() {
  if (!running) return;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    el.video.requestVideoFrameCallback(onFrame);
  } else {
    requestAnimationFrame(() => onFrame(performance.now(), null));
  }
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

  const lm = result.landmarks?.[0];
  const world = result.worldLandmarks?.[0];
  if (lm) {
    drawing.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: 'rgba(255,255,255,0.35)', lineWidth: 2 });
    drawing.drawLandmarks([lm[13], lm[14], lm[15], lm[16]], { color: '#ff3b30', fillColor: '#ff3b30', radius: 5 });

    const selfMotion = gyroMag > settings.gyroGate;
    const r = detector.frame(lm, world, t0, w / h, selfMotion);
    el.speed.textContent = r.debug ? `${r.debug.speed} (${r.debug.joint})` : '-';
    if (r.cue) fire(r.cue, t0, meta?.captureTime, r.debug);
    if (!r.cue && r.status === 'no-shoulders') setStatus('Can\'t see both shoulders: step back or use ultra wide', 'warn');
    else if (!r.cue) setStatus(`Live: ${r.status}`, 'live');
  } else {
    detector.reset();
    el.speed.textContent = '-';
    setStatus('Live: no person in frame', 'warn');
  }

  el.proc.textContent = `${procMs.toFixed(0)} ms`;
  frameCount++;
  const now = performance.now();
  if (now - fpsT0 >= 1000) {
    el.fps.textContent = String(Math.round((frameCount * 1000) / (now - fpsT0)));
    frameCount = 0;
    fpsT0 = now;
  }
  el.gyro.textContent = `${Math.round(gyroMag)}°/s`;
  scheduleFrame();
}

function fire(cue, frameT0, captureTime, debug) {
  playCue(cue);
  const now = performance.now();
  const sinceCapture = captureTime ? now - captureTime : null;
  const useCapture = sinceCapture !== null && sinceCapture > 0 && sinceCapture < 1000;
  const latency = useCapture ? sinceCapture : now - frameT0;
  const label = useCapture ? 'camera to sound' : 'model to sound';
  el.lat.textContent = `${Math.round(latency)} ms`;
  el.lat.title = label;
  showCue(cue);
  lastLogged.unshift(`${new Date().toLocaleTimeString()}  ${CUES[cue].label.padEnd(5)}  ${Math.round(latency)}ms ${label}  speed ${debug?.speed ?? '-'}  y ${debug?.y ?? '-'}`);
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

// ── Audio ────────────────────────────────────────────────────────────────────

async function initAudio() {
  if (navigator.audioSession) {
    try { navigator.audioSession.type = 'playback'; } catch {}
  }
  if (!audio) {
    audio = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  }
  await audio.resume();

  // Silent blip inside the tap gesture fully unlocks iOS output.
  const blip = audio.createBufferSource();
  blip.buffer = audio.createBuffer(1, 1, audio.sampleRate);
  blip.connect(audio.destination);
  blip.start();

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

function playCue(cue) {
  if (!audio) return;
  if (audio.state !== 'running') audio.resume();
  const spec = CUES[cue];
  const t = audio.currentTime;

  const panner = audio.createStereoPanner();
  panner.pan.value = spec.pan;
  panner.connect(audio.destination);

  for (let p = 0; p < spec.pulses; p++) {
    const start = t + p * 0.07;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(spec.tone[0], start);
    osc.frequency.linearRampToValueAtTime(spec.tone[1], start + 0.05);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.05);
    osc.connect(gain).connect(panner);
    osc.start(start);
    osc.stop(start + 0.06);
  }

  const v = voices[cue];
  if (v) {
    const src = audio.createBufferSource();
    src.buffer = v.buf;
    src.playbackRate.value = settings.voiceRate;
    const g = audio.createGain();
    g.gain.value = 1;
    src.connect(g).connect(panner);
    src.start(t + 0.04 + (spec.pulses - 1) * 0.07, v.offset);
  }
}

// ── Sensors / device ─────────────────────────────────────────────────────────

async function requestMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const state = await DeviceMotionEvent.requestPermission();
      if (state !== 'granted') return;
    }
    window.addEventListener('devicemotion', (e) => {
      const r = e.rotationRate;
      if (!r) return;
      gyroMag = Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0);
    });
  } catch (err) {
    console.warn('[motion] unavailable', err);
  }
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) requestWakeLock();
});

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
  bindRange(el.refr, el.refrVal, 'refractoryMs', (v) => `${v} ms`);
  bindRange(el.voice, el.voiceVal, 'voiceRate', (v) => `${v.toFixed(1)}x`);
  bindRange(el.gyroGate, el.gyroGateVal, 'gyroGate', (v) => `${v}°/s`);

  el.confirm.value = String(settings.confirmFrames);
  el.confirm.addEventListener('change', () => {
    settings.confirmFrames = Number(el.confirm.value);
    saveSettings();
    if (detector) Object.assign(detector.cfg, detectorOpts());
  });

  el.model.value = settings.model;
  el.model.addEventListener('change', () => {
    settings.model = el.model.value;
    saveSettings();
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
      if (!audio) await initAudio();
      playCue(id);
      showCue(id);
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
