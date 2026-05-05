const CACHE = 'ontour-v15';
const BASE = self.location.pathname.replace(/\/sw\.js$/, '');

const ASSETS = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/manifest.json`
];

self.addEventListener('install', event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }

        return response;
      })
      .catch(() => {
        return caches.match(event.request)
          .then(cached => cached || caches.match(`${BASE}/index.html`));
      })
  );
});
