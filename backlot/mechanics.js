// ============================================================
// Backlot — Mechanics Service
//   Mounts into #section-mechanics. Read-only, shop-wide view of what
//   mechanics are working on right now, sourced from the same
//   `service_jobs` / `service_vendors` tables the driver app's Mechanic
//   role writes to. Bucketed the same way as that role's own "New
//   Entry" landing screen (maintenance.js #panel-service-scan): open
//   jobs, waiting on parts, out at vendor, closed this week, and
//   vehicles flagged for service that no one has opened a job for yet.
//
//   No edit/close actions here — this is a manager's status board, not
//   a second copy of the mechanic's work-order form. Realtime + 30s
//   poll. Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;
  const label = (s) => (window.BL_STATUS_LABEL ? BL_STATUS_LABEL(s) : s) || "";

  // Mirrors maintenance.js's own JOB_TYPES — the set of statuses that mean
  // "this vehicle needs mechanic work" rather than a driver/CXR status.
  const JOB_TYPES = ["PM", "MK", "MR", "OM", "TI", "LP", "BODY", "GLASS"];

  let pollTimer = null, realtimeChan = null, started = false;

  const vinCell = (serial) =>
    `<button type="button" class="bl-rowbtn" data-vin-history="${esc(serial || "")}">${esc(serial || "—")}</button>`;

  // Small neutral "Nd" callout, same idea as the driver app's svc-days-out —
  // only worth a caller's attention once it's been at least a day.
  function daysTag(iso) {
    if (!iso) return "";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return days >= 1 ? ` <span class="bl-shift-tag">${days}d</span>` : "";
  }

  function performedByText(j) {
    if (j.performed_by !== "vendor") return "In-house";
    const name = j.vendor && j.vendor.name;
    return name ? `Vendor · ${name}` : "Vendor";
  }

  // Resolve display names for a set of profile ids in one round trip —
  // same shape as roster.js / reports.js's own copy.
  async function resolveNames(ids, fallback) {
    const names = {};
    const list = [...new Set(ids.filter(Boolean))];
    if (list.length) {
      const { data } = await sb.from("profiles").select("id,display_name").in("id", list);
      (data || []).forEach((p) => { names[p.id] = p.display_name || fallback; });
    }
    return names;
  }

  // Shared fetch → count → name-resolve → render pipeline for the four
  // service_jobs-backed buckets (Flagged is vehicles-backed and handled
  // separately below). "Mechanic" on each row is whoever touched the job
  // last (updated_by), falling back to whoever opened it.
  async function runBucket({ query, countEl, bodyEl, colspan, emptyMsg, rowHtml }) {
    const { data, error } = await query;
    if (error) {
      if (countEl) countEl.textContent = "—";
      if (bodyEl) bodyEl.innerHTML = `<tr><td colspan="${colspan}"><div class="bl-empty">${esc(error.message)}</div></td></tr>`;
      return;
    }
    const rows = data || [];
    if (countEl) countEl.textContent = String(rows.length);
    if (!bodyEl) return;
    if (!rows.length) {
      bodyEl.innerHTML = `<tr><td colspan="${colspan}"><div class="bl-empty">${esc(emptyMsg)}</div></td></tr>`;
      return;
    }
    const names = await resolveNames(rows.flatMap((j) => [j.opened_by, j.updated_by]), "—");
    bodyEl.innerHTML = rows.map((j) => rowHtml(j, names[j.updated_by || j.opened_by] || "—")).join("");
  }

  function loadOpen() {
    return runBucket({
      query: sb.from("service_jobs")
        .select("id,serial_id,job_type,performed_by,opened_at,opened_by,updated_by,vendor:service_vendors(name)")
        .eq("state", "OPEN").eq("waiting_on_parts", false)
        .order("opened_at", { ascending: false }).limit(50),
      countEl: $("blMechOpenCount"), bodyEl: $("blMechOpenBody"), colspan: 5,
      emptyMsg: "No open jobs.",
      rowHtml: (j, name) => `
        <tr>
          <td>${vinCell(j.serial_id)}</td>
          <td><span class="bl-role-pill">${esc(label(j.job_type))}</span></td>
          <td>${esc(performedByText(j))}</td>
          <td>${esc(name)}</td>
          <td>${esc(fmt.timeAgo(j.opened_at))}</td>
        </tr>`,
    });
  }

  function loadWaiting() {
    return runBucket({
      query: sb.from("service_jobs")
        .select("id,serial_id,job_type,parts_note,waiting_since,opened_by,updated_by")
        .eq("waiting_on_parts", true).neq("state", "CLOSED")
        .order("waiting_since", { ascending: false }).limit(50),
      countEl: $("blMechWaitingCount"), bodyEl: $("blMechWaitingBody"), colspan: 5,
      emptyMsg: "Nothing waiting on parts.",
      rowHtml: (j, name) => `
        <tr>
          <td>${vinCell(j.serial_id)}</td>
          <td><span class="bl-role-pill">${esc(label(j.job_type))}</span></td>
          <td>${esc(j.parts_note || "—")}</td>
          <td>${esc(fmt.timeAgo(j.waiting_since))}${daysTag(j.waiting_since)}</td>
          <td>${esc(name)}</td>
        </tr>`,
    });
  }

  function loadVendor() {
    return runBucket({
      query: sb.from("service_jobs")
        .select("id,serial_id,job_type,sent_out_at,opened_by,updated_by,vendor:service_vendors(name)")
        .eq("state", "SENT_OUT")
        .order("sent_out_at", { ascending: false }).limit(50),
      countEl: $("blMechVendorCount"), bodyEl: $("blMechVendorBody"), colspan: 5,
      emptyMsg: "Nothing out at a vendor.",
      rowHtml: (j, name) => `
        <tr>
          <td>${vinCell(j.serial_id)}</td>
          <td><span class="bl-role-pill">${esc(label(j.job_type))}</span></td>
          <td>${esc((j.vendor && j.vendor.name) || "—")}</td>
          <td>${esc(fmt.timeAgo(j.sent_out_at))}${daysTag(j.sent_out_at)}</td>
          <td>${esc(name)}</td>
        </tr>`,
    });
  }

  function loadClosed() {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    return runBucket({
      query: sb.from("service_jobs")
        .select("id,serial_id,job_type,close_status,closed_at,opened_by,updated_by")
        .eq("state", "CLOSED").gte("closed_at", since)
        .order("closed_at", { ascending: false }).limit(50),
      countEl: $("blMechClosedCount"), bodyEl: $("blMechClosedBody"), colspan: 5,
      emptyMsg: "Nothing closed in the last 7 days.",
      rowHtml: (j, name) => `
        <tr>
          <td>${vinCell(j.serial_id)}</td>
          <td><span class="bl-role-pill">${esc(label(j.job_type))}</span></td>
          <td>${esc(label(j.close_status) || "—")}</td>
          <td>${esc(fmt.timeAgo(j.closed_at))}</td>
          <td>${esc(name)}</td>
        </tr>`,
    });
  }

  // Vehicles a driver/CXR flagged (current_status = a job type) that no
  // mechanic has opened a matching job for yet — mirrors maintenance.js's
  // loadFlaggedVehicles so a manager sees the same "not started" gap the
  // mechanic's own landing screen surfaces.
  async function loadFlagged() {
    const countEl = $("blMechFlaggedCount"), bodyEl = $("blMechFlaggedBody");
    const [vehRes, jobsRes] = await Promise.all([
      sb.from("vehicles").select("serial_id,current_status,last_seen_at").in("current_status", JOB_TYPES),
      sb.from("service_jobs").select("serial_id,job_type").neq("state", "CLOSED"),
    ]);
    if (vehRes.error) {
      if (countEl) countEl.textContent = "—";
      if (bodyEl) bodyEl.innerHTML = `<tr><td colspan="3"><div class="bl-empty">${esc(vehRes.error.message)}</div></td></tr>`;
      return;
    }
    if (jobsRes.error) console.warn("[Backlot] mechanics flagged jobs", jobsRes.error);
    const openPairs = new Set((jobsRes.data || []).map((j) => `${j.serial_id}::${j.job_type}`));
    const flagged = (vehRes.data || []).filter((v) => !openPairs.has(`${v.serial_id}::${v.current_status}`));
    if (countEl) countEl.textContent = String(flagged.length);
    if (!bodyEl) return;
    bodyEl.innerHTML = flagged.length
      ? flagged.map((v) => `
          <tr>
            <td>${vinCell(v.serial_id)}</td>
            <td><span class="bl-role-pill">${esc(label(v.current_status))}</span></td>
            <td>${esc(fmt.timeAgo(v.last_seen_at))}</td>
          </tr>`).join("")
      : `<tr><td colspan="3"><div class="bl-empty">Nothing flagged.</div></td></tr>`;
  }

  function loadAll() {
    loadOpen();
    loadWaiting();
    loadVendor();
    loadClosed();
    loadFlagged();
  }

  // VIN cells jump to the same VIN-history page the topbar search and
  // Records table use — one drill-down path everywhere in Backlot.
  function onSectionClick(e) {
    const btn = e.target.closest("[data-vin-history]");
    if (!btn) return;
    if (window.BL_RECORDS && BL_RECORDS.openVinHistory) BL_RECORDS.openVinHistory(btn.dataset.vinHistory);
  }

  function start() {
    if (started) return;
    started = true;
    $("blMechRefresh")?.addEventListener("click", loadAll);
    $("section-mechanics")?.addEventListener("click", onSectionClick);
    loadAll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(loadAll, 30000);
    realtimeChan = sb.channel("backlot-mechanics")
      .on("postgres_changes", { event: "*", schema: "public", table: "service_jobs" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "vehicles" }, loadAll)
      .subscribe();
  }

  function stop() {
    started = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  document.addEventListener("bl-auth-change", () => { if (BL_AUTH.canEnter()) start(); else stop(); });
  if (BL_AUTH.canEnter()) start();
  document.addEventListener("bl-section-shown", (e) => { if (e.detail === "mechanics" && started) loadAll(); });

  window.BL_MECHANICS = { refresh: loadAll };
})();
