// Service worker: offline app shell (incl. the pinned Firebase SDK). Data and photos are cached by
// Firestore itself (IndexedDB), so they're not handled here.
// The shell is network-first, so deploys show up on the next open. Bump VERSION when the list of
// SHELL_FILES changes (or to force-refresh the offline copy).
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const LIBS = 'libs';
const FIREBASE = 'https://www.gstatic.com/firebasejs/11.10.0/';
const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/firebase-config.js', 'js/agent.js', 'js/settings.js', 'js/util.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES);
    // Versioned, immutable SDK files: precache so the app opens offline.
    const libs = await caches.open(LIBS);
    await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js']
      .map((f) => libs.add(FIREBASE + f).catch(() => {})));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith('shell-') && k !== SHELL) || k === 'data' || k === 'photos') await caches.delete(k); // old GitHub-storage caches
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (req.url.startsWith(FIREBASE)) e.respondWith(cacheFirst(req, LIBS));
  else if (sameOrigin) e.respondWith(shell(req));
  // everything else (Firestore, sign-in, Gemini) goes straight to the network
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
