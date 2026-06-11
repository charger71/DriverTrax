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
  const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const ago = (d) => (window.dtTimeAgo ? window.dtTimeAgo(d) : new Date(d).toLocaleString());

  // ---- task catalog ----
  const TASKS = {
    TRASH:         "Trash",
    VACUUM:        "Vacuum",
    DISINFECT:     "Disinfect",
    DEODORIZE:     "Deodorize",
    WINDOWS:       "Windows",
    RESET_RADIO:   "Reset Radio",
    RESET_OIL:     "Reset Oil",
    AIR:           "Air",
    WASHER_FLUID:  "Washer Fluid",
    SCRUB:         "Scrub",
    WASH:          "Wash"
  };

  // condition → which tasks it brings into the todo
  const CONDITION_TASKS = {
    PRIORITY:     [],   // flag only, no tasks of its own
    PET_HAIR:     ["VACUUM"],
    QUICK_FLIP:   ["TRASH","VACUUM","WINDOWS","RESET_RADIO"],
    DETAIL:       ["TRASH","VACUUM","DISINFECT","DEODORIZE","WINDOWS","RESET_RADIO","RESET_OIL","SCRUB"],
    AIR:          ["AIR"],
    WASHER_FLUID: ["WASHER_FLUID"],
    SPIFFY:       ["TRASH","VACUUM","WINDOWS","WASH"]
  };

  const CONDITIONS = [
    { id: "PRIORITY",     label: "Priority"     },
    { id: "PET_HAIR",     label: "Pet Hair"     },
    { id: "QUICK_FLIP",   label: "Quick Flip"   },
    { id: "DETAIL",       label: "Detail"       },
    { id: "AIR",          label: "Air"          },
    { id: "WASHER_FLUID", label: "Washer Fluid" },
    { id: "SPIFFY",       label: "Spiffy"       }
  ];

  // ---- state ----
  let started = false;
  let currentVin = null;
  let currentJob = null;          // { id, conditions: Set, todo: [{id,label,done,note,done_at}], serial_id }
  let saveTimer = null;
  const profileCache = new Map();

  async function fetchProfileNames(ids) {
    const missing = [...new Set(ids)].filter(id => id && !profileCache.has(id));
    if (!missing.length) return;
    const { data } = await sb.from("profiles").select("id,display_name,role").in("id", missing);
    (data || []).forEach(p => profileCache.set(p.id, p));
  }

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
  }

  async function loadVin(serialId) {
    if (!serialId) return;
    currentVin = serialId.toUpperCase();
    currentJob = { id: null, conditions: new Set(), todo: [], serial_id: currentVin };
    showLoaded();
    renderShell(currentVin);
    await Promise.all([loadNotes(currentVin), tryResumeJob(currentVin)]);
    renderConditions();
    renderTodo();
  }

  function renderShell(vin) {
    $("detailScanLoaded").innerHTML = `
      <div class="detail-vin-header">
        <div>
          <div class="detail-vin-label">VIN</div>
          <div class="detail-vin-value">${esc(vin)}</div>
        </div>
        <button type="button" class="btn btn-secondary" id="detailVinClose">Done</button>
      </div>

      <div class="detail-subhead">Conditions</div>
      <div class="detail-conditions" id="detailConditions"></div>

      <div class="detail-subhead">Today's todo</div>
      <div id="detailTodo"><div class="bl-empty">Pick a condition to generate the list.</div></div>

      <div class="detail-job-actions" id="detailJobActions" style="display:none">
        <button type="button" class="btn btn-primary" id="detailCompleteBtn">Complete Job</button>
      </div>

      <div class="detail-subhead">Notes from the team</div>
      <div id="detailNotesList"><div class="bl-empty">Loading…</div></div>

      <div class="detail-subhead">Add a note</div>
      <form id="detailNoteForm" class="bl-form">
        <textarea name="body" placeholder="Anything the next person should know…" required maxlength="1000"></textarea>
        <div class="note-attach-row">
          <label class="note-attach-chip">
            <input type="checkbox" id="noteGpsInput">
            <span>📍 <span id="noteGpsLabel">Attach location</span></span>
          </label>
          <label class="note-attach-chip" id="noteCameraBtn">
            <input type="file" id="notePhotoInput" accept="image/*" capture="environment" hidden>
            <span>📷 Add photo</span>
          </label>
        </div>
        <div class="note-photo-preview" id="notePhotoPreview" style="display:none">
          <img id="notePhotoImg" alt="Selected photo">
          <button type="button" id="notePhotoRemove" aria-label="Remove">✕</button>
        </div>
        <button type="submit" class="btn btn-primary">Save Note</button>
      </form>
    `;
    $("detailVinClose").addEventListener("click", () => {
      if (currentJob && currentJob.id && !currentJob.completed_at) {
        if (!confirm("This job isn't marked complete yet. Leave anyway?")) return;
      }
      $("serial").value = "";
      showEmpty();
    });
    $("detailNoteForm").addEventListener("submit", onAddNote);
    $("detailCompleteBtn").addEventListener("click", onCompleteJob);
    wireAttachments();
  }

  // ---- attachments (GPS + photo) ----
  let pendingPhotoBlob = null;
  let pendingGps = null;

  function wireAttachments() {
    pendingPhotoBlob = null;
    pendingGps = null;

    const gpsInput = $("noteGpsInput");
    const gpsLabel = $("noteGpsLabel");
    gpsInput?.addEventListener("change", async () => {
      if (gpsInput.checked) {
        gpsLabel.textContent = "Locating…";
        const loc = await captureGps();
        if (!loc) {
          gpsInput.checked = false;
          gpsLabel.textContent = "Location unavailable";
          pendingGps = null;
          return;
        }
        pendingGps = loc;
        gpsLabel.textContent = `Location attached (±${Math.round(loc.acc || 0)}m)`;
      } else {
        pendingGps = null;
        gpsLabel.textContent = "Attach location";
      }
    });

    const photoInput = $("notePhotoInput");
    const previewWrap = $("notePhotoPreview");
    const previewImg = $("notePhotoImg");
    photoInput?.addEventListener("change", async () => {
      const file = photoInput.files?.[0];
      if (!file) return;
      try {
        const blob = await resizeImageBlob(file, 1920, 1080, 0.85);
        pendingPhotoBlob = blob;
        previewImg.src = URL.createObjectURL(blob);
        previewWrap.style.display = "";
      } catch (e) {
        console.warn("[Detail] resize failed", e);
        alert("Couldn't process that image.");
      }
    });
    $("notePhotoRemove")?.addEventListener("click", () => {
      pendingPhotoBlob = null;
      photoInput.value = "";
      previewWrap.style.display = "none";
      previewImg.src = "";
    });
  }

  function captureGps() {
    return new Promise(resolve => {
      if (!("geolocation" in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        () => resolve(null),
        { timeout: 8000, enableHighAccuracy: true, maximumAge: 30000 }
      );
    });
  }

  async function resizeImageBlob(file, maxW, maxH, quality) {
    const bmp = await createImageBitmap(file);
    const ratio = Math.min(maxW / bmp.width, maxH / bmp.height, 1);
    const w = Math.round(bmp.width * ratio);
    const h = Math.round(bmp.height * ratio);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    return new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
  }

  async function uploadPhoto(blob) {
    const user = DT_AUTH.getUser();
    if (!user) throw new Error("Not signed in");
    const path = `${user.id}/${currentVin}-${Date.now()}.jpg`;
    const { error } = await sb.storage
      .from("vehicle-photos")
      .upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (error) throw error;
    return path;
  }

  // Try to resume an existing in-progress job for this VIN + detailer.
  async function tryResumeJob(vin) {
    const user = DT_AUTH.getUser();
    const { data } = await sb
      .from("detail_jobs")
      .select("id,condition_tags,todo_state,completed_at")
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
      todo_state: currentJob.todo
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

  async function onCompleteJob() {
    if (!currentJob || !currentJob.id) { await saveJob(); }
    const open = currentJob.todo.filter(t => !t.done).length;
    if (open > 0 && !confirm(`${open} item${open === 1 ? "" : "s"} still open. Complete anyway?`)) return;

    if (typeof showToast === "function") showToast("Capturing location…", "info");
    const loc = await captureGps();   // single capture at completion time

    const update = { completed_at: new Date().toISOString() };
    if (loc) {
      update.completion_lat = loc.lat;
      update.completion_lng = loc.lng;
    }
    const { error } = await sb.from("detail_jobs").update(update).eq("id", currentJob.id);
    if (error) { alert(error.message); return; }

    currentJob.completed_at = update.completed_at;
    if (typeof showToast === "function") {
      showToast(loc ? "Job complete · location captured" : "Job complete (no GPS)", "success");
    }
    $("serial").value = "";
    showEmpty();
  }

  // ---- notes (Phase B) ----
  async function loadNotes(vin) {
    const { data, error } = await sb
      .from("vehicle_notes")
      .select("id,body,author_id,created_at,archived,lat,lng,photo_url")
      .eq("serial_id", vin)
      .eq("archived", false)
      .order("created_at", { ascending: false })
      .limit(50);
    const el = $("detailNotesList");
    if (!el) return;
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }
    if (!data || !data.length) {
      el.innerHTML = `<div class="bl-empty">No notes on this VIN yet.</div>`;
      return;
    }
    await fetchProfileNames(data.map(n => n.author_id));

    // Sign all photo paths in one call (10-min expiry — plenty for browse)
    const photoPaths = [...new Set(data.filter(n => n.photo_url).map(n => n.photo_url))];
    const signedUrls = {};
    if (photoPaths.length) {
      const { data: signed, error: sErr } = await sb.storage
        .from("vehicle-photos")
        .createSignedUrls(photoPaths, 600);
      if (sErr) console.warn("[Detail] signed urls", sErr);
      (signed || []).forEach(s => { signedUrls[s.path] = s.signedUrl; });
    }

    const myId = DT_AUTH.getUser()?.id;
    el.innerHTML = data.map(n => {
      const p = profileCache.get(n.author_id);
      const name = p?.display_name || "Someone";
      const roleLabel = p?.role ? ` <span class="note-role role-${esc(p.role)}">${esc(p.role)}</span>` : "";
      const mine = n.author_id === myId;
      const photoHtml = n.photo_url && signedUrls[n.photo_url]
        ? `<div class="note-photo"><img src="${esc(signedUrls[n.photo_url])}" alt="" data-full="${esc(signedUrls[n.photo_url])}"></div>`
        : "";
      const gpsHtml = (Number.isFinite(n.lat) && Number.isFinite(n.lng))
        ? `<a class="note-gps" href="https://www.google.com/maps?q=${n.lat},${n.lng}" target="_blank" rel="noopener">📍 Location</a>`
        : "";
      return `
        <div class="note-card" data-id="${n.id}">
          <div class="note-head">
            <span class="note-author">${esc(name)}${roleLabel}</span>
            <span class="note-time">${esc(ago(n.created_at))}</span>
          </div>
          <div class="note-body">${esc(n.body)}</div>
          ${photoHtml}
          ${gpsHtml}
          ${mine ? `<button class="note-del" data-id="${n.id}">delete</button>` : ""}
        </div>
      `;
    }).join("");
    el.querySelectorAll(".note-del").forEach(b => {
      b.addEventListener("click", async () => {
        if (!confirm("Delete this note?")) return;
        const { error } = await sb.from("vehicle_notes").delete().eq("id", b.dataset.id);
        if (error) { alert(error.message); return; }
        loadNotes(currentVin);
      });
    });
    el.querySelectorAll(".note-photo img").forEach(img => {
      img.addEventListener("click", () => openPhotoViewer(img.dataset.full));
    });
  }

  function openPhotoViewer(url) {
    let v = document.getElementById("notePhotoViewer");
    if (!v) {
      v = document.createElement("div");
      v.id = "notePhotoViewer";
      v.className = "note-photo-viewer";
      v.innerHTML = `<img id="notePhotoViewerImg" alt=""><button id="notePhotoViewerClose">✕</button>`;
      document.body.appendChild(v);
      v.addEventListener("click", (e) => { if (e.target === v || e.target.id === "notePhotoViewerClose") v.classList.remove("show"); });
    }
    document.getElementById("notePhotoViewerImg").src = url;
    v.classList.add("show");
  }

  async function onAddNote(e) {
    e.preventDefault();
    const submitBtn = e.target.querySelector("button[type=submit]");
    const fd = new FormData(e.target);
    const body = (fd.get("body") || "").trim();
    if (!body) return;
    const user = DT_AUTH.getUser();
    if (!user) return;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }

    let photo_url = null;
    try {
      if (pendingPhotoBlob) photo_url = await uploadPhoto(pendingPhotoBlob);
    } catch (err) {
      console.warn("[Detail] photo upload failed", err);
      alert("Photo upload failed: " + err.message);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save Note"; }
      return;
    }

    const row = {
      serial_id: currentVin,
      author_id: user.id,
      body
    };
    if (pendingGps) { row.lat = pendingGps.lat; row.lng = pendingGps.lng; }
    if (photo_url) row.photo_url = photo_url;

    const { error } = await sb.from("vehicle_notes").insert(row);
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save Note"; }
    if (error) { alert(error.message); return; }
    e.target.reset();
    pendingPhotoBlob = null;
    pendingGps = null;
    $("notePhotoPreview").style.display = "none";
    $("noteGpsLabel").textContent = "Attach location";
    loadNotes(currentVin);
  }

  // ---- History tab ----
  async function loadHistory() {
    const user = DT_AUTH.getUser();
    if (!user) return;
    const { data, error } = await sb
      .from("detail_jobs")
      .select("id,serial_id,vehicle_type,condition_tags,completed_at,started_at")
      .eq("detailer_id", user.id)
      .order("started_at", { ascending: false })
      .limit(50);
    const el = $("detailHistoryList");
    if (!el) return;
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }
    if (!data || !data.length) { el.innerHTML = `<div class="bl-empty">No jobs yet. Scan a VIN to start.</div>`; return; }
    el.innerHTML = data.map(j => `
      <div class="detail-history-row ${j.completed_at ? "done" : "open"}">
        <div class="detail-history-serial">${esc(j.serial_id)}</div>
        <div class="detail-history-meta">
          ${j.completed_at ? "Done" : "In progress"} · ${esc(ago(j.completed_at || j.started_at))}
          ${j.condition_tags && j.condition_tags.length ? " · " + j.condition_tags.map(esc).join(" · ") : ""}
        </div>
      </div>
    `).join("");
  }

  document.addEventListener("dt-auth-change", () => {
    if (DT_AUTH.isDetailer && DT_AUTH.isDetailer()) start();
  });
  if (DT_AUTH.isDetailer && DT_AUTH.isDetailer()) start();

  document.addEventListener("dt-tab-shown", (e) => {
    if (e.detail === "detail-history") loadHistory();
  });

  window.DT_DETAIL = { loadVin, loadHistory, TASKS, CONDITIONS, CONDITION_TASKS };
})();
