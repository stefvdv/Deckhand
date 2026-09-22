/* Deckhand — service worker
   Strategy:
   - App shell (this page, icons, manifest): network-first with cache fallback,
     so hosted updates arrive immediately but the app still opens offline.
   - Fonts + Scryfall card images: cache-first (they never change for a given
     URL), keeping repeat browsing fast and cheap.
   - Scryfall API responses are NOT cached — searches and prices stay live. */
const VERSION = 'admiral-v2.51.607';
// Card images and fonts survive app updates: this cache is deliberately
// NOT version-named, so activating a new version never wipes it.
const ASSETS = 'admiral-assets-v1';
const SHELL = ['./', './index.html', './manifest.json', './format.txt', './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

/* Web Push (spoilers): the daily Netlify function sends {title, body, url}. */
self.addEventListener('push', (e) => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){ d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '\ud83d\udd2e Deckhand', {
    body: d.body || 'New spoilers are up.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: d.url || './?go=spoilers' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for(const c of list){ if('focus' in c){ c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== ASSETS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Live data must stay live
  if (url.hostname === 'api.scryfall.com') return;
  // Netlify Functions (news feed): live too — never fall back to index.html
  if (url.pathname.startsWith('/.netlify/')) return;
  // The weekly card database is streamed straight into IndexedDB, and that is
  // where the app reads it when offline. Caching it here only kept a second
  // copy of roughly 11 MB that nothing ever read back.
  if (/\.(jsonl|tsv)\.gz$/.test(url.pathname)) return;

  // Static, immutable assets: cache-first
  const isFont = url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com');
  const isCardImage = url.hostname === 'cards.scryfall.io' || url.hostname.endsWith('.scryfall.io');
  if (isFont || isCardImage) {
    e.respondWith(
      caches.open(ASSETS).then(cache =>
        cache.match(e.request).then(hit => hit || fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // App shell: network-first, fall back to cache when offline
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      }).catch(() =>
        caches.match(e.request, {ignoreSearch:true}).then(hit => hit || caches.match('./index.html'))
      )
    );
  }
});
