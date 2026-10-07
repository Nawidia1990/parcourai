// Minimal service worker: caches the app shell so it can be installed as an app
// and has something to fall back to if the network is genuinely unavailable.
// Network-first: always tries to fetch the latest version first, and only falls
// back to the cached copy if that fetch fails (e.g. offline) — this is what
// actually matters for an app that changes often, since a stale-cache-first
// strategy would otherwise keep serving old versions indefinitely after a
// deployment, regardless of how recently the server was updated.
//
// IMPORTANT: bump CACHE_NAME (e.g. v2 -> v3) whenever you want to force every
// visitor's browser to drop old cached data — the version bump is what makes
// the activate handler below actually purge anything from a previous version.
const CACHE_NAME = 'parcoura-v2';
const APP_SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache API calls
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
