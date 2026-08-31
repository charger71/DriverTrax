// ============================================================
// Backlot — service worker (own cache, scope ./ = /backlot/)
//
// Fully independent of the driver app's sw.js. Precaches only the
// Backlot shell. BUMP CACHE_VERSION on ANY change to a precached
// asset below, or installed PWAs keep serving the stale file.
// ============================================================
const CACHE_VERSION = "backlot-v4.21-sipp-compact-flag";

// Same-origin shell only. CDN libs (supabase-js, leaflet) are runtime-cached.
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./utils.js",
  "./catalogs.js",
  "./vin.js",
  "./auth.js",
  "./nav.js",
  "./parking-sections-map.html",
  "./parking-sections-map.js",
  "./map-tool.css",
  "./dashboard.js",
  "./roster.js",
  "./mechanics.js",
  "./users.js",
  "./parking-sections.js",
  "./vendors.js",
  "./sipp-codes.js",
  "./comms.js",
  "./reports.js",
  "./counters.js",
  "./records.js",
  "./record-form.js",
  "./search.js",
  "./boot.js",
  "./manifest.webmanifest",
  "./icons/icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Never cache Supabase API/realtime traffic — always go to network.
  if (url.hostname.endsWith(".supabase.co")) return;

  if (sameOrigin) {
    // Cache-first for the app shell, with a network fallback that refreshes the cache.
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html")))
    );
  } else {
    // Cross-origin (CDN libs, map tiles): network-first, fall back to cache if offline.
    event.respondWith(
      fetch(req).then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
