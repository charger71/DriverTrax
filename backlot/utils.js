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

  // ---- pagination -----------------------------------------------------
  // Client-side pager for lists that are already fully loaded in memory
  // (Records, Users). It slices the current page and renders a compact
  // "N–M of T · Prev/Next" control into `mount`.
  //   create({ mount, pageSize = 25, render })
  //     mount    — element that hosts the pager controls
  //     pageSize — rows per page (default 25)
  //     render   — (pageItems) => void, draws just the current page
  //   returns { setItems(items) } — resets to page 1 and renders.
  // Prev/Next re-slice the same items in place (no re-fetch).
  const DEFAULT_PAGE_SIZE = 25;
  function createPager(opts) {
    const mount = opts.mount;
    const pageSize = opts.pageSize || DEFAULT_PAGE_SIZE;
    const draw = opts.render;
    let items = [], page = 1;
    const pageCount = () => Math.max(1, Math.ceil(items.length / pageSize));

    function renderPage() {
      page = Math.min(Math.max(1, page), pageCount());
      const start = (page - 1) * pageSize;
      draw(items.slice(start, start + pageSize));
      renderControls(start);
    }
    function renderControls(start) {
      if (!mount) return;
      const total = items.length;
      if (total <= pageSize) { mount.innerHTML = ""; mount.hidden = true; return; }
      mount.hidden = false;
      const from = start + 1, to = Math.min(start + pageSize, total);
      mount.innerHTML =
        `<span class="bl-pager-info">${from}–${to} of ${total}</span>` +
        `<div class="bl-pager-nav">` +
          `<button type="button" class="bl-btn bl-btn--sm bl-btn--secondary" data-pager="prev"${page <= 1 ? " disabled" : ""}>Prev</button>` +
          `<span class="bl-pager-page">Page ${page} / ${pageCount()}</span>` +
          `<button type="button" class="bl-btn bl-btn--sm bl-btn--secondary" data-pager="next"${page >= pageCount() ? " disabled" : ""}>Next</button>` +
        `</div>`;
    }
    if (mount) {
      mount.addEventListener("click", (e) => {
        const b = e.target.closest("[data-pager]");
        if (!b) return;
        if (b.dataset.pager === "prev" && page > 1) { page--; renderPage(); }
        else if (b.dataset.pager === "next" && page < pageCount()) { page++; renderPage(); }
      });
    }
    return {
      setItems(next) { items = next || []; page = 1; renderPage(); },
    };
  }
  window.BL_PAGINATE = { create: createPager, DEFAULT_SIZE: DEFAULT_PAGE_SIZE };

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
