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
  function ensureToastHost() {
    let host = document.getElementById("dtPwaToasts");
    if (host) return host;
    host = document.createElement("div");
    host.id = "dtPwaToasts";
    host.style.cssText = "position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom, 0px) + 16px);display:flex;flex-direction:column;align-items:center;gap:8px;z-index:99998;pointer-events:none;";
    document.body.appendChild(host);
    return host;
  }
  function showToast({ text, actionLabel, onAction, persistent = false }) {
    const host = ensureToastHost();
    const t = document.createElement("div");
    t.style.cssText = "pointer-events:auto;background:#13161a;color:#fff;border:1px solid #2a2f36;border-radius:999px;padding:10px 14px;display:flex;align-items:center;gap:12px;box-shadow:0 6px 24px rgba(0,0,0,0.35);font:500 14px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:92vw;";
    const msg = document.createElement("span");
    msg.textContent = text;
    t.appendChild(msg);
    if (actionLabel) {
      const btn = document.createElement("button");
      btn.textContent = actionLabel;
      btn.style.cssText = "background:#4a9eff;color:#fff;border:0;border-radius:999px;padding:6px 12px;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;";
      btn.addEventListener("click", () => { try { onAction && onAction(); } finally { t.remove(); } });
      t.appendChild(btn);
    }
    const close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.style.cssText = "background:transparent;color:#9aa3ad;border:0;font-size:20px;line-height:1;cursor:pointer;padding:0 4px;";
    close.addEventListener("click", () => t.remove());
    t.appendChild(close);
    host.appendChild(t);
    if (!persistent) setTimeout(() => t.remove(), 8000);
    return t;
  }

  // ---------- SW update flow ----------
  if ("serviceWorker" in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });

    function promptUpdate(waitingWorker) {
      if (!waitingWorker) return;
      showToast({
        text: "Update available",
        actionLabel: "Refresh",
        persistent: true,
        onAction: () => waitingWorker.postMessage({ type: "SKIP_WAITING" })
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
    pill.textContent = "Install DriverTrax";
    pill.style.cssText = "position:fixed;right:14px;bottom:calc(env(safe-area-inset-bottom, 0px) + 72px);z-index:99997;background:#4a9eff;color:#fff;border:0;border-radius:999px;padding:10px 16px;font:600 14px/1 system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,0.35);cursor:pointer;display:none;";
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
    pill.style.display = "inline-flex";
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
