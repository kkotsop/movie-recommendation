// Swipeflix service worker: the app opens instantly, and everything works offline once it has been used.
//  - app shell + demo catalog: cached on install, refreshed in the background on every visit
//  - country catalogs (/api/catalog/XX, not personal): cached, refreshed in the background
//  - posters (TMDB images): cached the first time they are seen
//  - everything else under /api (history lookups, transfer codes) always goes straight to the network
const VERSION = 'v9';
const SHELL = `swipeflix-shell-${VERSION}`;
const CATALOGS = `swipeflix-catalogs-${VERSION}`;
const IMAGES = `swipeflix-images-${VERSION}`;
const MAX_IMAGES = 300;
const SHELL_FILES = [
  '/', '/app.css', '/app.js', '/netflix-export.js', '/device-store.js',
  '/lib/engine.js', '/lib/recommender.js', '/lib/history.js', '/lib/match.js', '/lib/regions.js', '/demo-catalog.json',
  '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL, CATALOGS, IMAGES]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  const fresh = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') {
    cache.put(request, res.clone());
    trim(cacheName, MAX_IMAGES);
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/catalog/')) return void event.respondWith(staleWhileRevalidate(request, CATALOGS));
    if (url.pathname.startsWith('/api/')) return; // personal or one-time: always straight to the network
    if (url.pathname === '/sw.js') return;
    if (request.mode === 'navigate') return void event.respondWith(staleWhileRevalidate(new Request('/'), SHELL));
    return void event.respondWith(staleWhileRevalidate(request, SHELL));
  }
  if (url.hostname === 'image.tmdb.org') event.respondWith(cacheFirst(request, IMAGES));
});
