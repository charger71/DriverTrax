// ============================================================
// DriverTrax PWA glue
//   - Honors ?tab=<name> deep links (manifest shortcuts + SW
//     notification clicks both use this).
//   - Detects a waiting service worker and shows an "Update
//     available" toast; tells the SW to skipWaiting on accept,
//     reloads when the new SW takes control.
//   - Captures beforeinstallprompt and shows an Install pill on
//     supported platforms (Android/desktop Chromium).
// ============================================================

(function () {
  // ---------- ?share=1 incoming shared photo ----------
  async function applyShareParam() {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get("share") !== "1") return;
      const cache = await caches.open("drivertrax-share-inbox");
      const res = await cache.match("./shared-photo");
      if (!res) return;
      const blob = await res.blob();
      await cache.delete("./shared-photo");
      const name = res.headers.get("x-share-filename") || "shared.jpg";
      const file = new File([blob], name, { type: blob.type || "image/jpeg" });

      if (typeof window.showTab === "function") window.showTab("entry");
      const input = document.getElementById("entryPhotoInput");
      if (input) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // Strip ?share=1 from the URL so reload doesn't replay.
      const url = new URL(location.href);
      url.searchParams.delete("share");
      history.replaceState({}, "", url.pathname + url.search + url.hash);
    } catch (err) {
      console.warn("share inbox pickup failed", err);
    }
  }
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(applyShareParam, 0);
  } else {
    document.addEventListener("DOMContentLoaded", applyShareParam);
  }

  // ---------- ?tab=<name> deep link ----------
  function applyTabParam() {
    try {
      const params = new URLSearchParams(location.search);
      const tab = params.get("tab");
      if (tab && typeof window.showTab === "function") {
        window.showTab(tab);
        // Clean the URL so a reload doesn't keep re-routing.
        const url = new URL(location.href);
        url.searchParams.delete("tab");
        history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
      }
    } catch {}
  }
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(applyTabParam, 0);
  } else {
    document.addEventListener("DOMContentLoaded", applyTabParam);
  }

  // ---------- Toast helpers ----------
  // Styling lives in app.css (.pwa-toast-host / .pwa-toast / .pwa-install-pill)
  // so these follow the theme like everything else.
  function ensureToastHost() {
    let host = document.getElementById("dtPwaToasts");
    if (host) return host;
    host = document.createElement("div");
    host.id = "dtPwaToasts";
    host.className = "pwa-toast-host";
    document.body.appendChild(host);
    return host;
  }
  function showToast({ text, actionLabel, onAction, persistent = false }) {
    const host = ensureToastHost();
    const t = document.createElement("div");
    t.className = "pwa-toast";
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    const msg = document.createElement("span");
    msg.textContent = text;
    t.appendChild(msg);
    if (actionLabel) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pwa-toast-action";
      btn.textContent = actionLabel;
      btn.addEventListener("click", () => { try { onAction && onAction(); } finally { t.remove(); } });
      t.appendChild(btn);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "pwa-toast-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => t.remove());
    t.appendChild(close);
    host.appendChild(t);
    if (!persistent) setTimeout(() => t.remove(), 8000);
    return t;
  }

  // ---------- SW update flow ----------
  if ("serviceWorker" in navigator) {
    // Only reload when the user actually clicked the "Refresh" toast.
    // controllerchange fires in other scenarios too (clients.claim on
    // activate, browser-initiated SW updates), and auto-reloading on those
    // is what made the page feel like it was randomly refreshing.
    let userInitiatedRefresh = false;
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!userInitiatedRefresh || refreshing) return;
      refreshing = true;
      location.reload();
    });

    function promptUpdate(waitingWorker) {
      if (!waitingWorker) return;
      showToast({
        text: "Update available",
        actionLabel: "Refresh",
        persistent: true,
        onAction: () => {
          userInitiatedRefresh = true;
          waitingWorker.postMessage({ type: "SKIP_WAITING" });
        }
      });
    }

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      if (reg.waiting) promptUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            promptUpdate(sw);
          }
        });
      });
      // Check for updates periodically while the app is open.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      // iOS PWAs spend most of their life suspended — the hourly timer
      // rarely fires. Re-check whenever the app comes back to the front.
      const checkOnResume = () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", checkOnResume);
      window.addEventListener("pageshow", checkOnResume);
    }).catch(() => {});
  }

  // ---------- App version footer ----------
  // Show the running SW's CACHE_VERSION at the bottom of the page so a
  // deploy landing (or a stale SW) is obvious without devtools. Sources
  // are tried in parallel and the first non-empty wins:
  //   1. Ask the controlling SW directly via postMessage (most accurate —
  //      it reflects the SW that's actually intercepting requests).
  //   2. Read caches.keys() and pick the drivertrax-* entry.
  //   3. Fetch sw.js with a cache-buster to force a network round-trip
  //      that the SW's cache-first handler can't short-circuit.
  // First-load timing: on the very first visit, the SW isn't installed
  // yet — sources 1 and 2 are empty. Source 3 is the only signal, and
  // if it fails the footer retries once after the SW has time to install.
  // Deferred to DOM ready because pwa.js loads before the footer element.
  function showAppVersion() {
    const el = document.getElementById("appVersionFooter");
    if (!el) return;
    // file:// — no service worker and cross-origin fetches to sibling
    // files are blocked. Show a friendly indicator and stop; there's
    // nothing to compare against and no SW to be stale.
    if (location.protocol === "file:") {
      el.textContent = "file:// (no SW)";
      return;
    }
    const parseVer = (txt) => {
      const m = txt && txt.match(/CACHE_VERSION\s*=\s*["']([^"']+)["']/);
      return m ? m[1] : "";
    };
    const askSw = () => new Promise((resolve) => {
      const ctrl = navigator.serviceWorker?.controller;
      if (!ctrl) { resolve(""); return; }
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(""), 1200);
      ch.port1.onmessage = (ev) => {
        clearTimeout(timer);
        resolve((ev.data && ev.data.version) || "");
      };
      try { ctrl.postMessage({ type: "GET_VERSION" }, [ch.port2]); }
      catch { clearTimeout(timer); resolve(""); }
    });
    const askCaches = () => (window.caches?.keys?.() || Promise.resolve([]))
      .then(keys => keys.find(k => k.startsWith("drivertrax-")) || "")
      .catch(() => "");
    // Absolute URL avoids a base-href surprise (some hosts serve index
    // from a subpath). If the fetch fails or the response body has no
    // CACHE_VERSION match, we surface the failure reason in the console
    // so a real deploy issue is diagnosable without editing the code.
    const askNetwork = async (diag) => {
      const url = new URL("sw.js", document.baseURI).href + `?_v=${Date.now()}`;
      diag.url = url;
      try {
        const r = await fetch(url, { cache: "no-store" });
        diag.status = r.status;
        diag.contentType = r.headers.get("content-type") || "";
        if (!r.ok) return "";
        const t = await r.text();
        diag.bodyLen = t.length;
        diag.bodyHead = t.slice(0, 80);
        return parseVer(t);
      } catch (err) {
        diag.error = String(err && err.message || err);
        return "";
      }
    };
    let attempts = 0;
    const run = () => {
      const netDiag = {};
      Promise.all([askSw(), askCaches(), askNetwork(netDiag)]).then(([running, cache, deployed]) => {
        const active = running || cache;
        const shown = deployed || active || "";
        const mismatch = deployed && active && deployed !== active;
        if (shown) {
          el.textContent = mismatch ? `${shown}  ·  active: ${active}` : shown;
          el.classList.toggle("app-version-footer--mismatch", !!mismatch);
          return;
        }
        // All three empty. On first load the SW is likely still installing —
        // wait a beat and try one more time so the cache has a chance to fill.
        if (attempts === 0) {
          attempts++;
          el.textContent = "installing…";
          setTimeout(run, 2500);
          return;
        }
        el.textContent = "unknown";
        console.warn("[appVersion] all sources empty", {
          running, cache, deployed, network: netDiag,
          swSupport: "serviceWorker" in navigator,
          controller: !!navigator.serviceWorker?.controller
        });
      });
    };
    run();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showAppVersion);
  } else {
    showAppVersion();
  }

  // ---------- Install prompt ----------
  let deferredInstallEvent = null;

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches
        || window.navigator.standalone === true;
  }

  function ensureInstallPill() {
    let pill = document.getElementById("dtInstallPill");
    if (pill) return pill;
    pill = document.createElement("button");
    pill.id = "dtInstallPill";
    pill.type = "button";
    pill.className = "pwa-install-pill";
    pill.hidden = true;
    pill.textContent = "Install DriverTrax";
    pill.addEventListener("click", async () => {
      if (!deferredInstallEvent) return;
      pill.disabled = true;
      try {
        deferredInstallEvent.prompt();
        await deferredInstallEvent.userChoice;
      } catch {}
      deferredInstallEvent = null;
      pill.remove();
    });
    document.body.appendChild(pill);
    return pill;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    if (isStandalone()) return;
    if (localStorage.getItem("drivertrax_install_dismissed") === "1") return;
    deferredInstallEvent = e;
    const pill = ensureInstallPill();
    pill.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallEvent = null;
    const pill = document.getElementById("dtInstallPill");
    if (pill) pill.remove();
  });

  // ---------- Persistent storage ----------
  // Ask the browser not to evict our IndexedDB/cache/localStorage under
  // storage pressure. Granted automatically once the user installs the
  // PWA on most engines; harmless to ask early.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then((already) => {
      if (!already) navigator.storage.persist().catch(() => {});
    }).catch(() => {});
  }

  // ---------- App Badging API ----------
  // Sums contributions from multiple modules (alerts + coverage)
  // and pushes the total to the OS via navigator.setAppBadge.
  const badgeCounts = { alerts: 0, coverage: 0 };
  function flushBadge() {
    const total = Object.values(badgeCounts).reduce((a, b) => a + (b | 0), 0);
    try {
      if (total > 0 && navigator.setAppBadge) {
        navigator.setAppBadge(total).catch(() => {});
      } else if (navigator.clearAppBadge) {
        navigator.clearAppBadge().catch(() => {});
      }
    } catch {}
  }

  window.DT_PWA = {
    setBadgeSource: (source, n) => {
      badgeCounts[source] = Math.max(0, n | 0);
      flushBadge();
    },
    dismissInstall: () => {
      localStorage.setItem("drivertrax_install_dismissed", "1");
      const pill = document.getElementById("dtInstallPill");
      if (pill) pill.remove();
    }
  };
})();
