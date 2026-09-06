/* global self, caches, fetch, Response, URL */
/**
 * $COAST service worker — offline app shell (goal.md UX-2, M0 "service worker shell"). Plain JS, no build step.
 *
 *  - Navigations (`/`, `/?scene=…`): network-first, fall back to the cached shell when offline.
 *  - Hashed `/assets/*` bundles, `/icons/*`, `/samples/*`: cache-first (immutable by name / rarely change).
 *  - Never touched: `/api/*` (session-bound, must stay live), cross-origin requests (the splat CDN streams `.rad`
 *    pages with Range requests — a cached full body would break paging), and any request carrying a Range header.
 *
 * Bump CACHE_VERSION whenever the caching rules change; `activate` deletes every other `coast-` cache.
 */
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `coast-shell-${CACHE_VERSION}`;
const KEEP_CACHES = new Set([SHELL_CACHE]);
const SHELL_KEY = '/'; // every navigation resolves to the same index.html (SPA), cached under one key
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const CACHE_FIRST = /^\/(assets|icons|samples)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Tolerate a missing icon in a dev build: one failed precache must not block installation.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('coast-') && !KEEP_CACHES.has(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return; // partial content must come straight from the network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin (splat CDN, vendor APIs): never cached
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (CACHE_FIRST.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(SHELL_KEY, response.clone());
    return response;
  } catch {
    const cached = await cache.match(SHELL_KEY);
    return cached ?? Response.error(); // no shell cached yet: behave as if there were no service worker
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only store complete successes: 206 (partial), 404, and opaque (status 0) responses are never cached.
  if (response.ok && response.status === 200) await cache.put(request, response.clone());
  return response;
}
