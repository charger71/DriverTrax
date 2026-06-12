// ============================================================
// DriverTrax shared utilities
//   - DT_ESC: HTML escape (same map every module had its own copy of)
//   - DT_FORMAT: time/date formatters (single source for "America/New_York")
//   - DT_TOAST: thin wrapper over showToast() so non-app modules can use it
//   - DT_UI: misc UI helpers (modal status message)
// Load this BEFORE auth.js / app.js / feature modules.
// ============================================================
(function () {
  const ESC_MAP = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ESC_MAP[c]);

  const TZ = "America/New_York";
  const toDate = (v) => (v instanceof Date) ? v : new Date(v);
  const valid  = (d) => d && !isNaN(d.getTime());

  const time = (v) => {
    const d = toDate(v);
    if (!valid(d)) return "";
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  };
  const date = (v) => {
    const d = toDate(v);
    if (!valid(d)) return "";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };
  const dateTime = (v) => {
    const d = toDate(v);
    if (!valid(d)) return "";
    return d.toLocaleString();
  };
  // Prefer the rich timeAgo from announcements.js when loaded; fall back to dateTime.
  const timeAgo = (v, prefix) => {
    if (typeof window.dtTimeAgo === "function") return window.dtTimeAgo(v, prefix);
    return dateTime(v);
  };
  // Records show "5 min ago" when announcements.js is loaded, EST clock time otherwise.
  const timeAgoOrClock = (v) => {
    if (typeof window.dtTimeAgo === "function") return window.dtTimeAgo(v);
    return time(v);
  };

  window.DT_ESC = esc;
  window.DT_FORMAT = { time, date, dateTime, timeAgo, timeAgoOrClock, TZ };

  // Toast: delegate to showToast() defined in app.js once it's loaded.
  // Safe to call before app.js initializes — calls are dropped silently.
  window.DT_TOAST = {
    show(msg, type) {
      if (typeof window.showToast === "function") window.showToast(msg, type);
    }
  };

  // Set a modal status message (matches the .users-modal-msg className pattern
  // already used in notes/users/auth modals).
  window.DT_UI = {
    setMessage(el, text, kind) {
      if (!el) return;
      el.textContent = text || "";
      el.className = "users-modal-msg" + (kind ? " " + kind : "");
    }
  };
})();
