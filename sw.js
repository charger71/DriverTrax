// DriverTrax Service Worker
// Provides offline support and caches app assets
const CACHE_VERSION = "drivertrax-v2.2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/@zxing/library@0.18.6/umd/index.min.js"
];

// Install: pre-cache the app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        console.warn("Some shell assets failed to cache:", err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch strategy: cache-first for app shell, network-first for API calls
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  // Network-first for API calls (NHTSA VIN, NWS weather, Open-Meteo)
  if (
    url.hostname.includes("nhtsa.dot.gov") ||
    url.hostname.includes("weather.gov") ||
    url.hostname.includes("open-meteo.com") ||
    url.hostname.includes("openstreetmap.org")
  ) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for everything else (app shell, libraries)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Refresh the cache in the background
        fetch(event.request).then((res) => {
          if (res && res.ok) {
            caches.open(CACHE_VERSION).then((c) => c.put(event.request, res.clone()));
          }
        }).catch(() => {});
        return cached;
      }
      // Not in cache: fetch from network and cache it
      return fetch(event.request).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone));
        }
        return res;
      }).catch(() => {
        // Offline fallback
        if (event.request.mode === "navigate") {
          return caches.match("./index.html");
        }
      });
    })
  );
});
