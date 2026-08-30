// ============================================================
// Backlot — Mechanics Service
//   Mounts into #section-mechanics. Shop-wide view of what mechanics
//   are working on, sourced from the same `service_jobs` /
//   `service_vendors` tables the driver app's Mechanic role writes to.
//   Bucketed the same way that role's own "New Entry" landing screen
//   (maintenance.js #panel-service-scan) is: open jobs, waiting on
//   parts, out at vendor, closed this week, and vehicles flagged for
//   service that no one has opened a job for yet. Each list is
//   client-sortable (BL_SORT) since every bucket is already fetched
//   into memory (capped at 50 rows).
//
//   "Manage" (or "Start Job" on a flagged row) opens a modal with the
//   same fields and open → sent-out → returned → closed lifecycle the
//   mechanic's own screen offers — job type, in-house/vendor routing,
//   destination, mileage, "what's being done", parts, a notes log, and
//   waiting-on-parts. State transitions write a `records` row the same
//   way maintenance.js's commitTransitionRecord does (minus GPS, which
//   only makes sense from a mobile device), so the vehicle's
//   current_status/last_seen_at and VIN history stay in sync — same
//   direct-insert shape record-form.js already uses successfully.
//   No damage/tire body-diagram marker — that's a large driver-app-only
//   visual subsystem (SVG silhouette, panel hit-testing) with no
//   Backlot equivalent; damage/tire state stays visible read-only via
//   the VIN-history drill-down every row's VIN links to.
//
//   Realtime + 30s poll. Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;
  const label = (s) => (window.BL_STATUS_LABEL ? BL_STATUS_LABEL(s) : s) || "";
  const S = window.BL_SANITIZE || { serial: (x) => x, notes: (x) => x };

  // Mirrors maintenance.js's own constants.
  const JOB_TYPES = ["PM", "MK", "MR", "OM", "TI", "LP", "BODY", "GLASS"];
  const VENDOR_DEFAULT = new Set(["BODY", "GLASS"]);
  const SERVICE_ACTIONS = [
    "Change Tire", "Rotate Tires", "Oil Change", "Battery Replacement",
    "Transmission Fluid Change", "Brake Service", "Fluid Top-Off", "Inspection"
  ];

  let pollTimer = null, realtimeChan = null, started = false;
  let vendorCache = [];

  // ---- per-bucket cache + client-side sort state ----
  let openRows = [], waitingRows = [], vendorRows = [], closedRows = [], flaggedRows = [];
  let openSortCtl = null, waitingSortCtl = null, vendorSortCtl = null, closedSortCtl = null, flaggedSortCtl = null;

  const vinCell = (serial) =>
    `<button type="button" class="bl-rowbtn" data-vin-history="${esc(serial || "")}">${esc(serial || "—")}</button>`;
  const manageBtn = (id) =>
    `<button type="button" class="bl-btn bl-btn--sm bl-btn--secondary" data-manage-id="${esc(id)}">Manage</button>`;
  const emptyRow = (colspan, msg) => `<tr><td colspan="${colspan}"><div class="bl-empty">${esc(msg)}</div></td></tr>`;

  // Small neutral "Nd" callout, same idea as the driver app's svc-days-out —
  // only worth a caller's attention once it's been at least a day.
  function daysTag(iso) {
    if (!iso) return "";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return days >= 1 ? ` <span class="bl-shift-tag">${days}d</span>` : "";
  }

  function performedByText(j) {
    if (j.performed_by !== "vendor") return "In-house";
    const name = j.vendor && j.vendor.name;
    return name ? `Vendor · ${name}` : "Vendor";
  }

  // Resolve display names for a set of profile ids in one round trip —
  // same shape as roster.js / reports.js's own copy.
  async function resolveNames(ids, fallback) {
    const names = {};
    const list = [...new Set(ids.filter(Boolean))];
    if (list.length) {
      const { data } = await sb.from("profiles").select("id,display_name").in("id", list);
      (data || []).forEach((p) => { names[p.id] = p.display_name || fallback; });
    }
    return names;
  }

  // Shared fetch → count → name-resolve → annotate → cache pipeline for the
  // four service_jobs-backed buckets (Flagged is vehicles-backed and
  // handled separately below). Annotated fields (e.g. `_mechanic`) let
  // BL_SORT and the row renderer both read plain properties instead of
  // recomputing display text.
  async function runBucket({ query, countEl, bodyEl, colspan, emptyMsg, annotate, setCache, render }) {
    const { data, error } = await query;
    if (error) {
      if (countEl) countEl.textContent = "—";
      if (bodyEl) bodyEl.innerHTML = emptyRow(colspan, error.message);
      setCache([]);
      return;
    }
    const rows = data || [];
    if (countEl) countEl.textContent = String(rows.length);
    if (rows.length) {
      const names = await resolveNames(rows.flatMap((j) => [j.opened_by, j.updated_by]), "—");
      annotate(rows, names);
    }
    setCache(rows);
    if (!rows.length && bodyEl) { bodyEl.innerHTML = emptyRow(colspan, emptyMsg); return; }
    render();
  }

  function loadOpen() {
    return runBucket({
      query: sb.from("service_jobs")
        .select("id,serial_id,job_type,performed_by,destination,mileage,opened_at,opened_by,updated_by,vendor:service_vendors(name)")
        .eq("state", "OPEN").eq("waiting_on_parts", false)
        .order("opened_at", { ascending: false }).limit(50),
      countEl: $("blMechOpenCount"), bodyEl: $("blMechOpenBody"), colspan: 6,
      emptyMsg: "No open jobs.",
      annotate: (rows, names) => rows.forEach((j) => {
        j._mechanic = names[j.updated_by || j.opened_by] || "—";
        j._jobTypeLabel = label(j.job_type);
        j._performedByText = performedByText(j);
      }),
      setCache: (rows) => { openRows = rows; },
      render: renderOpenTable,
    });
  }
  function renderOpenTable() {
    const bodyEl = $("blMechOpenBody");
    if (!bodyEl || !openRows.length) return;
    const rows = openSortCtl ? openSortCtl.sort(openRows) : openRows;
    bodyEl.innerHTML = rows.map((j) => `
      <tr>
        <td>${vinCell(j.serial_id)}</td>
        <td><span class="bl-role-pill">${esc(j._jobTypeLabel)}</span></td>
        <td>${esc(j._performedByText)}</td>
        <td>${esc(j._mechanic)}</td>
        <td>${esc(fmt.timeAgo(j.opened_at))}</td>
        <td>${manageBtn(j.id)}</td>
      </tr>`).join("");
  }

  function loadWaiting() {
    return runBucket({
      query: sb.from("service_jobs")
        .select("id,serial_id,job_type,parts_note,waiting_since,opened_by,updated_by")
        .eq("waiting_on_parts", true).neq("state", "CLOSED")
        .order("waiting_since", { ascending: false }).limit(50),
      countEl: $("blMechWaitingCount"), bodyEl: $("blMechWaitingBody"), colspan: 6,
      emptyMsg: "Nothing waiting on parts.",
      annotate: (rows, names) => rows.forEach((j) => {
        j._mechanic = names[j.updated_by || j.opened_by] || "—";
        j._jobTypeLabel = label(j.job_type);
      }),
      setCache: (rows) => { waitingRows = rows; },
      render: renderWaitingTable,
    });
  }
  function renderWaitingTable() {
    const bodyEl = $("blMechWaitingBody");
    if (!bodyEl || !waitingRows.length) return;
    const rows = waitingSortCtl ? waitingSortCtl.sort(waitingRows) : waitingRows;
    bodyEl.innerHTML = rows.map((j) => `
      <tr>
        <td>${vinCell(j.serial_id)}</td>
        <td><span class="bl-role-pill">${esc(j._jobTypeLabel)}</span></td>
        <td>${esc(j.parts_note || "—")}</td>
        <td>${esc(fmt.timeAgo(j.waiting_since))}${daysTag(j.waiting_since)}</td>
        <td>${esc(j._mechanic)}</td>
        <td>${manageBtn(j.id)}</td>
      </tr>`).join("");
  }

  function loadVendor() {
    return runBucket({
      query: sb.from("service_jobs")
        .select("id,serial_id,job_type,sent_out_at,opened_by,updated_by,vendor:service_vendors(name)")
        .eq("state", "SENT_OUT")
        .order("sent_out_at", { ascending: false }).limit(50),
      countEl: $("blMechVendorCount"), bodyEl: $("blMechVendorBody"), colspan: 6,
      emptyMsg: "Nothing out at a vendor.",
      annotate: (rows, names) => rows.forEach((j) => {
        j._mechanic = names[j.updated_by || j.opened_by] || "—";
        j._jobTypeLabel = label(j.job_type);
        j._vendorName = (j.vendor && j.vendor.name) || "—";
      }),
      setCache: (rows) => { vendorRows = rows; },
      render: renderVendorTable,
    });
  }
  function renderVendorTable() {
    const bodyEl = $("blMechVendorBody");
    if (!bodyEl || !vendorRows.length) return;
    const rows = vendorSortCtl ? vendorSortCtl.sort(vendorRows) : vendorRows;
    bodyEl.innerHTML = rows.map((j) => `
      <tr>
        <td>${vinCell(j.serial_id)}</td>
        <td><span class="bl-role-pill">${esc(j._jobTypeLabel)}</span></td>
        <td>${esc(j._vendorName)}</td>
        <td>${esc(fmt.timeAgo(j.sent_out_at))}${daysTag(j.sent_out_at)}</td>
        <td>${esc(j._mechanic)}</td>
        <td>${manageBtn(j.id)}</td>
      </tr>`).join("");
  }

  function loadClosed() {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    return runBucket({
      query: sb.from("service_jobs")
        .select("id,serial_id,job_type,close_status,closed_at,opened_by,updated_by")
        .eq("state", "CLOSED").gte("closed_at", since)
        .order("closed_at", { ascending: false }).limit(50),
      countEl: $("blMechClosedCount"), bodyEl: $("blMechClosedBody"), colspan: 6,
      emptyMsg: "Nothing closed in the last 7 days.",
      annotate: (rows, names) => rows.forEach((j) => {
        j._mechanic = names[j.updated_by || j.opened_by] || "—";
        j._jobTypeLabel = label(j.job_type);
        j._closeStatusLabel = label(j.close_status) || "—";
      }),
      setCache: (rows) => { closedRows = rows; },
      render: renderClosedTable,
    });
  }
  function renderClosedTable() {
    const bodyEl = $("blMechClosedBody");
    if (!bodyEl || !closedRows.length) return;
    const rows = closedSortCtl ? closedSortCtl.sort(closedRows) : closedRows;
    bodyEl.innerHTML = rows.map((j) => `
      <tr>
        <td>${vinCell(j.serial_id)}</td>
        <td><span class="bl-role-pill">${esc(j._jobTypeLabel)}</span></td>
        <td>${esc(j._closeStatusLabel)}</td>
        <td>${esc(fmt.timeAgo(j.closed_at))}</td>
        <td>${esc(j._mechanic)}</td>
        <td>${manageBtn(j.id)}</td>
      </tr>`).join("");
  }

  // Vehicles a driver/CXR flagged (current_status = a job type) that no
  // mechanic has opened a matching job for yet — mirrors maintenance.js's
  // loadFlaggedVehicles so a manager sees the same "not started" gap the
  // mechanic's own landing screen surfaces. Bespoke (not runBucket): it
  // reads `vehicles`, not `service_jobs`, and carries no mechanic/opener.
  async function loadFlagged() {
    const countEl = $("blMechFlaggedCount"), bodyEl = $("blMechFlaggedBody");
    const [vehRes, jobsRes] = await Promise.all([
      sb.from("vehicles").select("serial_id,current_status,last_seen_at").in("current_status", JOB_TYPES)
        .order("last_seen_at", { ascending: false }),
      sb.from("service_jobs").select("serial_id,job_type").neq("state", "CLOSED"),
    ]);
    if (vehRes.error) {
      if (countEl) countEl.textContent = "—";
      if (bodyEl) bodyEl.innerHTML = emptyRow(4, vehRes.error.message);
      flaggedRows = [];
      return;
    }
    if (jobsRes.error) console.warn("[Backlot] mechanics flagged jobs", jobsRes.error);
    const openPairs = new Set((jobsRes.data || []).map((j) => `${j.serial_id}::${j.job_type}`));
    const flagged = (vehRes.data || []).filter((v) => !openPairs.has(`${v.serial_id}::${v.current_status}`));
    flagged.forEach((v) => { v._statusLabel = label(v.current_status); });
    flaggedRows = flagged;
    if (countEl) countEl.textContent = String(flagged.length);
    if (!flagged.length) { if (bodyEl) bodyEl.innerHTML = emptyRow(4, "Nothing flagged."); return; }
    renderFlaggedTable();
  }
  function renderFlaggedTable() {
    const bodyEl = $("blMechFlaggedBody");
    if (!bodyEl || !flaggedRows.length) return;
    const rows = flaggedSortCtl ? flaggedSortCtl.sort(flaggedRows) : flaggedRows;
    bodyEl.innerHTML = rows.map((v) => `
      <tr>
        <td>${vinCell(v.serial_id)}</td>
        <td><span class="bl-role-pill">${esc(v._statusLabel)}</span></td>
        <td>${esc(fmt.timeAgo(v.last_seen_at))}</td>
        <td><button type="button" class="bl-btn bl-btn--sm bl-btn--secondary" data-start-vin="${esc(v.serial_id)}" data-start-type="${esc(v.current_status)}">Start Job</button></td>
      </tr>`).join("");
  }

  function loadAll() {
    loadOpen();
    loadWaiting();
    loadVendor();
    loadClosed();
    loadFlagged();
  }

  // ============================================================
  // Job modal — full lifecycle editing (mirrors maintenance.js's job
  // state machine: OPEN → (vendor: SENT_OUT → RETURNED) → CLOSED, with
  // waiting-on-parts as an independent flag).
  // ============================================================
  let currentJob = null;
  let modalMode = "edit"; // "edit" | "create"

  function freshJob(serial, jobType) {
    return {
      id: null, serialId: serial, jobType: jobType || null,
      performedBy: jobType && VENDOR_DEFAULT.has(jobType) ? "vendor" : "in_house", performedByTouched: false,
      vendorId: null, vendorName: null, destination: "", mileage: null, notes: "", parts: [],
      serviceActions: [], serviceActionOther: "", notesLog: [],
      state: "OPEN", closeStatus: "CLEAN",
      waitingOnParts: false, partsNote: "", waitingSince: null,
    };
  }

  function hydrateJobFromRow(row) {
    return {
      id: row.id, serialId: row.serial_id, jobType: row.job_type,
      performedBy: row.performed_by, performedByTouched: true,
      vendorId: row.vendor_id, vendorName: (row.vendor && row.vendor.name) || null,
      destination: row.destination || "", mileage: Number.isFinite(row.mileage) ? row.mileage : null,
      notes: row.notes || "", parts: Array.isArray(row.parts) ? row.parts.slice() : [],
      serviceActions: Array.isArray(row.service_actions) ? row.service_actions.slice() : [],
      serviceActionOther: row.service_action_other || "",
      notesLog: Array.isArray(row.notes_log) ? row.notes_log.slice() : [],
      state: row.state, closeStatus: row.close_status || "CLEAN",
      openedAt: row.opened_at, sentOutAt: row.sent_out_at, returnedAt: row.returned_at, closedAt: row.closed_at,
      waitingOnParts: !!row.waiting_on_parts, partsNote: row.parts_note || "", waitingSince: row.waiting_since,
    };
  }

  function isJobLocked() { return !!(currentJob && currentJob.state === "CLOSED"); }
  const vendorNameFor = (j) => j.vendorName || (vendorCache.find((v) => v.id === j.vendorId) || {}).name || "the vendor";

  async function ensureVendorOptions() {
    const sel = $("blMechJobVendor");
    if (!sel) return;
    const { data, error } = await sb.from("service_vendors").select("id,name").eq("active", true).order("name", { ascending: true });
    if (error) console.warn("[Backlot] mechanics vendor list", error);
    vendorCache = data || [];
    const prev = sel.value;
    sel.innerHTML = '<option value="">-- Select vendor --</option>' + vendorCache.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("");
    if (prev && vendorCache.some((v) => v.id === prev)) sel.value = prev;
  }

  function populateJobTypeSelect() {
    const sel = $("blMechJobType");
    if (sel) sel.innerHTML = JOB_TYPES.map((t) => `<option value="${t}">${esc(label(t))}</option>`).join("");
  }
  function populateDestSelect() {
    const sel = $("blMechJobDest");
    const dests = (window.BL_OPTIONS && BL_OPTIONS.DESTINATIONS) || [];
    if (sel) sel.innerHTML = '<option value="">-- Location --</option>' + dests.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
  }
  function populateCloseStatusSelect() {
    const sel = $("blMechJobCloseStatus");
    const statuses = ((window.BL_OPTIONS && BL_OPTIONS.STATUS_BASE) || []).filter((c) => c !== "OTHER");
    if (sel) sel.innerHTML = statuses.map((s) => `<option value="${esc(s)}">${esc(label(s))}</option>`).join("");
  }

  function renderActionChecks() {
    const el = $("blMechJobActions");
    if (!el || !currentJob) return;
    const locked = isJobLocked();
    const options = [...SERVICE_ACTIONS, "OTHER"];
    const checked = new Set(currentJob.serviceActions);
    el.innerHTML = options.map((a) => `
      <label><input type="checkbox" value="${esc(a)}" ${checked.has(a) ? "checked" : ""} ${locked ? "disabled" : ""}> ${esc(a === "OTHER" ? "Other" : a)}</label>
    `).join("");
    el.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => {
        if (inp.checked) { if (!currentJob.serviceActions.includes(inp.value)) currentJob.serviceActions.push(inp.value); }
        else { currentJob.serviceActions = currentJob.serviceActions.filter((a) => a !== inp.value); }
        $("blMechJobActionOtherRow")?.classList.toggle("is-hidden", !currentJob.serviceActions.includes("OTHER"));
      });
    });
    $("blMechJobActionOtherRow")?.classList.toggle("is-hidden", !currentJob.serviceActions.includes("OTHER"));
  }

  function renderJobParts() {
    const el = $("blMechJobPartsList");
    if (!el || !currentJob) return;
    const locked = isJobLocked();
    if (!currentJob.parts.length) { el.innerHTML = `<div class="bl-empty">No parts added.</div>`; return; }
    el.innerHTML = currentJob.parts.map((p, idx) => `
      <span class="bl-tag">${esc(p)}${locked ? "" : `<button type="button" data-idx="${idx}" aria-label="Remove ${esc(p)}">&times;</button>`}</span>
    `).join("");
    el.querySelectorAll("button[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => { currentJob.parts.splice(parseInt(btn.dataset.idx, 10), 1); renderJobParts(); });
    });
  }
  function onAddJobPart() {
    if (!currentJob || isJobLocked()) return;
    const input = $("blMechJobPartInput");
    const val = S.notes((input?.value || "").trim()).slice(0, 80);
    if (!val) return;
    currentJob.parts.push(val);
    input.value = "";
    renderJobParts();
  }

  // Append-only — newest first, no remove action (a running log of every
  // touch, not an editable field). `authorName` is resolved once when the
  // modal opens and stripped back off before writing notes_log to Supabase.
  function renderJobNotesLog() {
    const el = $("blMechJobNotesList");
    if (!el || !currentJob) return;
    const log = currentJob.notesLog || [];
    if (!log.length) { el.innerHTML = `<div class="bl-empty">No notes yet.</div>`; return; }
    el.innerHTML = log.slice().reverse().map((entry) => `
      <div class="bl-note-row">
        <div class="bl-note-meta">${esc(fmt.timeAgo(entry.ts))}${entry.authorName ? " · " + esc(entry.authorName) : ""}</div>
        <div>${esc(entry.note)}</div>
      </div>
    `).join("");
  }

  function renderJobModal() {
    if (!currentJob) return;
    $("blMechJobTitle").textContent = modalMode === "create" ? "New Service Job" : "Service Job";
    $("blMechJobVin").textContent = currentJob.serialId || "—";

    const locked = isJobLocked();

    const typeSel = $("blMechJobType");
    if (typeSel) { typeSel.value = currentJob.jobType || ""; typeSel.disabled = locked; }
    const mEl = $("blMechJobMileage");
    if (mEl) { mEl.value = Number.isFinite(currentJob.mileage) ? currentJob.mileage : ""; mEl.disabled = locked; }

    const toggle = $("blMechJobPerformedBy");
    if (toggle) toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b.dataset.val === currentJob.performedBy));
    $("blMechJobPerformedBy")?.classList.toggle("is-hidden", locked || currentJob.state === "SENT_OUT" || currentJob.state === "RETURNED");

    const vSel = $("blMechJobVendor");
    if (vSel) { vSel.value = currentJob.vendorId || ""; vSel.disabled = locked || currentJob.state === "SENT_OUT"; }
    $("blMechJobVendorRow")?.classList.toggle("is-hidden", currentJob.performedBy !== "vendor");

    const destSel = $("blMechJobDest");
    if (destSel) { destSel.value = currentJob.destination || ""; destSel.disabled = locked; }

    renderActionChecks();
    const actionOtherEl = $("blMechJobActionOther");
    if (actionOtherEl) { actionOtherEl.value = currentJob.serviceActionOther || ""; actionOtherEl.disabled = locked; }

    renderJobParts();
    const partInput = $("blMechJobPartInput"), partAddBtn = $("blMechJobPartAdd");
    if (partInput) partInput.disabled = locked;
    if (partAddBtn) partAddBtn.disabled = locked;

    renderJobNotesLog();
    const noteInput = $("blMechJobNoteInput"), noteAddBtn = $("blMechJobNoteAdd");
    if (noteInput) noteInput.disabled = locked;
    if (noteAddBtn) noteAddBtn.disabled = locked;

    // ---- waiting on parts ----
    const canToggleWaiting = !locked && (currentJob.state === "OPEN" || currentJob.state === "RETURNED");
    $("blMechJobWaitingRow")?.classList.toggle("is-hidden", !canToggleWaiting);
    $("blMechJobWaitingBtn")?.classList.toggle("is-hidden", currentJob.waitingOnParts);
    $("blMechJobPartsArrivedBtn")?.classList.toggle("is-hidden", !currentJob.waitingOnParts);
    const partsNoteEl = $("blMechJobPartsNote");
    if (partsNoteEl) { partsNoteEl.value = currentJob.partsNote || ""; partsNoteEl.disabled = locked; }

    // ---- state banner ----
    const banner = $("blMechJobBanner");
    if (banner) {
      let text = "";
      if (currentJob.waitingOnParts) {
        text = `Waiting on parts${currentJob.partsNote ? " — " + currentJob.partsNote : ""} · since ${fmt.timeAgo(currentJob.waitingSince)}`;
      } else if (currentJob.state === "SENT_OUT") {
        text = `Out at ${vendorNameFor(currentJob)} — sent ${fmt.timeAgo(currentJob.sentOutAt)}`;
      } else if (currentJob.state === "RETURNED") {
        text = `Returned ${fmt.timeAgo(currentJob.returnedAt)} — pick a location and close the job.`;
      } else if (currentJob.state === "CLOSED") {
        text = `Job closed ${fmt.timeAgo(currentJob.closedAt)} — read-only.`;
      }
      banner.textContent = text;
      banner.classList.toggle("is-hidden", !text);
    }

    // ---- action buttons ----
    const saveBtn = $("blMechJobSaveBtn"), sendBtn = $("blMechJobSendBtn"), retBtn = $("blMechJobReturnBtn"), closeBtn = $("blMechJobCloseBtn");
    const closeStatusRow = $("blMechJobCloseStatusRow");
    [saveBtn, sendBtn, retBtn, closeBtn].forEach((b) => b?.classList.add("is-hidden"));
    closeStatusRow?.classList.add("is-hidden");
    if (saveBtn) saveBtn.textContent = currentJob.id ? "Update" : "Save";

    if (currentJob.state === "OPEN") {
      saveBtn?.classList.remove("is-hidden");
      if (currentJob.performedBy === "vendor") {
        sendBtn?.classList.remove("is-hidden");
      } else if (currentJob.id) {
        closeBtn?.classList.remove("is-hidden");
        closeStatusRow?.classList.remove("is-hidden");
      }
    } else if (currentJob.state === "SENT_OUT") {
      retBtn?.classList.remove("is-hidden");
    } else if (currentJob.state === "RETURNED") {
      closeBtn?.classList.remove("is-hidden");
      closeStatusRow?.classList.remove("is-hidden");
    }
    const closeSel = $("blMechJobCloseStatus");
    if (closeSel && currentJob.closeStatus) closeSel.value = currentJob.closeStatus;
  }

  async function openJobModal(mode, job) {
    modalMode = mode;
    currentJob = job;
    if (mode === "edit") {
      const names = await resolveNames(currentJob.notesLog.map((e) => e.author), "Unknown");
      currentJob.notesLog.forEach((e) => { e.authorName = names[e.author] || ""; });
    }
    await ensureVendorOptions();
    BL_UI.setMessage($("blMechJobMsg"), "");
    renderJobModal();
    $("blMechJobModal")?.classList.add("is-open");
  }
  function hideJobModal() {
    $("blMechJobModal")?.classList.remove("is-open");
    currentJob = null;
  }

  async function openJobFromId(id) {
    const { data, error } = await sb.from("service_jobs").select("*,vendor:service_vendors(name)").eq("id", id).maybeSingle();
    if (error || !data) { BL_TOAST.missing("job"); return; }
    await openJobModal("edit", hydrateJobFromRow(data));
  }
  function onStartJobFromFlagged(vin, jobType) {
    openJobModal("create", freshJob(vin, jobType));
  }

  // Writes a `records` row for a state transition, the same direct-insert
  // shape record-form.js uses (no GPS — that only makes sense from a
  // mobile device, unlike maintenance.js's own commitTransitionRecord).
  // The vehicles-table trigger picks this up the same way, so
  // current_status/last_seen_at and VIN history stay correct.
  async function writeTransitionRecord({ status, destination, notes, mileage }) {
    const id = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    const payload = {
      id, serial_id: currentJob.serialId, status, status_other: null,
      destination: destination || null, destination_other: null,
      conditions: [], tires: [], fuel_level: null,
      mileage: Number.isFinite(mileage) ? mileage : null,
      no_tag: false, shuttle: false, transport: false,
      notes: notes ? S.notes(notes) : null,
      photo_urls: null, vin_data: null,
      user_id: BL_AUTH.getUser()?.id || null, ts: new Date().toISOString(),
    };
    const { error } = await sb.from("records").insert(payload);
    if (error) console.warn("[Backlot] mechanics writeTransitionRecord", error);
    return id;
  }

  async function onSaveJob() {
    if (!currentJob.jobType) { BL_UI.setMessage($("blMechJobMsg"), "Pick a job type.", "err"); return; }
    const btn = $("blMechJobSaveBtn");
    if (btn) btn.disabled = true;
    BL_UI.setMessage($("blMechJobMsg"), "Saving…");

    const user = BL_AUTH.getUser();
    const isUpdate = !!currentJob.id;
    const payload = {
      serial_id: currentJob.serialId,
      job_type: currentJob.jobType,
      performed_by: currentJob.performedBy,
      vendor_id: currentJob.performedBy === "vendor" ? (currentJob.vendorId || null) : null,
      destination: currentJob.destination || null,
      mileage: currentJob.mileage,
      notes: currentJob.notes || null,
      parts: currentJob.parts,
      service_actions: currentJob.serviceActions,
      service_action_other: currentJob.serviceActions.includes("OTHER") ? (S.notes(currentJob.serviceActionOther || "") || null) : null,
      updated_by: user?.id || null,
    };

    let saveError = null;
    if (!currentJob.id) {
      const recordId = await writeTransitionRecord({ status: currentJob.jobType, destination: currentJob.destination, notes: currentJob.notes, mileage: currentJob.mileage });
      payload.opened_by = user?.id || null;
      payload.open_record_id = recordId;
      const { data, error } = await sb.from("service_jobs").insert(payload).select("id").single();
      saveError = error;
      if (error) BL_UI.setMessage($("blMechJobMsg"), error.message || "Couldn't save the job.", "err");
      else { currentJob.id = data.id; BL_TOAST.success("Job opened."); }
    } else {
      const { error } = await sb.from("service_jobs").update(payload).eq("id", currentJob.id);
      saveError = error;
      if (error) BL_UI.setMessage($("blMechJobMsg"), error.message || "Couldn't save the job.", "err");
      else BL_TOAST.success("Saved.");
    }

    if (btn) btn.disabled = false;
    if (!saveError) {
      loadAll();
      if (isUpdate) { hideJobModal(); return; }
    }
    renderJobModal();
  }

  async function onSendOutJob() {
    if (!currentJob.id) { await onSaveJob(); if (!currentJob.id) return; }
    if (!currentJob.vendorId) { BL_UI.setMessage($("blMechJobMsg"), "Pick a vendor first.", "err"); return; }
    const name = vendorNameFor(currentJob);
    if (!confirm(`Send to ${name}? This marks the vehicle as off-lot.`)) return;

    const btn = $("blMechJobSendBtn");
    if (btn) btn.disabled = true;
    const recordId = await writeTransitionRecord({ status: "AT_VENDOR", destination: `VENDOR: ${name}`, notes: `Sent out to ${name}`, mileage: currentJob.mileage });
    const { error } = await sb.from("service_jobs").update({
      state: "SENT_OUT", sent_out_at: new Date().toISOString(), sent_out_record_id: recordId,
      waiting_on_parts: false, waiting_since: null, updated_by: BL_AUTH.getUser()?.id || null,
    }).eq("id", currentJob.id);
    if (btn) btn.disabled = false;
    if (error) { BL_UI.setMessage($("blMechJobMsg"), error.message || "Couldn't send the job out.", "err"); return; }
    currentJob.state = "SENT_OUT";
    currentJob.sentOutAt = new Date().toISOString();
    currentJob.waitingOnParts = false;
    currentJob.waitingSince = null;
    BL_TOAST.success(`Sent to ${name}.`);
    loadAll();
    renderJobModal();
  }

  async function onMarkReturnedJob() {
    if (!currentJob.destination) { BL_UI.setMessage($("blMechJobMsg"), "Pick where it's parked.", "err"); return; }
    const btn = $("blMechJobReturnBtn");
    if (btn) btn.disabled = true;
    const name = vendorNameFor(currentJob);
    const recordId = await writeTransitionRecord({ status: currentJob.jobType, destination: currentJob.destination, notes: `Returned from ${name}`, mileage: currentJob.mileage });
    const { error } = await sb.from("service_jobs").update({
      state: "RETURNED", returned_at: new Date().toISOString(), returned_record_id: recordId,
      destination: currentJob.destination, updated_by: BL_AUTH.getUser()?.id || null,
    }).eq("id", currentJob.id);
    if (btn) btn.disabled = false;
    if (error) { BL_UI.setMessage($("blMechJobMsg"), error.message || "Couldn't mark it returned.", "err"); return; }
    currentJob.state = "RETURNED";
    currentJob.returnedAt = new Date().toISOString();
    BL_TOAST.success("Marked returned.");
    loadAll();
    renderJobModal();
  }

  async function onCloseJob() {
    if (!currentJob.id) { await onSaveJob(); if (!currentJob.id) return; }
    if (!currentJob.destination) { BL_UI.setMessage($("blMechJobMsg"), "Pick where it's parked.", "err"); return; }
    const closeStatus = $("blMechJobCloseStatus")?.value || "CLEAN";
    if (!confirm(`Close this job? Vehicle status will be set to ${label(closeStatus)}.`)) return;

    const btn = $("blMechJobCloseBtn");
    if (btn) btn.disabled = true;
    const recordId = await writeTransitionRecord({ status: closeStatus, destination: currentJob.destination, notes: currentJob.notes, mileage: currentJob.mileage });
    const { error } = await sb.from("service_jobs").update({
      state: "CLOSED", closed_at: new Date().toISOString(), close_status: closeStatus, close_record_id: recordId,
      destination: currentJob.destination, waiting_on_parts: false, waiting_since: null,
      updated_by: BL_AUTH.getUser()?.id || null,
    }).eq("id", currentJob.id);
    if (btn) btn.disabled = false;
    if (error) { BL_UI.setMessage($("blMechJobMsg"), error.message || "Couldn't close the job.", "err"); return; }
    BL_TOAST.success("Job closed.");
    loadAll();
    hideJobModal();
  }

  // Mark a job blocked on a part (or resume it once the part arrives) — a
  // flag alongside `state`, not a fifth state value, since a job can be
  // waiting whether it's in-house (OPEN) or a returned vendor job still
  // needs a part before it can close.
  async function onToggleWaitingPartsJob(waiting) {
    if (!currentJob.id) { await onSaveJob(); if (!currentJob.id) return; }
    const note = S.notes(($("blMechJobPartsNote")?.value || "").trim()).slice(0, 200);
    const btn = waiting ? $("blMechJobWaitingBtn") : $("blMechJobPartsArrivedBtn");
    if (btn) btn.disabled = true;
    await writeTransitionRecord({
      status: waiting ? "WAITING_PARTS" : currentJob.jobType,
      destination: currentJob.destination,
      notes: waiting ? (note || "Waiting on parts") : "Parts arrived — resuming",
      mileage: currentJob.mileage,
    });
    const payload = waiting
      ? { waiting_on_parts: true, parts_note: note || null, waiting_since: new Date().toISOString() }
      : { waiting_on_parts: false, waiting_since: null };
    payload.updated_by = BL_AUTH.getUser()?.id || null;
    const { error } = await sb.from("service_jobs").update(payload).eq("id", currentJob.id);
    if (btn) btn.disabled = false;
    if (error) { BL_UI.setMessage($("blMechJobMsg"), error.message || "Couldn't update the job.", "err"); return; }
    currentJob.waitingOnParts = waiting;
    currentJob.partsNote = waiting ? note : "";
    currentJob.waitingSince = payload.waiting_since;
    BL_TOAST.success(waiting ? "Marked waiting on parts." : "Parts arrived.");
    loadAll();
    renderJobModal();
  }

  // Appends a dated note without requiring Save/Send/Return/Close. Writes a
  // records row too (unchanged status, same as the waiting-parts toggle)
  // so the touch shows up in VIN history and bumps last_seen_at.
  async function onAddJobNote() {
    if (!currentJob || isJobLocked()) return;
    if (!currentJob.id) { await onSaveJob(); if (!currentJob.id) return; }
    const input = $("blMechJobNoteInput");
    const text = S.notes((input?.value || "").trim()).slice(0, 500);
    if (!text) return;
    const btn = $("blMechJobNoteAdd");
    if (btn) btn.disabled = true;
    const user = BL_AUTH.getUser();
    const entry = { note: text, ts: new Date().toISOString(), author: user?.id || null };
    const updatedLog = [...currentJob.notesLog, entry];
    await writeTransitionRecord({ status: currentJob.jobType, destination: currentJob.destination, notes: text, mileage: currentJob.mileage });
    const { error } = await sb.from("service_jobs").update({
      notes_log: updatedLog.map(({ authorName, ...rest }) => rest), // strip the local-only display field before writing
      notes: text, updated_by: user?.id || null,
    }).eq("id", currentJob.id);
    if (btn) btn.disabled = false;
    if (error) { BL_UI.setMessage($("blMechJobMsg"), error.message || "Couldn't add the note.", "err"); return; }
    const names = await resolveNames([user?.id], "You");
    entry.authorName = names[user?.id] || "You";
    currentJob.notesLog = updatedLog;
    currentJob.notes = text;
    if (input) input.value = "";
    renderJobNotesLog();
    BL_TOAST.success("Note added.");
  }

  function wireJobModal() {
    $("blMechJobType")?.addEventListener("change", (e) => {
      if (!currentJob || isJobLocked()) return;
      currentJob.jobType = e.target.value;
      if (!currentJob.performedByTouched) currentJob.performedBy = VENDOR_DEFAULT.has(currentJob.jobType) ? "vendor" : "in_house";
      renderJobModal();
    });
    $("blMechJobMileage")?.addEventListener("input", (e) => {
      if (!currentJob) return;
      const v = parseInt(e.target.value, 10);
      currentJob.mileage = Number.isFinite(v) && v >= 0 ? v : null;
    });
    $("blMechJobPerformedBy")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-val]");
      if (!btn || !currentJob || isJobLocked()) return;
      currentJob.performedBy = btn.dataset.val;
      currentJob.performedByTouched = true;
      renderJobModal();
    });
    $("blMechJobVendor")?.addEventListener("change", (e) => { if (currentJob) currentJob.vendorId = e.target.value || null; });
    $("blMechJobDest")?.addEventListener("change", (e) => { if (currentJob) currentJob.destination = e.target.value || ""; });
    $("blMechJobActionOther")?.addEventListener("input", (e) => { if (currentJob) currentJob.serviceActionOther = e.target.value; });

    $("blMechJobPartAdd")?.addEventListener("click", onAddJobPart);
    $("blMechJobPartInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onAddJobPart(); } });
    $("blMechJobNoteAdd")?.addEventListener("click", onAddJobNote);
    $("blMechJobNoteInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onAddJobNote(); } });

    $("blMechJobWaitingBtn")?.addEventListener("click", () => onToggleWaitingPartsJob(true));
    $("blMechJobPartsArrivedBtn")?.addEventListener("click", () => onToggleWaitingPartsJob(false));

    $("blMechJobForm")?.addEventListener("submit", (e) => { e.preventDefault(); onSaveJob(); });
    $("blMechJobSendBtn")?.addEventListener("click", onSendOutJob);
    $("blMechJobReturnBtn")?.addEventListener("click", onMarkReturnedJob);
    $("blMechJobCloseBtn")?.addEventListener("click", onCloseJob);
    $("blMechJobClose")?.addEventListener("click", hideJobModal);
    $("blMechJobCancel")?.addEventListener("click", hideJobModal);
    $("blMechJobModal")?.addEventListener("click", (e) => { if (e.target.id === "blMechJobModal") hideJobModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("blMechJobModal")?.classList.contains("is-open")) hideJobModal();
    });
  }

  // VIN cells jump to the same VIN-history page the topbar search and
  // Records table use; row buttons open the job modal.
  function onSectionClick(e) {
    const vinBtn = e.target.closest("[data-vin-history]");
    if (vinBtn) {
      if (window.BL_RECORDS && BL_RECORDS.openVinHistory) BL_RECORDS.openVinHistory(vinBtn.dataset.vinHistory);
      return;
    }
    const manageBtnEl = e.target.closest("[data-manage-id]");
    if (manageBtnEl) { openJobFromId(manageBtnEl.dataset.manageId); return; }
    const startBtnEl = e.target.closest("[data-start-vin]");
    if (startBtnEl) { onStartJobFromFlagged(startBtnEl.dataset.startVin, startBtnEl.dataset.startType); return; }
  }

  function wireSort() {
    const dateCol = { type: "date" };
    openSortCtl = BL_SORT.attach({
      thead: $("blMechOpenThead"),
      columns: {
        serial_id: { get: (r) => r.serial_id, type: "string" },
        job_type: { get: (r) => r._jobTypeLabel, type: "string" },
        performed_by: { get: (r) => r._performedByText, type: "string" },
        mechanic: { get: (r) => r._mechanic, type: "string" },
        opened_at: { get: (r) => r.opened_at, ...dateCol },
      },
      default: { key: "opened_at", dir: "desc" },
      storageKey: "bl-mech-sort:open",
      onChange: renderOpenTable,
    });
    waitingSortCtl = BL_SORT.attach({
      thead: $("blMechWaitingThead"),
      columns: {
        serial_id: { get: (r) => r.serial_id, type: "string" },
        job_type: { get: (r) => r._jobTypeLabel, type: "string" },
        waiting_since: { get: (r) => r.waiting_since, ...dateCol },
        mechanic: { get: (r) => r._mechanic, type: "string" },
      },
      default: { key: "waiting_since", dir: "desc" },
      storageKey: "bl-mech-sort:waiting",
      onChange: renderWaitingTable,
    });
    vendorSortCtl = BL_SORT.attach({
      thead: $("blMechVendorThead"),
      columns: {
        serial_id: { get: (r) => r.serial_id, type: "string" },
        job_type: { get: (r) => r._jobTypeLabel, type: "string" },
        vendor: { get: (r) => r._vendorName, type: "string" },
        sent_out_at: { get: (r) => r.sent_out_at, ...dateCol },
        mechanic: { get: (r) => r._mechanic, type: "string" },
      },
      default: { key: "sent_out_at", dir: "desc" },
      storageKey: "bl-mech-sort:vendor",
      onChange: renderVendorTable,
    });
    closedSortCtl = BL_SORT.attach({
      thead: $("blMechClosedThead"),
      columns: {
        serial_id: { get: (r) => r.serial_id, type: "string" },
        job_type: { get: (r) => r._jobTypeLabel, type: "string" },
        close_status: { get: (r) => r._closeStatusLabel, type: "string" },
        closed_at: { get: (r) => r.closed_at, ...dateCol },
        mechanic: { get: (r) => r._mechanic, type: "string" },
      },
      default: { key: "closed_at", dir: "desc" },
      storageKey: "bl-mech-sort:closed",
      onChange: renderClosedTable,
    });
    flaggedSortCtl = BL_SORT.attach({
      thead: $("blMechFlaggedThead"),
      columns: {
        serial_id: { get: (r) => r.serial_id, type: "string" },
        current_status: { get: (r) => r._statusLabel, type: "string" },
        last_seen_at: { get: (r) => r.last_seen_at, ...dateCol },
      },
      default: { key: "last_seen_at", dir: "desc" },
      storageKey: "bl-mech-sort:flagged",
      onChange: renderFlaggedTable,
    });
  }

  function start() {
    if (started) return;
    started = true;
    populateJobTypeSelect();
    populateDestSelect();
    populateCloseStatusSelect();
    wireJobModal();
    wireSort();
    $("blMechRefresh")?.addEventListener("click", loadAll);
    $("section-mechanics")?.addEventListener("click", onSectionClick);
    loadAll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(loadAll, 30000);
    realtimeChan = sb.channel("backlot-mechanics")
      .on("postgres_changes", { event: "*", schema: "public", table: "service_jobs" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "vehicles" }, loadAll)
      .subscribe();
  }

  function stop() {
    started = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  document.addEventListener("bl-auth-change", () => { if (BL_AUTH.canEnter()) start(); else stop(); });
  if (BL_AUTH.canEnter()) start();
  document.addEventListener("bl-section-shown", (e) => { if (e.detail === "mechanics" && started) loadAll(); });

  window.BL_MECHANICS = { refresh: loadAll };
})();
