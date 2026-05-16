const CACHE = 'ontour-v19';
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

// --- Push notification handler ---
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch (e) {
    data = { body: event.data?.text() || 'New update from onTour' };
  }
  console.log('[sw] push received:', data);
  event.waitUntil(
    self.registration.showNotification(data.title || 'onTour', {
      body:  data.body  || 'You have a new tour update.',
      icon:  `${BASE}/icon-192.png`,
      badge: `${BASE}/icon-192.png`,
      tag:   data.tag   || 'ontour-default',
      data:  { url: data.url || BASE + '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || BASE + '/';

  // Clear app badge so the count resets when user taps the notification
  if ('clearAppBadge' in self.registration) {
    self.registration.clearAppBadge().catch(() => {});
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // Find any existing app window and navigate it to the full notif URL (with params)
        const existing = windowClients.find(c => 'navigate' in c);
        if (existing) {
          existing.navigate(url);
          return existing.focus();
        }
        return clients.openWindow(url);
      })
  );
});
