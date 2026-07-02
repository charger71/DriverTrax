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

  const REC_COLS = "id,user_id,serial_id,status,status_other,destination,destination_other,conditions,no_tag,shuttle,transport,notes,lat,lng,mileage,fuel_level,tires,vin_data,ts,photo_urls,photo_url";
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
      search: ($("blRecSearch")?.value || "").trim(),
      status: $("blRecStatus")?.value || "",
      driver: $("blRecDriver")?.value || "",
      from:   $("blRecFrom")?.value || "",
      to:     $("blRecTo")?.value || "",
    };
  }
  function writeFilters(f) {
    if ($("blRecSearch")) $("blRecSearch").value = f.search || "";
    if ($("blRecStatus")) $("blRecStatus").value = f.status || "";
    if ($("blRecDriver")) $("blRecDriver").value = f.driver || "";
    if ($("blRecFrom"))   $("blRecFrom").value   = f.from   || "";
    if ($("blRecTo"))     $("blRecTo").value     = f.to     || "";
  }
  function applyFiltersToQuery(q, f) {
    if (f.status) q = q.eq("status", f.status);
    if (f.driver) q = q.eq("user_id", f.driver);
    if (f.from)   q = q.gte("ts", new Date(f.from + "T00:00:00").toISOString());
    if (f.to)     q = q.lte("ts", new Date(f.to + "T23:59:59.999").toISOString());
    if (f.search) q = q.ilike("serial_id", `%${f.search}%`);
    return q;
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
      const dest = r.destination === "OTHER" ? (r.destination_other || "Other") : (r.destination || "—");
      return `<tr>
        <td data-col="serial_id"><button class="bl-rowbtn" data-open="${r.id}"><span class="bl-rec-vin">${esc(r.serial_id || "—")}${sub ? `<small>${esc(sub)}</small>` : ""}</span></button></td>
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
      const header = ["Serial","Year","Make","Model","Status","Destination","Driver","Logged","Fuel","Mileage","Notes"];
      const lines = [header.map(csvCell).join(",")];
      rows.forEach((r) => {
        const vd = r.vin_data || {};
        const dest = r.destination === "OTHER" ? (r.destination_other || "Other") : (r.destination || "");
        const stat = r.status === "OTHER" ? (r.status_other || "OTHER") : (label(r.status) || r.status || "");
        lines.push([
          r.serial_id || "", vd.year || "", vd.make || "", vd.model || "",
          stat, dest, driverName(r.user_id), r.ts || "",
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
  function openDetail(id) {
    const r = findRec(id);
    if (!r) { BL_TOAST.missing("record"); return; }
    currentIdx = currentPage.findIndex((x) => x.id === id);
    renderDetail(r);
    $("blRecDetail").classList.add("is-open");
  }

  function renderDetail(r) {
    $("blRecDetailTitle").textContent = r.serial_id || "Record";
    const vd = r.vin_data || {};
    const rows = [];
    const add = (k, v) => { if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) rows.push([k, v]); };
    add("Status", label(r.status) || r.status);
    if (r.status === "OTHER") add("Status detail", r.status_other);
    add("Destination", r.destination === "OTHER" ? (r.destination_other || "Other") : r.destination);
    if (r.conditions && r.conditions.length) add("Conditions", r.conditions.map(condLabel).join(", "));
    if (r.tires && r.tires.length) add("Tires", r.tires.join(", "));
    add("Fuel", r.fuel_level);
    add("Mileage", r.mileage != null ? r.mileage.toLocaleString() : null);
    add("No tag", r.no_tag ? "Yes" : null);
    add("Shuttle", r.shuttle ? "Yes" : null);
    add("Transport", r.transport ? "Yes" : null);
    add("Notes", r.notes);
    add("Driver", driverName(r.user_id));
    add("Logged", new Date(r.ts).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: fmt.TZ }));
    if (r.lat != null && r.lng != null) add("Location", `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`);

    const vinBlock = (vd.year || vd.make || vd.model)
      ? `<div class="bl-vin-block"><span class="yr">${esc([vd.year, vd.make, vd.model].filter(Boolean).join(" "))}</span>${vd.trim ? ` · ${esc(vd.trim)}` : ""}${vd.bodyClass ? `<br>${esc(vd.bodyClass)}` : ""}</div>`
      : "";

    $("blRecDetailBody").innerHTML = `
      <dl class="bl-detail-grid">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("")}</dl>
      ${vinBlock}
      <div class="bl-photo-strip" id="blRecDetailPhotos"></div>`;
    renderDetailPhotos(r);
    updateDetailNav();
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

  function closeDetail() { $("blRecDetail").classList.remove("is-open"); currentIdx = -1; }

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
    const openBtn = e.target.closest("[data-open]");
    if (openBtn) return openDetail(openBtn.dataset.open);
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
    ["blRecStatus", "blRecDriver", "blRecFrom", "blRecTo"].forEach((id) => $(id)?.addEventListener("change", reload));
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

    // Modal keyboard: Escape closes; arrow keys step through the current page.
    document.addEventListener("keydown", (e) => {
      const open = $("blRecDetail")?.classList.contains("is-open");
      if (!open) return;
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

  window.BL_RECORDS = { reload, profilesMap };
})();
