// sw.js — Pulse Zero's minimal offline shell (UX#3, 2026-08-14 fix wave).
//
// Before this: no <link rel="manifest">, no serviceWorker.register() anywhere
// (grepped, zero hits), and the app's one JS dependency loaded from a bare
// CDN <script> with no local fallback. Log in, load the board, go offline,
// reload the same tab -> the top-level navigation itself failed
// (net::ERR_INTERNET_DISCONNECTED) and Mike saw the browser's native
// no-connection interstitial with ZERO of his cards visible — exactly the
// moment (elevator, subway, weak signal) he'd actually reach for this board.
//
// Scope, deliberately narrow: cache-first the STATIC APP SHELL only (this
// file's own HTML/JS/CSS/icons — nothing that changes per-card). Board DATA
// staleness (the "offline — last synced Xm ago" banner over a cached card
// snapshot) is handled client-side in index.html via localStorage, NOT here
// — intercepting and cache-managing Supabase's REST responses inside a
// service worker is a much larger surface (auth headers, PostgREST query
// strings, cache-invalidation-on-write) for the same user-facing outcome a
// simple localStorage snapshot already gets. Keep this file boring.
//
// Versioned cache name: bump SHELL_CACHE on any shell-asset change so
// activate's cleanup step evicts the old one instead of serving it forever.
const SHELL_CACHE = 'pulse-zero-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/pulse-actions.js',
  '/vendor/supabase-js/supabase.js',
  '/vendor/soma-feedback/soma-feedback.css',
  '/vendor/soma-feedback/soma-feedback.js',
  '/favicon.svg',
  '/favicon-32.png',
  '/favicon-16.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            // One missing/renamed asset must not fail the whole install —
            // that would leave the shell permanently uncached.
            console.warn('sw.js: could not precache', url, err);
          })
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only this app's own shell

  // Cache-first for shell assets; network fallback updates the cache so a
  // shell edit propagates on the next successful online load. Never touches
  // Supabase (different origin) or Netlify function calls (also fine —
  // same-origin /.netlify/functions/* paths are dynamic per-request and
  // intentionally excluded by not being in SHELL_ASSETS / not matching the
  // cache-first branch below unless already cached, which they won't be).
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        event.waitUntil(
          fetch(req).then((fresh) => {
            if (fresh && fresh.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, fresh));
          }).catch(() => {})
        );
        return cached;
      }
      return fetch(req).then((fresh) => {
        if (fresh && fresh.ok && SHELL_ASSETS.includes(url.pathname)) {
          const copy = fresh.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return fresh;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
