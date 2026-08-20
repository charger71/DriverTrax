// ============================================================
// Backlot — Roster & Leaderboard
//   Mounts into #section-roster.
//     • On-shift roster (today): drivers from records, detailers
//       from detail_jobs, mechanics from service_jobs, with
//       count / pace / last-active.
//     • Leaderboard: role (driver|detailer|mechanic) × period
//       (today|week|month|quarter), ranked by volume.
//   Realtime + 30s poll. Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;

  // Single source of truth for the three roles this panel tracks. Driver
  // volume comes from `records` (one row per scan); detailer/mechanic
  // volume comes from their own per-job tables (one row per job, not per
  // scan), so both need a start/end pair instead of a single timestamp.
  const ROLE_META = {
    driver:   { label: "Driver",   plural: "drivers",   unit: "car" },
    detailer: { label: "Detailer", plural: "detailers", unit: "job" },
    mechanic: { label: "Mechanic", plural: "mechanics", unit: "job" }
  };
  const roleLabel = (r) => (ROLE_META[r] || ROLE_META.driver).label;

  const state = { role: "driver", period: "today" };
  let realtimeChan = null, pollTimer = null, started = false;
  let lbSeq = 0; // guards against out-of-order leaderboard renders on rapid toggles
  let rosterPager = null, lbPager = null;
  let lbCtx = { unit: "car" }; // last-render context used by the leaderboard row renderer

  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

  function periodStart(period) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (period === "week")    { d.setDate(d.getDate() - d.getDay()); return d; }   // Sunday
    if (period === "month")   { d.setDate(1); return d; }
    if (period === "quarter") { d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1); return d; }
    return d; // today
  }
  const periodLabel = (p) => ({ today: "Today's", week: "This Week's", month: "This Month's", quarter: "This Quarter's" }[p] || "Today's");

  // Resolve display names for a set of profile ids in one round trip.
  async function resolveNames(ids, fallback) {
    const names = {};
    const list = [...new Set(ids.filter(Boolean))];
    if (list.length) {
      const { data } = await sb.from("profiles").select("id,display_name").in("id", list);
      (data || []).forEach((p) => { names[p.id] = p.display_name || fallback; });
    }
    return names;
  }

  function paceSub(count, first, last) {
    const spanHrs = (new Date(last) - new Date(first)) / 3600000;
    if (spanHrs >= 1 / 60) return `${(count / Math.max(1 / 60, spanHrs)).toFixed(1)}/hr`;
    return "—";
  }

  // Aggregate per-job rows (detail_jobs / service_jobs shape: one row per
  // job, with separate start/end timestamps) into { count, first, last } by id.
  function aggregateByJob(rows, idCol, startCol, endCol) {
    const byId = {};
    rows.forEach((j) => {
      const id = j[idCol];
      if (!id) return;
      const last = j[endCol] || j[startCol];
      const a = byId[id] || (byId[id] = { count: 0, first: j[startCol], last });
      a.count++; if (j[startCol] < a.first) a.first = j[startCol]; if (last > a.last) a.last = last;
    });
    return byId;
  }

  // Aggregate per-scan rows (records shape: one row per scan, single ts)
  // into the same { count, first, last } shape by id.
  function aggregateByTs(rows, idCol, tsCol) {
    const byId = {};
    rows.forEach((r) => {
      const id = r[idCol];
      if (!id) return;
      const a = byId[id] || (byId[id] = { count: 0, first: r[tsCol], last: r[tsCol] });
      a.count++; if (r[tsCol] < a.first) a.first = r[tsCol]; if (r[tsCol] > a.last) a.last = r[tsCol];
    });
    return byId;
  }

  // ---------- on-shift roster (today, all three roles) ----------
  async function loadRoster() {
    const since = startOfToday().toISOString();
    const [recRes, jobRes, svcRes] = await Promise.all([
      sb.from("records").select("user_id,ts,status").gte("ts", since).not("status", "in", "(DETAILING,DETAILED)"),
      sb.from("detail_jobs").select("detailer_id,started_at,completed_at").gte("started_at", since),
      sb.from("service_jobs").select("opened_by,opened_at,closed_at").gte("opened_at", since),
    ]);
    if (recRes.error) console.warn("[Backlot] roster records", recRes.error);
    if (jobRes.error) console.warn("[Backlot] roster jobs", jobRes.error);
    if (svcRes.error) console.warn("[Backlot] roster service jobs", svcRes.error);

    const agg = {}; // key `${role}:${id}` → { id, role, count, first, last }
    const merge = (role, byId) => {
      Object.entries(byId).forEach(([id, a]) => { agg[`${role}:${id}`] = { id, role, ...a }; });
    };
    merge("driver", aggregateByTs(recRes.data || [], "user_id", "ts"));
    merge("detailer", aggregateByJob(jobRes.data || [], "detailer_id", "started_at", "completed_at"));
    merge("mechanic", aggregateByJob(svcRes.data || [], "opened_by", "opened_at", "closed_at"));

    const rows = Object.values(agg).sort((a, b) => b.count - a.count);
    const countEl = $("blRosterCount");
    if (countEl) countEl.textContent = rows.length ? `${rows.length} active` : "none yet";

    const body = $("blRosterBody");
    if (!body) return;
    if (!rows.length) {
      const err = recRes.error?.message || jobRes.error?.message || svcRes.error?.message;
      const msg = err ? `Query error: ${err}` : "No drivers, detailers, or mechanics active yet today.";
      body.innerHTML = `<tr><td colspan="5"><div class="bl-empty">${esc(msg)}</div></td></tr>`;
      hidePager($("blRosterPager"));
      return;
    }
    const names = await resolveNames(rows.map((r) => r.id), "Unknown");
    const enriched = rows.map((r) => ({ ...r, name: names[r.id] || roleLabel(r.role) }));
    ensureRosterPager();
    rosterPager.setItems(enriched);
  }

  function renderRosterRows(rows) {
    const body = $("blRosterBody");
    if (!body) return;
    body.innerHTML = rows.map((r) => {
      const unit = (ROLE_META[r.role] || ROLE_META.driver).unit;
      return `<tr>
        <td>${esc(r.name)}</td>
        <td><span class="bl-role-pill bl-role-pill--${esc(r.role)}">${esc(r.role)}</span></td>
        <td><b>${r.count}</b> <span class="u-muted">${unit}${r.count === 1 ? "" : "s"}</span></td>
        <td>${esc(paceSub(r.count, r.first, r.last))}</td>
        <td>${esc(fmt.timeAgo(r.last))}</td>
      </tr>`;
    }).join("");
  }

  function ensureRosterPager() { if (!rosterPager) rosterPager = BL_PAGINATE.create({ mount: $("blRosterPager"), render: renderRosterRows }); }
  function hidePager(mount) { if (mount) { mount.hidden = true; mount.innerHTML = ""; } }

  // ---------- leaderboard (role × period) ----------
  async function loadLeaderboard() {
    const meta = ROLE_META[state.role] || ROLE_META.driver;
    const title = $("blLbTitle");
    if (title) title.textContent = `${periodLabel(state.period)} ${meta.label} Leaders`;
    const el = $("blLeaderboard");
    if (!el) return;
    const seq = ++lbSeq;
    const since = periodStart(state.period).toISOString();

    let byUser = {};
    let lbError = null;
    if (state.role === "detailer") {
      const { data, error } = await sb.from("detail_jobs").select("detailer_id,started_at,completed_at").gte("started_at", since);
      if (error) { console.warn("[Backlot] leaderboard", error); lbError = error; }
      byUser = aggregateByJob(data || [], "detailer_id", "started_at", "completed_at");
    } else if (state.role === "mechanic") {
      const { data, error } = await sb.from("service_jobs").select("opened_by,opened_at,closed_at").gte("opened_at", since);
      if (error) { console.warn("[Backlot] leaderboard", error); lbError = error; }
      byUser = aggregateByJob(data || [], "opened_by", "opened_at", "closed_at");
    } else {
      const { data, error } = await sb.from("records").select("user_id,ts").gte("ts", since).not("status", "in", "(DETAILING,DETAILED)");
      if (error) { console.warn("[Backlot] leaderboard", error); lbError = error; }
      byUser = aggregateByTs(data || [], "user_id", "ts");
    }

    if (seq !== lbSeq) return; // a newer toggle superseded this load
    const ids = Object.keys(byUser);
    if (!ids.length) {
      const when = { today: "yet today", week: "this week", month: "this month", quarter: "this quarter" }[state.period];
      el.innerHTML = `<div class="bl-empty">${lbError ? esc("Query error: " + lbError.message) : `No ${meta.plural} active ${when}.`}</div>`;
      hidePager($("blLbPager"));
      return;
    }
    const names = await resolveNames(ids, meta.label);
    if (seq !== lbSeq) return;
    const rows = ids.map((id) => ({ id, name: names[id] || meta.label, ...byUser[id] }))
      .sort((a, b) => b.count - a.count)
      .map((r, i) => ({ ...r, rank: i + 1 })); // stamp absolute rank before paginating

    lbCtx.unit = meta.unit;
    ensureLbPager();
    lbPager.setItems(rows);
  }

  function renderLbRows(rows) {
    const el = $("blLeaderboard");
    if (!el) return;
    const unit = lbCtx.unit;
    el.innerHTML = rows.map((r) => `
      <div class="bl-leader-row">
        <div class="bl-leader-rank ${r.rank === 1 ? "is-gold" : ""}">${r.rank}</div>
        <div>
          <div class="bl-leader-name">${esc(r.name)}</div>
          <div class="bl-leader-sub">${esc(paceSub(r.count, r.first, r.last))} · ${esc(fmt.timeAgo(r.last))}</div>
        </div>
        <div class="bl-leader-count" title="${r.count} ${unit}${r.count === 1 ? "" : "s"}">${r.count}</div>
      </div>`).join("");
  }

  function ensureLbPager() { if (!lbPager) lbPager = BL_PAGINATE.create({ mount: $("blLbPager"), render: renderLbRows }); }

  function wireControls() {
    const roleSeg = $("blLbRole"), periodSeg = $("blLbPeriod");
    if (roleSeg && !roleSeg.dataset.wired) {
      roleSeg.dataset.wired = "1";
      roleSeg.addEventListener("click", (e) => {
        const btn = e.target.closest(".bl-seg-btn"); if (!btn) return;
        state.role = btn.dataset.role;
        roleSeg.querySelectorAll(".bl-seg-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
        loadLeaderboard();
      });
    }
    if (periodSeg && !periodSeg.dataset.wired) {
      periodSeg.dataset.wired = "1";
      periodSeg.addEventListener("click", (e) => {
        const btn = e.target.closest(".bl-seg-btn"); if (!btn) return;
        state.period = btn.dataset.period;
        periodSeg.querySelectorAll(".bl-seg-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
        loadLeaderboard();
      });
    }
  }

  function refreshAll() { loadRoster(); loadLeaderboard(); }

  function start() {
    if (started) return;
    started = true;
    wireControls();
    $("blRosterRefresh")?.addEventListener("click", refreshAll);
    refreshAll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshAll, 30000);
    realtimeChan = sb.channel("backlot-roster")
      .on("postgres_changes", { event: "*", schema: "public", table: "records" }, refreshAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "detail_jobs" }, refreshAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "service_jobs" }, refreshAll)
      .subscribe();
  }

  function stop() {
    started = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  document.addEventListener("bl-auth-change", () => { if (BL_AUTH.canEnter()) start(); else stop(); });
  if (BL_AUTH.canEnter()) start();
  document.addEventListener("bl-section-shown", (e) => { if (e.detail === "roster" && started) refreshAll(); });

  window.BL_ROSTER = { refresh: refreshAll };
})();
