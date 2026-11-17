// Service worker: offline app shell, network-first data, cache-first photos.
// The shell is network-first, so deploys show up on the next open. Bump VERSION when the list of
// SHELL_FILES changes (or to force-refresh the offline copy).
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const DATA = 'data';
const PHOTOS = 'photos';
const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/github.js', 'js/queue.js', 'js/agent.js', 'js/settings.js', 'js/util.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isPhoto = /\/data\/(photos|note-photos)\/[^/]+\.(jpe?g|png|webp)$/i.test(url.pathname);

  if (isPhoto && (sameOrigin || url.hostname === 'raw.githubusercontent.com')) {
    e.respondWith(cacheFirst(req, PHOTOS));
  } else if (sameOrigin && /\/data\/[^/]+\.json$/.test(url.pathname)) {
    e.respondWith(networkFirst(req, DATA));
  } else if (sameOrigin) {
    e.respondWith(shell(req));
  }
  // everything else (GitHub API, Gemini) goes straight to the network
});

// App shell: network-first (so a deploy shows up on the next open) with a 3 s timeout,
// falling back to the cached copy when offline or on a slow connection.
async function shell(req) {
  const cache = await caches.open(SHELL);
  const key = req.mode === 'navigate' ? 'index.html' : req;
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  const first = await Promise.race([net.catch(() => null), timeout]);
  if (first) return first;
  const hit = await cache.match(key, { ignoreSearch: true });
  return hit || net;
}

async function cacheFirst(req, name) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(name)).put(req, res.clone());
  return res;
}

async function networkFirst(req, name) {
  const key = new Request(new URL(req.url).pathname); // ignore cache-busting params
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(name)).put(key, res.clone());
    return res;
  } catch {
    const hit = await caches.match(key);
    if (hit) return hit;
    throw new Error('offline');
  }
}
