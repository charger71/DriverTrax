// ============================================================
// DriverTrax Vehicle Notes — manager-only admin view
//   - Lists every note across every VIN
//   - Filter by VIN/text, toggle archived
//   - Per-note: edit body, archive/unarchive, delete (cascades
//     the photo file out of vehicle-photos storage)
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const ago = (d) => (window.dtTimeAgo ? window.dtTimeAgo(d) : new Date(d).toLocaleString());

  let notes = [];
  let realtimeChan = null;
  let started = false;
  const profileCache = new Map();

  async function fetchProfileNames(ids) {
    const missing = [...new Set(ids)].filter(id => id && !profileCache.has(id));
    if (!missing.length) return;
    const { data } = await sb.from("profiles").select("id,display_name,role").in("id", missing);
    (data || []).forEach(p => profileCache.set(p.id, p));
  }

  async function load() {
    const wantArchived = $("notesShowArchived")?.checked;
    let q = sb.from("vehicle_notes")
      .select("id,serial_id,body,author_id,created_at,archived,lat,lng,photo_url")
      .order("created_at", { ascending: false })
      .limit(200);
    if (!wantArchived) q = q.eq("archived", false);
    const { data, error } = await q;
    if (error) {
      $("notesAdminList").innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`;
      return;
    }
    notes = data || [];
    await fetchProfileNames(notes.map(n => n.author_id));
    await render();
  }

  async function render() {
    const term = ($("notesSearch")?.value || "").trim().toLowerCase();
    const filtered = notes.filter(n => !term
      || (n.serial_id || "").toLowerCase().includes(term)
      || (n.body || "").toLowerCase().includes(term));
    const el = $("notesAdminList");
    if (!filtered.length) {
      el.innerHTML = `<div class="bl-empty">No notes match.</div>`;
      return;
    }

    // Batch sign photo URLs
    const photoPaths = [...new Set(filtered.filter(n => n.photo_url).map(n => n.photo_url))];
    const signedUrls = {};
    if (photoPaths.length) {
      const { data: signed } = await sb.storage.from("vehicle-photos").createSignedUrls(photoPaths, 600);
      (signed || []).forEach(s => { signedUrls[s.path] = s.signedUrl; });
    }

    el.innerHTML = filtered.map(n => {
      const p = profileCache.get(n.author_id);
      const name = p?.display_name || "Someone";
      const roleLabel = p?.role ? ` <span class="note-role role-${esc(p.role)}">${esc(p.role)}</span>` : "";
      const photoHtml = n.photo_url && signedUrls[n.photo_url]
        ? `<div class="note-photo"><img src="${esc(signedUrls[n.photo_url])}" alt="" data-full="${esc(signedUrls[n.photo_url])}"></div>`
        : "";
      const gpsHtml = (Number.isFinite(n.lat) && Number.isFinite(n.lng))
        ? `<a class="note-gps" href="https://www.google.com/maps?q=${n.lat},${n.lng}" target="_blank" rel="noopener">📍 Location</a>`
        : "";
      return `
        <div class="note-card ${n.archived ? "archived" : ""}" data-id="${n.id}" data-photo="${esc(n.photo_url || "")}">
          <div class="note-head">
            <span class="note-author"><b>${esc(n.serial_id)}</b> · ${esc(name)}${roleLabel}</span>
            <span class="note-time">${esc(ago(n.created_at))}</span>
          </div>
          <div class="note-body">${esc(n.body)}</div>
          ${photoHtml}
          ${gpsHtml}
          <div class="note-admin-actions">
            <button class="note-act-edit"    data-id="${n.id}">Edit</button>
            <button class="note-act-archive" data-id="${n.id}">${n.archived ? "Unarchive" : "Archive"}</button>
            <button class="note-act-del"     data-id="${n.id}">Delete</button>
          </div>
        </div>
      `;
    }).join("");

    el.querySelectorAll(".note-act-edit").forEach(b => b.addEventListener("click", () => openEdit(b.dataset.id)));
    el.querySelectorAll(".note-act-archive").forEach(b => b.addEventListener("click", () => toggleArchive(b.dataset.id)));
    el.querySelectorAll(".note-act-del").forEach(b => b.addEventListener("click", () => deleteNote(b.dataset.id)));
    el.querySelectorAll(".note-photo img").forEach(img => {
      img.addEventListener("click", () => openPhotoViewer(img.dataset.full));
    });
  }

  function openEdit(id) {
    const n = notes.find(x => x.id === id);
    if (!n) return;
    const form = $("notesEditForm");
    form.elements.id.value = n.id;
    form.elements.body.value = n.body || "";
    $("notesEditMsg").textContent = "";
    $("notesEditModal").classList.add("show");
  }
  function closeEdit() { $("notesEditModal").classList.remove("show"); }

  async function onEditSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const id = form.elements.id.value;
    const body = (form.elements.body.value || "").trim();
    if (!body) return;
    $("notesEditMsg").textContent = "Saving…";
    const { error } = await sb.from("vehicle_notes")
      .update({ body, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) { $("notesEditMsg").textContent = error.message; $("notesEditMsg").className = "users-modal-msg err"; return; }
    $("notesEditMsg").textContent = "Saved.";
    $("notesEditMsg").className = "users-modal-msg ok";
    load();
    setTimeout(closeEdit, 400);
  }

  async function toggleArchive(id) {
    const n = notes.find(x => x.id === id);
    if (!n) return;
    const { error } = await sb.from("vehicle_notes")
      .update({ archived: !n.archived, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) { alert(error.message); return; }
    load();
  }

  async function deleteNote(id) {
    const n = notes.find(x => x.id === id);
    if (!n) return;
    if (!confirm("Delete this note? The photo (if any) will be removed too. This can't be undone.")) return;
    // Remove the photo from storage first; if the row delete then fails we'd
    // have an orphaned-row issue, but that's recoverable; an orphaned blob is
    // dead weight no one can clean up via the UI.
    if (n.photo_url) {
      const { error: sErr } = await sb.storage.from("vehicle-photos").remove([n.photo_url]);
      if (sErr) console.warn("[Notes] photo remove", sErr);
    }
    const { error } = await sb.from("vehicle_notes").delete().eq("id", id);
    if (error) { alert(error.message); return; }
    load();
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

  function start() {
    if (started) return;
    started = true;
    $("notesSearch")?.addEventListener("input", render);
    $("notesShowArchived")?.addEventListener("change", load);
    $("notesEditForm")?.addEventListener("submit", onEditSubmit);
    $("notesEditClose")?.addEventListener("click", closeEdit);
    $("notesEditCancel")?.addEventListener("click", closeEdit);
    $("notesEditModal")?.addEventListener("click", (e) => { if (e.target.id === "notesEditModal") closeEdit(); });
    load();
    realtimeChan = sb.channel("vehicle-notes-admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "vehicle_notes" }, load)
      .subscribe();
  }

  function stop() {
    started = false;
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  document.addEventListener("dt-auth-change", () => {
    if (DT_AUTH.isManager()) start(); else stop();
  });
  if (DT_AUTH.isManager()) start();

  window.DT_NOTES = { reload: load };
})();
