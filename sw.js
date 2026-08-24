// DriverTrax Service Worker
// Provides offline support and caches app assets
const CACHE_VERSION = "drivertrax-v9.70-plate-sipp-badge-base";
// Every <script src> and <link href> in index.html must appear here. Anything
// missing is unavailable on an offline cold start: cross-origin assets in
// particular can't be backfilled at runtime by any reliable means, so a gap
// here is a gap forever. Keep this list in sync when adding a script tag.
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.json",
  "./icon.png",
  "./supabase-config.js",
  "./utils.js",
  "./a11y.js",
  "./idb.js",
  "./auth.js",
  "./sync.js",
  "./backlot.js",
  "./announcements.js",
  "./fleet-counts.js",
  "./requests.js",
  "./drop-offs.js",
  "./damage.js",
  "./users.js",
  "./locations.js",
  "./vehicle-info.js",
  "./detailer.js",
  "./vendors.js",
  "./maintenance.js",
  "./elearning.js",
  "./notifications.js",
  "./pull-refresh.js",
  "./pwa.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/@zxing/library@0.18.6/umd/index.min.js",
  // Without this the app cannot boot offline at all: auth.js bails when
  // window.supabase is missing, and every feature module then trips its own
  // `if (!window.DT_AUTH) return;` guard. Unlike leaflet/zxing this URL is an
  // unpinned major range, so jsDelivr may serve a new minor at any time —
  // worth pinning to an exact version on a future pass.
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"
];
// Install: pre-cache the app shell. `cache: "reload"` bypasses the
// browser's HTTP cache so a stale in-disk copy of an app-shell asset
// (left over from the previous SW generation) can't get baked into the
// new cache — otherwise a v-bump would still serve old JS/CSS to users
// whose browser cached those resources with a long-ish freshness window.
// cache.addAll() is all-or-nothing: one unreachable CDN asset during install
// rejects the whole batch and leaves an empty cache. That failed silently
// here, so a momentary blip while installing produced a PWA with no offline
// support at all. Add each entry independently instead, so the same-origin
// shell always lands even when a third-party host is having a bad minute.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const results = await Promise.allSettled(
      APP_SHELL.map((u) => cache.add(new Request(u, { cache: "reload" })))
    );
    const failed = APP_SHELL.filter((_, i) => results[i].status === "rejected");
    if (failed.length) console.warn("[SW] shell assets not cached:", failed);
  })());
});

// Page can ask the waiting SW to activate immediately when the user
// accepts the "Update available" toast. The version-footer in pwa.js
// also asks the running SW for its CACHE_VERSION via GET_VERSION.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "GET_VERSION") {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ version: CACHE_VERSION });
    return;
  }
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

// Background Sync: wake any visible clients so sync.js can flush
// its localStorage queue. The SW can't reach the queue itself yet
// (it lives in page localStorage); moving it to IndexedDB would
// enable true closed-app flushing.
self.addEventListener("sync", (event) => {
  if (event.tag !== "drivertrax-flush") return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: "dt-sync-flush" }));
  })());
});

// Web Push: payload from the notify edge function is JSON
// { title, body, tag, tab, url }. Falls back to a generic message
// if the payload is missing or unparseable.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text?.() || "" }; }
  const title = data.title || "DriverTrax";
  const opts = {
    body: data.body || "",
    tag: data.tag || "drivertrax",
    icon: "./icon.png",
    badge: "./icon.png",
    data: { tab: data.tab || null, url: data.url || "./" }
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Notification click: focus an existing window (or open one) and ask
// the page to switch to the tab encoded in notification.data.tab.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const tab = event.notification.data && event.notification.data.tab;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = all.find((c) => "focus" in c);
    if (client) {
      await client.focus();
      if (tab) client.postMessage({ type: "dt-show-tab", tab });
      return;
    }
    await self.clients.openWindow("./");
  })());
});

// Web Share Target: receive a shared photo from the OS share sheet.
// Stash it in a dedicated cache so the page (which loads after the
// redirect) can fetch it back without re-uploading. The handler is
// keyed by the URL pattern declared in manifest.json#share_target.
const SHARE_CACHE = "drivertrax-share-inbox";
async function handleShareTarget(event) {
  try {
    const formData = await event.request.formData();
    const file = formData.get("photo");
    if (file && file instanceof File) {
      const cache = await caches.open(SHARE_CACHE);
      const headers = new Headers({
        "content-type": file.type || "application/octet-stream",
        "x-share-filename": file.name || "shared.jpg"
      });
      await cache.put("./shared-photo", new Response(file, { headers }));
    }
  } catch (err) {
    console.warn("share_target capture failed", err);
  }
  return Response.redirect("./?share=1", 303);
}

// Fetch strategy: cache-first for app shell, network-first for API calls
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Web Share Target POST — intercept before the method filter below.
  if (event.request.method === "POST" && url.pathname.endsWith("/") && url.searchParams.get("share") === "1") {
    event.respondWith(handleShareTarget(event));
    return;
  }

  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  // Bypass entirely for backend / dynamic origins. Supabase realtime
  // (wss) is bypassed automatically because it's not a fetch; REST and
  // storage GETs we leave to the browser so CORS + auth behave normally
  // and we don't try to cache user-data responses.
  if (
    url.hostname.endsWith(".supabase.co") ||
    url.hostname.endsWith(".supabase.in")
  ) {
    return;
  }

  // Network-first for API calls (NHTSA VIN, NHTSA recalls, NWS weather, Open-Meteo)
  if (
    url.hostname.includes("nhtsa.dot.gov") ||
    url.hostname.includes("api.nhtsa.gov") ||
    url.hostname.includes("weather.gov") ||
    url.hostname.includes("open-meteo.com") ||
    url.hostname.includes("openstreetmap.org")
  ) {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match(event.request);
        return cached || new Response("", { status: 504, statusText: "Offline" });
      })
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
      // Not in cache: fetch from network and cache it. "basic" alone would
      // skip every cross-origin asset (those come back as "cors"), which is
      // how a missing precache entry stayed missing forever. Opaque responses
      // are still excluded — res.ok is false for those.
      return fetch(event.request).then((res) => {
        if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone));
        }
        return res;
      }).catch(async () => {
        // Offline fallback. Must always return a Response — otherwise
        // respondWith throws "Failed to convert value to 'Response'".
        if (event.request.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) return shell;
        }
        return new Response("", { status: 504, statusText: "Offline" });
      });
    })
  );
});
