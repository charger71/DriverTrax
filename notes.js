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
  // Profile cache + photo viewer + URL signing are shared with DT_VNOTES so
  // every notes view in the app speaks the same language.
  const profileCache = window.DT_VNOTES?.profileCache || new Map();
  const fetchProfileNames = (ids) => window.DT_VNOTES?.fetchProfileNames(ids);
  const signPhotoPaths    = (paths) => window.DT_VNOTES?.signPhotoPaths(paths) || {};
  const openPhotoViewer   = (url)   => window.DT_VNOTES?.openPhotoViewer(url);

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

    const signedUrls = await signPhotoPaths(filtered.map(n => n.photo_url));

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

  // ---- Add Note modal (manager entry point that doesn't require a record) ----
  function openAddNote() {
    const modal = $("notesAddModal");
    const form  = $("notesAddVinForm");
    const mount = $("notesAddMount");
    form.reset();
    mount.innerHTML = "";
    $("notesAddMsg").textContent = "";
    modal.classList.add("show");
    form.elements.vin.focus();
  }
  function closeAddNote() { $("notesAddModal")?.classList.remove("show"); }

  function onAddVinSubmit(e) {
    e.preventDefault();
    const vin = (e.target.elements.vin.value || "").trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{6,17}$/.test(vin)) {
      $("notesAddMsg").textContent = "Enter a valid VIN (6–17 alphanumeric, no I/O/Q).";
      $("notesAddMsg").className = "users-modal-msg err";
      return;
    }
    $("notesAddMsg").textContent = "";
    // Hand off to the shared widget — same UI as everywhere else
    window.DT_VNOTES?.mount($("notesAddMount"), vin, { addWithMedia: true, showList: true });
  }

  function start() {
    if (started) return;
    started = true;
    $("notesSearch")?.addEventListener("input", render);
    $("notesShowArchived")?.addEventListener("change", load);
    $("notesEditForm")?.addEventListener("submit", onEditSubmit);
    $("notesAddBtn")?.addEventListener("click", openAddNote);
    $("notesAddClose")?.addEventListener("click", closeAddNote);
    $("notesAddModal")?.addEventListener("click", (e) => { if (e.target.id === "notesAddModal") closeAddNote(); });
    $("notesAddVinForm")?.addEventListener("submit", onAddVinSubmit);
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
