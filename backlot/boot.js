// ============================================================
// Backlot — PWA boot: register the service worker.
// Kept external (not inline) so the CSP needs no 'unsafe-inline'.
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((err) => {
      console.warn("[Backlot] SW registration failed", err);
    });
  });
}
