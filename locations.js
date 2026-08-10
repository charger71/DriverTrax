// ============================================================
// DriverTrax Locations (manager-only)
//   - Lists every row in parking_sections
//   - Add-location modal creates a name-only row (no polygon)
//     that immediately shows up in the driver's Location dropdown
//   - Delete removes the row; the boundary editor for polygon
//     locations still lives outside the driver app
//
// Mounts into #panel-locations; wired from the Locations menu item.
// After any mutation, calls DT_DROPOFFS.refreshSections() so
// #destination and #fDest re-populate without a page reload.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb  = DT_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  let sections = [];
  let realtimeChan = null;

  async function load() {
    const list = $("locList");
    const { data, error } = await sb
      .from("parking_sections_geo")
      .select("id,name,status,geojson")
      .order("name", { ascending: true });
    if (error) {
      if (list) list.innerHTML = `<div class="u-empty">${esc(error.message)}</div>`;
      return;
    }
    sections = data || [];
    render();
  }

  function render() {
    const list = $("locList");
    if (!list) return;
    if (!sections.length) {
      list.innerHTML = `<div class="u-empty">No locations yet. Add one to get started.</div>`;
      return;
    }
    list.innerHTML = sections.map(s => {
      const hasPolygon = !!s.geojson;
      const statusLabel = s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : "—";
      return `
        <div class="loc-row" data-id="${esc(s.id)}">
          <div class="loc-row-main">
            <div class="loc-row-name">${esc(s.name)}</div>
            <div class="loc-row-meta">
              <span class="loc-row-status loc-row-status--${esc(s.status || 'open')}">${esc(statusLabel)}</span>
              <span class="loc-row-badge loc-row-badge--${hasPolygon ? 'polygon' : 'name'}">
                ${hasPolygon ? 'polygon' : 'name only'}
              </span>
            </div>
          </div>
          <button type="button" class="btn btn-destructive btn--sm loc-row-delete"
                  data-id="${esc(s.id)}" data-name="${esc(s.name)}"
                  aria-label="Delete ${esc(s.name)}">Delete</button>
        </div>
      `;
    }).join("");
  }

  function showModal() {
    const modal = $("locModal");
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => modal.querySelector('input[name="name"]')?.focus(), 50);
  }

  function hideModal() {
    const modal = $("locModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    const form = $("locForm");
    if (form) form.reset();
    DT_UI.setMessage($("locModalMsg"), "");
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form  = $("locForm");
    const msg   = $("locModalMsg");
    const submit = $("locModalSubmit");
    if (!form) return;
    const name = (form.elements.name.value || "").trim().slice(0, 40);
    const status = form.elements.status.value || "open";
    if (!name) {
      DT_UI.setMessage(msg, "Enter a name.", "err");
      return;
    }
    submit.disabled = true;
    DT_UI.setMessage(msg, "Saving…", "ok");

    // boundary stays null — this is a name-only location. Managers who
    // want polygon-based auto-tagging still author those outside the app.
    const { error } = await sb
      .from("parking_sections")
      .insert({ name, status });

    submit.disabled = false;
    if (error) {
      // 23505 = unique_violation on the case-insensitive name index.
      const dup = error.code === "23505" ||
                  /duplicate|unique/i.test(error.message || "");
      DT_UI.setMessage(msg, dup ? "That name already exists." : (error.message || "Save failed"), "err");
      return;
    }

    DT_TOAST.show("Location added", "success");
    hideModal();
    await load();
    // Refresh the driver dropdown cache so the new option is immediately
    // pickable on the entry form.
    if (window.DT_DROPOFFS?.refreshSections) {
      try { await DT_DROPOFFS.refreshSections(); } catch (_) {}
    }
  }

  async function onDelete(id, name) {
    if (!id) return;
    if (!confirm(`Delete "${name}"?\n\nThis removes it from the Location dropdown. Existing records that already reference this name are unaffected.`)) return;
    const { error } = await sb
      .from("parking_sections")
      .delete()
      .eq("id", id);
    if (error) {
      if (DT_ERR.isMissing(error)) {
        DT_TOAST.missing("location");
        await load();
        return;
      }
      DT_TOAST.show(error.message || "Delete failed", "error");
      return;
    }
    DT_TOAST.show("Location deleted", "success");
    await load();
    if (window.DT_DROPOFFS?.refreshSections) {
      try { await DT_DROPOFFS.refreshSections(); } catch (_) {}
    }
  }

  const life = DT_LIFECYCLE.create({
    // Registered once ever — see DT_LIFECYCLE in utils.js.
    wire() {
      $("locAddBtn")?.addEventListener("click", showModal);
      $("locModalClose")?.addEventListener("click", hideModal);
      $("locModalCancel")?.addEventListener("click", hideModal);
      $("locModal")?.addEventListener("click", (e) => { if (e.target.id === "locModal") hideModal(); });
      $("locForm")?.addEventListener("submit", onSubmit);
      $("locList")?.addEventListener("click", (e) => {
        const btn = e.target.closest(".loc-row-delete");
        if (!btn) return;
        onDelete(btn.dataset.id, btn.dataset.name);
      });
    },
    start() {
      load();
      realtimeChan = sb.channel("locations-feed")
        .on("postgres_changes", { event: "*", schema: "public", table: "parking_sections" }, () => {
          load();
          if (window.DT_DROPOFFS?.refreshSections) {
            DT_DROPOFFS.refreshSections().catch(() => {});
          }
        })
        .subscribe();
    },
    stop() {
      if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
    }
  });

  const canSee = () => !!(DT_AUTH.isManager?.() || DT_AUTH.isAdmin?.());
  document.addEventListener("dt-auth-change", () => life.set(canSee()));
  life.set(canSee());

  window.DT_LOCATIONS = { reload: load };
})();
