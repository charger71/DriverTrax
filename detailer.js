// ============================================================
// DriverTrax Detailer
//   Unified with the driver NEW ENTRY form (#panel-entry). This module
//   mounts the detailer-specific bits (conditions chip list, job
//   checklist, Save Job / Complete Job footer) into the shared form,
//   and reuses the standard saveRecord() pipeline to create the
//   underlying records row.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const $ = (id) => document.getElementById(id);
  const esc = window.DT_ESC;
  const ago = (d) => window.DT_FORMAT.timeAgo(d);

  // ---- task catalog ----
  const TASKS = {
    TRASH:        "Trash",
    VACUUM:       "Vacuum",
    DISINFECT:    "Disinfect",
    DEODORIZE:    "Deodorize",
    WINDOWS:      "Windows",
    RESET_RADIO:  "Reset Radio",
    SCRUB:        "Scrub",
    WASH:         "Wash",
    CHECK_FLUIDS: "Check Air and Washer Fluids",
    FUEL:         "Fuel",
    CHARGE:       "Charge",
    ODOR:         "Odor Treatment"
  };

  // condition → which tasks it brings into the todo.
  // Tags without tasks (Priority, Pet Hair, Detail, Air, Washer Fluid) are
  // descriptive only — they mark the vehicle as needing extra time/effort
  // but don't add a checklist item.
  const CONDITION_TASKS = {
    PRIORITY:     [],
    PET_HAIR:     [],
    QUICK_FLIP:   ["TRASH","VACUUM","DISINFECT","DEODORIZE","WINDOWS","RESET_RADIO"],
    REGULAR:      ["TRASH","VACUUM","DISINFECT","DEODORIZE","WINDOWS","RESET_RADIO","SCRUB","WASH","CHECK_FLUIDS"],
    DETAIL:       [],
    SPIFFY:       ["ODOR"],
    FUEL:         ["FUEL"],
    CHARGE:       ["CHARGE"],
    AIR:          [],
    WASHER_FLUID: []
  };

  // Shared with the NEW ENTRY form via DT_OPTIONS (defined in app.js).
  const CONDITIONS = (window.DT_OPTIONS?.CONDITIONS) || [
    { id: "REGULAR",      label: "Regular"      },
    { id: "DETAIL",       label: "Detail"       },
    { id: "PET_HAIR",     label: "Pet Hair"     },
    { id: "SPIFFY",       label: "Spiffy"       },
    { id: "AIR",          label: "Air"          },
    { id: "WASHER_FLUID", label: "Washer Fluid" },
    { id: "FUEL",         label: "Fuel"         },
    { id: "CHARGE",       label: "Charge"       },
    { id: "QUICK_FLIP",   label: "Quick Flip"   },
    { id: "PRIORITY",     label: "Priority"     }
  ];

  // ---- state ----
  let started = false;
  let currentVin = null;
  let currentJob = null;          // { id, conditions: Set, todo: [...], serial_id, record_id, completed_at }
  let saveTimer = null;
  let mounted = false;

  function start() {
    if (started) return;
    started = true;
    // SCAN BARCODE button on the landing screen.
    $("detailScanBtn")?.addEventListener("click", () => {
      if (typeof openScanner === "function") openScanner();
      else alert("Scanner not loaded.");
    });
    $("detailScanManualBtn")?.addEventListener("click", (e) => {
      e.preventDefault();
      if (typeof openVinKeypad === "function") openVinKeypad("serial");
      else alert("VIN keypad not loaded.");
    });
    // VIN scanned anywhere in the app (including the shared panel-entry scan
    // button) — load it into the detailer flow.
    document.addEventListener("dt-vin-scanned", (e) => {
      if (!DT_AUTH.isDetailer()) return;
      loadVin(e.detail || $("serial")?.value || "");
    });
    // Driver's saveRecord() dispatches this once a row is inserted. We use the
    // resulting id as the detail_jobs.record_id so the two rows stay linked.
    document.addEventListener("dt-record-saved", (e) => {
      if (!DT_AUTH.isDetailer()) return;
      const det = e.detail || {};
      if (!currentJob || !currentJob.serial_id) return;
      if (det.serialId && det.serialId.toUpperCase() !== currentJob.serial_id) return;
      currentJob.record_id = det.id;
      saveJob().then(revealCompleteJob);
    });
  }

  // Mount detailer-only behavior onto the shared #panel-entry form once.
  function ensureMounted() {
    if (mounted) return;
    mounted = true;
    $("entrySaveJobBtn")?.addEventListener("click", () => {
      const mode = $("entrySaveJobBtn")?.dataset.mode || "save";
      if (mode === "complete") onCompleteJob();
      else onSaveJob();
    });
  }

  // The detailer's landing screen (Open Jobs / This Shift) lives in
  // #panel-detail-scan but the actual work form lives in #panel-entry.
  function showLandingScreen() {
    currentVin = null;
    currentJob = null;
    hideJobActions();
    setLockedBanner(null);
    if (typeof showTab === "function") showTab("detail-scan");
    loadOpenJobs();
    loadShiftJobs();
  }

  async function loadVin(serialId) {
    if (!serialId) return;
    ensureMounted();
    currentVin = serialId.toUpperCase();
    currentJob = { id: null, conditions: new Set(), todo: [], serial_id: currentVin, record_id: null };

    // Fill the shared Serial input — saveRecord() reads from #serial.
    const serialInput = $("serial");
    if (serialInput) serialInput.value = currentVin;

    // Land the detailer on the unified entry form. The dt-vin-scanned listener
    // in app.js will hydrate #entryCurrentState and the Mileage / Fuel hints.
    if (typeof showTab === "function") showTab("entry");

    await tryResumeJob(currentVin);
    // No in-progress job — fall back to the vehicle's last known conditions so
    // the detailer sees the todo carried over instead of always starting fresh.
    if (!currentJob.id && currentJob.conditions.size === 0) {
      await seedConditionsFromVehicle(currentVin);
    }
    if (!currentJob.id && currentJob.conditions.size === 0) {
      currentJob.conditions.add("REGULAR");
    }
    rebuildTodoFromConditions();
    renderConditions();
    renderTodo();
    setLockedBanner(isJobLocked() ? currentJob.completed_at : null);

    // Expose Save / Complete buttons.
    const actions = $("entryJobActions");
    if (actions && !isJobLocked()) actions.style.display = "";
    if (currentJob.id) revealCompleteJob();

    // Open the Conditions disclosure so the carried-over chips are visible.
    const condCollapse = $("entryConditionsCollapse");
    if (condCollapse) condCollapse.open = true;
  }

  async function seedConditionsFromVehicle(vin) {
    try {
      const { data } = await sb
        .from("vehicles")
        .select("current_conditions")
        .eq("serial_id", vin)
        .maybeSingle();
      const list = Array.isArray(data?.current_conditions) ? data.current_conditions : [];
      list.forEach(id => currentJob.conditions.add(id));
    } catch (e) {
      console.warn("[Detail] seed conditions from vehicle", e);
    }
  }

  // Try to resume an existing in-progress job for this VIN + detailer.
  async function tryResumeJob(vin) {
    const user = DT_AUTH.getUser();
    const { data } = await sb
      .from("detail_jobs")
      .select("id,condition_tags,todo_state,completed_at,record_id")
      .eq("detailer_id", user.id)
      .eq("serial_id", vin)
      .is("completed_at", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return;
    currentJob.id = data.id;
    currentJob.conditions = new Set(data.condition_tags || []);
    currentJob.todo = Array.isArray(data.todo_state) ? data.todo_state : [];
    currentJob.record_id = data.record_id || null;
  }

  // ---- conditions ----
  function isJobLocked() {
    return !!(currentJob && currentJob.completed_at);
  }

  function setLockedBanner(completedAt) {
    const el = $("entryLockedBanner");
    if (!el) return;
    if (!completedAt) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "";
    el.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-lock"/></svg> Job completed ${esc(ago(completedAt))} — read-only.`;
  }

  function hideJobActions() {
    const actions = $("entryJobActions");
    if (actions) actions.style.display = "none";
    const sBtn = $("entrySaveJobBtn");
    if (sBtn) { sBtn.style.display = ""; sBtn.dataset.mode = "save"; sBtn.textContent = "Save Job"; }
  }

  function renderConditions() {
    const el = $("detailConditions");
    if (!el) return;
    const locked = isJobLocked();
    el.innerHTML = CONDITIONS.map(c => `
      <label class="cond-chip ${currentJob.conditions.has(c.id) ? "checked" : ""} ${locked ? "is-locked" : ""}">
        <input type="checkbox" value="${c.id}" ${currentJob.conditions.has(c.id) ? "checked" : ""} ${locked ? "disabled" : ""}>
        <span>${esc(c.label)}</span>
      </label>
    `).join("");
    if (locked) return;
    el.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("change", () => {
        if (inp.checked) currentJob.conditions.add(inp.value);
        else currentJob.conditions.delete(inp.value);
        inp.closest(".cond-chip").classList.toggle("checked", inp.checked);
        rebuildTodoFromConditions();
        renderTodo();
        scheduleSave();
      });
    });
  }

  function rebuildTodoFromConditions() {
    const want = new Set();
    currentJob.conditions.forEach(c => (CONDITION_TASKS[c] || []).forEach(t => want.add(t)));
    const existing = new Map(currentJob.todo.map(t => [t.id, t]));
    const next = [];
    [...want].forEach(taskId => {
      if (existing.has(taskId)) next.push(existing.get(taskId));
      else next.push({ id: taskId, label: TASKS[taskId] || taskId, done: false, note: "", done_at: null });
    });
    currentJob.todo = next;
  }

  // ---- todo ----
  function renderTodo() {
    const el = $("entryJobChecklistBody");
    const actions = $("entryJobActions");
    if (!el) return;
    const locked = isJobLocked();
    if (!currentJob.todo.length) {
      el.innerHTML = `<div class="u-empty">Pick a condition to generate the list.</div>`;
      if (actions && !currentJob.id) actions.style.display = "none";
      return;
    }
    el.innerHTML = currentJob.todo.map((t, idx) => `
      <div class="todo-item ${t.done ? "done" : ""} ${locked ? "is-locked" : ""}" data-idx="${idx}">
        <label class="todo-check">
          <input type="checkbox" ${t.done ? "checked" : ""} ${locked ? "disabled" : ""}>
          <span class="todo-label">${esc(t.label)}</span>
        </label>
        ${locked
          ? (t.note ? `<span class="todo-note-locked" aria-label="Note"><svg class="icon" aria-hidden="true"><use href="#icon-note"/></svg></span>` : "")
          : `<button type="button" class="todo-note-toggle" title="Add note"><svg class="icon" aria-hidden="true"><use href="#${t.note ? "icon-note" : "icon-plus"}"/></svg></button>`}
        <textarea class="todo-note ${t.note ? "" : "hidden"}" placeholder="Optional note" maxlength="200" ${locked ? "readonly" : ""}>${esc(t.note)}</textarea>
      </div>
    `).join("");
    if (locked) {
      if (actions) actions.style.display = "none";
      return;
    }
    el.querySelectorAll(".todo-item").forEach(row => {
      const idx = parseInt(row.dataset.idx, 10);
      row.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
        currentJob.todo[idx].done = e.target.checked;
        currentJob.todo[idx].done_at = e.target.checked ? new Date().toISOString() : null;
        row.classList.toggle("done", e.target.checked);
        updateCompleteBtnState();
        scheduleSave();
      });
      row.querySelector(".todo-note-toggle").addEventListener("click", () => {
        const ta = row.querySelector(".todo-note");
        ta.classList.toggle("hidden");
        if (!ta.classList.contains("hidden")) ta.focus();
      });
      row.querySelector(".todo-note").addEventListener("input", (e) => {
        currentJob.todo[idx].note = e.target.value;
        scheduleSave();
      });
    });
    if (actions) actions.style.display = "";
    updateCompleteBtnState();
  }

  // Save Job morphs into Complete Job once every todo item is checked.
  // Stays "Save Job" otherwise so detailers can persist in-progress work.
  function updateCompleteBtnState() {
    const btn = $("entrySaveJobBtn");
    if (!btn) return;
    const items = currentJob?.todo || [];
    const allDone = items.length > 0 && items.every(t => t.done);
    if (allDone) {
      btn.dataset.mode = "complete";
      btn.textContent = "Complete Job";
    } else {
      btn.dataset.mode = "save";
      btn.textContent = "Save Job";
    }
  }

  // ---- persistence (auto-save) ----
  function scheduleSave() {
    if (isJobLocked()) return;
    if (!currentJob || !currentJob.id) return; // wait until Save Job creates the row
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveJob, 500);
  }

  async function saveJob() {
    if (!currentJob) return;
    const user = DT_AUTH.getUser();
    if (!user) return;
    const payload = {
      detailer_id: user.id,
      serial_id: currentJob.serial_id,
      condition_tags: [...currentJob.conditions],
      todo_state: currentJob.todo,
      record_id: currentJob.record_id || null
    };
    if (currentJob.id) {
      const { error } = await sb.from("detail_jobs").update(payload).eq("id", currentJob.id);
      if (error) console.warn("[Detail] save", error);
    } else {
      const { data, error } = await sb.from("detail_jobs").insert(payload).select("id").single();
      if (error) { console.warn("[Detail] insert", error); return; }
      currentJob.id = data.id;
    }
  }

  function revealCompleteJob() {
    if (isJobLocked()) {
      const saveBtn = $("entrySaveJobBtn");
      if (saveBtn) saveBtn.style.display = "none";
      const actions = $("entryJobActions");
      if (actions) actions.style.display = "none";
      return;
    }
    updateCompleteBtnState();
  }

  // Save Job: trigger the standard saveRecord() pipeline so mileage / fuel /
  // notes / photo all save via the driver path. The dt-record-saved listener
  // picks up the inserted record id, links it to detail_jobs, and reveals
  // Complete Job. If saveRecord can't run (no status picked yet), fall back
  // to just persisting the detail_jobs row so progress isn't lost.
  async function onSaveJob() {
    const btn = $("entrySaveJobBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

    const statusVal = $("status")?.value || "";
    if (statusVal && typeof saveRecord === "function") {
      // saveRecord is async-ish (GPS + photo upload) — the dt-record-saved
      // event will fire on success and we'll link record_id then.
      try { saveRecord(); } catch (e) { console.warn("[Detail] saveRecord", e); }
    } else {
      // No status picked — just persist the detail_jobs row so the conditions
      // and checklist survive. The detailer can come back, set status, and
      // hit Save Job again to create the tracking record.
      await saveJob();
    }

    if (btn) btn.disabled = false;
    // revealCompleteJob runs from dt-record-saved when the standard save
    // pipeline completes. For the fallback path, expose it now.
    // updateCompleteBtnState restores the right label ("Save Job" or "Complete Job").
    if (currentJob && currentJob.id) revealCompleteJob();
    else updateCompleteBtnState();
    if (typeof showToast === "function" && !statusVal) showToast("Progress saved — set Status to file a record", "info");
  }

  async function onCompleteJob() {
    if (!currentJob || !currentJob.id) { await saveJob(); }
    const open = currentJob.todo.filter(t => !t.done).length;
    if (open > 0 && !confirm(`${open} item${open === 1 ? "" : "s"} still open. Complete anyway?`)) return;

    if (typeof showToast === "function") showToast("Capturing location…", "info");
    const loc = await DT_MEDIA.captureGps();
    const completedAt = new Date().toISOString();

    const jobUpdate = { completed_at: completedAt };
    if (loc) { jobUpdate.completion_lat = loc.lat; jobUpdate.completion_lng = loc.lng; }
    const { error } = await sb.from("detail_jobs").update(jobUpdate).eq("id", currentJob.id);
    if (error) { alert(error.message); return; }

    // Stamp the linked tracking record with the completion GPS + CLEAN status
    // so the VIN's current_status flips to CLEAN as soon as the detailer
    // submits, matching how the rest of the app reads "ready to roll".
    if (currentJob.record_id) {
      const recordUpdate = { status: "CLEAN" };
      if (loc) { recordUpdate.lat = loc.lat; recordUpdate.lng = loc.lng; recordUpdate.gps_error = false; }
      const { error: rErr } = await sb.from("records").update(recordUpdate).eq("id", currentJob.record_id);
      if (rErr) console.warn("[Detail] record update on complete", rErr);
    }

    currentJob.completed_at = completedAt;
    if (typeof showToast === "function") {
      showToast(loc ? "Job complete · location captured" : "Job complete (no GPS)", "success");
    }
    const serialEl = $("serial");
    if (serialEl) serialEl.value = "";
    showLandingScreen();
  }

  // ---- Open Jobs (shown under New Entry while no VIN is loaded) ----
  async function loadOpenJobs() {
    const user = DT_AUTH.getUser();
    if (!user) return;
    const el = $("detailOpenJobsList");
    const countEl = $("detailOpenJobsCount");
    if (!el) return;
    const { data, error } = await sb
      .from("detail_jobs")
      .select("id,serial_id,condition_tags,started_at")
      .eq("detailer_id", user.id)
      .is("completed_at", null)
      .order("started_at", { ascending: false })
      .limit(50);
    if (error) { el.innerHTML = `<div class="u-empty">${esc(error.message)}</div>`; if (countEl) countEl.textContent = "0"; return; }
    if (!data || !data.length) {
      el.innerHTML = `<div class="u-empty">No open jobs.</div>`;
      if (countEl) countEl.textContent = "0";
      return;
    }
    if (countEl) countEl.textContent = String(data.length);
    el.innerHTML = data.map(j => `
      <div class="detail-history-row open" data-job-id="${esc(j.id)}">
        <div class="detail-history-serial">${esc(j.serial_id)}</div>
        <div class="detail-history-meta">
          In progress · ${esc(ago(j.started_at))}
          ${j.condition_tags && j.condition_tags.length ? " · " + j.condition_tags.map(esc).join(" · ") : ""}
        </div>
      </div>
    `).join("");
    el.querySelectorAll(".detail-history-row").forEach(row => {
      row.addEventListener("click", () => openJobFromHistory(row.dataset.jobId));
    });
  }

  // ---- This Shift (today's jobs, open + closed, with VIN current status) ----
  async function loadShiftJobs() {
    const user = DT_AUTH.getUser();
    if (!user) return;
    const el = $("detailShiftJobsList");
    const countEl = $("detailShiftJobsCount");
    if (!el) return;
    const now = new Date();
    const estParts = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const shiftStart = new Date(estParts.getFullYear(), estParts.getMonth(), estParts.getDate()).toISOString();

    const { data: jobs, error } = await sb
      .from("detail_jobs")
      .select("id,serial_id,condition_tags,started_at,completed_at")
      .eq("detailer_id", user.id)
      .gte("started_at", shiftStart)
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) { el.innerHTML = `<div class="u-empty">${esc(error.message)}</div>`; if (countEl) countEl.textContent = "0"; return; }
    if (!jobs || !jobs.length) {
      el.innerHTML = `<div class="u-empty">No jobs this shift yet.</div>`;
      if (countEl) countEl.textContent = "0";
      return;
    }
    if (countEl) countEl.textContent = String(jobs.length);

    const vins = [...new Set(jobs.map(j => j.serial_id).filter(Boolean))];
    const statusByVin = {};
    if (vins.length) {
      const { data: vehs } = await sb
        .from("vehicles")
        .select("serial_id,current_status,current_status_other")
        .in("serial_id", vins);
      (vehs || []).forEach(v => {
        const disp = v.current_status === "OTHER" && v.current_status_other
          ? `OTHER: ${v.current_status_other}`
          : (typeof statusLabel === "function" ? statusLabel(v.current_status) : v.current_status || "");
        statusByVin[v.serial_id] = { code: v.current_status || "", disp };
      });
    }

    el.innerHTML = jobs.map(j => {
      const done = !!j.completed_at;
      const when = ago(done ? j.completed_at : j.started_at);
      const vinStatus = statusByVin[j.serial_id];
      const statusPill = vinStatus?.code
        ? `<span class="record-status ${typeof statusClass === "function" ? statusClass(vinStatus.code) : ""}">${esc(vinStatus.disp)}</span>`
        : "";
      const condChips = j.condition_tags && j.condition_tags.length
        ? j.condition_tags.map(esc).join(" · ")
        : "";
      return `
        <div class="detail-history-row ${done ? "done" : "open"}" data-job-id="${esc(j.id)}">
          <div class="detail-history-serial">${esc(j.serial_id)}</div>
          <div class="detail-history-meta">
            ${done ? "Done" : "In progress"} · ${esc(when)}
            ${condChips ? " · " + condChips : ""}
          </div>
          ${statusPill ? `<div class="detail-history-status">VIN status: ${statusPill}</div>` : ""}
        </div>
      `;
    }).join("");
    el.querySelectorAll(".detail-history-row").forEach(row => {
      row.addEventListener("click", () => openJobFromHistory(row.dataset.jobId));
    });
  }

  async function openJobFromHistory(jobId) {
    ensureMounted();
    const { data, error } = await sb
      .from("detail_jobs")
      .select("id,serial_id,condition_tags,todo_state,completed_at,record_id")
      .eq("id", jobId)
      .maybeSingle();
    if (error || !data) { alert(error?.message || "Job not found"); return; }
    currentVin = data.serial_id;
    currentJob = {
      id: data.id,
      serial_id: data.serial_id,
      conditions: new Set(data.condition_tags || []),
      todo: Array.isArray(data.todo_state) ? data.todo_state : [],
      completed_at: data.completed_at,
      record_id: data.record_id || null
    };
    const serialInput = $("serial");
    if (serialInput) serialInput.value = currentVin;
    if (typeof showTab === "function") showTab("entry");
    // Trigger the shared scan-handler so current-state info + placeholders fill.
    document.dispatchEvent(new CustomEvent("dt-vin-scanned", { detail: currentVin }));
    renderConditions();
    renderTodo();
    setLockedBanner(isJobLocked() ? currentJob.completed_at : null);
    revealCompleteJob();
    const condCollapse = $("entryConditionsCollapse");
    if (condCollapse) condCollapse.open = true;
  }

  document.addEventListener("dt-auth-change", () => {
    if (DT_AUTH.isDetailer && DT_AUTH.isDetailer()) start();
  });
  if (DT_AUTH.isDetailer && DT_AUTH.isDetailer()) start();

  document.addEventListener("dt-tab-shown", (e) => {
    if (e.detail === "detail-scan") { loadOpenJobs(); loadShiftJobs(); }
    if (e.detail === "dashboard")   renderDashboard();
    // Entering the entry tab fresh (no VIN loaded) — make sure stale detail
    // UI from a previous VIN doesn't linger.
    if (e.detail === "entry" && DT_AUTH.isDetailer && DT_AUTH.isDetailer() && !currentVin) {
      hideJobActions();
      setLockedBanner(null);
      const body = $("entryJobChecklistBody");
      if (body) body.innerHTML = `<div class="u-empty">Pick a condition to generate the list.</div>`;
      const dc = $("detailConditions");
      if (dc) dc.innerHTML = "";
    }
  });

  // ---- personal dashboard ----
  async function renderDashboard() {
    const user = DT_AUTH.getUser();
    if (!user) return;
    const todayStart = startOfDay(new Date());
    const weekStart  = startOfDay(addDays(new Date(), -7));
    const monthStart = startOfDay(addDays(new Date(), -30));

    const { data, error } = await sb
      .from("detail_jobs")
      .select("id,serial_id,condition_tags,completed_at,started_at")
      .eq("detailer_id", user.id)
      .order("started_at", { ascending: false })
      .limit(500);
    if (error) { console.warn("[Detail Dash]", error); return; }
    const jobs = data || [];
    const done = jobs.filter(j => j.completed_at);

    const todayCount = done.filter(j => new Date(j.completed_at) >= todayStart).length;
    const weekCount  = done.filter(j => new Date(j.completed_at) >= weekStart).length;
    const monthCount = done.filter(j => new Date(j.completed_at) >= monthStart).length;
    document.getElementById("detailStatToday").textContent = todayCount;
    document.getElementById("detailStatWeek").textContent  = weekCount;
    document.getElementById("detailStat30").textContent    = monthCount;
    document.getElementById("detailStatAll").textContent   = done.length;

    const recent = done.filter(j => j.completed_at && j.started_at && new Date(j.completed_at) >= monthStart);
    let avgStr = "—";
    if (recent.length) {
      const avgMs = recent.reduce((a, j) => a + (new Date(j.completed_at) - new Date(j.started_at)), 0) / recent.length;
      const mins = Math.round(avgMs / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      avgStr = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    }
    document.getElementById("detailStatAvg").textContent = avgStr;

    updateDetailerAvgBanner(done, todayStart, avgStr);

    const byCond = {};
    done
      .filter(j => new Date(j.completed_at) >= monthStart)
      .forEach(j => (j.condition_tags || []).forEach(c => { byCond[c] = (byCond[c] || 0) + 1; }));
    const entries = Object.entries(byCond).sort((a, b) => b[1] - a[1]);
    const max = entries[0]?.[1] || 1;
    const bd = document.getElementById("detailConditionsBreakdown");
    bd.innerHTML = entries.length
      ? entries.map(([c, n]) => {
          const label = (CONDITIONS.find(x => x.id === c) || {}).label || c;
          return `<div class="bl-bar-row"><div class="label">${esc(label)}</div><div class="bar"><span style="width:${(n/max)*100}%"></span></div><div class="count">${n}</div></div>`;
        }).join("")
      : `<div class="u-empty">No jobs in the last 30 days.</div>`;

    const recentRows = jobs.slice(0, 10);
    const recentEl = document.getElementById("detailRecentList");
    recentEl.innerHTML = recentRows.length
      ? recentRows.map(j => `
          <div class="detail-history-row ${j.completed_at ? "done" : "open"}" data-job-id="${esc(j.id)}">
            <div class="detail-history-serial">${esc(j.serial_id)}</div>
            <div class="detail-history-meta">
              ${j.completed_at ? "Done" : "In progress"} · ${esc(ago(j.completed_at || j.started_at))}
              ${j.condition_tags && j.condition_tags.length ? " · " + j.condition_tags.map(esc).join(" · ") : ""}
            </div>
          </div>
        `).join("")
      : `<div class="u-empty">No jobs yet.</div>`;
    recentEl.querySelectorAll(".detail-history-row").forEach(row => {
      row.addEventListener("click", () => openJobFromHistory(row.dataset.jobId));
    });
  }
  function updateDetailerAvgBanner(done, todayStart, avgStr) {
    if (!document.body.classList.contains("is-detailer")) return;
    const banner = document.getElementById("avgBanner");
    if (!banner) return;
    const todayDone = done.filter(j => new Date(j.completed_at) >= todayStart);
    if (todayDone.length < 2) { banner.style.display = "none"; return; }
    const ts = todayDone.map(j => new Date(j.completed_at).getTime()).sort((a, b) => a - b);
    const elapsedHrs = (ts[ts.length - 1] - ts[0]) / 3600000;
    const cph = elapsedHrs > 0 ? (ts.length / elapsedHrs).toFixed(1) : "—";
    const lbl = document.getElementById("avgBannerTimeLabel");
    if (lbl) lbl.textContent = "AVG CLEAN TIME";
    document.getElementById("avgBannerTime").textContent = avgStr;
    document.getElementById("avgBannerCph").textContent  = cph;
    banner.style.display = "block";
  }
  function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  window.DT_DETAIL = { loadVin, loadOpenJobs, loadShiftJobs, renderDashboard, TASKS, CONDITIONS, CONDITION_TASKS };
})();
