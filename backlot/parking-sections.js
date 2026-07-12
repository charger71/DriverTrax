// ============================================================
// Backlot — Parking sections admin
//
// Mounts into #section-parking-sections. Lists every parking_sections
// row with its reference counts, and offers:
//   • inline rename                (double-click name or Edit button)
//   • status cycle open/full/restricted
//   • delete, with an optional "move rows to another section" step
//   • retag button (calls public.retag_drop_offs)
//
// New polygons are still authored in the standalone Leaflet tool —
// there's a "Add polygon" link in the header that opens it. That's the
// only creation path; this page is for maintenance.
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;

  let started = false;
  let rows = [];          // [{id, name, status, drop_offs, records}]
  let editingId = null;   // section id currently in inline-rename mode
  let deleteTarget = null;

  // ---------- load ----------
  async function loadAll() {
    const body = $("blPsBody");
    if (!body) return;
    body.innerHTML = `<tr><td colspan="5"><div class="bl-empty">Loading…</div></td></tr>`;

    const { data: sections, error } = await sb
      .from("parking_sections")
      .select("id,name,status,created_at")
      .order("name");
    if (error) {
      body.innerHTML = `<tr><td colspan="5"><div class="bl-empty">${esc(error.message)}</div></td></tr>`;
      return;
    }

    // Get reference counts in two lightweight aggregates. We do this
    // client-side (fetch just id + section_id) so we don't need a view
    // per aggregate. On a lot with a few sections and drop-offs / records
    // in the thousands, this is a handful of KB.
    const [doRes, recRes] = await Promise.all([
      sb.from("drop_offs").select("section_id"),
      sb.from("records").select("section_id"),
    ]);
    const dropCounts = {}, recCounts = {};
    (doRes.data || []).forEach(r => { if (r.section_id) dropCounts[r.section_id] = (dropCounts[r.section_id] || 0) + 1; });
    (recRes.data || []).forEach(r => { if (r.section_id) recCounts[r.section_id]  = (recCounts[r.section_id]  || 0) + 1; });

    rows = (sections || []).map(s => ({
      id: s.id, name: s.name, status: s.status,
      drop_offs: dropCounts[s.id] || 0,
      records:   recCounts[s.id]  || 0,
    }));
    render();
  }

  function statusLabel(s) {
    return { open: "Open", full: "Full", restricted: "Restricted" }[s] || s || "Open";
  }
  function statusClass(s) {
    return { open: "bl-pill--ok", full: "bl-pill--danger", restricted: "bl-pill--warn" }[s] || "bl-pill--ok";
  }
  function nextStatus(s) {
    return { open: "full", full: "restricted", restricted: "open" }[s] || "open";
  }

  function render() {
    const body = $("blPsBody");
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5"><div class="bl-empty">No parking sections yet. Draw polygons in the Leaflet tool and paste the SQL into Supabase, then refresh.</div></td></tr>`;
      return;
    }
    body.innerHTML = rows.map(r => {
      const nameCell = r.id === editingId
        ? `<input class="bl-ps-name-input" data-id="${esc(r.id)}" value="${esc(r.name)}" maxlength="60" autofocus>`
        : `<button class="bl-rowbtn bl-ps-name" data-rename="${esc(r.id)}" title="Rename">${esc(r.name)}</button>`;
      const actions = r.id === editingId
        ? `<button class="bl-btn bl-btn--primary bl-btn--sm" data-save="${esc(r.id)}">Save</button>
           <button class="bl-btn bl-btn--ghost bl-btn--sm" data-cancel="${esc(r.id)}">Cancel</button>`
        : `<button class="bl-btn bl-btn--ghost bl-btn--icon bl-btn--sm" data-rename="${esc(r.id)}" aria-label="Rename ${esc(r.name)}">
             <svg class="bl-icon bl-icon--sm" aria-hidden="true"><use href="#icon-edit"/></svg>
           </button>
           <button class="bl-btn bl-btn--ghost bl-btn--icon bl-btn--sm" data-delete="${esc(r.id)}" aria-label="Delete ${esc(r.name)}">
             <svg class="bl-icon bl-icon--sm" aria-hidden="true"><use href="#icon-trash"/></svg>
           </button>`;
      return `<tr data-row="${esc(r.id)}">
        <td>${nameCell}</td>
        <td><button class="bl-pill ${statusClass(r.status)}" data-status="${esc(r.id)}" title="Cycle status">${esc(statusLabel(r.status))}</button></td>
        <td class="bl-num">${r.drop_offs}</td>
        <td class="bl-num">${r.records}</td>
        <td>${actions}</td>
      </tr>`;
    }).join("");
  }

  // ---------- rename ----------
  function startRename(id) {
    editingId = id;
    render();
    setTimeout(() => {
      const inp = document.querySelector(`.bl-ps-name-input[data-id="${id}"]`);
      if (inp) { inp.focus(); inp.select(); }
    }, 0);
  }
  function cancelRename() { editingId = null; render(); }

  async function saveRename(id) {
    const inp = document.querySelector(`.bl-ps-name-input[data-id="${id}"]`);
    if (!inp) return;
    const name = inp.value.trim().slice(0, 60);
    if (!name) { BL_TOAST.warn("Name can't be empty."); return; }
    const { error } = await sb.from("parking_sections").update({ name }).eq("id", id);
    if (error) { BL_TOAST.error("Rename failed: " + error.message); return; }
    editingId = null;
    BL_TOAST.success("Renamed.");
    await loadAll();
  }

  // ---------- status cycle ----------
  async function cycleStatus(id) {
    const row = rows.find(r => r.id === id);
    if (!row) return;
    const next = nextStatus(row.status);
    const { error } = await sb.from("parking_sections").update({ status: next }).eq("id", id);
    if (error) { BL_TOAST.error("Update failed: " + error.message); return; }
    row.status = next;
    render();
  }

  // ---------- delete-with-merge ----------
  function openDelete(id) {
    const row = rows.find(r => r.id === id);
    if (!row) return;
    deleteTarget = row;
    $("blPsDeleteName").textContent = row.name;
    const total = row.drop_offs + row.records;
    $("blPsDeleteSummary").textContent = total
      ? `${row.drop_offs} drop-off${row.drop_offs === 1 ? "" : "s"} and ${row.records} record${row.records === 1 ? "" : "s"} currently reference this section.`
      : "No drop-offs or records reference this section.";
    // Populate the move-to dropdown with the OTHER sections
    const sel = $("blPsDeleteMove");
    sel.innerHTML = `<option value="">— leave orphaned (section will show as blank) —</option>` +
      rows.filter(r => r.id !== row.id)
          .map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`)
          .join("");
    $("blPsDeleteMoveRow").style.display = total ? "" : "none";
    $("blPsDeleteMsg").textContent = "";
    $("blPsDeleteModal").classList.add("is-open");
    $("blPsDeleteModal").setAttribute("aria-hidden", "false");
  }
  function closeDelete() {
    $("blPsDeleteModal").classList.remove("is-open");
    $("blPsDeleteModal").setAttribute("aria-hidden", "true");
    deleteTarget = null;
  }

  async function confirmDelete() {
    if (!deleteTarget) { closeDelete(); return; }
    const moveTo = $("blPsDeleteMove").value || null;
    const btn = $("blPsDeleteConfirm");
    btn.disabled = true;
    $("blPsDeleteMsg").textContent = "Working…";

    try {
      // 1) reassign referencing rows if requested. Order matters so that if
      // one update fails, we haven't already destroyed the section.
      if (moveTo) {
        const doUpd = await sb.from("drop_offs").update({ section_id: moveTo }).eq("section_id", deleteTarget.id);
        if (doUpd.error) throw new Error("drop_offs move: " + doUpd.error.message);
        const recUpd = await sb.from("records").update({ section_id: moveTo }).eq("section_id", deleteTarget.id);
        if (recUpd.error) throw new Error("records move: " + recUpd.error.message);
      }
      // 2) delete the section. FK is ON DELETE SET NULL, so orphans stay
      // queryable (section_id becomes null; section_name on records is
      // untouched — the row already carried the name at capture time).
      const del = await sb.from("parking_sections").delete().eq("id", deleteTarget.id);
      if (del.error) throw new Error("delete: " + del.error.message);
      BL_TOAST.success(moveTo ? "Deleted and rows moved." : "Deleted.");
      closeDelete();
      await loadAll();
    } catch (e) {
      $("blPsDeleteMsg").textContent = e.message || String(e);
      btn.disabled = false;
    }
  }

  // ---------- retag ----------
  async function retag() {
    const btn = $("blPsRetag");
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "Retagging…";
    const { data, error } = await sb.rpc("retag_drop_offs");
    btn.disabled = false;
    btn.textContent = orig;
    if (error) { BL_TOAST.error("Retag failed: " + error.message); return; }
    BL_TOAST.success(`Retagged. ${data ?? 0} record${data === 1 ? "" : "s"} updated.`);
    await loadAll();
  }

  // ---------- events ----------
  function onBodyClick(e) {
    const btn = e.target.closest("button, input");
    if (!btn) return;
    if (btn.dataset.rename)  return startRename(btn.dataset.rename);
    if (btn.dataset.save)    return saveRename(btn.dataset.save);
    if (btn.dataset.cancel)  return cancelRename();
    if (btn.dataset.status)  return cycleStatus(btn.dataset.status);
    if (btn.dataset.delete)  return openDelete(btn.dataset.delete);
  }
  function onBodyKeydown(e) {
    if (!editingId) return;
    if (e.key === "Enter")  { e.preventDefault(); saveRename(editingId); }
    if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
  }

  function start() {
    if (started) return;
    started = true;
    $("blPsBody")?.addEventListener("click", onBodyClick);
    $("blPsBody")?.addEventListener("keydown", onBodyKeydown);
    $("blPsRefresh")?.addEventListener("click", loadAll);
    $("blPsRetag")?.addEventListener("click", retag);
    $("blPsDeleteClose")?.addEventListener("click", closeDelete);
    $("blPsDeleteCancel")?.addEventListener("click", closeDelete);
    $("blPsDeleteConfirm")?.addEventListener("click", confirmDelete);
    $("blPsDeleteModal")?.addEventListener("click", (e) => {
      if (e.target === $("blPsDeleteModal")) closeDelete();
    });
  }

  // Lazy-load when the section is first shown.
  document.addEventListener("bl-section-shown", (e) => {
    if (e.detail !== "parking-sections") return;
    start();
    loadAll();
  });

  window.BL_PARKING_SECTIONS = { reload: loadAll };
})();
