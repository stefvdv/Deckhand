/* Gaea service worker — VERSION altijd gelijk aan APP_VERSION in index.html */
const VERSION = "0.63.0";
const SHELL = "wildpluk-shell-v" + VERSION;
const LIB   = "wildpluk-lib-v" + VERSION;
const TILES = "wildpluk-tiles";          /* niet versiegebonden */
const BEELD = "wildpluk-beeld";          /* foto's van soorten, ook niet versiegebonden */
const BEELD_MAX = 900;
const TILE_MAX = 1500;

const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./badge-96.png"];

/* Al het sierbeeld zit als data-URI in index.html, dus er is geen
   losse art-map meer om te cachen. */
const LIB_FILES = [
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SHELL_FILES);
    const l = await caches.open(LIB);
    await Promise.all(LIB_FILES.map(u => fetch(u, {mode:"cors"}).then(r => r.ok && l.put(u, r)).catch(()=>{})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== SHELL && k !== LIB && k !== TILES && k !== BEELD && k.startsWith("wildpluk-")) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

const isTile = u => /service\.pdok\.nl|tile\.openstreetmap\.org/.test(u.hostname);

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - TILE_MAX; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  /* GBIF nooit via de service worker cachen — dat doet de app zelf in IndexedDB */
  /* Netwerkverkeer naar de beeld- en soortbronnen laten we met rust: dat is
     verse data, geen app-bestand. Naast GBIF nu ook iNaturalist en Wikimedia,
     die als reserve dienen wanneer GBIF niets heeft. */
  if (url.pathname.startsWith("/gbif/") || /(^|\.)gbif\.org$/.test(url.hostname)) return;
  if (url.pathname.startsWith("/inat/") || /(^|\.)inaturalist\.org$/.test(url.hostname)) return;
  if (url.pathname.startsWith("/wiki/") || /(^|\.)wikimedia\.org$/.test(url.hostname)
      || /(^|\.)wikipedia\.org$/.test(url.hostname)) return;
  if (/(^|\.)staticflickr\.com$/.test(url.hostname)) return;
  /* Omgekeerd geocoderen voor de plaatsnaam bij een vondst: ook verse data,
     en het antwoord hangt aan coördinaten die nooit twee keer hetzelfde zijn. */
  if (/(^|\.)openstreetmap\.org$/.test(url.hostname)) return;

  /* kaarttegels: cache-first, zo werkt een eerder bezocht gebied offline */
  if (isTile(url)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque")) { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch (err) { return new Response("", {status:504}); }
    })());
    return;
  }

  /* soortfoto's van willekeurige hosts: cache-first, ook ondoorzichtige antwoorden.
     Zo blijft alles wat je een keer hebt gezien of voorgeladen offline werken. */
  if (req.destination === "image" && url.origin !== self.location.origin && !isTile(url)) {
    e.respondWith((async () => {
      const c = await caches.open(BEELD);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque")) {
          c.put(req, res.clone());
          const keys = await c.keys();
          for (let i = 0; i < keys.length - BEELD_MAX; i++) await c.delete(keys[i]);
        }
        return res;
      } catch (err) { return new Response("", { status: 504 }); }
    })());
    return;
  }

  /* libs en fonts: cache-first */
  if (/cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(LIB);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
        return res;
      } catch (err) { return hit || new Response("", {status:504}); }
    })());
    return;
  }

  /* eigen bestanden: network-first met terugval op cache */
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch (err) {
        return (await caches.match(req)) || caches.match("./index.html");
      }
    })());
  }
});
