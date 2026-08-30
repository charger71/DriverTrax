// ============================================================
// Backlot — Records browser
//   Mounts into #section-records. Server-side paginated + sorted
//   list of records with filters (VIN/serial search, status, driver,
//   date range), a detail modal with prev/next navigation, delete,
//   and entry points into the create/edit form (record-form.js).
//
//   Data path: Supabase .range() + count:"exact" per page. Sort and
//   filters are applied server-side. Realtime on `records` refetches
//   the current page.
//
//   UX add-ons:
//     • Column sort (BL_SORT) — persisted
//     • CSV export of the whole filter (batched, capped at CSV_CAP)
//     • Filter presets in localStorage
//     • Column show/hide in a menu, persisted
//     • Prev/Next in the detail modal across the current page
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
  const condLabel = (id) => (window.BL_CONDITION_LABEL ? BL_CONDITION_LABEL(id) : id);

  const REC_COLS = "id,user_id,serial_id,status,status_other,destination,destination_other,section_id,section_name,conditions,no_tag,shuttle,transport,notes,lat,lng,mileage,fuel_level,tires,tire_details,damage_marks,claim_number,claim_notes,vin_data,ts,photo_urls,photo_url";

  // Location label used in the table + detail + timeline. Prefers the
  // GPS-tagged parking section (from parking_sections auto-tag or the
  // driver's "Where is this?" fallback) and falls back to the destination
  // dropdown so pre-parking-sections records still render.
  function locationOf(r, fallbackDash) {
    if (r.section_name) return r.section_name;
    if (r.destination === "OTHER") return r.destination_other || "Other";
    return r.destination || (fallbackDash ? "—" : "");
  }
  const CSV_CAP = 5000; // hard cap on CSV export size
  const CSV_BATCH = 1000;

  const LS_PRESETS = "bl-records-presets";
  const LS_COLS    = "bl-records-cols";
  const LS_SORT    = "bl-records-sort";

  const COLUMNS = [
    { key: "serial_id",   label: "VIN / Serial",  defaultOn: true,  toggleable: false },
    { key: "status",      label: "Status",        defaultOn: true,  toggleable: true },
    { key: "destination", label: "Destination",   defaultOn: true,  toggleable: true },
    { key: "driver",      label: "Driver",        defaultOn: true,  toggleable: true },
    { key: "ts",          label: "When",          defaultOn: true,  toggleable: true },
    { key: "actions",     label: "Actions",       defaultOn: true,  toggleable: false },
  ];
  const SORT_COL_MAP = { serial_id: "serial_id", status: "status", ts: "ts" };

  const profilesMap = {}; // id → display_name
  let realtimeChan = null, started = false;
  let currentPage = []; // in-memory rows for the current page
  let currentIdx = -1;  // index in currentPage of the open detail record
  let pager = null;
  let sortCtl = null;
  let filterSeq = 0; // guards against out-of-order refetches on rapid typing

  // ---------- filter population ----------
  function populateStatusFilter() {
    const sel = $("blRecStatus");
    if (!sel || sel.dataset.filled) return;
    const o = window.BL_OPTIONS;
    if (!o) return;
    const all = [...o.STATUS_BASE, ...o.STATUS_PRIVILEGED, ...o.STATUS_DERIVED];
    sel.insertAdjacentHTML("beforeend", all.map((s) => `<option value="${esc(s)}">${esc(label(s))}</option>`).join(""));
    sel.dataset.filled = "1";
  }

  async function loadProfiles() {
    const { data } = await sb.from("profiles").select("id,display_name,role").order("display_name", { ascending: true, nullsFirst: false });
    (data || []).forEach((p) => { profilesMap[p.id] = p.display_name || "(no name)"; });
    const sel = $("blRecDriver");
    if (sel && !sel.dataset.filled) {
      sel.insertAdjacentHTML("beforeend", (data || []).map((p) => `<option value="${p.id}">${esc(p.display_name || "(no name)")}</option>`).join(""));
      sel.dataset.filled = "1";
    }
  }
  const driverName = (id) => profilesMap[id] || "—";

  // ---------- filter state ----------
  function readFilters() {
    return {
      search:  ($("blRecSearch")?.value || "").trim(),
      status:  $("blRecStatus")?.value || "",
      driver:  $("blRecDriver")?.value || "",
      section: $("blRecSection")?.value || "",
      from:    $("blRecFrom")?.value || "",
      to:      $("blRecTo")?.value || "",
    };
  }
  function writeFilters(f) {
    if ($("blRecSearch"))  $("blRecSearch").value  = f.search  || "";
    if ($("blRecStatus"))  $("blRecStatus").value  = f.status  || "";
    if ($("blRecDriver"))  $("blRecDriver").value  = f.driver  || "";
    if ($("blRecSection")) $("blRecSection").value = f.section || "";
    if ($("blRecFrom"))    $("blRecFrom").value    = f.from    || "";
    if ($("blRecTo"))      $("blRecTo").value      = f.to      || "";
  }
  function applyFiltersToQuery(q, f) {
    if (f.status)  q = q.eq("status", f.status);
    if (f.driver)  q = q.eq("user_id", f.driver);
    if (f.section) q = q.eq("section_id", f.section);
    if (f.from)    q = q.gte("ts", new Date(f.from + "T00:00:00").toISOString());
    if (f.to)      q = q.lte("ts", new Date(f.to + "T23:59:59.999").toISOString());
    if (f.search)  q = q.ilike("serial_id", `%${f.search}%`);
    return q;
  }

  // Populate the Section filter dropdown from parking_sections.
  async function populateSectionFilter() {
    const sel = $("blRecSection");
    if (!sel || sel.dataset.filled) return;
    const { data, error } = await sb.from("parking_sections").select("id,name").order("name");
    if (error) { console.warn("[Backlot] parking_sections", error); return; }
    sel.insertAdjacentHTML("beforeend",
      (data || []).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")
    );
    sel.dataset.filled = "1";
  }

  // ---------- server-side load ----------
  async function loadPage(page, pageSize) {
    const body = $("blRecBody");
    if (!body) return;
    const p = page || pager?.getPage() || 1;
    const ps = pageSize || pager?.getPageSize() || BL_PAGINATE.DEFAULT_SIZE;
    const from = (p - 1) * ps;
    const to = from + ps - 1;
    const seq = ++filterSeq;
    body.innerHTML = `<tr><td colspan="6"><div class="bl-empty">Loading…</div></td></tr>`;

    const filters = readFilters();
    const sort = sortCtl ? sortCtl.current() : null;
    const sortCol = sort && SORT_COL_MAP[sort.key] ? SORT_COL_MAP[sort.key] : "ts";
    const sortAsc = sort ? sort.dir === "asc" : false;

    let q = sb.from("records").select(REC_COLS, { count: "exact" })
      .order(sortCol, { ascending: sortAsc, nullsFirst: false })
      .range(from, to);
    q = applyFiltersToQuery(q, filters);

    const { data, error, count } = await q;
    if (seq !== filterSeq) return; // a newer request superseded this one

    if (error) {
      body.innerHTML = `<tr><td colspan="6"><div class="bl-empty">${esc("Query error: " + error.message)}</div></td></tr>`;
      hidePager();
      updateCount(null);
      return;
    }
    currentPage = data || [];
    const total = count == null ? currentPage.length : count;
    updateCount(total);

    if (!total) {
      body.innerHTML = `<tr><td colspan="6"><div class="bl-empty">No records match these filters.</div></td></tr>`;
      hidePager();
      return;
    }
    ensurePager();
    pager.setPage({ items: currentPage, total, page: p });
  }

  function updateCount(total) {
    const el = $("blRecCount");
    if (!el) return;
    if (total == null) el.textContent = "";
    else el.textContent = `${total.toLocaleString()} record${total === 1 ? "" : "s"}`;
  }

  // Draws one page of records into the table body.
  function renderRows(rows) {
    const body = $("blRecBody");
    if (!body) return;
    body.innerHTML = rows.map((r) => {
      const vd = r.vin_data || {};
      const sub = [vd.year, vd.make, vd.model].filter(Boolean).join(" ");
      const dest = locationOf(r, true);
      return `<tr>
        <td data-col="serial_id"><button class="bl-rowbtn" data-vin-history="${esc(r.serial_id || "")}"><span class="bl-rec-vin">${esc(r.serial_id || "—")}${sub ? `<small>${esc(sub)}</small>` : ""}</span></button></td>
        <td data-col="status">${esc(label(r.status) || r.status || "—")}</td>
        <td data-col="destination">${esc(dest)}</td>
        <td data-col="driver">${esc(driverName(r.user_id))}</td>
        <td data-col="ts">${esc(fmt.timeAgoOrClock(r.ts))}</td>
        <td data-col="actions"><button class="bl-btn bl-btn--icon bl-btn--ghost bl-btn--sm" data-edit="${r.id}" aria-label="Edit record"><svg class="bl-icon bl-icon--sm" aria-hidden="true"><use href="#icon-edit"/></svg></button></td>
      </tr>`;
    }).join("");
  }

  function ensurePager() {
    if (pager) return;
    pager = BL_PAGINATE.create({
      mount: $("blRecPager"),
      mode: "server",
      render: renderRows,
      onPageChange: (page, pageSize) => loadPage(page, pageSize),
    });
  }
  function hidePager() { const m = $("blRecPager"); if (m) { m.hidden = true; m.innerHTML = ""; } }

  const findRec = (id) => currentPage.find((r) => r.id === id);

  // ---------- CSV export ----------
  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  async function exportCsv() {
    const btn = $("blRecExport");
    if (btn) { btn.disabled = true; btn.dataset.origText = btn.textContent; btn.textContent = "Exporting…"; }
    try {
      const filters = readFilters();
      const sort = sortCtl ? sortCtl.current() : null;
      const sortCol = sort && SORT_COL_MAP[sort.key] ? SORT_COL_MAP[sort.key] : "ts";
      const sortAsc = sort ? sort.dir === "asc" : false;
      const rows = [];
      for (let offset = 0; offset < CSV_CAP; offset += CSV_BATCH) {
        let q = sb.from("records").select(REC_COLS)
          .order(sortCol, { ascending: sortAsc, nullsFirst: false })
          .range(offset, offset + CSV_BATCH - 1);
        q = applyFiltersToQuery(q, filters);
        const { data, error } = await q;
        if (error) { BL_TOAST.error("Export failed: " + error.message); return; }
        rows.push(...(data || []));
        if (!data || data.length < CSV_BATCH) break;
      }
      if (!rows.length) { BL_TOAST.warn("No records to export."); return; }
      const cap = rows.length >= CSV_CAP;
      const header = ["Serial","Year","Make","Model","Status","Destination","Section","Driver","Logged","Fuel","Mileage","Notes"];
      const lines = [header.map(csvCell).join(",")];
      rows.forEach((r) => {
        const vd = r.vin_data || {};
        const dest = r.destination === "OTHER" ? (r.destination_other || "Other") : (r.destination || "");
        const section = r.section_name || "";
        const stat = r.status === "OTHER" ? (r.status_other || "OTHER") : (label(r.status) || r.status || "");
        lines.push([
          r.serial_id || "", vd.year || "", vd.make || "", vd.model || "",
          stat, dest, section, driverName(r.user_id), r.ts || "",
          r.fuel_level || "", r.mileage != null ? r.mileage : "",
          (r.notes || "").replace(/\r?\n/g, " "),
        ].map(csvCell).join(","));
      });
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `backlot-records-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      BL_TOAST.success(cap ? `Exported ${rows.length.toLocaleString()} rows (capped at ${CSV_CAP.toLocaleString()}).` : `Exported ${rows.length.toLocaleString()} rows.`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || "Export CSV"; }
    }
  }

  // ---------- filter presets ----------
  function readPresets() {
    try { return JSON.parse(localStorage.getItem(LS_PRESETS) || "[]"); } catch (_) { return []; }
  }
  function writePresets(list) {
    try { localStorage.setItem(LS_PRESETS, JSON.stringify(list)); } catch (_) { /* ignore */ }
  }
  function renderPresetChips() {
    const wrap = $("blRecPresetChips");
    if (!wrap) return;
    const list = readPresets();
    if (!list.length) { wrap.innerHTML = `<span class="bl-preset-empty">None saved</span>`; return; }
    wrap.innerHTML = list.map((p, i) =>
      `<span class="bl-preset-chip" data-preset-idx="${i}" title="Apply preset">
         <button type="button" class="bl-preset-apply" data-preset-apply="${i}">${esc(p.name)}</button>
         <button type="button" class="bl-preset-del" data-preset-del="${i}" aria-label="Delete preset">×</button>
       </span>`).join("");
  }
  function savePresetPrompt() {
    const name = (prompt("Name this preset:") || "").trim();
    if (!name) return;
    const list = readPresets();
    const filters = readFilters();
    const existing = list.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) list[existing] = { name, filters }; else list.push({ name, filters });
    writePresets(list);
    renderPresetChips();
    BL_TOAST.success(`Preset "${name}" saved.`);
  }
  function applyPreset(idx) {
    const p = readPresets()[idx];
    if (!p) return;
    writeFilters(p.filters || {});
    reload();
  }
  function deletePreset(idx) {
    const list = readPresets();
    const p = list[idx];
    if (!p) return;
    if (!confirm(`Delete preset "${p.name}"?`)) return;
    list.splice(idx, 1);
    writePresets(list);
    renderPresetChips();
  }
  function onPresetClick(e) {
    const applyBtn = e.target.closest("[data-preset-apply]");
    if (applyBtn) { applyPreset(parseInt(applyBtn.dataset.presetApply, 10)); return; }
    const delBtn = e.target.closest("[data-preset-del]");
    if (delBtn) { deletePreset(parseInt(delBtn.dataset.presetDel, 10)); }
  }

  // ---------- column show/hide ----------
  function readCols() {
    const defaults = {};
    COLUMNS.forEach((c) => { defaults[c.key] = c.defaultOn; });
    try {
      const saved = JSON.parse(localStorage.getItem(LS_COLS) || "{}");
      return { ...defaults, ...saved };
    } catch (_) { return defaults; }
  }
  function writeCols(state) {
    try { localStorage.setItem(LS_COLS, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }
  let colState = readCols();
  function applyColState() {
    const table = $("blRecTable");
    if (!table) return;
    COLUMNS.forEach((c) => {
      if (!c.toggleable) return;
      const on = colState[c.key] !== false;
      table.querySelectorAll(`[data-col="${c.key}"]`).forEach((el) => { el.hidden = !on; });
    });
  }
  function renderColsMenu() {
    const menu = $("blRecColumnsMenu");
    if (!menu) return;
    menu.innerHTML = COLUMNS.filter((c) => c.toggleable).map((c) =>
      `<label class="bl-menu-item"><input type="checkbox" data-col-toggle="${c.key}"${colState[c.key] !== false ? " checked" : ""}> <span>${esc(c.label)}</span></label>`
    ).join("");
  }
  function toggleColsMenu(force) {
    const btn = $("blRecColumnsBtn");
    const menu = $("blRecColumnsMenu");
    if (!menu || !btn) return;
    const open = typeof force === "boolean" ? force : menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  }
  function onColsMenuChange(e) {
    const cb = e.target.closest("[data-col-toggle]");
    if (!cb) return;
    colState[cb.dataset.colToggle] = cb.checked;
    writeCols(colState);
    applyColState();
  }
  function onDocClickForCols(e) {
    if (e.target.closest("#blRecColumnsMenu") || e.target.closest("#blRecColumnsBtn")) return;
    toggleColsMenu(false);
  }

  // ---------- detail modal ----------
  // Status categories mirror dashboard.js — the header + status pill recolor
  // off the same buckets so status reads consistently across the app.
  const READY_SET   = new Set(["CLEAN", "DETAILED"]);
  const DIRTY_SET   = new Set(["DIRTY", "REWASH", "DETAILING", "GLASS"]);
  const SERVICE_SET = new Set(["PM", "MK", "MR", "OM", "BODY", "TI", "HOLD", "DNR", "AUDIT FAIL", "WI/DELETE"]);
  function statusCategory(status) {
    const s = (status || "").toUpperCase();
    if (READY_SET.has(s))   return "clean";
    if (DIRTY_SET.has(s))   return "dirty";
    if (SERVICE_SET.has(s)) return "service";
    return "shut";
  }
  // FUEL_LEVELS = ["EMPTY","1/4","1/2","3/4","FULL"] → 0/25/50/75/100 %.
  // `is-low` at ≤25, `is-mid` at 26–50, default green above.
  function fuelInfo(level) {
    const L = (level || "").toUpperCase();
    const map = { "EMPTY": 0, "1/4": 25, "1/2": 50, "3/4": 75, "FULL": 100 };
    if (!(L in map)) return null;
    const pct = map[L];
    const kind = pct <= 25 ? "is-low" : (pct <= 50 ? "is-mid" : "");
    return { pct, kind, label: level };
  }

  // ---------- damage + tire catalogs (read-only, ported from the driver
  // app's damage.js). We reproduce them here so backlot stays self-contained
  // per the STYLE_GUIDE isolation rule. Keep in sync if the driver-app
  // catalog grows a panel or tire condition. ------------------------------
  const DAMAGE_LABELS = { dent: "Dent", scratch: "Scratch", chip: "Chip", crack: "Crack", missing: "Missing" };
  const DAMAGE_TYPES = new Set(Object.keys(DAMAGE_LABELS));
  const TIRE_POSITIONS = ["FL", "FR", "RL", "RR"];
  const TIRE_POS_LABEL = { FL: "Front left", FR: "Front right", RL: "Rear left", RR: "Rear right" };
  const TIRE_CONDITION_LABEL = { OK: "OK", worn: "Worn", low: "Low PSI", flat: "Flat", replace: "Replace" };
  const PANEL_NAMES = {
    FRONT_BUMPERS: "Front bumper", FRONT_GRILL: "Front grille", FRONT_PANEL: "Front fascia",
    FRONT_NUMBER_PLATE: "Front license plate", FRONT_NEAR_SIDE_HEADLAMP: "Driver headlight",
    FRONT_OFF_SIDE_HEADLAMP: "Passenger headlight", FRONT_NEAR_SIDE_FOG_LIGHT: "Driver fog light",
    FRONT_OFF_SIDE_FOG_LIGHT: "Passenger fog light", FRONT_BONNET: "Hood", FRONT_WINDSCREEN: "Windshield",
    REAR_BUMPER: "Rear bumper", REAR_PANEL: "Rear fascia", REAR_NUMBER_PLATE: "Rear license plate",
    NEAR_SIDE_REAR_HEADLAMP: "Driver taillight", OFF_SIDE_REAR_HEADLAMP: "Passenger taillight",
    FRONT_REAR_WINDOW: "Rear windshield", FRONT_ROOF_PANEL: "Roof",
    NEAR_SIDE_DRIVER_DOOR: "Driver front door", NEAR_SIDE_PASSENGER_DOOR: "Driver rear door",
    NEAR_SIDE_DRIVER_WINDOW: "Driver front window", NEAR_SIDE_PASSENGER_WINDOW: "Driver rear window",
    NEAR_SIDE_SIDE_WINDOW: "Driver quarter window", NEAR_SIDE_FRONT_PANEL: "Driver front fender",
    NEAR_SIDE_FENDERS: "Driver rear quarter", NEAR_SIDE_REAR_BUMPER: "Driver rear bumper corner",
    NEAR_SIDE_WING_MIRROR: "Driver side mirror", NEAR_SIDE_DRIVER_HANDLE: "Driver front door handle",
    NEAR_SIDE_PASSENGER_HANDLE: "Driver rear door handle", NEAR_SIDE_FRONT_WHEEL: "Driver front wheel",
    NEAR_SIDE_REAR_WHEEL: "Driver rear wheel", NEAR_SIDE_FRONT_TYPE: "Driver front tire",
    NEAR_SIDE_REAR_TYPE: "Driver rear tire", NEAR_SIDE_FUEL_CAP: "Fuel cap",
    OFF_SIDE_DRIVER_DOOR: "Passenger front door", OFF_SIDE_PASSENGER_DOOR: "Passenger rear door",
    OFF_SIDE_DRIVER_WINDOW: "Passenger front window", OFF_SIDE_PASSENGER_WINDOW: "Passenger rear window",
    OFF_SIDE_SIDE_WINDOW: "Passenger quarter window", OFF_SIDE_FRONT_PANEL: "Passenger front fender",
    OFF_SIDE_FENDERS: "Passenger rear quarter", OFF_SIDE_REAR_BUMPER: "Passenger rear bumper corner",
    OFF_SIDE_WING_MIRROR: "Passenger side mirror", OFF_SIDE_DRIVER_HANDLE: "Passenger front door handle",
    OFF_SIDE_PASSENGER_HANDLE: "Passenger rear door handle", OFF_SIDE_FRONT_WHEEL: "Passenger front wheel",
    OFF_SIDE_REAR_WHEEL: "Passenger rear wheel", OFF_SIDE_FRONT_TYPE: "Passenger front tire",
    OFF_SIDE_REAR_TYPE: "Passenger rear tire", BODY_TRIM: "Body trim"
  };

  // Return HTML for the body-damage panel (log rows + optional claim block),
  // or an empty string when the record has no damage marks and no claim.
  function renderDamagePanel(r) {
    const marks = Array.isArray(r.damage_marks) ? r.damage_marks : [];
    const claimNum   = r.claim_number || "";
    const claimNotes = r.claim_notes  || "";
    if (!marks.length && !claimNum) return "";

    const rows = marks.map((m, i) => {
      const type = DAMAGE_TYPES.has(m.damage_type) ? m.damage_type : "missing";
      const typeLabel = DAMAGE_LABELS[type] || type;
      const location  = PANEL_NAMES[m.panel_id] || m.panel_id || "—";
      return `
        <div class="bl-vin-damage-row">
          <span class="bl-vin-damage-num bl-vin-damage-num--${esc(type)}">${i + 1}</span>
          <span class="bl-vin-damage-name">
            <span class="bl-vin-damage-type">${esc(typeLabel)}</span>
            <span class="bl-vin-damage-loc"> · ${esc(location)}</span>
          </span>
        </div>`;
    }).join("");

    const claimBlock = claimNum
      ? `<dl class="bl-vin-damage-claim">
           <dt>Claim #</dt><dd>${esc(claimNum)}</dd>
           ${claimNotes ? `<dt>Notes</dt><dd>${esc(claimNotes)}</dd>` : ""}
         </dl>`
      : "";

    const countText = marks.length
      ? `${marks.length} mark${marks.length === 1 ? "" : "s"}`
      : "Claim on file";
    // The SVG mounts into `.bl-vin-damage-svg-wrap` after innerHTML runs
    // (mountDamageSvg is called by the caller). Only include it when there
    // are marks worth painting; a claim-only record skips the diagram.
    const svgSlot = marks.length ? `<div class="bl-vin-damage-svg-wrap" data-damage-slot="1"></div>` : "";
    const layout = marks.length
      ? `<div class="bl-vin-damage-layout">
           <div class="bl-vin-damage-list">${rows}</div>
           ${svgSlot}
         </div>`
      : "";
    return `
      <div class="bl-vin-section-label">Body damage · ${countText}</div>
      <div class="bl-vin-damage">
        ${layout}
        ${claimBlock}
      </div>`;
  }

  // Clone the inert car-silhouette template and rewrite its IDs to
  // data-panel attrs so the clone can be inserted into the live document
  // without leaking those IDs. Returns null if the template isn't present.
  function cloneCarSilhouette() {
    const tpl = document.getElementById("blCarSilhouette");
    if (!tpl || !tpl.content) return null;
    const source = tpl.content.querySelector("svg");
    if (!source) return null;
    const clone = source.cloneNode(true);
    clone.querySelectorAll("[id]").forEach((el) => {
      const id = el.id;
      el.removeAttribute("id");
      if (PANEL_NAMES[id]) el.setAttribute("data-panel", id);
    });
    clone.classList.add("bl-vin-damage-svg");
    return clone;
  }

  // Paint the numbered mark dots onto a cloned silhouette + tint the
  // affected panels. Mounts the whole SVG into every empty slot inside
  // `root` (there's usually exactly one — the damage panel).
  const SVG_NS = "http://www.w3.org/2000/svg";
  function mountDamageSvg(root, marks) {
    if (!root) return;
    const slots = root.querySelectorAll('[data-damage-slot="1"]');
    if (!slots.length || !marks.length) return;
    slots.forEach((slot) => {
      const svg = cloneCarSilhouette();
      if (!svg) return;
      const marksGroup = svg.querySelector(".bl-vin-damage-marks");
      marks.forEach((m, i) => {
        const type = DAMAGE_TYPES.has(m.damage_type) ? m.damage_type : "missing";
        const panel = svg.querySelector(`[data-panel="${m.panel_id}"]`);
        if (panel) panel.classList.add("has-damage");
        const g = document.createElementNS(SVG_NS, "g");
        const halo = document.createElementNS(SVG_NS, "circle");
        halo.setAttribute("cx", m.x); halo.setAttribute("cy", m.y);
        halo.setAttribute("r", 9);
        halo.setAttribute("class", `bl-dmg-halo bl-dmg-halo--${type}`);
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", m.x); dot.setAttribute("cy", m.y);
        dot.setAttribute("r", 6);
        dot.setAttribute("class", `bl-dmg-dot bl-dmg-dot--${type}`);
        const text = document.createElementNS(SVG_NS, "text");
        text.setAttribute("x", m.x); text.setAttribute("y", m.y + 2.5);
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("class", "bl-dmg-num");
        text.textContent = i + 1;
        g.appendChild(halo); g.appendChild(dot); g.appendChild(text);
        (marksGroup || svg).appendChild(g);
      });
      slot.appendChild(svg);
    });
  }

  // Return HTML for the tire-condition panel, or an empty string when the
  // record has no tire_details and no legacy tires[] flags.
  function renderTirePanel(r) {
    const details = (r.tire_details && typeof r.tire_details === "object") ? r.tire_details : null;
    const legacy  = Array.isArray(r.tires) ? r.tires : [];
    const hasAny  = (details && Object.keys(details).length) || legacy.length;
    if (!hasAny) return "";

    let flagged = 0;
    const cards = TIRE_POSITIONS.map((pos) => {
      const t = (details && details[pos]) || {};
      const cond = t.condition || (legacy.includes(pos) ? "flat" : "OK");
      if (cond !== "OK") flagged++;
      const condLabel = TIRE_CONDITION_LABEL[cond] || cond;
      const psi = (t.psi != null && t.psi !== "") ? t.psi : null;
      return `
        <div class="bl-vin-tire">
          <div class="bl-vin-tire-head">
            <span class="bl-vin-tire-pos">${esc(pos)}</span>
            <span class="bl-vin-tire-cond bl-vin-tire-cond--${esc(cond)}">${esc(condLabel)}</span>
          </div>
          <span class="bl-vin-tire-pos-label">${esc(TIRE_POS_LABEL[pos] || pos)}</span>
          ${psi != null ? `<span class="bl-vin-tire-psi">PSI: <b>${esc(String(psi))}</b></span>` : ""}
        </div>`;
    }).join("");
    const countText = flagged ? `${flagged} flagged` : "All OK";
    return `
      <div class="bl-vin-section-label">Tires · ${countText}</div>
      <div class="bl-vin-tires">
        <div class="bl-vin-tires-grid">${cards}</div>
      </div>`;
  }

  // ---------- vehicle-history timeline: expanded body -----------------
  // Renders the details revealed when a timeline row is opened. Kept lean:
  // VIN, vehicle, and latest status live in the header — no need to repeat
  // them per record. Focus on what this specific event actually changed.
  function renderTimelineExpanded(r) {
    const fields = [];
    const push = (k, v) => { if (v != null && v !== "") fields.push([k, v]); };
    // Full timestamp is already in the summary; drop from fields.
    push("Shift", r.shift_num);
    if (r.status === "OTHER") push("Status detail", r.status_other);
    const conds = (r.conditions || []).map(condLabel).filter(Boolean).join(", ");
    if (conds) push("Conditions", conds);
    if (r.lat != null && r.lng != null) push("Coordinates", `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`);
    const fieldsHtml = fields.length
      ? `<dl class="bl-vin-tl-fields">
           ${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("")}
         </dl>`
      : "";

    // Flag chips: only render if the flag applies. Damage/tire chips summarize
    // this record's contribution — the full lists live in the aggregate panels
    // above the timeline.
    const flags = [];
    if (r.shuttle)   flags.push(`<span class="bl-vin-flag bl-vin-flag--info">Shuttle</span>`);
    if (r.transport) flags.push(`<span class="bl-vin-flag bl-vin-flag--info">Transport</span>`);
    if (r.no_tag)    flags.push(`<span class="bl-vin-flag bl-vin-flag--warn">Bad tag</span>`);
    const photoCount = (Array.isArray(r.photo_urls) && r.photo_urls.length)
      || (r.photo_url ? 1 : 0);
    if (photoCount) flags.push(`<span class="bl-vin-flag">Photos · ${photoCount}</span>`);
    const dmgCount = Array.isArray(r.damage_marks) ? r.damage_marks.length : 0;
    if (dmgCount) flags.push(`<span class="bl-vin-flag bl-vin-flag--warn">Damage · ${dmgCount} mark${dmgCount === 1 ? "" : "s"}</span>`);
    const tireDetails = (r.tire_details && typeof r.tire_details === "object") ? r.tire_details : null;
    const legacyTires = Array.isArray(r.tires) ? r.tires : [];
    let tireFlagged = 0;
    if (tireDetails) {
      for (const pos of TIRE_POSITIONS) {
        const t = tireDetails[pos];
        if (t && t.condition && t.condition !== "OK") tireFlagged++;
      }
    } else if (legacyTires.length) {
      tireFlagged = legacyTires.length;
    }
    if (tireFlagged) flags.push(`<span class="bl-vin-flag bl-vin-flag--warn">Tires · ${tireFlagged} flagged</span>`);
    const flagsHtml = flags.length ? `<div class="bl-vin-tl-flags">${flags.join("")}</div>` : "";

    const notesHtml = r.notes
      ? `<div class="bl-vin-tl-notes-block">${esc(r.notes)}</div>`
      : "";

    // "Open full record" drops into the existing detail modal so the manager
    // can still edit / delete / walk prev-next when needed.
    const openBtn = `<button type="button" class="bl-btn bl-btn--sm bl-btn--secondary" data-open-detail="${esc(r.id)}"><svg class="bl-icon bl-icon--sm" aria-hidden="true"><use href="#icon-clipboard"/></svg>Open full record</button>`;

    return `
      <div class="bl-vin-tl-expanded">
        ${fieldsHtml}
        ${flagsHtml}
        ${notesHtml}
        <div class="bl-vin-tl-actions">${openBtn}</div>
      </div>`;
  }

  let _detailMap = null;

  async function openDetail(id) {
    let r = findRec(id);
    if (r) {
      currentIdx = currentPage.findIndex((x) => x.id === id);
    } else {
      // Not in the current page cache — the global topbar search may have
      // jumped straight to this record. Fetch the full row + its driver name
      // so the detail renders every field. Prev/Next stays disabled because
      // there's no page context to walk.
      const { data, error } = await sb.from("records").select(REC_COLS).eq("id", id).maybeSingle();
      if (BL_ERR.isMissing(error, data)) { BL_TOAST.missing("record"); return; }
      if (error) { BL_TOAST.error("Load failed: " + error.message); return; }
      r = data;
      currentIdx = -1;
      if (r.user_id && !profilesMap[r.user_id]) {
        const { data: prof } = await sb.from("profiles").select("id,display_name").eq("id", r.user_id).maybeSingle();
        if (prof) profilesMap[prof.id] = prof.display_name || "(no name)";
      }
    }
    renderDetail(r);
    $("blRecDetail").classList.add("is-open");
  }

  function renderDetail(r) {
    // Any prior map instance dies with the previous render — Leaflet doesn't
    // like sharing a container across .setView calls once it's been remove()d.
    if (_detailMap) { try { _detailMap.remove(); } catch (e) {} _detailMap = null; }

    $("blRecDetailTitle").textContent = r.serial_id || "Record";

    const vd = r.vin_data || {};
    const cat = statusCategory(r.status);
    const statusText  = label(r.status) || r.status || "—";
    const statusPillMod = cat === "clean" ? "" : ` bl-vin-status-pill--${cat}`;

    // Vehicle: bold Year Make Model + trim, specs on second line.
    const nameLine = [vd.year, vd.make, vd.model].filter(Boolean).map(esc).join(" ");
    const trimLine = vd.trim ? " · " + esc(vd.trim) : "";
    const specs    = [vd.bodyClass, vd.engine, vd.fuelType].filter(Boolean).map(esc).join(" · ");
    const vehicleBlock = nameLine
      ? `<div class="bl-vin-vehicle"><b>${nameLine}</b>${trimLine}${specs ? `<span class="specs">${specs}</span>` : ""}</div>`
      : "";

    // Utility flags share the pill row.
    const flags = [];
    if (r.shuttle)   flags.push(`<span class="bl-vin-flag bl-vin-flag--info">Shuttle</span>`);
    if (r.transport) flags.push(`<span class="bl-vin-flag bl-vin-flag--info">Transport</span>`);
    if (r.no_tag)    flags.push(`<span class="bl-vin-flag bl-vin-flag--warn">Bad tag</span>`);
    if (r.lat == null || r.lng == null) flags.push(`<span class="bl-vin-flag">No GPS</span>`);

    const conds = (r.conditions || []).map((c) => `<span class="bl-vin-cond-chip">${esc(condLabel(c))}</span>`).join("");
    const condsBlock = conds ? `<div class="bl-vin-cond-row">${conds}</div>` : "";

    // Meters row: mileage, fuel gauge, logged time.
    const fi = fuelInfo(r.fuel_level);
    const tsAgo  = r.ts ? fmt.timeAgo(r.ts) : "";
    const tsFull = r.ts
      ? new Date(r.ts).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: fmt.TZ })
      : "";
    const mileageVal = r.mileage != null
      ? `<span class="val">${esc(r.mileage.toLocaleString())}<span class="unit">mi</span></span>`
      : `<span class="val val--muted">—</span><span class="sub">Not recorded</span>`;
    const fuelMeter = fi
      ? `<div class="bl-vin-meter">
           <div class="bl-vin-fuel">
             <div class="bl-vin-fuel-head">
               <span class="bl-vin-fuel-label">Fuel</span>
               <span class="bl-vin-fuel-value">${esc(fi.label)}</span>
             </div>
             <div class="bl-vin-fuel-gauge ${fi.kind}">
               <div class="bl-vin-fuel-fill bl-vin-fuel-fill--${fi.pct}"></div>
               <div class="bl-vin-fuel-ticks"><span></span><span></span><span></span><span></span></div>
             </div>
             <div class="bl-vin-fuel-scale"><span>E</span><span>¼</span><span>½</span><span>¾</span><span>F</span></div>
           </div>
         </div>`
      : "";
    const loggedMeter = r.ts
      ? `<div class="bl-vin-meter">
           <span class="label">Logged</span>
           <span class="val val--text">${esc(tsAgo || "—")}</span>
           <span class="sub">${esc(tsFull)}</span>
         </div>`
      : "";
    const metersHtml = `
      <div class="bl-vin-meters">
        <div class="bl-vin-meter"><span class="label">Mileage</span>${mileageVal}</div>
        ${fuelMeter}
        ${loggedMeter}
      </div>`;

    // Facts (below header) — anything not surfaced above. Tires used to land
    // here as a comma-joined list of positions; the tire panel below now
    // surfaces the full condition + PSI grid, so drop the flat fact.
    const facts = [];
    const push = (k, v) => { if (v != null && v !== "") facts.push([k, v]); };
    push("Driver",       driverName(r.user_id));
    push("Destination",  r.destination === "OTHER" ? (r.destination_other || "Other") : r.destination);
    if (r.section_name) push("Section (GPS)", r.section_name);
    if (r.status === "OTHER") push("Status detail", r.status_other);
    if (r.lat != null && r.lng != null) push("Coordinates", `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`);
    const factsHtml = facts.length
      ? `<div class="bl-vin-section-label">Details</div>
         <div class="bl-vin-facts">
           ${facts.map(([k, v]) => `<div class="bl-vin-fact"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join("")}
         </div>`
      : "";

    const damageBlock = renderDamagePanel(r);
    const tireBlock   = renderTirePanel(r);

    const notesBlock = r.notes
      ? `<div class="bl-vin-section-label">Notes</div>
         <div class="bl-vin-notes">${esc(r.notes)}</div>`
      : "";

    const locBlock = (r.lat != null && r.lng != null)
      ? `<div class="bl-vin-section-label">Location</div>
         <div class="bl-vin-map" id="blRecDetailMap"></div>`
      : "";

    const hasPhotos = (Array.isArray(r.photo_urls) && r.photo_urls.length) || r.photo_url;
    const photosBlock = hasPhotos
      ? `<div class="bl-vin-section-label">Photos</div>
         <div class="bl-photo-strip" id="blRecDetailPhotos"></div>`
      : "";

    $("blRecDetailBody").innerHTML = `
      <div class="bl-vin-header">
        <div class="bl-vin-eyebrow-row">
          <span class="bl-vin-eyebrow">Record</span>
          ${tsAgo ? `<span class="bl-vin-seen">Last seen <b>${esc(tsAgo)}</b></span>` : ""}
        </div>
        <div class="bl-vin-vin">${esc(r.serial_id || "—")}</div>
        ${vehicleBlock}
        <div class="bl-vin-pill-row">
          <span class="bl-vin-status-pill${statusPillMod}">${esc(statusText)}</span>
          ${flags.join("")}
        </div>
        ${condsBlock}
        ${metersHtml}
      </div>
      ${factsHtml}
      ${damageBlock}
      ${tireBlock}
      ${notesBlock}
      ${locBlock}
      ${photosBlock}`;

    if (hasPhotos) renderDetailPhotos(r);
    if (r.lat != null && r.lng != null) renderDetailMap(r);
    mountDamageSvg($("blRecDetailBody"), Array.isArray(r.damage_marks) ? r.damage_marks : []);
    updateDetailNav();
  }

  function renderDetailMap(r) {
    const mount = $("blRecDetailMap");
    if (!mount || !window.L) return;
    // The modal is display:none until .is-open so the container has no size on
    // first paint; deferring a frame gives Leaflet real dimensions.
    setTimeout(() => {
      _detailMap = L.map(mount, { zoomControl: true, scrollWheelZoom: false, attributionControl: true })
        .setView([r.lat, r.lng], 17);
      BL_MAP.addCartoDarkTiles(_detailMap);
      const cat = statusCategory(r.status);
      const pinMod = cat === "clean" ? "" : ` bl-lot-pin--${cat === "shut" ? "other" : cat}`;
      const icon = L.divIcon({ className: "", html: `<div class="bl-lot-pin${pinMod}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
      L.marker([r.lat, r.lng], { icon }).addTo(_detailMap);
    }, 60);
  }

  function updateDetailNav() {
    const nav = $("blRecDetailNav");
    const prev = $("blRecDetailPrev");
    const next = $("blRecDetailNext");
    const total = currentPage.length;
    if (nav) nav.textContent = total > 1 && currentIdx >= 0 ? `${currentIdx + 1} / ${total}` : "";
    if (prev) prev.disabled = !(currentIdx > 0);
    if (next) next.disabled = !(currentIdx >= 0 && currentIdx < total - 1);
  }

  // ---------- vehicle-history full page (#section-vin) ----------
  const VIN_HISTORY_LIMIT = 100;

  async function openVinHistory(serial) {
    if (!serial) return;
    // Swap to the VIN page immediately with a "loading" body so the click
    // feels instant even before Supabase responds. BL_NAV.show handles the
    // section switch + records the previous section for the Back button.
    $("blVinPageTitle").textContent = serial;
    $("blVinPageSub").textContent = "Loading history…";
    $("blVinBody").innerHTML = `<div class="bl-empty">Loading history…</div>`;
    if (window.BL_NAV) BL_NAV.show("vin");

    const { data, error } = await sb.from("records")
      .select(REC_COLS)
      .eq("serial_id", serial)
      .order("ts", { ascending: false })
      .limit(VIN_HISTORY_LIMIT);
    if (error) {
      $("blVinBody").innerHTML = `<div class="bl-empty">Load failed: ${esc(error.message)}</div>`;
      return;
    }
    const rows = data || [];
    if (!rows.length) {
      $("blVinBody").innerHTML = `<div class="bl-empty">No records for <b>${esc(serial)}</b>.</div>`;
      return;
    }
    // Backfill any driver names we don't already have cached so the timeline
    // meta line renders M. Alvarez instead of a blank.
    const missing = [...new Set(rows.map((r) => r.user_id).filter((id) => id && !profilesMap[id]))];
    if (missing.length) {
      const { data: profs } = await sb.from("profiles").select("id,display_name").in("id", missing);
      (profs || []).forEach((p) => { profilesMap[p.id] = p.display_name || "(no name)"; });
    }
    renderVinHistory(serial, rows);
  }

  function renderVinHistory(serial, rows) {
    const latest = rows[0];
    const oldest = rows[rows.length - 1];
    const vd = latest.vin_data || {};
    const cat = statusCategory(latest.status);
    const statusText = label(latest.status) || latest.status || "—";
    const statusPillMod = cat === "clean" ? "" : ` bl-vin-status-pill--${cat}`;
    const tsAgo = latest.ts ? fmt.timeAgo(latest.ts) : "";

    const nameLine = [vd.year, vd.make, vd.model].filter(Boolean).map(esc).join(" ");
    const trimLine = vd.trim ? " · " + esc(vd.trim) : "";
    const specs    = [vd.bodyClass, vd.engine, vd.fuelType].filter(Boolean).map(esc).join(" · ");
    const vehicleBlock = nameLine
      ? `<div class="bl-vin-vehicle"><b>${nameLine}</b>${trimLine}${specs ? `<span class="specs">${specs}</span>` : ""}</div>`
      : "";

    // Summary meters at the top of the history: N records / first seen /
    // latest mileage / latest fuel. "Latest" for mileage + fuel means the
    // most recent record that actually recorded that field — not necessarily
    // the newest overall record — so a partial newest entry doesn't hide
    // the last known state.
    const firstSeen = oldest.ts ? new Date(oldest.ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: fmt.TZ }) : "—";
    const latestMileage = rows.find((r) => r.mileage != null)?.mileage;
    const latestFuel    = fuelInfo(rows.find((r) => r.fuel_level)?.fuel_level);
    const fuelMeterHtml = latestFuel
      ? `<div class="bl-vin-meter">
           <div class="bl-vin-fuel">
             <div class="bl-vin-fuel-head">
               <span class="bl-vin-fuel-label">Latest fuel</span>
               <span class="bl-vin-fuel-value">${esc(latestFuel.label)}</span>
             </div>
             <div class="bl-vin-fuel-gauge ${latestFuel.kind}">
               <div class="bl-vin-fuel-fill bl-vin-fuel-fill--${latestFuel.pct}"></div>
               <div class="bl-vin-fuel-ticks"><span></span><span></span><span></span><span></span></div>
             </div>
             <div class="bl-vin-fuel-scale"><span>E</span><span>¼</span><span>½</span><span>¾</span><span>F</span></div>
           </div>
         </div>`
      : `<div class="bl-vin-meter">
           <span class="label">Latest fuel</span>
           <span class="val val--muted">—</span>
         </div>`;
    const metersHtml = `
      <div class="bl-vin-meters">
        <div class="bl-vin-meter">
          <span class="label">Records</span>
          <span class="val">${rows.length}${rows.length >= VIN_HISTORY_LIMIT ? "+" : ""}</span>
        </div>
        <div class="bl-vin-meter">
          <span class="label">First seen</span>
          <span class="val val--text">${esc(firstSeen)}</span>
        </div>
        <div class="bl-vin-meter">
          <span class="label">Latest mileage</span>
          ${latestMileage != null
            ? `<span class="val">${esc(latestMileage.toLocaleString())}<span class="unit">mi</span></span>`
            : `<span class="val val--muted">—</span>`}
        </div>
        ${fuelMeterHtml}
      </div>`;

    // Aggregate damage + tires across every record so the header shows
    // whether the vehicle has damage / tire issues on file at a glance.
    // Damage marks: union across all records, deduped by (panel_id, damage_type)
    //   — first occurrence wins, which given ts DESC ordering is the newest
    //   x/y for that damage. Repeated logging of the same damage doesn't
    //   inflate the count.
    // Claim: most recent record with a claim number wins.
    // Tires: most recent record with any tire data wins (full snapshot).
    const dmgSeen = new Map();
    for (const rec of rows) {
      const list = Array.isArray(rec.damage_marks) ? rec.damage_marks : [];
      for (const m of list) {
        if (!m || !m.panel_id || !m.damage_type) continue;
        const key = `${m.panel_id}|${m.damage_type}`;
        if (!dmgSeen.has(key)) dmgSeen.set(key, m);
      }
    }
    const claimRec = rows.find((r) => r.claim_number);
    const tireRec  = rows.find((r) => (r.tire_details && Object.keys(r.tire_details).length) || (Array.isArray(r.tires) && r.tires.length));
    const aggRec = {
      damage_marks: [...dmgSeen.values()],
      claim_number: claimRec?.claim_number || null,
      claim_notes:  claimRec?.claim_notes  || null,
      tire_details: tireRec?.tire_details  || null,
      tires:        tireRec?.tires         || [],
    };
    const aggDamageHtml = renderDamagePanel(aggRec);
    const aggTireHtml   = renderTirePanel(aggRec);

    const timelineHtml = rows.map((r) => {
      const rcat = statusCategory(r.status);
      const rStat = label(r.status) || r.status || "—";
      const rStatPillMod = rcat === "clean" ? "" : ` bl-vin-status-pill--${rcat}`;
      const dotMod = rcat === "clean" ? "" : ` bl-vin-tl-dot--${rcat}`;
      const ago = r.ts ? fmt.timeAgo(r.ts) : "";
      const full = r.ts ? new Date(r.ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: fmt.TZ }) : "";
      const dest = locationOf(r, false);
      // Compact meta line kept on the collapsed summary — enough context to
      // scan the timeline without expanding every row.
      const metaBits = [];
      if (r.user_id) metaBits.push(esc(driverName(r.user_id)));
      if (r.mileage != null) metaBits.push(`${esc(r.mileage.toLocaleString())} mi`);
      if (r.fuel_level) metaBits.push(`Fuel ${esc(r.fuel_level)}`);
      return `
        <details class="bl-vin-tl-row" data-id="${esc(r.id)}">
          <summary>
            <div class="bl-vin-tl-time">
              <span class="bl-vin-tl-ago">${esc(ago || "—")}</span>
              <span class="bl-vin-tl-full">${esc(full)}</span>
            </div>
            <span class="bl-vin-tl-dot${dotMod}" aria-hidden="true"></span>
            <div class="bl-vin-tl-body">
              <div class="bl-vin-tl-status">
                <span class="bl-vin-status-pill${rStatPillMod}">${esc(rStat)}</span>
                ${dest ? `<span class="bl-vin-tl-dest">→ <b>${esc(dest)}</b></span>` : ""}
              </div>
              ${metaBits.length ? `<div class="bl-vin-tl-meta">${metaBits.join(" · ")}</div>` : ""}
            </div>
            <span class="bl-vin-tl-chev" aria-hidden="true">▾</span>
          </summary>
          ${renderTimelineExpanded(r)}
        </details>`;
    }).join("");

    // Page title (VIN) + subtitle (vehicle name) go into the section header
    // so the header stays populated even after the body scrolls.
    $("blVinPageTitle").textContent = serial;
    $("blVinPageSub").textContent = nameLine
      ? [vd.year, vd.make, vd.model].filter(Boolean).join(" ") + (vd.trim ? " · " + vd.trim : "")
      : "—";
    $("blVinBody").innerHTML = `
      <div class="bl-vin-header">
        <div class="bl-vin-eyebrow-row">
          <span class="bl-vin-eyebrow">Vehicle history</span>
          ${tsAgo ? `<span class="bl-vin-seen">Last seen <b>${esc(tsAgo)}</b></span>` : ""}
        </div>
        <div class="bl-vin-vin">${esc(serial)}</div>
        ${vehicleBlock}
        <div class="bl-vin-pill-row">
          <span class="bl-vin-status-pill${statusPillMod}">${esc(statusText)}</span>
        </div>
        ${metersHtml}
      </div>
      ${aggDamageHtml}
      ${aggTireHtml}
      <div class="bl-vin-section-label">Timeline · ${rows.length}${rows.length >= VIN_HISTORY_LIMIT ? "+" : ""} event${rows.length === 1 ? "" : "s"}</div>
      <div class="bl-vin-timeline">${timelineHtml}</div>`;

    mountDamageSvg($("blVinBody"), aggRec.damage_marks);
  }

  function onVinHistoryClick(e) {
    // Row summary clicks toggle the <details> element natively — nothing to
    // wire here. Only the "Open full record" button inside an expanded row
    // drills into the single-record detail modal. Reads the id from the
    // ancestor <details>, not from the button itself, so we survive markup
    // tweaks that move the button around.
    const openBtn = e.target.closest("[data-open-detail]");
    if (!openBtn) return;
    const row = openBtn.closest(".bl-vin-tl-row");
    const id = openBtn.dataset.openDetail || row?.dataset.id;
    if (!id) return;
    // Nested drill-down: leave the VIN history modal open in the background;
    // the record detail modal has a higher effective z-index by being later in DOM.
    openDetail(id);
  }

  function stepDetail(delta) {
    const nextIdx = currentIdx + delta;
    if (nextIdx < 0 || nextIdx >= currentPage.length) return;
    currentIdx = nextIdx;
    renderDetail(currentPage[currentIdx]);
  }

  async function renderDetailPhotos(r) {
    const strip = $("blRecDetailPhotos");
    if (!strip) return;
    const paths = (Array.isArray(r.photo_urls) && r.photo_urls.length) ? r.photo_urls
      : (r.photo_url ? [r.photo_url] : []);
    if (!paths.length) return;
    try {
      const { data } = await sb.storage.from("vehicle-photos").createSignedUrls(paths, 600);
      strip.innerHTML = (data || []).filter((d) => d.signedUrl).map((d) =>
        `<img class="bl-photo-thumb" src="${esc(d.signedUrl)}" alt="Record photo" loading="lazy">`).join("");
    } catch (e) { /* photos best-effort */ }
  }

  function closeDetail() {
    $("blRecDetail").classList.remove("is-open");
    currentIdx = -1;
    if (_detailMap) { try { _detailMap.remove(); } catch (e) {} _detailMap = null; }
  }

  async function deleteDetail() {
    if (currentIdx < 0) return;
    const r = currentPage[currentIdx];
    if (!r) return;
    if (!confirm(`Delete this record${r.serial_id ? " for " + r.serial_id : ""}? This cannot be undone.`)) return;
    const { error } = await sb.from("records").delete().eq("id", r.id);
    if (error) { BL_TOAST.error("Delete failed: " + error.message); return; }
    BL_TOAST.success("Record deleted.");
    closeDetail();
    reload();
  }

  function editDetail() {
    if (currentIdx < 0) return;
    const r = currentPage[currentIdx];
    if (!r) return;
    closeDetail();
    if (window.BL_RECORD_FORM) BL_RECORD_FORM.open("edit", r);
    else BL_TOAST.warn("Editor not loaded yet.");
  }

  // ---------- events ----------
  function onBodyClick(e) {
    // Row's VIN column → navigate to the vehicle-history page. Same target
    // as the global topbar search, so both entry points feel identical.
    const vinBtn = e.target.closest("[data-vin-history]");
    if (vinBtn) return openVinHistory(vinBtn.dataset.vinHistory);
    // Edit-column icon → drop straight into the edit form for that record;
    // the record-detail modal is still reachable via the VIN page timeline
    // ("Open full record"), but power-users get one-click edit here.
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      const r = findRec(editBtn.dataset.edit);
      if (r && window.BL_RECORD_FORM) BL_RECORD_FORM.open("edit", r);
      else if (!window.BL_RECORD_FORM) BL_TOAST.warn("Editor not loaded yet.");
    }
  }

  // reload from page 1 (used on filter change, save/delete, realtime).
  function reload() { return loadPage(1); }

  function start() {
    if (started) return;
    started = true;
    populateStatusFilter();
    populateSectionFilter();
    renderPresetChips();
    renderColsMenu();
    applyColState();

    // Sort — server-side. Change re-fetches page 1.
    sortCtl = BL_SORT.attach({
      thead: $("blRecThead"),
      columns: {
        serial_id: { get: (r) => r.serial_id, type: "string" },
        status:    { get: (r) => label(r.status) || r.status, type: "string" },
        ts:        { get: (r) => r.ts, type: "date" },
      },
      default: { key: "ts", dir: "desc" },
      storageKey: LS_SORT,
      onChange: () => reload(),
    });

    loadProfiles().then(() => reload());

    $("blRecBody")?.addEventListener("click", onBodyClick);
    $("blRecRefresh")?.addEventListener("click", reload);
    $("blRecSearch")?.addEventListener("input", debounce(reload, 300));
    ["blRecStatus", "blRecDriver", "blRecSection", "blRecFrom", "blRecTo"].forEach((id) => $(id)?.addEventListener("change", reload));
    $("blRecNew")?.addEventListener("click", () => { if (window.BL_RECORD_FORM) BL_RECORD_FORM.open("create"); else BL_TOAST.warn("Editor not loaded yet."); });
    $("blRecExport")?.addEventListener("click", exportCsv);
    $("blRecPresetSave")?.addEventListener("click", savePresetPrompt);
    $("blRecPresetChips")?.addEventListener("click", onPresetClick);
    $("blRecColumnsBtn")?.addEventListener("click", () => toggleColsMenu());
    $("blRecColumnsMenu")?.addEventListener("change", onColsMenuChange);
    document.addEventListener("click", onDocClickForCols);

    $("blRecDetailClose")?.addEventListener("click", closeDetail);
    $("blRecDetail")?.addEventListener("click", (e) => { if (e.target.id === "blRecDetail") closeDetail(); });
    $("blRecDetailDelete")?.addEventListener("click", deleteDetail);
    $("blRecDetailEdit")?.addEventListener("click", editDetail);
    $("blRecDetailPrev")?.addEventListener("click", () => stepDetail(-1));
    $("blRecDetailNext")?.addEventListener("click", () => stepDetail(1));

    // VIN page (not a modal): Back button pops the previous section,
    // timeline clicks + open-full-record drill into the record modal.
    $("blVinBack")?.addEventListener("click", () => { if (window.BL_NAV) BL_NAV.back(); });
    $("blVinBody")?.addEventListener("click", onVinHistoryClick);

    // Modal keyboard: Escape closes the record detail modal; arrow keys
    // step through the current records page while the modal is open.
    document.addEventListener("keydown", (e) => {
      const detailOpen  = $("blRecDetail")?.classList.contains("is-open");
      if (!detailOpen) return;
      if (e.key === "Escape") { closeDetail(); return; }
      if (e.key === "ArrowLeft")  { e.preventDefault(); stepDetail(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); stepDetail(1); }
    });

    realtimeChan = sb.channel("backlot-records")
      .on("postgres_changes", { event: "*", schema: "public", table: "records" }, () => loadPage(pager?.getPage() || 1))
      .subscribe();
  }

  function stop() {
    started = false;
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  document.addEventListener("bl-auth-change", () => { if (BL_AUTH.canEnter()) start(); else stop(); });
  if (BL_AUTH.canEnter()) start();
  document.addEventListener("bl-section-shown", (e) => { if (e.detail === "records" && started) reload(); });

  // PANEL_NAMES/DAMAGE_LABELS/TIRE_* and cloneCarSilhouette are exposed so
  // mechanics.js can build its own independent, interactive damage/tire
  // editor (a manager marking what a driver/mechanic may have missed)
  // without a second copy of the ~200-path vehicle SVG or a second catalog.
  // All were already stateless — nothing here changes existing behavior.
  window.BL_RECORDS = {
    reload, profilesMap, openDetail, openVinHistory,
    PANEL_NAMES, DAMAGE_LABELS, TIRE_POSITIONS, TIRE_POS_LABEL, TIRE_CONDITION_LABEL,
    cloneCarSilhouette,
  };
})();
