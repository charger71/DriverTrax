// ============================================================
// Backlot — Records browser
//   Mounts into #section-records. Server-side filtered list of
//   records (VIN/serial search, status, driver, date range), a
//   detail modal (all fields + VIN data + photos), delete, and
//   entry points into the create/edit form (record-form.js).
//   Direct Supabase reads/writes; realtime on `records`.
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

  const profilesMap = {}; // id → display_name
  let realtimeChan = null, started = false, detailId = null;

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

  // ---------- list ----------
  async function load() {
    const body = $("blRecBody");
    if (!body) return;
    const search = ($("blRecSearch")?.value || "").trim();
    const status = $("blRecStatus")?.value || "";
    const driver = $("blRecDriver")?.value || "";
    const from = $("blRecFrom")?.value || "";
    const to   = $("blRecTo")?.value || "";

    let q = sb.from("records").select(REC_COLS).order("ts", { ascending: false }).limit(200);
    if (status) q = q.eq("status", status);
    if (driver) q = q.eq("user_id", driver);
    if (from)   q = q.gte("ts", new Date(from + "T00:00:00").toISOString());
    if (to)     q = q.lte("ts", new Date(to + "T23:59:59.999").toISOString());
    if (search) q = q.ilike("serial_id", `%${search}%`);

    const { data, error } = await q;
    if (error) {
      body.innerHTML = `<tr><td colspan="6"><div class="bl-empty">${esc("Query error: " + error.message)}</div></td></tr>`;
      hidePager();
      return;
    }
    _cache = data || [];
    const countEl = $("blRecCount");
    if (countEl) countEl.textContent = _cache.length ? `${_cache.length}${_cache.length === 200 ? "+" : ""} record${_cache.length === 1 ? "" : "s"}` : "";

    if (!_cache.length) {
      body.innerHTML = `<tr><td colspan="6"><div class="bl-empty">No records match these filters.</div></td></tr>`;
      hidePager();
      return;
    }
    ensurePager();
    pager.setItems(_cache); // paginates client-side (25/page), draws via renderRows
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
        <td><button class="bl-rowbtn" data-open="${r.id}"><span class="bl-rec-vin">${esc(r.serial_id || "—")}${sub ? `<small>${esc(sub)}</small>` : ""}</span></button></td>
        <td>${esc(label(r.status) || r.status || "—")}</td>
        <td>${esc(dest)}</td>
        <td>${esc(driverName(r.user_id))}</td>
        <td>${esc(fmt.timeAgoOrClock(r.ts))}</td>
        <td><button class="bl-btn bl-btn--icon bl-btn--ghost bl-btn--sm" data-edit="${r.id}" aria-label="Edit record"><svg class="bl-icon bl-icon--sm" aria-hidden="true"><use href="#icon-edit"/></svg></button></td>
      </tr>`;
    }).join("");
  }

  function ensurePager() { if (!pager) pager = BL_PAGINATE.create({ mount: $("blRecPager"), render: renderRows }); }
  function hidePager() { const m = $("blRecPager"); if (m) { m.hidden = true; m.innerHTML = ""; } }

  let _cache = [], pager = null;
  const findRec = (id) => _cache.find((r) => r.id === id);

  // ---------- detail modal ----------
  function openDetail(id) {
    const r = findRec(id);
    if (!r) { BL_TOAST.missing("record"); return; }
    detailId = id;
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
    $("blRecDetail").classList.add("is-open");
  }

  async function renderDetailPhotos(r) {
    const strip = $("blRecDetailPhotos");
    if (!strip) return;
    const paths = (Array.isArray(r.photo_urls) && r.photo_urls.length) ? r.photo_urls
      : (r.photo_url ? [r.photo_url] : []);
    if (!paths.length) return;
    // Photos live in the vehicle-photos bucket as storage paths → signed URLs.
    try {
      const { data } = await sb.storage.from("vehicle-photos").createSignedUrls(paths, 600);
      strip.innerHTML = (data || []).filter((d) => d.signedUrl).map((d) =>
        `<img class="bl-photo-thumb" src="${esc(d.signedUrl)}" alt="Record photo" loading="lazy">`).join("");
    } catch (e) { /* photos best-effort */ }
  }

  function closeDetail() { $("blRecDetail").classList.remove("is-open"); detailId = null; }

  async function deleteDetail() {
    if (!detailId) return;
    const r = findRec(detailId);
    if (!confirm(`Delete this record${r?.serial_id ? " for " + r.serial_id : ""}? This cannot be undone.`)) return;
    const { error } = await sb.from("records").delete().eq("id", detailId);
    if (error) { BL_TOAST.error("Delete failed: " + error.message); return; }
    BL_TOAST.success("Record deleted.");
    closeDetail();
    load();
  }

  function editDetail() {
    const r = findRec(detailId);
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

  function start() {
    if (started) return;
    started = true;
    populateStatusFilter();
    loadProfiles().then(load);

    $("blRecBody")?.addEventListener("click", onBodyClick);
    $("blRecRefresh")?.addEventListener("click", load);
    $("blRecSearch")?.addEventListener("input", debounce(load, 300));
    ["blRecStatus", "blRecDriver", "blRecFrom", "blRecTo"].forEach((id) => $(id)?.addEventListener("change", load));
    $("blRecNew")?.addEventListener("click", () => { if (window.BL_RECORD_FORM) BL_RECORD_FORM.open("create"); else BL_TOAST.warn("Editor not loaded yet."); });
    $("blRecDetailClose")?.addEventListener("click", closeDetail);
    $("blRecDetail")?.addEventListener("click", (e) => { if (e.target.id === "blRecDetail") closeDetail(); });
    $("blRecDetailDelete")?.addEventListener("click", deleteDetail);
    $("blRecDetailEdit")?.addEventListener("click", editDetail);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("blRecDetail")?.classList.contains("is-open")) closeDetail(); });

    realtimeChan = sb.channel("backlot-records")
      .on("postgres_changes", { event: "*", schema: "public", table: "records" }, load)
      .subscribe();
  }

  function stop() {
    started = false;
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  document.addEventListener("bl-auth-change", () => { if (BL_AUTH.canEnter()) start(); else stop(); });
  if (BL_AUTH.canEnter()) start();
  document.addEventListener("bl-section-shown", (e) => { if (e.detail === "records" && started) load(); });

  window.BL_RECORDS = { reload: load, profilesMap };
})();
