// ============================================================
// DriverTrax Vehicle Notes — shared module
//
//   The single source of truth for everything VIN-note related.
//
//   Public surface (window.DT_VNOTES):
//
//   UI
//     mount(container, vin, opts)   — full widget: notes list + Add form
//     refresh(container, vin)       — re-render an existing mount
//     openPhotoViewer(url)          — fullscreen image overlay
//
//   Data
//     addNote(vin, body, opts)      — programmatic insert
//                                     opts: { lat, lng, photoBlob }
//     listNotes(vin, opts)          — fetch notes for a VIN
//                                     opts: { includeArchived }
//
//   Helpers (so callers stop duplicating)
//     fetchProfileNames(ids)        — populate profileCache
//     profileCache                  — Map<userId, {display_name, role}>
//     signPhotoPaths(paths)         — returns { path: signedUrl }
//     captureGps()                  — Promise<{lat,lng,acc} | null>
//     resizeImageBlob(file, w, h, q)
//     uploadPhoto(blob, vin)        — returns storage path string
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const esc = window.DT_ESC;
  const ago = (d) => window.DT_FORMAT.timeAgo(d);

  // ---- shared cache ----
  const profileCache = new Map();

  async function fetchProfileNames(ids) {
    const missing = [...new Set(ids)].filter(id => id && !profileCache.has(id));
    if (!missing.length) return;
    const { data } = await sb.from("profiles").select("id,display_name,role").in("id", missing);
    (data || []).forEach(p => profileCache.set(p.id, p));
  }

  // ---- storage helpers ----
  async function signPhotoPaths(paths) {
    const unique = [...new Set((paths || []).filter(Boolean))];
    if (!unique.length) return {};
    const { data } = await sb.storage.from("vehicle-photos").createSignedUrls(unique, 600);
    const out = {};
    (data || []).forEach(u => { out[u.path] = u.signedUrl; });
    return out;
  }

  async function uploadPhoto(blob, vin) {
    const user = DT_AUTH.getUser();
    if (!user) throw new Error("Not signed in");
    const path = `${user.id}/${vin}-${Date.now()}.jpg`;
    const { error } = await sb.storage
      .from("vehicle-photos")
      .upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (error) throw error;
    return path;
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

  // Cache of currently rendered notes (by id) so a click can show full detail
  // without re-querying. Keyed by id, value is the original row + signed photo URL.
  const _renderedNotes = new Map();

  // ---- note detail overlay ----
  async function openNoteDetail(id) {
    if (!id || id === "undefined" || id === "null") {
      console.warn("[VNotes] openNoteDetail called with invalid id:", id);
      return;
    }
    let n = _renderedNotes.get(id);
    if (!n) {
      // Fallback: fetch the row directly so the viewer still opens even if the
      // cache hasn't been populated for this id (e.g. across remounts).
      const { data, error } = await sb.from("vehicle_notes")
        .select("id,body,author_id,created_at,lat,lng,photo_url,mileage,fuel_level")
        .eq("id", id).maybeSingle();
      if (error || !data) { console.warn("[VNotes] detail fetch", error); return; }
      n = { ...data };
      if (data.photo_url) {
        const signed = await signPhotoPaths([data.photo_url]);
        n._signedPhotoUrl = signed[data.photo_url] || null;
      }
      await fetchProfileNames([data.author_id]);
      _renderedNotes.set(id, n);
    }
    const p = profileCache.get(n.author_id);
    const name = esc(p?.display_name || "Someone");
    const role = p?.role ? `<span class="note-role role-${esc(p.role)}">${esc(p.role)}</span>` : "";
    const when = (() => {
      try { return new Date(n.created_at).toLocaleString(); } catch { return ""; }
    })();
    const photo = n._signedPhotoUrl ? `<div class="detail-note-photo"><img src="${esc(n._signedPhotoUrl)}" alt=""></div>` : "";
    const gpsAction = (Number.isFinite(n.lat) && Number.isFinite(n.lng))
      ? `<a class="btn btn-secondary" href="https://www.google.com/maps?q=${n.lat},${n.lng}" target="_blank" rel="noopener">Open in Maps</a>` : "";

    const body = document.getElementById("noteDetailBody");
    if (!body) return;
    body.innerHTML = `
      <div class="detail-header">
        <div>
          <div class="detail-serial">NOTE</div>
          <div class="detail-time">${esc(when)}</div>
        </div>
        <button class="detail-close" onclick="closeNoteDetailOverlay()" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="detail-body">
        <div class="detail-row"><span class="detail-label">Author</span><span class="detail-val">${name}${role}</span></div>
        ${n.body ? `<div class="detail-row"><span class="detail-label">Body</span><span class="detail-val" style="white-space:pre-wrap">${esc(n.body)}</span></div>` : ""}
        ${Number.isFinite(n.mileage) ? `<div class="detail-row"><span class="detail-label">Mileage</span><span class="detail-val">${n.mileage.toLocaleString()} mi</span></div>` : ""}
        ${n.fuel_level ? `<div class="detail-row"><span class="detail-label">Fuel</span><span class="detail-val">${esc(n.fuel_level)}</span></div>` : ""}
      </div>
      ${photo}
      ${gpsAction ? `<div class="detail-actions" style="grid-template-columns:1fr">${gpsAction}</div>` : ""}
    `;
    document.getElementById("noteDetailOverlay")?.classList.add("open");
  }

  // ---- fullscreen photo viewer (one DOM instance shared across modules) ----
  function openPhotoViewer(url) {
    let v = document.getElementById("notePhotoViewer");
    if (!v) {
      v = document.createElement("div");
      v.id = "notePhotoViewer";
      v.className = "note-photo-viewer";
      v.innerHTML = `<img id="notePhotoViewerImg" alt=""><button id="notePhotoViewerClose">✕</button>`;
      document.body.appendChild(v);
      v.addEventListener("click", (e) => {
        if (e.target === v || e.target.id === "notePhotoViewerClose") v.classList.remove("show");
      });
    }
    document.getElementById("notePhotoViewerImg").src = url;
    v.classList.add("show");
  }

  // ---- data ----
  async function listNotes(vin, { includeArchived = false } = {}) {
    let q = sb.from("vehicle_notes")
      .select("id,body,author_id,created_at,archived,lat,lng,photo_url,mileage,fuel_level")
      .eq("serial_id", vin)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!includeArchived) q = q.eq("archived", false);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function addNote(vin, body, opts = {}) {
    const user = DT_AUTH.getUser();
    if (!user) throw new Error("Not signed in");
    const row = { serial_id: vin, author_id: user.id, body };
    if (opts.photoBlob) row.photo_url = await uploadPhoto(opts.photoBlob, vin);
    if (Number.isFinite(opts.lat) && Number.isFinite(opts.lng)) {
      row.lat = opts.lat; row.lng = opts.lng;
    }
    if (Number.isFinite(opts.mileage) && opts.mileage >= 0) row.mileage = opts.mileage;
    if (opts.fuel_level) row.fuel_level = opts.fuel_level;
    const { data: insertedNote, error } = await sb.from("vehicle_notes")
      .insert(row).select("id").single();
    if (error) throw error;

    // If a status change is included, also write a record row tagged source='note'
    // and linked back to the note via note_id, so the timeline can merge them
    // into a single entry. Existing readers of records.status work unchanged.
    if (opts.status) {
      const rec = {
        id: Date.now().toString(),
        ts: new Date().toISOString(),
        user_id: user.id,
        serial_id: vin,
        status: opts.status,
        status_other: opts.statusOther || null,
        destination: opts.destination || null,
        destination_other: opts.destinationOther || null,
        no_tag: false,
        shuttle: false,
        transport: false,
        notes: body,
        source: "note",
        note_id: insertedNote?.id || null
      };
      if (Number.isFinite(opts.lat) && Number.isFinite(opts.lng)) {
        rec.lat = opts.lat; rec.lng = opts.lng;
      } else {
        rec.gps_error = true;
      }
      const { error: recErr } = await sb.from("records").insert(rec);
      if (recErr) throw recErr;
    }

    document.dispatchEvent(new CustomEvent("dt-vehicle-note-added", { detail: { vin } }));
  }

  // Latest status/destination for a VIN — looks at the most recent record row.
  async function getCurrentStatus(vin) {
    const { data, error } = await sb.from("records")
      .select("status,status_other,destination,destination_other,ts,user_id,source")
      .eq("serial_id", vin)
      .order("ts", { ascending: false })
      .limit(1);
    if (error) { console.warn("[VNotes] currentStatus", error); return null; }
    return (data && data[0]) || null;
  }

  // Most recent mileage/fuel values from this VIN's notes — used to pre-fill the form.
  async function getLatestMileageAndFuel(vin) {
    const { data, error } = await sb.from("vehicle_notes")
      .select("mileage,fuel_level,created_at")
      .eq("serial_id", vin)
      .eq("archived", false)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) { console.warn("[VNotes] latestMileageFuel", error); return { mileage: null, fuel: null }; }
    const rows = data || [];
    const mileage = rows.find(r => Number.isFinite(r.mileage))?.mileage ?? null;
    const fuel    = rows.find(r => r.fuel_level)?.fuel_level ?? null;
    return { mileage, fuel };
  }

  const STATUS_OPTS = ["CLEAN","DIRTY","REWASH","BODY","PM","MK","MR","OM","AUDIT FAIL","WI/DELETE","GLASS","TI","DETAILING","DETAILED","CHECK_IN","OTHER"];
  // CXR / manager / admin only. Visible label vs stored code.
  const PRIVILEGED_STATUS_OPTS = [
    { code: "CHECK_OUT", label: "CUSTOMER CHECK OUT" },
    { code: "HOLD",      label: "HOLD" },
    { code: "DNR",       label: "DO NOT RENT (DNR)" }
  ];
  function canSetPrivilegedStatus() {
    return !!(window.DT_AUTH && (DT_AUTH.isCxr?.() || DT_AUTH.isManager?.() || DT_AUTH.isAdmin?.()));
  }
  const DEST_OPTS = ["GARAGE","QTA","BACKLOT","ATLANTIC","BRANCH","OTHER"];
  const FUEL_OPTS = ["EMPTY","1/4","1/2","3/4","FULL"];

  // ---- shared render of a list of note rows ----
  function renderNoteCardsHtml(notes, signed) {
    const myId = DT_AUTH.getUser()?.id;
    // Drop any rows that came back without an id — they can't be opened,
    // and they'd render as data-id="undefined" which then triggers UUID parse errors.
    const safe = notes.filter(n => n && n.id);
    if (safe.length !== notes.length) {
      console.warn("[VNotes] dropping", notes.length - safe.length, "note rows missing id");
    }
    notes = safe;
    // Refresh the rendered-notes cache so click handlers can look up full data.
    notes.forEach(n => {
      const copy = { ...n };
      copy._signedPhotoUrl = n.photo_url ? (signed[n.photo_url] || null) : null;
      _renderedNotes.set(n.id, copy);
    });
    return notes.map(n => {
      const p = profileCache.get(n.author_id);
      const name = p?.display_name || "Someone";
      const roleLabel = p?.role ? ` <span class="note-role role-${esc(p.role)}">${esc(p.role)}</span>` : "";
      const mine = n.author_id === myId;
      const photoHtml = n.photo_url && signed[n.photo_url]
        ? `<div class="note-photo"><img src="${esc(signed[n.photo_url])}" alt="" data-full="${esc(signed[n.photo_url])}"></div>`
        : "";
      const gpsHtml = (Number.isFinite(n.lat) && Number.isFinite(n.lng))
        ? `<a class="note-gps" href="https://www.google.com/maps?q=${n.lat},${n.lng}" target="_blank" rel="noopener">Location</a>`
        : "";
      const mileageHtml = Number.isFinite(n.mileage)
        ? `<span class="note-mileage"><svg class="ico-mileage" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 16a9 9 0 0 1 18 0"/><path d="M12 16 16 10"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/></svg>${n.mileage.toLocaleString()} mi</span>` : "";
      const fuelHtml = n.fuel_level
        ? `<span class="note-fuel"><svg class="ico-fuel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="11" height="18" rx="1"/><line x1="3" y1="9" x2="14" y2="9"/><path d="M14 13h3a2 2 0 0 1 2 2v2a1.5 1.5 0 0 0 3 0V8l-3-3"/></svg>${esc(n.fuel_level)}</span>` : "";
      return `
        <div class="note-card" data-id="${n.id}">
          <div class="note-head">
            <span class="note-author">${esc(name)}${roleLabel}</span>
            <span class="note-time">${esc(ago(n.created_at))}</span>
          </div>
          <div class="note-body">${esc(n.body)}</div>
          ${photoHtml}
          ${gpsHtml}
          <div class="note-footer">
            <span class="note-footer-left">${mileageHtml}${fuelHtml}</span>
            ${mine ? `<button class="note-del" data-id="${n.id}">delete</button>` : ""}
          </div>
        </div>
      `;
    }).join("");
  }

  // Single delegated handler — bind once per list container in mount(),
  // survives refresh() re-renders, no per-row listeners.
  function wireListDelegation(scope, onAfter) {
    if (scope._vnDelegated) return;
    scope._vnDelegated = true;
    scope.addEventListener("click", async (e) => {
      const t = e.target;
      if (t.matches(".note-photo img")) {
        return openPhotoViewer(t.dataset.full);
      }
      if (t.matches(".note-del")) {
        if (!confirm("Delete this note?")) return;
        const { error } = await sb.from("vehicle_notes").delete().eq("id", t.dataset.id);
        if (error) { alert(error.message); return; }
        if (typeof onAfter === "function") onAfter();
        return;
      }
      // Open detail viewer when clicking the card itself (but not on an interactive child)
      if (t.closest("a, button, .note-photo")) return;
      const card = t.closest(".note-card");
      const cid = card?.dataset.id;
      if (!cid || cid === "undefined" || cid === "null") return;
      openNoteDetail(cid);
    });
  }
  // Back-compat shims for external callers (e.g. requests.js uses _wirePhotoZoom).
  function wirePhotoZoom(scope) {
    if (scope._vnZoomDelegated) return;
    scope._vnZoomDelegated = true;
    scope.addEventListener("click", (e) => {
      if (e.target.matches(".note-photo img")) openPhotoViewer(e.target.dataset.full);
    });
  }

  // ---- mount-able widget ----
  async function mount(container, vin, opts = {}) {
    if (!container) return;
    if (!vin) { container.innerHTML = ""; return; }
    const { showList = true, showAdd = true, addWithMedia = false, withStatus = false } = opts;
    // Status mode implies media so location/photo can ride along with the change.
    const wantMedia = addWithMedia || withStatus;
    container.classList.add("vn-mount");

    const [current, latestMF] = withStatus
      ? await Promise.all([getCurrentStatus(vin), getLatestMileageAndFuel(vin)])
      : [null, { mileage: null, fuel: null }];
    const curStatus = current?.status || "";
    const curDest = current?.destination || "";
    const lastMileage = latestMF?.mileage ?? null;
    const lastFuel    = latestMF?.fuel ?? "";
    const curStatusLabel = (window.statusLabel ? statusLabel(curStatus) : curStatus) || "";
    const labelFor = (s) => (window.statusLabel ? statusLabel(s) : s);
    const baseOpts = STATUS_OPTS.map(s => `<option value="${s}"${s===curStatus?" selected":""}>${labelFor(s)}</option>`).join("");
    const privOpts = canSetPrivilegedStatus()
      ? PRIVILEGED_STATUS_OPTS.map(o => `<option value="${o.code}"${o.code===curStatus?" selected":""}>${o.label}</option>`).join("")
      : "";
    const statusOpts = baseOpts + (privOpts ? `<optgroup label="CXR / Manager">${privOpts}</optgroup>` : "");
    const destOpts = DEST_OPTS.map(d => `<option value="${d}"${d===curDest?" selected":""}>${d}</option>`).join("");

    container.innerHTML = `
      ${showAdd ? `<div class="vn-head"><button type="button" class="vn-add-toggle btn btn-primary" data-state="closed">+ Add a note</button></div>` : ""}
      ${showList ? `<div class="vin-tl-label" style="margin-top:14px;margin-bottom:6px">NOTES</div><div class="vn-list"><div class="bl-empty">Loading…</div></div>` : ""}
      ${showAdd ? `
        <form class="vn-add-form" style="display:none">
          <textarea name="body" placeholder="What should the next person know?" required maxlength="1000"></textarea>
          ${withStatus ? `
          <div class="vn-status-row">
            <label class="vn-field">
              <span>Status</span>
              <select name="status"><option value="">(leave unchanged)</option>${statusOpts}</select>
            </label>
            <label class="vn-field">
              <span>Location</span>
              <select name="destination"><option value="">(none)</option>${destOpts}</select>
            </label>
            <label class="vn-field">
              <span>Mileage</span>
              <input type="number" name="mileage" inputmode="numeric" min="0" step="1" placeholder="${Number.isFinite(lastMileage) ? lastMileage : "optional"}">
            </label>
            <label class="vn-field">
              <span>Fuel</span>
              <select name="fuel_level"><option value="">(none)</option>${FUEL_OPTS.map(f => `<option value="${f}"${f===lastFuel?" selected":""}>${f}</option>`).join("")}</select>
            </label>
          </div>` : ""}
          ${wantMedia ? `
          <div class="note-attach-row">
            <label class="vn-gps-switch">
              <span class="vn-gps-text">Update Location</span>
              <span class="vn-switch">
                <input type="checkbox" name="gps">
                <span class="vn-switch-track"><span class="vn-switch-thumb"></span></span>
              </span>
            </label>
            <div class="vn-photo-action">
              <input type="file" name="photo" id="vnPhotoInput-${vin}" accept="image/*" capture="environment" hidden>
              <button type="button" class="btn btn-secondary vn-photo-btn" onclick="document.getElementById('vnPhotoInput-${vin}').click()">📷 Add photo</button>
            </div>
          </div>
          <div class="note-photo-preview vn-photo-preview" style="display:none">
            <img class="vn-photo-img" alt="">
            <button type="button" class="vn-photo-remove" aria-label="Remove">✕</button>
          </div>` : ""}
          <button type="submit" class="btn btn-primary" style="margin-bottom:48px">Save Note</button>
        </form>
      ` : ""}
    `;
    container.dataset.vin = vin;

    if (showAdd) {
      const toggle = container.querySelector(".vn-add-toggle");
      const form = container.querySelector(".vn-add-form");
      toggle.addEventListener("click", () => {
        const open = toggle.dataset.state !== "open";
        toggle.dataset.state = open ? "open" : "closed";
        toggle.textContent = open ? "Cancel" : "+ Add a note";
        form.style.display = open ? "flex" : "none";
        if (open) form.querySelector("textarea").focus();
      });
      wireAddForm(form, container, vin, wantMedia, withStatus);
    }

    if (showList) await refresh(container, vin);
  }

  function wireAddForm(form, container, vin, withMedia, withStatus) {
    let pendingPhoto = null;

    if (withMedia) {
      const photoInput = form.querySelector("input[name=photo]");
      const preview = form.querySelector(".vn-photo-preview");
      const previewImg = form.querySelector(".vn-photo-img");
      photoInput?.addEventListener("change", async () => {
        const file = photoInput.files?.[0];
        if (!file) return;
        try {
          const blob = await resizeImageBlob(file, 1920, 1080, 0.85);
          pendingPhoto = blob;
          previewImg.src = URL.createObjectURL(blob);
          preview.style.display = "";
        } catch (e) { console.warn("[VNotes] resize", e); alert("Couldn't process that image."); }
      });
      form.querySelector(".vn-photo-remove")?.addEventListener("click", () => {
        pendingPhoto = null;
        photoInput.value = "";
        preview.style.display = "none";
        previewImg.src = "";
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = (new FormData(form).get("body") || "").trim();
      if (!body) return;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const fd = new FormData(form);
        const statusVal = withStatus ? (fd.get("status") || "").trim() : "";
        const destVal   = withStatus ? (fd.get("destination") || "").trim() : "";
        const mileageRaw = withStatus ? (fd.get("mileage") || "").trim() : "";
        const mileageVal = mileageRaw ? parseInt(mileageRaw, 10) : null;
        const fuelVal    = withStatus ? (fd.get("fuel_level") || "").trim() : "";
        let pendingGps = null;
        const gpsInput = form.querySelector("input[name=gps]");
        if (withMedia && gpsInput?.checked) {
          btn.textContent = "Locating…";
          pendingGps = await captureGps();
          if (!pendingGps) {
            const proceed = confirm("Couldn't get current location. Save without location?");
            if (!proceed) { btn.disabled = false; btn.textContent = "Save Note"; return; }
          }
          btn.textContent = "Saving…";
        }
        await addNote(vin, body, {
          photoBlob: pendingPhoto,
          ...(pendingGps ? { lat: pendingGps.lat, lng: pendingGps.lng } : {}),
          ...(statusVal ? { status: statusVal } : {}),
          ...(destVal   ? { destination: destVal } : {}),
          ...(Number.isFinite(mileageVal) && mileageVal >= 0 ? { mileage: mileageVal } : {}),
          ...(fuelVal ? { fuel_level: fuelVal } : {})
        });
      } catch (err) {
        btn.disabled = false; btn.textContent = "Save Note";
        alert(err.message);
        return;
      }
      btn.disabled = false; btn.textContent = "Save Note";
      form.reset();
      form.style.display = "none";
      const toggle = container.querySelector(".vn-add-toggle");
      toggle.dataset.state = "closed";
      toggle.textContent = "+ Add a note";
      pendingPhoto = null;
      const preview = form.querySelector(".vn-photo-preview");
      if (preview) preview.style.display = "none";
      refresh(container, vin);
    });
  }

  async function refresh(container, vin) {
    const list = container.querySelector(".vn-list");
    if (!list) return;
    let notes;
    try { notes = await listNotes(vin); }
    catch (err) { list.innerHTML = `<div class="bl-empty">${esc(err.message)}</div>`; return; }
    if (!notes.length) { list.innerHTML = `<div class="vn-empty">No notes yet for this VIN.</div>`; return; }
    await fetchProfileNames(notes.map(n => n.author_id));
    const signed = await signPhotoPaths(notes.map(n => n.photo_url));
    list.innerHTML = renderNoteCardsHtml(notes, signed);
    wireListDelegation(list, () => refresh(container, vin));
  }

  window.DT_VNOTES = {
    // UI
    mount, refresh, openPhotoViewer, openNoteDetail,
    // Data
    addNote, listNotes,
    // Helpers
    fetchProfileNames, profileCache, signPhotoPaths,
    captureGps, resizeImageBlob, uploadPhoto,
    // Internal render helpers (for modules with custom row shapes)
    _renderCardsHtml: renderNoteCardsHtml,
    _wirePhotoZoom: wirePhotoZoom
  };
})();
