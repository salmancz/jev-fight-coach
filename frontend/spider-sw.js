// Offline support: after one online session everything spider sense needs is cached.
// Versioned/immutable assets (pose model, MediaPipe runtime) are cache-first;
// our own page, scripts and voices are network-first so new pushes show up immediately.
const CACHE = 'spider-sense-v1';
const IMMUTABLE = [
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\//,
  /^https:\/\/storage\.googleapis\.com\/mediapipe-models\//,
  /\/models\/[^/]+\.task$/,
];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = request.url;
  if (IMMUTABLE.some((re) => re.test(url))) event.respondWith(cacheFirst(request));
  else if (new URL(url).origin === self.location.origin) event.respondWith(networkFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}
