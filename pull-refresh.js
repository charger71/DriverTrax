// Pull-to-refresh
//   Adds a native-feeling pull-down gesture that reloads the page. Necessary
//   because WKWebView does not expose Safari's built-in pull-to-refresh.
//
//   Engages only when: touch device, page scrolled to the very top, no modal
//   or overlay is open, and no input is focused (typing shouldn't reload).
//   Threshold + friction values tuned to feel similar to iOS Mail.
(function () {
  if (!("ontouchstart" in window)) return;

  const THRESHOLD = 72;
  const MAX_PULL  = 120;
  const FRICTION  = 0.55;

  let startY = 0;
  let pulled = 0;
  let pulling = false;
  let engaged = false;   // becomes true once pull > small deadzone; only then do we preventDefault
  let indicator = null;

  function ensureIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement("div");
    indicator.id = "pullRefreshIndicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.innerHTML = '<div class="ptr-spinner" aria-hidden="true"></div>';
    document.body.appendChild(indicator);
    return indicator;
  }

  function overlayOpen() {
    if (document.querySelector(".users-modal.show")) return true;
    if (document.querySelector(".scanner-overlay.open")) return true;
    if (document.querySelector(".detail-overlay.open")) return true;
    if (document.getElementById("recordDetailOverlay")?.classList.contains("open")) return true;
    if (document.getElementById("vinKeypadOverlay")?.classList.contains("open")) return true;
    if (document.querySelector(".slide-menu.open")) return true;
    if (document.getElementById("dt-auth-modal")?.classList.contains("show")) return true;
    return false;
  }

  function atTop() {
    return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  }

  function inputFocused() {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function updateIndicator() {
    const el = ensureIndicator();
    el.style.transform = `translate3d(-50%, ${pulled}px, 0)`;
    el.style.opacity = String(Math.min(pulled / THRESHOLD, 1));
    el.classList.toggle("ptr-ready", pulled >= THRESHOLD);
  }

  function hideIndicator() {
    if (!indicator) return;
    indicator.style.transition = "transform 0.22s ease, opacity 0.22s ease";
    indicator.style.transform = "translate3d(-50%, -60px, 0)";
    indicator.style.opacity = "0";
    window.setTimeout(() => {
      if (!indicator) return;
      indicator.style.transition = "";
      indicator.classList.remove("ptr-ready", "ptr-spinning");
    }, 240);
  }

  function trigger() {
    const el = ensureIndicator();
    el.classList.add("ptr-spinning");
    el.style.transform = `translate3d(-50%, ${THRESHOLD}px, 0)`;
    el.style.opacity = "1";
    // Soft refresh: surface any missed alerts as modals and let panel modules
    // (e.g. announcements.js) refetch their data via the dt-refresh event.
    // Doing this instead of location.reload() preserves entry-form state.
    try { window.DT_NOTIFS?.catchUp?.(); } catch {}
    try { document.dispatchEvent(new CustomEvent("dt-refresh")); } catch {}
    // Keep the spinner visible briefly so the gesture feels acknowledged.
    window.setTimeout(hideIndicator, 700);
  }

  function reset() {
    pulling = false;
    engaged = false;
    pulled = 0;
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) { reset(); return; }
    if (overlayOpen() || inputFocused() || !atTop()) { reset(); return; }
    startY = e.touches[0].clientY;
    pulling = true;
    engaged = false;
    pulled = 0;
  }

  function onTouchMove(e) {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { reset(); hideIndicator(); return; }
    if (!atTop()) { reset(); hideIndicator(); return; }
    pulled = Math.min(dy * FRICTION, MAX_PULL);
    updateIndicator();
    // Only start preventing the browser's rubber-band once the user has
    // clearly committed to a downward pull — avoids swallowing quick taps.
    if (pulled > 8) {
      engaged = true;
      if (e.cancelable) e.preventDefault();
    }
  }

  function onTouchEnd() {
    if (!pulling) return;
    const shouldTrigger = engaged && pulled >= THRESHOLD;
    reset();
    if (shouldTrigger) trigger();
    else hideIndicator();
  }

  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove",  onTouchMove,  { passive: false });
  document.addEventListener("touchend",   onTouchEnd,   { passive: true });
  document.addEventListener("touchcancel", onTouchEnd,  { passive: true });
})();
