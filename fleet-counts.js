// ============================================================
// DriverTrax Fleet Counts
//   Top-of-screen banner showing lot-wide Returns + Rentals.
//   Managers / CXR / admin edit the numbers from the Alerts
//   panel (#fcForm). Everyone else sees a read-only banner.
//
//   Backing table: public.fleet_counts (singleton row id='global')
//   Realtime channel: postgres_changes on the same row.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const $ = (id) => document.getElementById(id);
  const ROW_ID = "global";
  let realtimeChan = null;
  let wired = false;

  function canEdit() {
    return !!(DT_AUTH.isCxr?.() || DT_AUTH.isManager?.() || DT_AUTH.isAdmin?.());
  }

  function fmtAgo(iso) {
    if (!iso || !window.DT_FORMAT) return "";
    return DT_FORMAT.timeAgo(iso);
  }

  function renderBanner(row) {
    const banner = $("fleetCountsBanner");
    if (!banner) return;
    if (!row) { banner.classList.add("hidden"); return; }
    banner.classList.remove("hidden");
    const returns = Number.isFinite(row.returns_count) ? row.returns_count : 0;
    const rentals = Number.isFinite(row.rentals_count) ? row.rentals_count : 0;
    $("fcReturns").textContent = returns;
    $("fcRentals").textContent = rentals;
    // Day-start only renders when the baseline differs from the live
    // number — no point in showing "start 5" next to "5".
    const rs = Number.isFinite(row.returns_day_start) ? row.returns_day_start : null;
    const ls = Number.isFinite(row.rentals_day_start) ? row.rentals_day_start : null;
    $("fcReturnsStart").textContent = (rs !== null && rs !== returns) ? rs : "";
    $("fcRentalsStart").textContent = (ls !== null && ls !== rentals) ? ls : "";
    $("fcNote").textContent = row.note ? row.note : "";
    const ago = fmtAgo(row.updated_at);
    $("fcUpdated").textContent = ago ? `updated ${ago}` : "";
  }

  function prefillForm(row) {
    const form = $("fcForm");
    if (!form || !row) return;
    form.elements.returns_count.value = Number.isFinite(row.returns_count) ? row.returns_count : 0;
    form.elements.rentals_count.value = Number.isFinite(row.rentals_count) ? row.rentals_count : 0;
    form.elements.note.value = row.note || "";
  }

  async function loadRow() {
    const { data, error } = await sb.from("fleet_counts")
      .select("returns_count,rentals_count,returns_day_start,rentals_day_start,day_start_date,note,updated_at,updated_by")
      .eq("id", ROW_ID).maybeSingle();
    if (error) { console.warn("[FleetCounts] load", error); return null; }
    renderBanner(data);
    if (canEdit()) prefillForm(data);
    return data;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!canEdit()) return;
    const form = $("fcForm");
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = "Saving…";
    const fd = new FormData(form);
    const returnsVal = parseInt(fd.get("returns_count"), 10);
    const rentalsVal = parseInt(fd.get("rentals_count"), 10);
    const noteVal = (fd.get("note") || "").trim();
    if (!Number.isFinite(returnsVal) || !Number.isFinite(rentalsVal) || returnsVal < 0 || rentalsVal < 0) {
      btn.disabled = false; btn.textContent = "Update counts";
      if (typeof showToast === "function") showToast("Enter non-negative numbers for both counts.", "error");
      return;
    }
    const user = DT_AUTH.getUser();
    const { error } = await sb.from("fleet_counts")
      .update({
        returns_count: returnsVal,
        rentals_count: rentalsVal,
        note: noteVal || null,
        updated_at: new Date().toISOString(),
        updated_by: user?.id || null
      })
      .eq("id", ROW_ID);
    btn.disabled = false; btn.textContent = "Update counts";
    if (error) {
      console.warn("[FleetCounts] update", error);
      if (typeof showToast === "function") showToast(error.message, "error");
      return;
    }
    if (typeof showToast === "function") showToast("Counts updated", "success");
    await loadRow();
  }

  function subscribe() {
    if (realtimeChan) return;
    try {
      realtimeChan = sb.channel("fleet-counts-live")
        .on("postgres_changes",
            { event: "*", schema: "public", table: "fleet_counts", filter: `id=eq.${ROW_ID}` },
            () => loadRow())
        .subscribe();
    } catch (e) { console.warn("[FleetCounts] subscribe", e); }
  }

  function teardown() {
    if (realtimeChan) {
      try { sb.removeChannel(realtimeChan); } catch (_) {}
      realtimeChan = null;
    }
    const banner = $("fleetCountsBanner");
    if (banner) banner.classList.add("hidden");
  }

  // Show/hide the editor section based on current role. Safe to call as
  // often as needed — runs on every auth-change so the form appears once
  // the profile is loaded (the first auth-change fires before profile
  // is populated and would otherwise hide the form for everyone).
  function applyEditorVisibility() {
    const form = $("fcForm");
    const section = form?.closest(".dash-section");
    if (section) section.style.display = canEdit() ? "" : "none";
  }

  function start() {
    if (!wired) {
      wired = true;
      const form = $("fcForm");
      if (form) form.addEventListener("submit", onSubmit);
      loadRow();
      subscribe();
    }
    applyEditorVisibility();
    // Re-prefill the form if the user just gained edit rights.
    if (canEdit()) loadRow();
  }

  document.addEventListener("dt-auth-change", (e) => {
    if (e.detail?.user) start();
    else teardown();
  });
  if (DT_AUTH.getUser()) start();

  window.DT_FLEET_COUNTS = { reload: loadRow };
})();
