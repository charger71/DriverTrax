// ============================================================
// Backlot — global VIN / serial search
//   Mounts into the topbar (#blGlobalSearch + #blGlobalSearchDropdown).
//   Debounced ilike query against records.serial_id, ordered by newest ts.
//   Selecting a result opens the record-detail modal directly via
//   BL_RECORDS.openDetail(id) — no section navigation, no page context.
//   Managers who start from a VIN/serial handed to them by a CXR can
//   jump straight to the record from anywhere in the app.
//
//   Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;
  const label = (s) => (window.BL_STATUS_LABEL ? BL_STATUS_LABEL(s) : s) || "";

  const MAX_RESULTS   = 8;   // unique VINs shown
  const FETCH_LIMIT   = 50;  // rows fetched before client-side dedupe (enough to surface 8 VINs even when the top row has ~6 events)
  const MIN_CHARS     = 2;
  const DEBOUNCE_MS   = 250;

  let input, dropdown;
  let seq = 0;       // guards against out-of-order results on rapid typing
  let timer = null;
  let activeIdx = -1;
  let results = [];

  function mount() {
    input = $("blGlobalSearch");
    dropdown = $("blGlobalSearchDropdown");
    if (!input || !dropdown) return;
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("focus", () => {
      if (input.value.trim().length >= MIN_CHARS) show();
    });
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onGlobalKeydown);
  }

  function onInput() {
    activeIdx = -1;
    const q = input.value.trim();
    if (q.length < MIN_CHARS) { hide(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => run(q), DEBOUNCE_MS);
  }

  async function run(q) {
    const my = ++seq;
    render({ state: "loading" });
    show();
    // Wildcard chars in Postgres LIKE that we want to treat as literal.
    const safe = q.replace(/[%_]/g, "\\$&");
    const { data, error } = await sb.from("records")
      .select("id,serial_id,status,ts,vin_data")
      .ilike("serial_id", `%${safe}%`)
      .order("ts", { ascending: false })
      .limit(FETCH_LIMIT);
    if (my !== seq) return; // superseded by a newer keystroke
    if (error) { render({ state: "error", msg: error.message }); return; }
    // Dedupe by serial_id: keep the newest event per VIN (fetch was ordered
    // ts DESC, so first occurrence wins). Managers searching by VIN want one
    // row per vehicle showing the latest status, not every event for it.
    const bySerial = new Map();
    for (const r of (data || [])) {
      const key = r.serial_id || "";
      if (!key || bySerial.has(key)) continue;
      bySerial.set(key, r);
      if (bySerial.size >= MAX_RESULTS) break;
    }
    results = [...bySerial.values()];
    render({ state: results.length ? "results" : "empty", q });
  }

  function render(ctx) {
    if (ctx.state === "loading") {
      dropdown.innerHTML = `<div class="bl-search-empty">Searching…</div>`;
      return;
    }
    if (ctx.state === "error") {
      dropdown.innerHTML = `<div class="bl-search-empty">Search failed: ${esc(ctx.msg)}</div>`;
      return;
    }
    if (ctx.state === "empty") {
      dropdown.innerHTML = `<div class="bl-search-empty">No records match <b>${esc(ctx.q)}</b>.</div>`;
      return;
    }
    dropdown.innerHTML = results.map((r, i) => {
      const vd = r.vin_data || {};
      const vehicle = [vd.year, vd.make, vd.model].filter(Boolean).join(" ") || "—";
      const status = label(r.status) || r.status || "";
      const when = r.ts ? fmt.timeAgo(r.ts) : "";
      return `
        <button type="button" class="bl-search-result${i === activeIdx ? " is-active" : ""}" role="option" data-serial="${esc(r.serial_id || "")}">
          <span class="bl-search-serial">${esc(r.serial_id || "—")}</span>
          <span class="bl-search-vehicle">${esc(vehicle)}</span>
          <span class="bl-search-status">${esc(status)}</span>
          <span class="bl-search-when">${esc(when)}</span>
        </button>`;
    }).join("");
    [...dropdown.querySelectorAll(".bl-search-result")].forEach((btn) => {
      btn.addEventListener("click", () => select(btn.dataset.serial));
    });
  }

  function show() { dropdown.hidden = false; }
  function hide() { dropdown.hidden = true; activeIdx = -1; }
  function clear() { input.value = ""; hide(); }

  function select(serial) {
    if (!serial) return;
    hide();
    input.blur();
    if (window.BL_RECORDS && BL_RECORDS.openVinHistory) {
      BL_RECORDS.openVinHistory(serial);
    }
  }

  function highlight() {
    [...dropdown.querySelectorAll(".bl-search-result")].forEach((btn, i) => {
      btn.classList.toggle("is-active", i === activeIdx);
    });
    const active = dropdown.querySelector(".bl-search-result.is-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function onKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!results.length) return;
      activeIdx = Math.min(results.length - 1, activeIdx + 1);
      highlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(-1, activeIdx - 1);
      highlight();
    } else if (e.key === "Enter") {
      if (activeIdx >= 0 && results[activeIdx]) {
        e.preventDefault();
        select(results[activeIdx].serial_id);
      }
    } else if (e.key === "Escape") {
      clear();
    }
  }

  function onDocClick(e) {
    if (dropdown.hidden) return;
    if (e.target.closest("#blGlobalSearch")) return;
    if (e.target.closest("#blGlobalSearchDropdown")) return;
    hide();
  }

  // ⌘K / Ctrl+K focuses the search. Keyboard nicety for desktop; tablet
  // users just tap the input.
  function onGlobalKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (input) { input.focus(); input.select(); }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
