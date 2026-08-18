// ============================================================
// DriverTrax Maintenance (mechanic role)
//   Own landing screen (#panel-service-scan) + its own VIN-loaded work
//   order form — unlike detailer.js, this does NOT mount into the
//   shared driver #panel-entry. A service job can span shifts and days
//   (send a car to a body shop, it comes back next week), so it needs
//   its own fields (job type, in-house/vendor routing, vendor, parts)
//   rather than borrowing the driver's status/destination form.
//
//   service_jobs is the durable object; `records` rows are written at
//   each meaningful transition (opened / sent out / returned / closed)
//   the same way detail_jobs pairs with records for detailers — reusing
//   getRecords()/setRecords() so the existing local-first + sync.js
//   pipeline, and the vehicles-table trigger, pick them up for free.
//
//   Glass and Body route to an outside vendor by default (performed_by
//   defaults to 'vendor' for those two job types) but the mechanic can
//   override either way. No manager-approval gate on the vendor
//   lifecycle at this time.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb  = DT_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.DT_ESC;
  const ago = (d) => window.DT_FORMAT.timeAgo(d);

  const JOB_TYPES = ["PM", "MK", "MR", "OM", "TI", "LP", "BODY", "GLASS"];
  const VENDOR_DEFAULT = new Set(["BODY", "GLASS"]);

  let started = false;
  let currentVin = null;
  let currentJob = null; // { id, jobType, performedBy, performedByTouched, vendorId, destination, mileage, notes, parts, state, ... }
  let vendorCache = [];

  function start() {
    if (started) return;
    started = true;
    $("svcScanBtn")?.addEventListener("click", () => {
      if (typeof openScanner === "function") openScanner();
      else DT_TOAST.show("Scanner not loaded", "error");
    });
    $("svcScanManualBtn")?.addEventListener("click", (e) => {
      e.preventDefault();
      // Reuses the driver's shared #serial input as the keypad's write
      // target — it's off-screen (inside #panel-entry) but still in the
      // DOM, same trick detailer.js uses for its manual-entry button.
      if (typeof openVinKeypad === "function") openVinKeypad("serial");
      else DT_TOAST.show("VIN keypad not loaded", "error");
    });
    document.addEventListener("dt-vin-scanned", (e) => {
      if (!DT_AUTH.isMechanic()) return;
      const vin = (e.detail || "").toUpperCase();
      if (vin) loadVin(vin);
    });
    $("svcBackBtn")?.addEventListener("click", showLandingScreen);
    $("svcJobTypeChips")?.addEventListener("click", (e) => {
      const chip = e.target.closest(".svc-chip");
      if (!chip || isJobLocked()) return;
      onJobTypeChosen(chip.dataset.type);
    });
    $("svcPerformedToggle")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || isJobLocked()) return;
      currentJob.performedBy = btn.dataset.val;
      currentJob.performedByTouched = true;
      renderForm();
    });
    $("svcVendorSelect")?.addEventListener("change", (e) => {
      if (currentJob) currentJob.vendorId = e.target.value || null;
    });
    $("svcDestination")?.addEventListener("change", (e) => {
      if (currentJob) currentJob.destination = e.target.value || "";
    });
    $("svcMileage")?.addEventListener("input", (e) => {
      if (!currentJob) return;
      const v = parseInt(e.target.value, 10);
      currentJob.mileage = Number.isFinite(v) && v >= 0 ? v : null;
    });
    $("svcNotes")?.addEventListener("input", (e) => {
      if (currentJob) currentJob.notes = e.target.value;
    });
    $("svcPartAddBtn")?.addEventListener("click", onAddPart);
    $("svcPartInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); onAddPart(); }
    });
    $("svcPartsList")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".svc-part-remove");
      if (!btn || isJobLocked()) return;
      const idx = parseInt(btn.dataset.idx, 10);
      currentJob.parts.splice(idx, 1);
      renderParts();
    });
    $("svcSaveBtn")?.addEventListener("click", onSave);
    $("svcSendOutBtn")?.addEventListener("click", onSendOut);
    $("svcReturnedBtn")?.addEventListener("click", onMarkReturned);
    $("svcCloseBtn")?.addEventListener("click", onClose);

    // Populate the closing-status select once — same catalog + labels the
    // driver's own #status select uses (fillStatusSelect lives in app.js).
    if (typeof fillStatusSelect === "function") {
      fillStatusSelect("svcCloseStatus", DT_OPTIONS.STATUS_BASE.filter(c => c !== "OTHER"));
      const sel = $("svcCloseStatus");
      if (sel) sel.value = "CLEAN";
    }

    document.addEventListener("dt-tab-shown", (e) => {
      if (e.detail === "service-scan") { loadOpenJobs(); loadVendorJobs(); loadClosedJobs(); }
    });
  }

  function showLandingScreen() {
    currentVin = null;
    currentJob = null;
    $("svcScanForm")?.classList.add("u-hidden");
    $("svcScanEmpty")?.classList.remove("u-hidden");
    loadOpenJobs();
    loadVendorJobs();
    loadClosedJobs();
  }

  async function populateDestinationSelect() {
    const sel = $("svcDestination");
    if (!sel || !window.DT_DROPOFFS) return;
    let sections = [];
    try { sections = await DT_DROPOFFS.getSections(); } catch (_) { /* offline */ }
    const prev = sel.value;
    sel.innerHTML = '<option value="">-- LOCATION --</option>';
    const seen = new Set();
    (sections || []).forEach(s => {
      const name = String(s.name || "").trim().toUpperCase();
      if (!name || seen.has(name)) return;
      seen.add(name);
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (prev && seen.has(prev)) sel.value = prev;
  }

  async function ensureVendorOptions() {
    const sel = $("svcVendorSelect");
    if (!sel) return;
    vendorCache = (window.DT_VENDORS?.listActive) ? await DT_VENDORS.listActive() : [];
    const prev = sel.value;
    sel.innerHTML = '<option value="">-- SELECT VENDOR --</option>';
    vendorCache.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      sel.appendChild(opt);
    });
    if (prev && vendorCache.some(v => v.id === prev)) sel.value = prev;
  }

  function vendorName(id) {
    return (vendorCache.find(v => v.id === id) || {}).name || "the vendor";
  }

  // ---- loading a VIN ----
  async function loadVin(serialId) {
    if (!serialId) return;
    currentVin = serialId.toUpperCase();
    currentJob = {
      id: null, jobType: null, performedBy: "in_house", performedByTouched: false,
      vendorId: null, destination: "", mileage: null, notes: "", parts: [],
      state: "OPEN", closeStatus: "CLEAN"
    };

    await tryResumeJob(currentVin);
    await Promise.all([populateDestinationSelect(), ensureVendorOptions()]);

    $("svcScanEmpty")?.classList.add("u-hidden");
    $("svcScanForm")?.classList.remove("u-hidden");
    renderForm();
  }

  async function tryResumeJob(vin) {
    const { data, error } = await sb
      .from("service_jobs")
      .select("*")
      .eq("serial_id", vin)
      .neq("state", "CLOSED")
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) { console.warn("[Maint] tryResumeJob", error); return; }
    if (data) hydrateJobFromRow(data);
  }

  function hydrateJobFromRow(row) {
    currentVin = row.serial_id;
    currentJob = {
      id: row.id,
      jobType: row.job_type,
      performedBy: row.performed_by,
      performedByTouched: true,
      vendorId: row.vendor_id,
      destination: row.destination || "",
      mileage: Number.isFinite(row.mileage) ? row.mileage : null,
      notes: row.notes || "",
      parts: Array.isArray(row.parts) ? row.parts.slice() : [],
      state: row.state,
      closeStatus: row.close_status || "CLEAN",
      openedAt: row.opened_at,
      sentOutAt: row.sent_out_at,
      returnedAt: row.returned_at
    };
  }

  async function openJobFromHistory(jobId) {
    const { data, error } = await sb.from("service_jobs").select("*").eq("id", jobId).maybeSingle();
    if (error || !data) { DT_TOAST.missing("job"); return; }
    hydrateJobFromRow(data);
    await Promise.all([populateDestinationSelect(), ensureVendorOptions()]);
    $("svcScanEmpty")?.classList.add("u-hidden");
    $("svcScanForm")?.classList.remove("u-hidden");
    renderForm();
  }

  // ---- rendering ----
  function isJobLocked() { return !!(currentJob && currentJob.state === "CLOSED"); }

  function onJobTypeChosen(type) {
    currentJob.jobType = type;
    if (!currentJob.performedByTouched) {
      currentJob.performedBy = VENDOR_DEFAULT.has(type) ? "vendor" : "in_house";
    }
    renderForm();
  }

  function renderJobTypeChips() {
    const el = $("svcJobTypeChips");
    if (!el) return;
    const locked = isJobLocked();
    el.innerHTML = JOB_TYPES.map(t => {
      const checked = currentJob.jobType === t;
      const isVendorDefault = checked && VENDOR_DEFAULT.has(t);
      return `
        <label class="svc-chip ${checked ? "checked" : ""} ${isVendorDefault ? "is-vendor-default" : ""}" data-type="${t}">
          <input type="radio" name="svcJobType" value="${t}" ${checked ? "checked" : ""} ${locked ? "disabled" : ""}>
          <span>${esc(statusLabel(t))}</span>
        </label>
      `;
    }).join("");
  }

  function renderParts() {
    const el = $("svcPartsList");
    if (!el) return;
    const locked = isJobLocked();
    if (!currentJob.parts.length) {
      el.innerHTML = `<div class="u-empty-sm">No parts added.</div>`;
      return;
    }
    el.innerHTML = currentJob.parts.map((p, idx) => `
      <div class="svc-part-row">
        <span>${esc(p)}</span>
        ${locked ? "" : `<button type="button" class="svc-part-remove" data-idx="${idx}" aria-label="Remove ${esc(p)}">&times;</button>`}
      </div>
    `).join("");
  }

  function onAddPart() {
    if (isJobLocked()) return;
    const input = $("svcPartInput");
    const val = (input?.value || "").trim().slice(0, 80);
    if (!val || !currentJob) return;
    currentJob.parts.push(val);
    input.value = "";
    renderParts();
  }

  function renderForm() {
    if (!currentJob) return;
    const vinEl = $("svcFormVin");
    if (vinEl) vinEl.textContent = currentVin || "—";

    renderJobTypeChips();
    renderParts();

    const locked = isJobLocked();
    const destSel = $("svcDestination");
    if (destSel) { destSel.value = currentJob.destination || ""; destSel.disabled = locked; }
    const mEl = $("svcMileage");
    if (mEl) { mEl.value = Number.isFinite(currentJob.mileage) ? currentJob.mileage : ""; mEl.disabled = locked; }
    const nEl = $("svcNotes");
    if (nEl) { nEl.value = currentJob.notes || ""; nEl.disabled = locked; }
    const vSel = $("svcVendorSelect");
    if (vSel) { vSel.value = currentJob.vendorId || ""; vSel.disabled = locked || currentJob.state === "SENT_OUT"; }
    const partInput = $("svcPartInput"), partAddBtn = $("svcPartAddBtn");
    if (partInput) partInput.disabled = locked;
    if (partAddBtn) partAddBtn.disabled = locked;

    const toggle = $("svcPerformedToggle");
    if (toggle) {
      toggle.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.val === currentJob.performedBy));
      toggle.style.display = locked || currentJob.state === "SENT_OUT" || currentJob.state === "RETURNED" ? "none" : "flex";
    }
    $("svcVendorRow")?.classList.toggle("u-hidden", currentJob.performedBy !== "vendor");

    // ---- state banner ----
    const banner = $("svcStateBanner");
    if (banner) {
      banner.className = "svc-state-banner";
      if (currentJob.state === "SENT_OUT") {
        const days = currentJob.sentOutAt ? Math.floor((Date.now() - new Date(currentJob.sentOutAt).getTime()) / 86400000) : 0;
        banner.classList.add("svc-state-banner--sent-out");
        banner.innerHTML = `Out at ${esc(vendorName(currentJob.vendorId))} — sent ${esc(ago(currentJob.sentOutAt))}` +
          (days >= 1 ? `<span class="svc-days-out">${days} day${days === 1 ? "" : "s"} out</span>` : "");
        banner.classList.remove("u-hidden");
      } else if (currentJob.state === "RETURNED") {
        banner.classList.add("svc-state-banner--returned");
        banner.innerHTML = `Returned ${esc(ago(currentJob.returnedAt))} — pick a location and close the job.`;
        banner.classList.remove("u-hidden");
      } else if (currentJob.state === "CLOSED") {
        banner.classList.add("svc-state-banner--closed");
        banner.innerHTML = `Job closed ${esc(ago(currentJob.closedAt))} — read-only.`;
        banner.classList.remove("u-hidden");
      } else {
        banner.classList.add("u-hidden");
      }
    }

    // ---- action buttons ----
    const saveBtn = $("svcSaveBtn"), sendBtn = $("svcSendOutBtn"), retBtn = $("svcReturnedBtn"), closeBtn = $("svcCloseBtn");
    const closeStatusRow = $("svcCloseStatusRow");
    saveBtn?.classList.add("u-hidden"); sendBtn?.classList.add("u-hidden");
    retBtn?.classList.add("u-hidden"); closeBtn?.classList.add("u-hidden");
    closeStatusRow?.classList.add("u-hidden");

    if (currentJob.state === "OPEN") {
      saveBtn?.classList.remove("u-hidden");
      if (currentJob.performedBy === "vendor") sendBtn?.classList.remove("u-hidden");
      else { closeBtn?.classList.remove("u-hidden"); closeStatusRow?.classList.remove("u-hidden"); }
    } else if (currentJob.state === "SENT_OUT") {
      retBtn?.classList.remove("u-hidden");
    } else if (currentJob.state === "RETURNED") {
      closeBtn?.classList.remove("u-hidden");
      closeStatusRow?.classList.remove("u-hidden");
    }
    const closeSel = $("svcCloseStatus");
    if (closeSel && currentJob.closeStatus) closeSel.value = currentJob.closeStatus;
  }

  // ---- writing records ----
  async function commitTransitionRecord({ status, destination, notes }) {
    const gpsEl = $("svcGpsStatus");
    if (gpsEl) { gpsEl.className = "gps-status acquiring"; gpsEl.textContent = "Acquiring GPS coordinates…"; }
    let loc = null;
    try { loc = await DT_MEDIA.captureGps(); } catch (_) { /* no GPS */ }
    if (gpsEl) { gpsEl.className = "gps-status"; gpsEl.textContent = loc ? "" : "No GPS location"; }
    const recordData = {
      id: (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
      serialId: currentVin,
      status,
      statusOther: "",
      tires: [],
      destination: destination || "",
      destinationOther: "",
      conditions: [],
      noTag: false,
      shuttle: false,
      transport: false,
      shiftNum: null,
      notes: notes || "",
      mileage: Number.isFinite(currentJob.mileage) ? currentJob.mileage : null,
      fuel_level: null,
      timestamp: Date.now()
    };
    if (loc) { recordData.lat = loc.lat; recordData.lng = loc.lng; }
    else { recordData.gpsError = true; }
    const records = getRecords();
    records.unshift(recordData);
    setRecords(records);
    document.dispatchEvent(new CustomEvent("dt-record-saved", { detail: { id: recordData.id, serialId: recordData.serialId } }));
    if (typeof renderTodayEntries === "function") renderTodayEntries();
    return recordData.id;
  }

  // ---- actions ----
  async function onSave() {
    if (!currentJob.jobType) { DT_TOAST.show("Pick a job type", "warn"); return; }
    const btn = $("svcSaveBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

    const payload = {
      serial_id: currentVin,
      job_type: currentJob.jobType,
      performed_by: currentJob.performedBy,
      vendor_id: currentJob.performedBy === "vendor" ? (currentJob.vendorId || null) : null,
      destination: currentJob.destination || null,
      mileage: currentJob.mileage,
      notes: currentJob.notes || null,
      parts: currentJob.parts
    };

    if (!currentJob.id) {
      const user = DT_AUTH.getUser();
      const recordId = await commitTransitionRecord({
        status: currentJob.jobType,
        destination: currentJob.destination,
        notes: currentJob.notes
      });
      payload.opened_by = user?.id || null;
      payload.open_record_id = recordId;
      const { data, error } = await sb.from("service_jobs").insert(payload).select("id").single();
      if (error) { DT_TOAST.show(error.message || "Couldn't save the job", "error"); }
      else { currentJob.id = data.id; DT_TOAST.show("Job opened", "success"); }
    } else {
      const { error } = await sb.from("service_jobs").update(payload).eq("id", currentJob.id);
      if (error) DT_TOAST.show(error.message || "Couldn't save the job", "error");
      else DT_TOAST.show("Saved", "success");
    }

    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
    renderForm();
  }

  async function onSendOut() {
    if (!currentJob.id) { await onSave(); if (!currentJob.id) return; }
    if (!currentJob.vendorId) { DT_TOAST.show("Pick a vendor first", "warn"); return; }
    const name = vendorName(currentJob.vendorId);
    if (!await DT_UI.confirm({ title: `Send to ${name}?`, body: "This marks the vehicle as off-lot.", okLabel: "Send" })) return;

    const btn = $("svcSendOutBtn");
    if (btn) btn.disabled = true;
    const recordId = await commitTransitionRecord({
      status: currentJob.jobType,
      destination: `VENDOR: ${name}`,
      notes: `Sent out to ${name}`
    });
    const { error } = await sb.from("service_jobs").update({
      state: "SENT_OUT", sent_out_at: new Date().toISOString(), sent_out_record_id: recordId
    }).eq("id", currentJob.id);
    if (btn) btn.disabled = false;
    if (error) { DT_TOAST.show(error.message || "Couldn't send the job out", "error"); return; }
    currentJob.state = "SENT_OUT";
    currentJob.sentOutAt = new Date().toISOString();
    DT_TOAST.show(`Sent to ${name}`, "success");
    renderForm();
  }

  async function onMarkReturned() {
    if (!currentJob.destination) { DT_TOAST.show("Pick where it's parked", "warn"); return; }
    const btn = $("svcReturnedBtn");
    if (btn) btn.disabled = true;
    const name = vendorName(currentJob.vendorId);
    const recordId = await commitTransitionRecord({
      status: currentJob.jobType,
      destination: currentJob.destination,
      notes: `Returned from ${name}`
    });
    const { error } = await sb.from("service_jobs").update({
      state: "RETURNED", returned_at: new Date().toISOString(), returned_record_id: recordId,
      destination: currentJob.destination
    }).eq("id", currentJob.id);
    if (btn) btn.disabled = false;
    if (error) { DT_TOAST.show(error.message || "Couldn't mark it returned", "error"); return; }
    currentJob.state = "RETURNED";
    currentJob.returnedAt = new Date().toISOString();
    DT_TOAST.show("Marked returned", "success");
    renderForm();
  }

  async function onClose() {
    if (!currentJob.id) { await onSave(); if (!currentJob.id) return; }
    if (!currentJob.destination) { DT_TOAST.show("Pick where it's parked", "warn"); return; }
    const closeStatus = $("svcCloseStatus")?.value || "CLEAN";
    if (!await DT_UI.confirm({ title: "Close this job?", body: `Vehicle status will be set to ${statusLabel(closeStatus)}.`, okLabel: "Close" })) return;

    const btn = $("svcCloseBtn");
    if (btn) btn.disabled = true;
    const recordId = await commitTransitionRecord({
      status: closeStatus,
      destination: currentJob.destination,
      notes: currentJob.notes
    });
    const closedAt = new Date().toISOString();
    const { error } = await sb.from("service_jobs").update({
      state: "CLOSED", closed_at: closedAt, close_status: closeStatus, close_record_id: recordId,
      destination: currentJob.destination
    }).eq("id", currentJob.id);
    if (btn) btn.disabled = false;
    if (error) { DT_TOAST.show(error.message || "Couldn't close the job", "error"); return; }
    DT_TOAST.show("Job closed", "success");
    showLandingScreen();
  }

  // ---- landing lists ----
  function renderJobRow(j) {
    const metaBits = [statusLabel(j.job_type)];
    if (j.performed_by === "vendor") metaBits.push(j.state === "SENT_OUT" ? "at vendor" : "vendor job");
    return `
      <div class="detail-history-row" data-job-id="${esc(j.id)}">
        <div class="detail-history-serial">${esc(j.serial_id)}</div>
        <div class="detail-history-meta">${metaBits.map(esc).join(" · ")} · ${esc(ago(j.opened_at))}</div>
      </div>
    `;
  }

  function wireJobRows(el) {
    el.querySelectorAll(".detail-history-row").forEach(row => {
      row.addEventListener("click", () => openJobFromHistory(row.dataset.jobId));
    });
  }

  async function loadOpenJobs() {
    const el = $("svcOpenJobsList"), countEl = $("svcOpenJobsCount");
    if (!el) return;
    const { data, error } = await sb
      .from("service_jobs").select("id,serial_id,job_type,performed_by,state,opened_at")
      .eq("state", "OPEN").order("opened_at", { ascending: false }).limit(50);
    if (error) { el.innerHTML = `<div class="u-empty">${esc(error.message)}</div>`; if (countEl) countEl.textContent = "0"; return; }
    if (countEl) countEl.textContent = String((data || []).length);
    el.innerHTML = data && data.length ? data.map(renderJobRow).join("") : `<div class="u-empty">No open jobs.</div>`;
    wireJobRows(el);
  }

  async function loadVendorJobs() {
    const el = $("svcVendorJobsList"), countEl = $("svcVendorJobsCount");
    if (!el) return;
    const { data, error } = await sb
      .from("service_jobs").select("id,serial_id,job_type,performed_by,state,opened_at,sent_out_at,vendor_id")
      .eq("state", "SENT_OUT").order("sent_out_at", { ascending: false }).limit(50);
    if (error) { el.innerHTML = `<div class="u-empty">${esc(error.message)}</div>`; if (countEl) countEl.textContent = "0"; return; }
    if (countEl) countEl.textContent = String((data || []).length);
    el.innerHTML = data && data.length ? data.map(j => {
      const days = j.sent_out_at ? Math.floor((Date.now() - new Date(j.sent_out_at).getTime()) / 86400000) : 0;
      return `
        <div class="detail-history-row" data-job-id="${esc(j.id)}">
          <div class="detail-history-serial">${esc(j.serial_id)}</div>
          <div class="detail-history-meta">${esc(statusLabel(j.job_type))} · sent ${esc(ago(j.sent_out_at))}
            ${days >= 1 ? `<span class="svc-days-out">${days} day${days === 1 ? "" : "s"} out</span>` : ""}
          </div>
        </div>
      `;
    }).join("") : `<div class="u-empty">Nothing out at a vendor.</div>`;
    wireJobRows(el);
  }

  async function loadClosedJobs() {
    const el = $("svcClosedJobsList"), countEl = $("svcClosedJobsCount");
    if (!el) return;
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data, error } = await sb
      .from("service_jobs").select("id,serial_id,job_type,close_status,closed_at")
      .eq("state", "CLOSED").gte("closed_at", since).order("closed_at", { ascending: false }).limit(50);
    if (error) { el.innerHTML = `<div class="u-empty">${esc(error.message)}</div>`; if (countEl) countEl.textContent = "0"; return; }
    if (countEl) countEl.textContent = String((data || []).length);
    el.innerHTML = data && data.length ? data.map(j => `
      <div class="detail-history-row done" data-job-id="${esc(j.id)}">
        <div class="detail-history-serial">${esc(j.serial_id)}</div>
        <div class="detail-history-meta">${esc(statusLabel(j.job_type))} · closed ${esc(ago(j.closed_at))}</div>
      </div>
    `).join("") : `<div class="u-empty">Nothing closed in the last 7 days.</div>`;
    wireJobRows(el);
  }

  // ---- personal dashboard ----
  async function renderDashboard() {
    const { data, error } = await sb
      .from("service_jobs").select("id,serial_id,job_type,performed_by,state,opened_at,closed_at")
      .order("opened_at", { ascending: false }).limit(500);
    if (error) { console.warn("[Maint Dash]", error); return; }
    const jobs = data || [];
    const open = jobs.filter(j => j.state === "OPEN").length;
    const outAtVendor = jobs.filter(j => j.state === "SENT_OUT").length;
    const weekStart = new Date(Date.now() - 7 * 86400000);
    const closedWeek = jobs.filter(j => j.state === "CLOSED" && j.closed_at && new Date(j.closed_at) >= weekStart).length;
    const closedAll = jobs.filter(j => j.state === "CLOSED").length;

    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("svcStatOpen", open);
    set("svcStatVendor", outAtVendor);
    set("svcStatWeek", closedWeek);
    set("svcStatAll", closedAll);

    const recentEl = $("svcRecentList");
    if (recentEl) {
      const recent = jobs.slice(0, 10);
      recentEl.innerHTML = recent.length ? recent.map(renderJobRow).join("") : `<div class="u-empty">No jobs yet.</div>`;
      wireJobRows(recentEl);
    }
  }

  document.addEventListener("dt-auth-change", () => {
    if (DT_AUTH.isMechanic && DT_AUTH.isMechanic()) start();
  });
  if (DT_AUTH.isMechanic && DT_AUTH.isMechanic()) start();

  window.DT_MAINT = { loadVin, showLandingScreen, renderDashboard };
})();
