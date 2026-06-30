// DriverTrax Service Worker
// Provides offline support and caches app assets
const CACHE_VERSION = "drivertrax-v7.6-vin-keypad-safe-area";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.json",
  "./icon.png",
  "./supabase-config.js",
  "./utils.js",
  "./auth.js",
  "./sync.js",
  "./backlot.js",
  "./announcements.js",
  "./fleet-counts.js",
  "./requests.js",
  "./users.js",
  "./detailer.js",
  "./elearning.js",
  "./notifications.js",
  "./pwa.js",
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
    })
  );
});

// Page can ask the waiting SW to activate immediately when the user
// accepts the "Update available" toast.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
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
      // Not in cache: fetch from network and cache it
      return fetch(event.request).then((res) => {
        if (res && res.ok && res.type === "basic") {
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
