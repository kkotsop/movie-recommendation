// SwipeFlick service worker: the app opens instantly and works (read-only) without a connection.
//  - app shell: cached on install, refreshed in the background on every visit
//  - posters (TMDB images): cached the first time they are seen
//  - /api GET: network first, last good answer when offline
//  - everything else (POST swipes, etc.) goes straight to the network
const VERSION = 'v4';
const SHELL = `swipeflick-shell-${VERSION}`;
const IMAGES = `swipeflick-images-${VERSION}`;
const API = `swipeflick-api-${VERSION}`;
const MAX_IMAGES = 300;
const SHELL_FILES = ['/', '/app.css', '/app.js', '/netflix-export.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL, IMAGES, API]);
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

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
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
    if (url.pathname.startsWith('/api/')) return void event.respondWith(networkFirst(request, API));
    if (url.pathname === '/sw.js') return;
    if (request.mode === 'navigate') return void event.respondWith(staleWhileRevalidate(new Request('/'), SHELL));
    return void event.respondWith(staleWhileRevalidate(request, SHELL));
  }
  if (url.hostname === 'image.tmdb.org') event.respondWith(cacheFirst(request, IMAGES));
});
