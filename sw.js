// Service worker — offline shell, and nothing else.
//
// Every same-origin GET is served **network-first, cache as the fallback**. A hand-written VERSION
// plus cache-first would pin js/ and css/ to whatever the first visit cached, so a deploy that ships
// a new index.html against old modules is a ghost state nobody can reproduce — and in this game that
// is worse than no SW at all, because the shipped levels and the solver that verifies them are meant
// to be the same numbers. VERSION still carries the cache name: it is what clears the stale entries
// when the shell's shape changes, not a licence to serve stale code.
//
// Cross-origin requests are passed through untouched: there are none in this artifact, and
// swallowing them would only make a future embed fail silently.

const VERSION = 'skyscraper-v1';
const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './js/main.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/texture/night-sky-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      // A precache miss (an icon not deployed yet) must not abort the install and leave the old
      // worker in place forever; the runtime path below still fills the cache as it goes.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res && res.ok && (res.type === 'basic' || res.type === 'default')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // A POST-shaped navigation or an opaque request has no business being answered from our cache.
  if (req.mode === 'navigate' && !url.pathname.endsWith('.html') && !url.pathname.endsWith('/')) return;
  event.respondWith(networkFirst(req));
});
