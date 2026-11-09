/* Offline-first service worker: the app shell is cached on first visit and served
   from cache afterwards, so the app opens with no signal. Bump VERSION on every release. */
const VERSION = 'rc-v1.1.1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './logic.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(async cache => {
      // Cache what we can; a failed CDN fetch must not block install.
      await Promise.all(SHELL.map(u => cache.add(u).catch(() => null)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      const network = fetch(req).then(res => {
        if (res && res.ok && (new URL(req.url).origin === self.location.origin || req.url.includes('cdnjs.cloudflare.com'))) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      // Cache first for the shell; fall back to network for anything new.
      return hit || network;
    })
  );
});
