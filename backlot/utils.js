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
  // Pager for lists — works in two modes:
  //
  //   mode: "client" (default)  — caller passes the full array via
  //         setItems(items); pager slices & paginates in memory. Used
  //         for Users, Roster, Leaderboard, Reports.
  //
  //   mode: "server"            — caller passes ONE PAGE via
  //         setPage({items, total, page}); pager calls onPageChange
  //         (page, pageSize) whenever the user clicks Prev/Next, jumps,
  //         or changes size, and the caller re-fetches. Used for
  //         Records (unbounded row count).
  //
  //   create({ mount, pageSize, sizes, storageKey, render, mode, onPageChange })
  //     mount        — element that hosts the pager controls
  //     pageSize     — initial rows per page (overridden by saved size, if any)
  //     sizes        — options offered in the per-page dropdown
  //     storageKey   — localStorage key for persisted size (default derived
  //                    from mount.id so each list persists independently)
  //     render       — (pageItems) => void, draws the current page
  //     mode         — "client" | "server" (default "client")
  //     onPageChange — (page, pageSize) => void  [server mode only]
  //
  //   returns { setItems(items), setPage({items,total,page}), getPageSize(), getPage() }
  const DEFAULT_PAGE_SIZE = 25;
  const DEFAULT_SIZES = [25, 50, 100];
  function readSavedSize(key, sizes) {
    if (!key) return null;
    try {
      const v = parseInt(localStorage.getItem(key), 10);
      if (sizes.includes(v)) return v;
    } catch (_) { /* localStorage may be blocked */ }
    return null;
  }
  function saveSize(key, size) {
    if (!key) return;
    try { localStorage.setItem(key, String(size)); } catch (_) { /* ignore */ }
  }
  function createPager(opts) {
    const mount = opts.mount;
    const draw = opts.render;
    const sizes = Array.isArray(opts.sizes) && opts.sizes.length ? opts.sizes : DEFAULT_SIZES;
    const storageKey = opts.storageKey || (mount && mount.id ? `bl-pager-size:${mount.id}` : null);
    const mode = opts.mode === "server" ? "server" : "client";
    const onPageChange = typeof opts.onPageChange === "function" ? opts.onPageChange : null;
    let pageSize = readSavedSize(storageKey, sizes) || opts.pageSize || DEFAULT_PAGE_SIZE;
    let items = [], total = 0, page = 1;
    const pageCount = () => Math.max(1, Math.ceil(total / pageSize));

    function renderPage() {
      page = Math.min(Math.max(1, page), pageCount());
      const start = (page - 1) * pageSize;
      // Client mode slices in memory; server mode receives a pre-sliced page.
      draw(mode === "client" ? items.slice(start, start + pageSize) : items);
      renderControls(start);
    }
    function renderControls(start) {
      if (!mount) return;
      // Hide entirely for very small lists — the smallest size option is the threshold.
      if (total <= sizes[0]) { mount.innerHTML = ""; mount.hidden = true; return; }
      mount.hidden = false;
      const from = total ? start + 1 : 0;
      const shown = mode === "client" ? Math.min(pageSize, total - start) : items.length;
      const to = start + shown;
      const pc = pageCount();
      const sizeOpts = sizes.map((s) => `<option value="${s}"${s === pageSize ? " selected" : ""}>${s}</option>`).join("");
      mount.innerHTML =
        `<span class="bl-pager-info">${from}–${to} of ${total}</span>` +
        `<div class="bl-pager-nav">` +
          `<label class="bl-pager-size"><span>Per page</span>` +
            `<select class="bl-pager-select" data-pager="size" aria-label="Rows per page">${sizeOpts}</select>` +
          `</label>` +
          `<button type="button" class="bl-btn bl-btn--sm bl-btn--secondary" data-pager="prev"${page <= 1 ? " disabled" : ""}>Prev</button>` +
          `<span class="bl-pager-page">Page ` +
            `<input type="number" class="bl-pager-jump" data-pager="jump" min="1" max="${pc}" value="${page}" aria-label="Go to page">` +
            ` / ${pc}</span>` +
          `<button type="button" class="bl-btn bl-btn--sm bl-btn--secondary" data-pager="next"${page >= pc ? " disabled" : ""}>Next</button>` +
        `</div>`;
    }
    function goTo(next) {
      const clamped = Math.min(Math.max(1, next), pageCount());
      if (clamped === page && mode === "client") return;
      page = clamped;
      if (mode === "server") {
        if (onPageChange) onPageChange(page, pageSize);
      } else {
        renderPage();
      }
    }
    if (mount) {
      mount.addEventListener("click", (e) => {
        const b = e.target.closest("[data-pager]");
        if (!b) return;
        if (b.dataset.pager === "prev" && page > 1) goTo(page - 1);
        else if (b.dataset.pager === "next" && page < pageCount()) goTo(page + 1);
      });
      mount.addEventListener("change", (e) => {
        const t = e.target.closest('[data-pager="size"]');
        if (!t) return;
        const next = parseInt(t.value, 10);
        if (!next || next < 1) return;
        // Anchor on the currently-visible top item so users don't lose their place.
        const currentFirst = (page - 1) * pageSize;
        pageSize = next;
        page = Math.floor(currentFirst / pageSize) + 1;
        saveSize(storageKey, pageSize);
        if (mode === "server") {
          if (onPageChange) onPageChange(page, pageSize);
        } else {
          renderPage();
        }
      });
      mount.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const t = e.target.closest('[data-pager="jump"]');
        if (!t) return;
        e.preventDefault();
        const next = parseInt(t.value, 10);
        if (!Number.isNaN(next)) goTo(next);
      });
    }
    return {
      // Client mode
      setItems(next) {
        if (mode !== "client") return;
        items = next || [];
        total = items.length;
        page = 1;
        renderPage();
      },
      // Server mode
      setPage(payload) {
        if (mode !== "server") return;
        items = (payload && payload.items) || [];
        if (payload && Number.isFinite(payload.total)) total = payload.total;
        if (payload && Number.isFinite(payload.page)) page = payload.page;
        renderPage();
      },
      getPageSize() { return pageSize; },
      getPage() { return page; },
      // Utility: caller can force a re-render of controls without touching state.
      refreshControls() { renderControls((page - 1) * pageSize); },
    };
  }
  window.BL_PAGINATE = { create: createPager, DEFAULT_SIZE: DEFAULT_PAGE_SIZE, DEFAULT_SIZES };

  // ---- sortable table columns ----------------------------------------
  // Attaches sort behavior to a table. The caller declares which columns
  // are sortable by giving each <th> a `data-sort-key`, and passes a
  // matching `columns` map with a getter per key. BL_SORT draws the
  // ▲/▼ indicator, tracks state, persists it (optional), and fires
  // onChange whenever the sort changes so the caller can re-render.
  //
  //   attach({ thead, columns, default, storageKey, onChange })
  //     thead      — <thead> element (or its <tr>)
  //     columns    — { key: { get: (row) => value, type?: "string"|"number"|"date" } }
  //     default    — { key, dir: "asc"|"desc" }  optional initial sort
  //     storageKey — localStorage key for persisted sort state (optional)
  //     onChange   — (state, comparator) => void
  //         state       = { key, dir }
  //         comparator  = (a,b) => number  applies current sort to two rows
  //
  //   returns { current(), sort(rows), setSort(key, dir) }
  function readSavedSort(key) {
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s && typeof s.key === "string" && (s.dir === "asc" || s.dir === "desc")) return s;
    } catch (_) { /* ignore */ }
    return null;
  }
  function saveSort(key, state) {
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }
  function defaultCompare(type) {
    if (type === "number") return (a, b) => (Number(a) || 0) - (Number(b) || 0);
    if (type === "date")   return (a, b) => new Date(a || 0).getTime() - new Date(b || 0).getTime();
    // string / fallback: locale-aware, nullish → empty
    return (a, b) => String(a == null ? "" : a).localeCompare(String(b == null ? "" : b), undefined, { sensitivity: "base", numeric: true });
  }
  function attachSort(opts) {
    const thead = opts.thead;
    if (!thead) return null;
    const columns = opts.columns || {};
    const storageKey = opts.storageKey || null;
    let state = readSavedSort(storageKey) || (opts.default ? { ...opts.default } : null);
    if (state && !columns[state.key]) state = null; // saved column no longer exists

    function indicator(key) {
      if (!state || state.key !== key) return `<span class="bl-sort-ind" aria-hidden="true">↕</span>`;
      return `<span class="bl-sort-ind is-active" aria-hidden="true">${state.dir === "asc" ? "▲" : "▼"}</span>`;
    }
    function paint() {
      thead.querySelectorAll("th[data-sort-key]").forEach((th) => {
        const key = th.dataset.sortKey;
        th.classList.add("bl-sortable");
        th.classList.toggle("is-sorted", !!state && state.key === key);
        // Preserve original label as data-label so repaint doesn't accumulate indicators.
        if (!th.dataset.label) th.dataset.label = th.textContent.trim();
        th.innerHTML = `<button type="button" class="bl-sort-btn" data-sort-key="${key}"><span>${esc(th.dataset.label)}</span>${indicator(key)}</button>`;
        th.setAttribute("aria-sort", !state || state.key !== key ? "none" : (state.dir === "asc" ? "ascending" : "descending"));
      });
    }
    function comparator() {
      if (!state) return () => 0;
      const col = columns[state.key];
      if (!col) return () => 0;
      const cmp = col.compare || defaultCompare(col.type);
      const dir = state.dir === "asc" ? 1 : -1;
      const get = col.get;
      return (a, b) => cmp(get(a), get(b)) * dir;
    }
    function fire() {
      paint();
      if (typeof opts.onChange === "function") opts.onChange(state ? { ...state } : null, comparator());
    }
    thead.addEventListener("click", (e) => {
      // Match anywhere in the sortable header's subtree: the <button>, an inner
      // <span>, or the wrapping <th data-sort-key>. All share the same key.
      const target = e.target.closest("[data-sort-key]");
      if (!target) return;
      const key = target.dataset.sortKey;
      if (!columns[key]) return;
      if (!state || state.key !== key) state = { key, dir: "asc" };
      else if (state.dir === "asc") state = { key, dir: "desc" };
      else state = null; // third click clears the sort
      saveSort(storageKey, state);
      fire();
    });
    paint();
    return {
      current: () => (state ? { ...state } : null),
      sort: (rows) => (state ? rows.slice().sort(comparator()) : rows.slice()),
      setSort: (key, dir) => { state = key ? { key, dir: dir || "asc" } : null; saveSort(storageKey, state); fire(); },
    };
  }
  window.BL_SORT = { attach: attachSort };

  // ---- global keyboard shortcuts -------------------------------------
  // Section-scoped shortcuts:
  //   /            focus the search input in the active section
  //   n            click [data-shortcut="new"] in the active section
  //   ← / →        page Prev/Next in the active section's pager
  // Skipped when the user is typing in an input, textarea, select, or
  // contenteditable element. Runs automatically on load.
  function activeSection() {
    return document.querySelector(".bl-section.is-active") || document.body;
  }
  function isTyping(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return !!t.isContentEditable;
  }
  function handleShortcut(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    const scope = activeSection();
    if (e.key === "/") {
      const s = scope.querySelector('input[type="search"]');
      if (s) { e.preventDefault(); s.focus(); s.select && s.select(); }
      return;
    }
    if (e.key === "n" || e.key === "N") {
      const btn = scope.querySelector('[data-shortcut="new"]');
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const dir = e.key === "ArrowLeft" ? "prev" : "next";
      const btn = scope.querySelector(`.bl-pager [data-pager="${dir}"]`);
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    }
  }
  const BL_KEYS = {
    init() {
      if (this._done) return;
      this._done = true;
      document.addEventListener("keydown", handleShortcut);
    },
  };
  window.BL_KEYS = BL_KEYS;
  BL_KEYS.init();

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
