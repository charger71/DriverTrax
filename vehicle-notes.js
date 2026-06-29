// ============================================================
// DriverTrax Vehicle Notes — shared module
//
//   The single source of truth for everything VIN-note related.
//
//   Public surface (window.DT_VNOTES):
//
//   UI
//     mount(container, vin, opts)   — notes list widget (read-only).
//                                     Adding notes is done from the NEW ENTRY form.
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
    const type = blob.type || "image/jpeg";
    const ext = type === "image/png" ? "png"
              : type === "image/webp" ? "webp"
              : type === "image/heic" || type === "image/heif" ? "heic"
              : "jpg";
    const path = `${user.id}/${vin}-${Date.now()}.${ext}`;
    const { error } = await sb.storage
      .from("vehicle-photos")
      .upload(path, blob, { contentType: type, upsert: false });
    if (error) throw error;
    return path;
  }

  async function drawToJpeg(source, w, h, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(source, 0, 0, w, h);
    return new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
  }

  // Mobile-safe resize: createImageBitmap throws on iOS HEIC photos and on
  // some Android browsers, so fall back to an <img> element, and finally to
  // returning the original file untouched so the upload still goes through.
  async function resizeImageBlob(file, maxW, maxH, quality) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const ratio = Math.min(maxW / bmp.width, maxH / bmp.height, 1);
      return await drawToJpeg(bmp, Math.round(bmp.width * ratio), Math.round(bmp.height * ratio), quality);
    } catch (_) { /* fall through */ }

    try {
      const url = URL.createObjectURL(file);
      try {
        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error("image decode failed"));
          i.src = url;
        });
        const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
        return await drawToJpeg(img, Math.round(img.naturalWidth * ratio), Math.round(img.naturalHeight * ratio), quality);
      } finally { URL.revokeObjectURL(url); }
    } catch (_) { /* fall through */ }

    return file;
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
      if (DT_ERR.isMissing(error, data)) { DT_TOAST.missing("note"); return; }
      if (error) { console.warn("[VNotes] detail fetch", error); DT_TOAST.show("Couldn't load note", "error"); return; }
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
        <button class="btn btn-destructive btn-icon detail-close" onclick="closeNoteDetailOverlay()" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="detail-body">
        <div class="detail-row"><span class="detail-label">Author</span><span class="detail-val">${name}${role}</span></div>
        ${n.body ? `<div class="detail-row"><span class="detail-label">Body</span><span class="detail-val u-text-prewrap">${esc(n.body)}</span></div>` : ""}
        ${Number.isFinite(n.mileage) ? `<div class="detail-row"><span class="detail-label">Mileage</span><span class="detail-val">${n.mileage.toLocaleString()} mi</span></div>` : ""}
        ${n.fuel_level ? `<div class="detail-row"><span class="detail-label">Fuel</span><span class="detail-val">${esc(n.fuel_level)}</span></div>` : ""}
      </div>
      ${photo}
      ${gpsAction ? `<div class="detail-actions detail-actions--single">${gpsAction}</div>` : ""}
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
      v.innerHTML = `<img id="notePhotoViewerImg" alt=""><button id="notePhotoViewerClose" aria-label="Close"><svg class="icon" aria-hidden="true"><use href="#icon-x"/></svg></button>`;
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
    // Empty body → null. The vehicle_notes.body column has a non-empty
    // check constraint; null bypasses it so a "metadata-only" note (status
    // change, photo, GPS, mileage, fuel) can still save.
    const bodyVal = (body && body.trim()) ? body : null;
    const row = { serial_id: vin, author_id: user.id, body: bodyVal };
    if (opts.photoBlob) row.photo_url = await uploadPhoto(opts.photoBlob, vin);
    if (Number.isFinite(opts.lat) && Number.isFinite(opts.lng)) {
      row.lat = opts.lat; row.lng = opts.lng;
    }
    if (Number.isFinite(opts.mileage) && opts.mileage >= 0) row.mileage = opts.mileage;
    if (opts.fuel_level) row.fuel_level = opts.fuel_level;
    const { data: insertedNote, error } = await sb.from("vehicle_notes")
      .insert(row).select("id").single();
    if (error) {
      // Roll back the photo upload so we don't leave an orphan in storage.
      if (row.photo_url) {
        sb.storage.from("vehicle-photos").remove([row.photo_url])
          .catch(e => console.warn("[VNotes] orphan cleanup", e));
      }
      throw error;
    }

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
      if (recErr) {
        if (row.photo_url) {
          sb.storage.from("vehicle-photos").remove([row.photo_url])
            .catch(e => console.warn("[VNotes] orphan cleanup", e));
        }
        sb.from("vehicle_notes").delete().eq("id", insertedNote.id)
          .then(({ error }) => { if (error) console.warn("[VNotes] note rollback", error); });
        throw recErr;
      }
    }

    document.dispatchEvent(new CustomEvent("dt-vehicle-note-added", { detail: { vin } }));
  }

  // Most recent mileage/fuel values for a VIN. Pulls from both notes and
  // records (the NEW ENTRY form writes mileage/fuel onto records) and merges
  // by timestamp so the freshest source wins.
  async function getLatestMileageAndFuel(vin) {
    const [notesRes, recsRes] = await Promise.all([
      sb.from("vehicle_notes")
        .select("mileage,fuel_level,created_at")
        .eq("serial_id", vin)
        .eq("archived", false)
        .order("created_at", { ascending: false })
        .limit(50),
      sb.from("records")
        .select("mileage,fuel_level,ts")
        .eq("serial_id", vin)
        .order("ts", { ascending: false })
        .limit(50)
    ]);
    if (notesRes.error) console.warn("[VNotes] latestMileageFuel notes", notesRes.error);
    if (recsRes.error)  console.warn("[VNotes] latestMileageFuel records", recsRes.error);
    const merged = [
      ...((notesRes.data || []).map(r => ({ ts: r.created_at ? +new Date(r.created_at) : 0, mileage: r.mileage, fuel_level: r.fuel_level }))),
      ...((recsRes.data  || []).map(r => ({ ts: r.ts          ? +new Date(r.ts)         : 0, mileage: r.mileage, fuel_level: r.fuel_level })))
    ].sort((a, b) => b.ts - a.ts);
    const mileage = merged.find(r => Number.isFinite(r.mileage))?.mileage ?? null;
    const fuel    = merged.find(r => r.fuel_level)?.fuel_level ?? null;
    return { mileage, fuel };
  }

  // Detailer completion notes carry the full checklist in their body. In the
  // list view we collapse that to keep cards short — clicking the card opens
  // the detail viewer which renders the full body, so nothing is lost.
  function renderBodyPreview(body) {
    if (!body) return "";
    const marker = "\nChecklist:";
    const idx = body.indexOf(marker);
    if (idx < 0) return esc(body);
    const head = body.slice(0, idx).trimEnd();
    return `${esc(head)}<div class="note-body-more">Tap to view checklist</div>`;
  }

  // ---- shared render of a list of note rows ----
  // `vinData` is optional. When supplied (e.g. from the VIN-history timeline,
  // which has decoded the VIN once and passes the result down), every rendered
  // note gets an inline NHTSA-derived subtitle: year/make/model · body · fuel.
  function renderNoteCardsHtml(notes, signed, vinData) {
    const myId = DT_AUTH.getUser()?.id;
    const vehicleSub = vinData ? (() => {
      const name = [vinData.year, vinData.make, vinData.model, vinData.trim]
        .filter(Boolean).map(esc).join(" ");
      const meta = [vinData.bodyClass, vinData.fuelType, vinData.engine]
        .filter(Boolean).map(esc).join(" · ");
      const inner = [name, meta].filter(Boolean).join(" · ");
      return inner ? `<div class="note-vehicle">${inner}</div>` : "";
    })() : "";
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
        ? `<a class="note-gps" href="https://www.google.com/maps?q=${n.lat},${n.lng}" target="_blank" rel="noopener" aria-label="Open location in Maps"><svg class="ico-gps" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s-7-7.58-7-13a7 7 0 0 1 14 0c0 5.42-7 13-7 13z"/><circle cx="12" cy="9" r="2.5"/></svg></a>`
        : "";
      const mileageHtml = Number.isFinite(n.mileage)
        ? `<span class="note-mileage"><svg class="ico-mileage" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 16a9 9 0 0 1 18 0"/><path d="M12 16 16 10"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/></svg>${n.mileage.toLocaleString()} mi</span>` : "";
      const fuelHtml = n.fuel_level
        ? `<span class="note-fuel"><svg class="ico-fuel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="11" height="18" rx="1"/><line x1="3" y1="9" x2="14" y2="9"/><path d="M14 13h3a2 2 0 0 1 2 2v2a1.5 1.5 0 0 0 3 0V8l-3-3"/></svg>${esc(n.fuel_level)}</span>` : "";
      return `
        <div class="note-card" data-id="${n.id}">
          <div class="note-head">
            <span class="note-time">${esc(ago(n.created_at))}</span>
          </div>
          ${vehicleSub}
          <div class="note-body">${renderBodyPreview(n.body)}</div>
          ${photoHtml}
          <div class="note-footer">
            <span class="note-footer-left">${mileageHtml}${fuelHtml}${gpsHtml}</span>
            ${mine ? `<button class="btn btn-destructive btn--sm note-del" data-id="${n.id}">Delete</button>` : ""}
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
  // The inline "+ Add a note" UI was removed in favor of the NEW ENTRY form,
  // so this widget is now list-only. The showAdd / addWithMedia / withStatus
  // opts are accepted but ignored for back-compat with existing callers.
  async function mount(container, vin, opts = {}) {
    if (!container) return;
    if (!vin) { container.innerHTML = ""; return; }
    const { showList = true } = opts;
    container.classList.add("vn-mount");

    container.innerHTML = showList
      ? `<div class="vin-tl-label">NOTES</div><div class="vn-list"><div class="bl-empty">Loading…</div></div>`
      : "";
    container.dataset.vin = vin;

    if (showList) await refresh(container, vin);
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
    addNote, listNotes, getLatestMileageAndFuel,
    // Helpers
    fetchProfileNames, profileCache, signPhotoPaths,
    captureGps, resizeImageBlob, uploadPhoto,
    // Shared card-list helpers — use these so every notes view (New Entry,
    // VIN history, detail overlays, search results) renders and wires the
    // same way.
    renderCardsHtml: renderNoteCardsHtml,
    wireCards: wireListDelegation,
    // Back-compat aliases — older callers may still reference the underscore names.
    _renderCardsHtml: renderNoteCardsHtml,
    _wirePhotoZoom: wirePhotoZoom
  };
})();
