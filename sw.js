/* TimeTracker service worker — cache-first for the app shell so it works offline. */
const CACHE = 'timetracker-v1';
const ASSETS = [
  '.',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((resp) => {
          if (resp.ok && new URL(event.request.url).origin === location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
    )
  );
});
