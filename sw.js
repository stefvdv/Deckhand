/* Deckhand — service worker
   Strategy:
   - The page itself: the network gets SHELL_WAIT ms to answer, then the
     cached copy wins and the download finishes in the background. A quick
     line still serves the newest deploy at once; a slow one no longer holds
     the launch hostage behind a ~430 kB download.
   - Other shell files (icons, manifest): network-first with cache fallback.
   - Fonts + Scryfall card images: cache-first (they never change for a given
     URL), keeping repeat browsing fast and cheap.
   - Scryfall API responses are NOT cached — searches and prices stay live. */
const VERSION = 'admiral-v2.51.628';
// Card images and fonts survive app updates: this cache is deliberately
// NOT version-named, so activating a new version never wipes it.
const ASSETS = 'admiral-assets-v1';
// How long the page may wait for a fresh copy before the cached one wins.
// Long enough that a quick connection still serves the newest deploy at once,
// short enough that a slow one never holds the launcher's icon hostage.
const SHELL_WAIT = 1200;
const SHELL = ['./', './index.html', './manifest.json', './format.txt', './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

/* Web Push (spoilers): the daily Netlify function sends {title, body, url}.
   The status-bar icon (badge) must be a transparent cut-out. When the file is
   missing on the site, Android falls back to the full app icon and draws it
   as a solid square -- so the same D travels inline as a fallback. */
const BADGE_URL = './badge-d.png';
const BADGE_INLINE = 'data:image/png;base64,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';
async function badgeFor(){
  try{
    const r = await fetch(BADGE_URL, { cache: 'no-cache' });
    if(r.ok && /^image\//.test(r.headers.get('content-type') || '')) return BADGE_URL;
  }catch(err){}
  return BADGE_INLINE;
}
self.addEventListener('push', (e) => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){ d = { body: e.data && e.data.text() }; }
  e.waitUntil(badgeFor().then(badge => self.registration.showNotification(d.title || '\ud83d\udd2e Deckhand', {
    body: d.body || 'New spoilers are up.',
    icon: './icon-192.png',
    badge,
    data: { url: d.url || './?go=spoilers' }
  })));
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

  // App shell: network-first, fall back to cache when offline.
  // The PAGE ITSELF races the network against the clock: index.html is ~430 kB
  // over the wire, and on mobile data that download WAS the startup wait --
  // nothing can be drawn until it lands. A copy is already in the cache, so
  // after SHELL_WAIT ms we serve that instead and let the download finish in
  // the background, where it refreshes the cache for the next launch.
  if (url.origin === location.origin) {
    const isPage = e.request.mode === 'navigate';
    e.respondWith(
      (async () => {
        const store = caches.open(VERSION);
        const live = fetch(e.request).then(res => {
          if (res && res.ok) { const copy = res.clone(); store.then(c => c.put(e.request, copy)); }
          return res;
        });
        if (isPage) {
          const cached = await caches.match(e.request, { ignoreSearch: true })
                      || await caches.match('./index.html');
          if (cached) {
            const waited = await Promise.race([
              live.catch(() => null),
              new Promise(r => setTimeout(() => r('slow'), SHELL_WAIT))
            ]);
            if (waited && waited !== 'slow' && waited.ok) return waited;
            live.catch(() => {});        // keep refreshing the cache in the background
            return cached;
          }
        }
        try {
          const res = await live;
          if (res) return res;
        } catch (err) {}
        return (await caches.match(e.request, { ignoreSearch: true })) || (await caches.match('./index.html'));
      })()
    );
  }
});
