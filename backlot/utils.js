// ============================================================
// Backlot — shared helpers (own copy, BL_* namespace)
//
// Self-contained equivalents of the driver app's DT_* helpers so
// Backlot never reaches back into a driver-app file. Exposed as
// globals for the feature modules to use.
//   BL_ESC    — HTML escape
//   BL_FORMAT — time/date/timeAgo (America/New_York)
//   BL_TOAST  — transient toast feedback
//   BL_UI     — inline message lines, $ helper
// ============================================================
(function () {
  const TZ = "America/New_York";

  // ---- HTML escaping --------------------------------------------------
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }
  window.BL_ESC = esc;

  // ---- date / time ----------------------------------------------------
  function time(d) {
    if (!d) return "";
    return new Date(d).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: TZ
    });
  }
  function date(d) {
    if (!d) return "";
    return new Date(d).toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", timeZone: TZ
    });
  }
  function timeAgo(d) {
    if (!d) return "";
    const then = new Date(d).getTime();
    const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 45) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.floor(hrs / 24);
    if (days < 7) return days + "d ago";
    return date(d);
  }
  // Recent → relative ("4m ago"); older today → clock; otherwise date.
  function timeAgoOrClock(d) {
    if (!d) return "";
    const mins = (Date.now() - new Date(d).getTime()) / 60000;
    if (mins < 60) return timeAgo(d);
    const sameDay = new Date(d).toDateString() === new Date().toDateString();
    return sameDay ? time(d) : date(d);
  }
  window.BL_FORMAT = { TZ, time, date, timeAgo, timeAgoOrClock };

  // ---- toast ----------------------------------------------------------
  let toastTimer = null;
  function toast(msg, kind) {
    let el = document.getElementById("bl-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "bl-toast";
      el.className = "bl-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "bl-toast bl-toast--" + (kind || "info") + " is-show";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove("is-show"); }, 3200);
  }
  window.BL_TOAST = {
    show: toast,
    success: (m) => toast(m, "success"),
    warn: (m) => toast(m, "warn"),
    error: (m) => toast(m, "error"),
    missing: (what) => toast(`That ${what || "record"} is no longer here — it may have just been removed.`, "warn"),
  };

  // ---- inline UI helpers ---------------------------------------------
  function setMessage(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "bl-msg" + (kind ? " bl-msg--" + kind : "");
  }
  window.BL_UI = {
    $: (id) => document.getElementById(id),
    setMessage,
  };

  // ---- Supabase error helpers ----------------------------------------
  // Detect a row-not-found / empty result so callers can show a friendly
  // "it's gone" toast instead of a raw error.
  window.BL_ERR = {
    isMissing: (error, data) => {
      if (error && (error.code === "PGRST116" || /no rows/i.test(error.message || ""))) return true;
      if (!error && (data == null || (Array.isArray(data) && data.length === 0))) return true;
      return false;
    },
  };
})();
