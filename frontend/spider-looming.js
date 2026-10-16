// Looming detector: something big suddenly changing in the frame (a fist coming at the lens).
// Works on a small grayscale copy of the camera frame. Up close the pose model loses a fist
// flying at the camera, but the raw image change is huge (17-42% of the frame vs 5-12% for a
// guard in real footage), so this covers exactly where the skeleton fails.
//
// The wearer moving shifts the whole picture; a global shift (best match within +/-maxShift px)
// is removed before differencing, so only things moving relative to the scene count.

export const LOOM_DEFAULTS = {
  pixelDiff: 25,
  maxShift: 3,
  sample: 2,
  globalFrac: 0.7,
};

export function createLooming(width, height, overrides = {}) {
  const cfg = { ...LOOM_DEFAULTS, ...overrides };
  let prev = null;

  function bestShift(a, b) {
    let best = { dx: 0, dy: 0, sad: Infinity };
    const m = cfg.maxShift;
    for (let dy = -m; dy <= m; dy++) {
      for (let dx = -m; dx <= m; dx++) {
        let sad = 0;
        let n = 0;
        for (let y = m; y < height - m; y += cfg.sample) {
          const row = y * width;
          const rowB = (y + dy) * width;
          for (let x = m; x < width - m; x += cfg.sample) {
            sad += Math.abs(a[row + x] - b[rowB + x + dx]);
            n++;
          }
        }
        sad /= n;
        if (sad < best.sad) best = { dx, dy, sad };
      }
    }
    return best;
  }

  // Returns the fraction of the frame that changed after removing the global shift.
  function feed(gray) {
    if (!prev || prev.length !== gray.length) {
      prev = gray.slice();
      return { frac: 0, shift: 0, global: false };
    }
    const { dx, dy } = bestShift(gray, prev);
    const m = cfg.maxShift;
    let changed = 0;
    let total = 0;
    let sx = 0;
    let sy = 0;
    for (let y = m; y < height - m; y++) {
      const row = y * width;
      const rowB = (y + dy) * width;
      for (let x = m; x < width - m; x++) {
        total++;
        if (Math.abs(gray[row + x] - prev[rowB + x + dx]) > cfg.pixelDiff) {
          changed++;
          sx += x;
          sy += y;
        }
      }
    }
    prev = gray.slice();
    const frac = changed / total;
    return {
      frac,
      shift: Math.hypot(dx, dy),
      global: frac > cfg.globalFrac,
      cx: changed ? sx / changed / width : null,
      cy: changed ? sy / changed / height : null,
    };
  }

  return { feed, reset: () => { prev = null; }, cfg };
}

export function toGray(rgba, out) {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return out;
}
