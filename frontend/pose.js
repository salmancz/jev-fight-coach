/**
 * pose.js — MediaPipe BlazePose setup and per-frame keypoint capture loop.
 *
 * Responsibilities:
 *  - Open the camera via getUserMedia()
 *  - Run PoseLandmarker on each video frame (~30fps)
 *  - Call onLandmarks(landmarks, timestamp) for every frame that has a pose
 *
 * Landmark indices (MediaPipe 33-point model):
 *   0  nose         11 left_shoulder   12 right_shoulder
 *  13  left_elbow   14 right_elbow
 *  15  left_wrist   16 right_wrist
 *  23  left_hip     24 right_hip
 *  25  left_knee    26 right_knee
 *  27  left_ankle   28 right_ankle
 *
 * Each landmark: { x, y, z, visibility }
 *   x, y  — normalised [0,1] relative to frame dimensions (origin top-left)
 *   z     — depth relative to hip midpoint (negative = closer to camera)
 *   visibility — [0,1] likelihood landmark is visible
 */

// ─── CDN imports (loaded in index.html via importmap / script tag) ───────────
// @mediapipe/tasks-vision is loaded as an ES module from CDN.
// The importmap in index.html maps "mediapipe/tasks-vision" to the CDN URL.
import { PoseLandmarker, FilesetResolver, DrawingUtils } from 'mediapipe/tasks-vision';

// ─── Module state ────────────────────────────────────────────────────────────
let poseLandmarker = null;
let animFrameId    = null;
let lastVideoTime  = -1;
let _onLandmarks   = null;  // callback set by init()

/** Canvas + DrawingUtils for the pose skeleton overlay */
let drawingUtils   = null;
let overlayCtx     = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialise MediaPipe, open the camera, and start the detection loop.
 *
 * @param {HTMLVideoElement} videoEl   — <video> element to render camera into
 * @param {HTMLCanvasElement} overlayEl — <canvas> for pose skeleton overlay
 * @param {Function} onLandmarks       — called each frame: (landmarks[], timestampMs) => void
 * @param {'lite'|'full'} [model='lite'] — model complexity. Use 'lite' on phone,
 *                                          switch to 'full' if you have GPU headroom.
 */
export async function initPose(videoEl, overlayEl, onLandmarks, model = 'lite') {
  _onLandmarks = onLandmarks;
  overlayCtx   = overlayEl.getContext('2d');

  // ── 1. Load the WASM runtime locally ──
  const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');

  // ── 2. Load the pose model locally ──
  const modelAssetPath = './models/pose_landmarker_lite.task';

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath,
      delegate: 'GPU',   // falls back to CPU automatically if GPU unavailable
    },
    runningMode:    'VIDEO',  // VIDEO mode enables temporal smoothing
    numPoses:       1,        // we only care about one person (the opponent)
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence:  0.5,
    minTrackingConfidence:      0.5,
  });

  drawingUtils = new DrawingUtils(overlayCtx);

  // ── 3. Open camera ──
  await openCamera(videoEl, overlayEl);

  // ── 4. Start detection loop ──
  detectLoop(videoEl, overlayEl);

  console.log('[pose] MediaPipe PoseLandmarker initialised, camera open.');
}

/** Stop detection loop and release the camera stream. */
export function stopPose(videoEl) {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (videoEl?.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
  console.log('[pose] Stopped.');
}

// ─── Camera ──────────────────────────────────────────────────────────────────

async function openCamera(videoEl, overlayEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'environment',   // rear camera — points at opponent
      width:  { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });

  videoEl.srcObject = stream;

  // Wait until video metadata is loaded so we know dimensions
  await new Promise(resolve => { videoEl.onloadedmetadata = resolve; });
  await videoEl.play();

  // Match overlay canvas to video dimensions
  overlayEl.width  = videoEl.videoWidth;
  overlayEl.height = videoEl.videoHeight;
}

// ─── Detection loop ───────────────────────────────────────────────────────────

function detectLoop(videoEl, overlayEl) {
  if (!poseLandmarker) return;

  const tick = () => {
    if (videoEl.currentTime !== lastVideoTime && videoEl.readyState >= 2) {
      lastVideoTime = videoEl.currentTime;

      const timestampMs = performance.now();
      const result = poseLandmarker.detectForVideo(videoEl, timestampMs);

      // Keep overlay canvas in sync with video size (handles orientation changes)
      if (overlayEl.width !== videoEl.videoWidth) {
        overlayEl.width  = videoEl.videoWidth;
        overlayEl.height = videoEl.videoHeight;
      }

      // Clear previous frame's skeleton
      overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);

      if (result.landmarks?.length > 0) {
        const landmarks = result.landmarks[0];

        // Draw skeleton overlay
        drawSkeleton(landmarks);

        // Fire callback with the raw 33-point array for features.js to process
        if (_onLandmarks) _onLandmarks(landmarks, timestampMs);
      }
    }

    animFrameId = requestAnimationFrame(tick);
  };

  animFrameId = requestAnimationFrame(tick);
}

// ─── Skeleton drawing ─────────────────────────────────────────────────────────

/**
 * Draw the pose skeleton on the overlay canvas using MediaPipe's DrawingUtils.
 * Kept minimal so it doesn't dominate the frame budget.
 */
function drawSkeleton(landmarks) {
  // Connection lines — muted so they don't distract from the live cue display
  drawingUtils.drawConnectors(
    landmarks,
    PoseLandmarker.POSE_CONNECTIONS,
    { color: 'rgba(255,255,255,0.25)', lineWidth: 1 },
  );

  // Keypoints — only draw upper body (indices 0–22) to reduce clutter
  const upperBody = landmarks.slice(0, 23);
  drawingUtils.drawLandmarks(upperBody, {
    color:      'rgba(255, 80, 60, 0.85)',
    fillColor:  'rgba(255, 80, 60, 0.5)',
    lineWidth:  1,
    radius:     3,
  });
}
