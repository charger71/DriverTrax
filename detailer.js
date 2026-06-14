// ============================================================
// DriverTrax Detailer
//   Phase A: shell (Scan/History panels, role plumbing)
//   Phase B: VIN load → notes list + add-note form
//   Phase C: conditions + dynamic todo + per-item done/note,
//            auto-saved to detail_jobs
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
  // CONDITION_TASKS above maps each id to the auto-generated todo items;
  // any condition without a tasks entry is descriptive only.
  const CONDITIONS = (window.DT_OPTIONS?.CONDITIONS) || [
    { id: "PRIORITY",     label: "Priority"     },
    { id: "PET_HAIR",     label: "Pet Hair"     },
    { id: "QUICK_FLIP",   label: "Quick Flip"   },
    { id: "REGULAR",      label: "Regular"      },
    { id: "DETAIL",       label: "Detail"       },
    { id: "SPIFFY",       label: "Spiffy"       },
    { id: "FUEL",         label: "Fuel"         },
    { id: "CHARGE",       label: "Charge"       },
    { id: "AIR",          label: "Air"          },
    { id: "WASHER_FLUID", label: "Washer Fluid" }
  ];

  // ---- state ----
  let started = false;
  let currentVin = null;
  let currentJob = null;          // { id, conditions: Set, todo: [{id,label,done,note,done_at}], serial_id }
  let saveTimer = null;

  function start() {
    if (started) return;
    started = true;
    $("detailScanBtn")?.addEventListener("click", () => {
      if (typeof openScanner === "function") openScanner();
      else alert("Scanner not loaded.");
    });
    $("detailScanManualBtn")?.addEventListener("click", (e) => {
      e.preventDefault();
      if (typeof openVinKeypad === "function") openVinKeypad("serial");
      else alert("VIN keypad not loaded.");
    });
    document.addEventListener("dt-vin-scanned", (e) => {
      if (!DT_AUTH.isDetailer()) return;
      loadVin(e.detail || $("serial")?.value || "");
    });
    $("serial")?.addEventListener("input", () => {
      if (!DT_AUTH.isDetailer()) return;
      const v = $("serial").value.trim().toUpperCase();
      if (v.length >= 6 && v !== currentVin) {
        clearTimeout(start._t);
        start._t = setTimeout(() => loadVin(v), 250);
      }
    });
  }

  function showLoaded() { $("detailScanEmpty").style.display = "none"; $("detailScanLoaded").style.display = ""; }
  function showEmpty()  {
    $("detailScanEmpty").style.display = "";
    $("detailScanLoaded").style.display = "none";
    currentVin = null;
    currentJob = null;
    loadOpenJobs();
  }

  async function loadVin(serialId) {
    if (!serialId) return;
    currentVin = serialId.toUpperCase();
    currentJob = { id: null, conditions: new Set(), todo: [], serial_id: currentVin, record_id: null };
    showLoaded();
    renderShell(currentVin);
    await tryResumeJob(currentVin);
    // If this is a fresh scan (no in-progress job to resume), drop a tracking
    // record row so managers can see the VIN was touched, same way drivers do.
    if (!currentJob.id) await createTrackingRecord();
    renderConditions();
    renderTodo();
  }

  async function createTrackingRecord() {
    const user = DT_AUTH.getUser();
    if (!user) return;
    const id = Date.now().toString();
    const ts = new Date().toISOString();
    const { error } = await sb.from("records").insert({
      id,
      user_id: user.id,
      serial_id: currentVin,
      status: "DETAILING",
      no_tag: false,
      shuttle: false,
      transport: false,
      ts,
      gps_error: true   // GPS gets filled in at Complete Job time
    });
    if (error) { console.warn("[Detail] tracking record create", error); return; }
    currentJob.record_id = id;
  }

  function renderShell(vin) {
    $("detailScanLoaded").innerHTML = `
      <div class="detail-vin-header">
        <div>
          <div class="detail-vin-label">VIN</div>
          <div class="detail-vin-value">${esc(vin)}</div>
        </div>
        <button type="button" class="btn btn-danger" id="detailVinCancel">Cancel</button>
      </div>

      <div class="detail-subhead">Conditions</div>
      <div class="detail-conditions" id="detailConditions"></div>

      <div class="detail-subhead">Today's todo</div>
      <div id="detailTodo"><div class="bl-empty">Pick a condition to generate the list.</div></div>

      <div class="detail-job-actions" id="detailJobActions" style="display:none">
        <button type="button" class="btn btn-primary" id="detailSaveJobBtn">Save Job</button>
        <button type="button" class="btn btn-primary" id="detailCompleteBtn" style="display:none">Complete Job</button>
      </div>

      <div id="detailNotesMount"></div>
    `;
    $("detailVinCancel").addEventListener("click", () => {
      if (currentJob && currentJob.id && !currentJob.completed_at) {
        if (!confirm("This job isn't marked complete yet. Leave anyway?")) return;
      }
      $("serial").value = "";
      showEmpty();
    });
    $("detailSaveJobBtn").addEventListener("click", onSaveJob);
    $("detailCompleteBtn").addEventListener("click", onCompleteJob);
    // If we resumed an already-saved job, surface Complete Job immediately.
    if (currentJob && currentJob.id) revealCompleteJob();
    // DT_VNOTES handles the notes list + add-note form (with photo + GPS)
    if (window.DT_VNOTES) {
      DT_VNOTES.mount($("detailNotesMount"), vin, { addWithMedia: true, showAdd: false });
    }
  }

  // Notes UI + GPS + photo handling all live in DT_VNOTES now.

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
  function renderConditions() {
    const el = $("detailConditions");
    if (!el) return;
    el.innerHTML = CONDITIONS.map(c => `
      <label class="cond-chip ${currentJob.conditions.has(c.id) ? "checked" : ""}">
        <input type="checkbox" value="${c.id}" ${currentJob.conditions.has(c.id) ? "checked" : ""}>
        <span>${esc(c.label)}</span>
      </label>
    `).join("");
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
    // Build the desired task set from selected conditions
    const want = new Set();
    currentJob.conditions.forEach(c => (CONDITION_TASKS[c] || []).forEach(t => want.add(t)));
    // Preserve any existing done state + notes; drop tasks no longer in want; add new ones
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
    const el = $("detailTodo");
    const actions = $("detailJobActions");
    if (!el) return;
    if (!currentJob.todo.length) {
      el.innerHTML = `<div class="bl-empty">Pick a condition to generate the list.</div>`;
      if (actions) actions.style.display = "none";
      return;
    }
    el.innerHTML = currentJob.todo.map((t, idx) => `
      <div class="todo-item ${t.done ? "done" : ""}" data-idx="${idx}">
        <label class="todo-check">
          <input type="checkbox" ${t.done ? "checked" : ""}>
          <span class="todo-label">${esc(t.label)}</span>
        </label>
        <button type="button" class="todo-note-toggle" title="Add note">${t.note ? "📝" : "➕"}</button>
        <textarea class="todo-note ${t.note ? "" : "hidden"}" placeholder="Optional note" maxlength="200">${esc(t.note)}</textarea>
      </div>
    `).join("");
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

  // Complete Job stays disabled until every todo item is checked. We also
  // reflect the gating in the title attribute so a paused detailer hovering
  // over the disabled button gets a hint about why it's grayed out.
  function updateCompleteBtnState() {
    const btn = $("detailCompleteBtn");
    if (!btn) return;
    const items = currentJob?.todo || [];
    const allDone = items.length > 0 && items.every(t => t.done);
    btn.disabled = !allDone;
    btn.title = allDone ? "" : "Finish every todo item to enable.";
  }

  // ---- persistence (auto-save) ----
  function scheduleSave() {
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
    const btn = $("detailCompleteBtn");
    if (btn) btn.style.display = "";
    updateCompleteBtnState();
  }

  async function onSaveJob() {
    const btn = $("detailSaveJobBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    // Flush any pending auto-save debounce so the row is written before we
    // expose Complete Job. If saveJob() insert fails (e.g. offline + RLS),
    // the user sees a console warn but the button still progresses — the
    // existing onCompleteJob path re-attempts a save.
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    await saveJob();
    if (btn) { btn.disabled = false; btn.textContent = "Save Job"; }
    revealCompleteJob();
    if (typeof showToast === "function") showToast("Job saved", "success");
  }

  async function onCompleteJob() {
    if (!currentJob || !currentJob.id) { await saveJob(); }
    const open = currentJob.todo.filter(t => !t.done).length;
    if (open > 0 && !confirm(`${open} item${open === 1 ? "" : "s"} still open. Complete anyway?`)) return;

    if (typeof showToast === "function") showToast("Capturing location…", "info");
    const loc = await DT_VNOTES.captureGps();
    const completedAt = new Date().toISOString();

    const jobUpdate = { completed_at: completedAt };
    if (loc) { jobUpdate.completion_lat = loc.lat; jobUpdate.completion_lng = loc.lng; }
    const { error } = await sb.from("detail_jobs").update(jobUpdate).eq("id", currentJob.id);
    if (error) { alert(error.message); return; }

    // Stamp the linked tracking record with the completion GPS + a final status.
    if (currentJob.record_id) {
      const recordUpdate = { status: "DETAILED" };
      if (loc) { recordUpdate.lat = loc.lat; recordUpdate.lng = loc.lng; recordUpdate.gps_error = false; }
      const { error: rErr } = await sb.from("records").update(recordUpdate).eq("id", currentJob.record_id);
      if (rErr) console.warn("[Detail] record update on complete", rErr);
    }

    currentJob.completed_at = completedAt;
    if (typeof showToast === "function") {
      showToast(loc ? "Job complete · location captured" : "Job complete (no GPS)", "success");
    }
    $("serial").value = "";
    showEmpty();
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
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; if (countEl) countEl.textContent = "0"; return; }
    if (!data || !data.length) {
      el.innerHTML = `<div class="bl-empty">No open jobs.</div>`;
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

  async function openJobFromHistory(jobId) {
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
    showLoaded();
    renderShell(currentVin);    // renderShell already mounts DT_VNOTES for the notes UI
    renderConditions();
    renderTodo();
    if (typeof showTab === "function") showTab("detail-scan");
  }

  document.addEventListener("dt-auth-change", () => {
    if (DT_AUTH.isDetailer && DT_AUTH.isDetailer()) start();
  });
  if (DT_AUTH.isDetailer && DT_AUTH.isDetailer()) start();

  document.addEventListener("dt-tab-shown", (e) => {
    if (e.detail === "detail-scan")    loadOpenJobs();
    if (e.detail === "dashboard")      renderDashboard();
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

    // Stat cards
    const todayCount = done.filter(j => new Date(j.completed_at) >= todayStart).length;
    const weekCount  = done.filter(j => new Date(j.completed_at) >= weekStart).length;
    const monthCount = done.filter(j => new Date(j.completed_at) >= monthStart).length;
    document.getElementById("detailStatToday").textContent = todayCount;
    document.getElementById("detailStatWeek").textContent  = weekCount;
    document.getElementById("detailStat30").textContent    = monthCount;
    document.getElementById("detailStatAll").textContent   = done.length;

    // Avg job time (start → complete) over the last 30 days
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

    // Mirror the detailer numbers into the global #avgBanner so the role sees
    // their own AVG CLEAN TIME + CARS/HOUR at the top of the dashboard.
    updateDetailerAvgBanner(done, todayStart, avgStr);

    // Condition breakdown for the 30-day window
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
      : `<div class="bl-empty">No jobs in the last 30 days.</div>`;

    // Recent jobs list
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
      : `<div class="bl-empty">No jobs yet.</div>`;
    recentEl.querySelectorAll(".detail-history-row").forEach(row => {
      row.addEventListener("click", () => openJobFromHistory(row.dataset.jobId));
    });
  }
  // Cars/hour for detailers = completed jobs today ÷ elapsed hours between
  // first and last completion (matches the driver-side formula in app.js).
  function updateDetailerAvgBanner(done, todayStart, avgStr) {
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

  window.DT_DETAIL = { loadVin, loadOpenJobs, renderDashboard, TASKS, CONDITIONS, CONDITION_TASKS };
})();
