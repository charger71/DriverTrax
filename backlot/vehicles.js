// ============================================================
// Backlot — Vehicles master list
//   Mounts into #section-vehicles. Server-paginated list of every
//   public.vehicles row, queried directly (not via records) — this is
//   the only place in Backlot that can find a vehicle with zero scan
//   history (an Inventory Import placeholder, a duplicate, junk data).
//
//   Row actions:
//     • Archive/Unarchive — manager+CXR (same level as the rest of
//       Backlot; vehicles_update_authenticated already permits the
//       write, no RPC needed).
//     • Delete — admin-only, omitted entirely for everyone else. Calls
//       the delete_vehicle() RPC (security definer — there's no client
//       delete policy on vehicles), which blocks if the vehicle has any
//       reference in records/service_jobs/drop_offs.
//
//   archive/unarchive/openDeleteModal are exported on BL_VEHICLES so
//   records.js's VIN-history page (#section-vin) can trigger the same
//   actions without duplicating the logic.
//
//   Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;
  const label = (s) => (window.BL_STATUS_LABEL ? BL_STATUS_LABEL(s) : s) || "";

  let started = false;
  let currentPage = [];
  let pager = null;
  let filterSeq = 0;

  // ---------- filters ----------
  function readFilters() {
    return {
      search: ($("blVehSearch")?.value || "").trim(),
      scope: document.querySelector('#blVehScopeSeg .bl-seg-btn.is-active')?.dataset.scope || "active",
    };
  }
  function applyFiltersToQuery(q, f) {
    if (f.scope !== "all") q = q.is("archived_at", null);
    if (f.search) {
      const s = f.search.replace(/[%_]/g, "\\$&");
      q = q.or(`serial_id.ilike.%${s}%,plate.ilike.%${s}%,sipp.ilike.${s}%`);
    }
    return q;
  }

  // ---------- load ----------
  async function loadPage(page, pageSize) {
    const body = $("blVehBody");
    if (!body) return;
    const p = page || pager?.getPage() || 1;
    const ps = pageSize || pager?.getPageSize() || BL_PAGINATE.DEFAULT_SIZE;
    const from = (p - 1) * ps;
    const to = from + ps - 1;
    const seq = ++filterSeq;
    body.innerHTML = `<tr><td colspan="7"><div class="bl-empty">Loading…</div></td></tr>`;

    let q = sb.from("vehicles")
      .select("serial_id,plate,plate_state,sipp,current_status,last_seen_at,imported_at,archived_at,vin_data", { count: "exact" })
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .range(from, to);
    q = applyFiltersToQuery(q, readFilters());

    const { data, error, count } = await q;
    if (seq !== filterSeq) return; // superseded by a newer request

    if (error) {
      body.innerHTML = `<tr><td colspan="7"><div class="bl-empty">${esc("Query error: " + error.message)}</div></td></tr>`;
      hidePager();
      updateCount(null);
      return;
    }
    currentPage = data || [];
    const total = count == null ? currentPage.length : count;
    updateCount(total);

    if (!total) {
      body.innerHTML = `<tr><td colspan="7"><div class="bl-empty">No vehicles match these filters.</div></td></tr>`;
      hidePager();
      return;
    }
    ensurePager();
    pager.setPage({ items: currentPage, total, page: p });
  }

  function updateCount(total) {
    const el = $("blVehCount");
    if (!el) return;
    el.textContent = total == null ? "" : `${total.toLocaleString()} vehicle${total === 1 ? "" : "s"}`;
  }

  function renderRows(rows) {
    const body = $("blVehBody");
    if (!body) return;
    const isAdmin = !!BL_AUTH.isAdmin?.();
    body.innerHTML = rows.map((r) => {
      const vd = r.vin_data || {};
      const sub = [vd.year, vd.make, vd.model].filter(Boolean).join(" ");
      const plate = r.plate ? (r.plate_state ? `${esc(r.plate_state)}-${esc(r.plate)}` : esc(r.plate)) : "—";
      const isArchived = !!r.archived_at;
      const statePill = isArchived
        ? `<span class="bl-disabled-pill">Archived</span>`
        : `<span class="bl-role-pill">Active</span>`;
      const deleteBtn = isAdmin
        ? `<button class="bl-btn bl-btn--icon bl-btn--ghost bl-btn--sm" data-delete="${esc(r.serial_id)}" aria-label="Delete ${esc(r.serial_id)}">
             <svg class="bl-icon bl-icon--sm" aria-hidden="true"><use href="#icon-trash"/></svg>
           </button>`
        : "";
      return `<tr data-row="${esc(r.serial_id)}">
        <td><button class="bl-rowbtn" data-vin-history="${esc(r.serial_id)}"><span class="bl-rec-vin">${esc(r.serial_id)}${sub ? `<small>${esc(sub)}</small>` : ""}</span></button></td>
        <td>${plate}</td>
        <td>${r.sipp ? esc(r.sipp) : "—"}</td>
        <td>${esc(label(r.current_status) || r.current_status || "—")}</td>
        <td>${r.last_seen_at ? esc(fmt.timeAgoOrClock(r.last_seen_at)) : `<span class="sub">Never scanned</span>`}</td>
        <td>${statePill}</td>
        <td>
          <button class="bl-btn bl-btn--sm bl-btn--secondary" data-archive-toggle="${esc(r.serial_id)}" data-archived="${isArchived ? "1" : "0"}">${isArchived ? "Unarchive" : "Archive"}</button>
          ${deleteBtn}
        </td>
      </tr>`;
    }).join("");
  }

  function ensurePager() {
    if (pager) return;
    pager = BL_PAGINATE.create({
      mount: $("blVehPager"),
      mode: "server",
      render: renderRows,
      onPageChange: (page, pageSize) => loadPage(page, pageSize),
    });
  }
  function hidePager() { const m = $("blVehPager"); if (m) { m.hidden = true; m.innerHTML = ""; } }
  function reload() { return loadPage(1); }

  // ---------- archive / unarchive ----------
  async function archiveVehicle(serial) {
    if (!confirm(`Archive ${serial}? It will be hidden from Backlot's vehicle search and the driver app's VIN Lookup / plate lookup until unarchived — or until a driver scans it again, which un-archives it automatically.`)) return false;
    const user = BL_AUTH.getUser();
    const { error } = await sb.from("vehicles")
      .update({ archived_at: new Date().toISOString(), archived_by: user?.id || null })
      .eq("serial_id", serial);
    if (error) { BL_TOAST.error("Archive failed: " + error.message); return false; }
    BL_TOAST.success(`${serial} archived.`);
    return true;
  }

  async function unarchiveVehicle(serial) {
    if (!confirm(`Unarchive ${serial}? It will become visible again in Backlot and the driver app.`)) return false;
    const { error } = await sb.from("vehicles")
      .update({ archived_at: null, archived_by: null })
      .eq("serial_id", serial);
    if (error) { BL_TOAST.error("Unarchive failed: " + error.message); return false; }
    BL_TOAST.success(`${serial} unarchived.`);
    return true;
  }

  async function onArchiveToggle(serial, wasArchived) {
    const ok = wasArchived ? await unarchiveVehicle(serial) : await archiveVehicle(serial);
    if (ok && started) reload();
    return ok;
  }

  // ---------- delete (reference-aware modal) ----------
  let deleteTarget = null, deleteOpts = null;

  async function refreshDeleteCheck(serial) {
    const { data, error } = await sb.rpc("delete_vehicle", { p_serial_id: serial, p_dry_run: true });
    if (deleteTarget !== serial) return; // modal closed/retargeted mid-flight
    if (error) {
      $("blVehDeleteSummary").textContent = error.message || "Couldn't check references.";
      renderDeleteActions(false);
      return;
    }
    if (data.blocked) {
      $("blVehDeleteSummary").textContent =
        `Cannot delete — referenced by ${data.records} record${data.records === 1 ? "" : "s"}, ` +
        `${data.service_jobs} service job${data.service_jobs === 1 ? "" : "s"}, ` +
        `${data.drop_offs} drop-off${data.drop_offs === 1 ? "" : "s"}.`;
      renderDeleteActions(false);
    } else {
      $("blVehDeleteSummary").textContent = "No records, service jobs, or drop-offs reference this vehicle. This cannot be undone.";
      renderDeleteActions(true);
    }
  }

  function renderDeleteActions(canDelete) {
    const el = $("blVehDeleteActions");
    if (!el) return;
    el.innerHTML = canDelete
      ? `<button type="button" class="bl-btn bl-btn--secondary" id="blVehDeleteCancel">Cancel</button>
         <button type="button" class="bl-btn bl-btn--danger" id="blVehDeleteConfirm">Delete vehicle</button>`
      : `<button type="button" class="bl-btn bl-btn--secondary" id="blVehDeleteCancel">Close</button>`;
    $("blVehDeleteCancel")?.addEventListener("click", closeDeleteModal);
    $("blVehDeleteConfirm")?.addEventListener("click", confirmDelete);
  }

  function openDeleteModal(serial, opts) {
    if (!BL_AUTH.isAdmin?.()) return; // defense in depth — RPC re-checks server-side regardless
    deleteTarget = serial;
    deleteOpts = opts || {};
    $("blVehDeleteName").textContent = serial;
    $("blVehDeleteSummary").textContent = "Checking references…";
    $("blVehDeleteMsg").textContent = "";
    renderDeleteActions(false); // no confirm button until the dry-run clears it
    $("blVehDeleteModal").classList.add("is-open");
    $("blVehDeleteModal").setAttribute("aria-hidden", "false");
    refreshDeleteCheck(serial);
  }

  function closeDeleteModal() {
    $("blVehDeleteModal")?.classList.remove("is-open");
    $("blVehDeleteModal")?.setAttribute("aria-hidden", "true");
    deleteTarget = null;
    deleteOpts = null;
  }

  async function confirmDelete() {
    const serial = deleteTarget;
    if (!serial) return closeDeleteModal();
    const btn = $("blVehDeleteConfirm");
    if (btn) btn.disabled = true;
    $("blVehDeleteMsg").textContent = "Deleting…";
    const { data, error } = await sb.rpc("delete_vehicle", { p_serial_id: serial });
    if (deleteTarget !== serial) return; // retargeted mid-flight
    if (error) {
      $("blVehDeleteMsg").textContent = error.message || "Delete failed.";
      await refreshDeleteCheck(serial); // e.g. a reference landed in the gap — re-render as blocked
      return;
    }
    BL_TOAST.success(`${data?.serial_id || serial} deleted.`);
    const cb = deleteOpts?.onDeleted;
    closeDeleteModal();
    if (started) reload();
    if (typeof cb === "function") cb();
  }

  // ---------- events ----------
  function onBodyClick(e) {
    const vinBtn = e.target.closest("[data-vin-history]");
    if (vinBtn) { window.BL_RECORDS?.openVinHistory(vinBtn.dataset.vinHistory); return; }
    const archBtn = e.target.closest("[data-archive-toggle]");
    if (archBtn) { onArchiveToggle(archBtn.dataset.archiveToggle, archBtn.dataset.archived === "1"); return; }
    const delBtn = e.target.closest("[data-delete]");
    if (delBtn) { openDeleteModal(delBtn.dataset.delete); return; }
  }

  function onScopeClick(e) {
    const btn = e.target.closest(".bl-seg-btn");
    if (!btn) return;
    document.querySelectorAll("#blVehScopeSeg .bl-seg-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    reload();
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function start() {
    if (started) return;
    started = true;
    $("blVehBody")?.addEventListener("click", onBodyClick);
    $("blVehRefresh")?.addEventListener("click", reload);
    $("blVehSearch")?.addEventListener("input", debounce(reload, 300));
    $("blVehScopeSeg")?.addEventListener("click", onScopeClick);
    $("blVehDeleteClose")?.addEventListener("click", closeDeleteModal);
    $("blVehDeleteModal")?.addEventListener("click", (e) => { if (e.target === $("blVehDeleteModal")) closeDeleteModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("blVehDeleteModal")?.classList.contains("is-open")) closeDeleteModal();
    });
    reload();
  }

  document.addEventListener("bl-section-shown", (e) => {
    if (e.detail !== "vehicles") return;
    if (!started) start(); else reload();
  });

  window.BL_VEHICLES = { reload, archive: archiveVehicle, unarchive: unarchiveVehicle, openDeleteModal };
})();
