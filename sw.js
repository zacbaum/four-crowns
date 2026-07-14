/**
 * Four Crowns — service worker.
 * Cache-first with network fallback for the app shell, plus a background
 * refresh of cached responses (stale-while-revalidate). Bump CACHE_VERSION
 * to invalidate; activate cleans old caches.
 */

const CACHE_VERSION = 'v14';
const CACHE_NAME = `fourcrowns-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './css/app.css',
  './js/main.js',
  './js/ui/app.js',
  './js/ui/cards-render.js',
  './js/ui/home.js',
  './js/ui/scorekeeper.js',
  './js/ui/resume.js',
  './js/ui/table.js',
  './js/ui/online.js',
  './js/ui/stats-ui.js',
  './js/engine/cards.js',
  './js/engine/solver.js',
  './js/engine/game.js',
  './js/ai/ai.js',
  './js/net/sync.js',
  './js/stats/store.js',
  './js/stats/analytics.js',
  './js/vendor/peerjs.min.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Tolerate individual failures so one missing file can't block install.
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('fourcrowns-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only handle same-origin

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: false });
      if (cached) {
        // Background refresh: keep the cache fresh without blocking.
        event.waitUntil(
          fetch(req)
            .then((res) => {
              if (res && res.ok) return cache.put(req, res.clone());
            })
            .catch(() => { /* offline — cached copy stands */ })
        );
        return cached;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) await cache.put(req, res.clone());
        return res;
      } catch (err) {
        // Network down and not cached: fall back to the shell for navigations.
        if (req.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })
  );
});
