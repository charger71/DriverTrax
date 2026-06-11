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
  const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const ago = (d) => (window.dtTimeAgo ? window.dtTimeAgo(d) : new Date(d).toLocaleString());

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
      .select("id,body,author_id,created_at,archived,lat,lng,photo_url")
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
    const { error } = await sb.from("vehicle_notes").insert(row);
    if (error) throw error;
    document.dispatchEvent(new CustomEvent("dt-vehicle-note-added", { detail: { vin } }));
  }

  // ---- shared render of a list of note rows ----
  function renderNoteCardsHtml(notes, signed) {
    const myId = DT_AUTH.getUser()?.id;
    return notes.map(n => {
      const p = profileCache.get(n.author_id);
      const name = p?.display_name || "Someone";
      const roleLabel = p?.role ? ` <span class="note-role role-${esc(p.role)}">${esc(p.role)}</span>` : "";
      const mine = n.author_id === myId;
      const photoHtml = n.photo_url && signed[n.photo_url]
        ? `<div class="note-photo"><img src="${esc(signed[n.photo_url])}" alt="" data-full="${esc(signed[n.photo_url])}"></div>`
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
  }

  function wirePhotoZoom(scope) {
    scope.querySelectorAll(".note-photo img").forEach(img => {
      img.addEventListener("click", () => openPhotoViewer(img.dataset.full));
    });
  }

  function wireSelfDelete(scope, onAfter) {
    scope.querySelectorAll(".note-del").forEach(b => {
      b.addEventListener("click", async () => {
        if (!confirm("Delete this note?")) return;
        const { error } = await sb.from("vehicle_notes").delete().eq("id", b.dataset.id);
        if (error) { alert(error.message); return; }
        if (typeof onAfter === "function") onAfter();
      });
    });
  }

  // ---- mount-able widget ----
  async function mount(container, vin, opts = {}) {
    if (!container) return;
    if (!vin) { container.innerHTML = ""; return; }
    const { showList = true, showAdd = true, addWithMedia = false } = opts;
    container.classList.add("vn-mount");
    container.innerHTML = `
      <div class="vn-head">
        <span class="vn-title">Notes on this VIN</span>
        ${showAdd ? `<button type="button" class="vn-add-toggle" data-state="closed">+ Add a note</button>` : ""}
      </div>
      ${showList ? `<div class="vn-list"><div class="bl-empty">Loading…</div></div>` : ""}
      ${showAdd ? `
        <form class="vn-add-form" style="display:none">
          <textarea name="body" placeholder="What should the next person know?" required maxlength="1000"></textarea>
          ${addWithMedia ? `
          <div class="note-attach-row">
            <label class="note-attach-chip">
              <input type="checkbox" name="gps">
              <span>📍 <span class="vn-gps-label">Attach location</span></span>
            </label>
            <label class="note-attach-chip">
              <input type="file" name="photo" accept="image/*" capture="environment" hidden>
              <span>📷 Add photo</span>
            </label>
          </div>
          <div class="note-photo-preview vn-photo-preview" style="display:none">
            <img class="vn-photo-img" alt="">
            <button type="button" class="vn-photo-remove" aria-label="Remove">✕</button>
          </div>` : ""}
          <button type="submit" class="btn btn-primary">Save Note</button>
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
      wireAddForm(form, container, vin, addWithMedia);
    }

    if (showList) await refresh(container, vin);
  }

  function wireAddForm(form, container, vin, withMedia) {
    let pendingPhoto = null;
    let pendingGps = null;

    if (withMedia) {
      const gpsInput = form.querySelector("input[name=gps]");
      const gpsLabel = form.querySelector(".vn-gps-label");
      gpsInput?.addEventListener("change", async () => {
        if (gpsInput.checked) {
          gpsLabel.textContent = "Locating…";
          const loc = await captureGps();
          if (!loc) { gpsInput.checked = false; gpsLabel.textContent = "Location unavailable"; pendingGps = null; return; }
          pendingGps = loc;
          gpsLabel.textContent = `Location attached (±${Math.round(loc.acc || 0)}m)`;
        } else { pendingGps = null; gpsLabel.textContent = "Attach location"; }
      });
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
        await addNote(vin, body, {
          photoBlob: pendingPhoto,
          ...(pendingGps ? { lat: pendingGps.lat, lng: pendingGps.lng } : {})
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
      pendingGps = null;
      const preview = form.querySelector(".vn-photo-preview");
      if (preview) preview.style.display = "none";
      const gpsLabel = form.querySelector(".vn-gps-label");
      if (gpsLabel) gpsLabel.textContent = "Attach location";
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
    wirePhotoZoom(list);
    wireSelfDelete(list, () => refresh(container, vin));
  }

  window.DT_VNOTES = {
    // UI
    mount, refresh, openPhotoViewer,
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
