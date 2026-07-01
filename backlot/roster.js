// ============================================================
// Backlot — Roster & Leaderboard
//   Mounts into #section-roster.
//     • On-shift roster (today): drivers from records + detailers
//       from detail_jobs, with count / pace / last-active.
//     • Leaderboard: role (driver|detailer) × period
//       (today|week|month|quarter), ranked by volume.
//   Realtime + 30s poll. Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;

  const state = { role: "driver", period: "today" };
  let realtimeChan = null, pollTimer = null, started = false;
  let lbSeq = 0; // guards against out-of-order leaderboard renders on rapid toggles

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

  // ---------- on-shift roster (today, both roles) ----------
  async function loadRoster() {
    const since = startOfToday().toISOString();
    const [recRes, jobRes] = await Promise.all([
      sb.from("records").select("user_id,ts,status").gte("ts", since).not("status", "in", "(DETAILING,DETAILED)"),
      sb.from("detail_jobs").select("detailer_id,started_at,completed_at").gte("started_at", since),
    ]);
    if (recRes.error) console.warn("[Backlot] roster records", recRes.error);
    if (jobRes.error) console.warn("[Backlot] roster jobs", jobRes.error);

    const agg = {}; // key `${role}:${id}` → { id, role, count, first, last }
    (recRes.data || []).forEach((r) => {
      const k = "driver:" + r.user_id;
      const a = agg[k] || (agg[k] = { id: r.user_id, role: "driver", count: 0, first: r.ts, last: r.ts });
      a.count++; if (r.ts < a.first) a.first = r.ts; if (r.ts > a.last) a.last = r.ts;
    });
    (jobRes.data || []).forEach((j) => {
      if (!j.detailer_id) return;
      const last = j.completed_at || j.started_at;
      const k = "detailer:" + j.detailer_id;
      const a = agg[k] || (agg[k] = { id: j.detailer_id, role: "detailer", count: 0, first: j.started_at, last });
      a.count++; if (j.started_at < a.first) a.first = j.started_at; if (last > a.last) a.last = last;
    });

    const rows = Object.values(agg).sort((a, b) => b.count - a.count);
    const countEl = $("blRosterCount");
    if (countEl) countEl.textContent = rows.length ? `${rows.length} active` : "none yet";

    const body = $("blRosterBody");
    if (!body) return;
    if (!rows.length) {
      const err = recRes.error?.message || jobRes.error?.message;
      const msg = err ? `Query error: ${err}` : "No drivers or detailers active yet today.";
      body.innerHTML = `<tr><td colspan="5"><div class="bl-empty">${esc(msg)}</div></td></tr>`;
      return;
    }
    const names = await resolveNames(rows.map((r) => r.id), "Unknown");
    body.innerHTML = rows.map((r) => {
      const unit = r.role === "detailer" ? "job" : "car";
      return `<tr>
        <td>${esc(names[r.id] || (r.role === "detailer" ? "Detailer" : "Driver"))}</td>
        <td><span class="bl-role bl-role--${r.role}">${r.role}</span></td>
        <td><b>${r.count}</b> <span class="u-muted">${unit}${r.count === 1 ? "" : "s"}</span></td>
        <td>${esc(paceSub(r.count, r.first, r.last))}</td>
        <td>${esc(fmt.timeAgo(r.last))}</td>
      </tr>`;
    }).join("");
  }

  // ---------- leaderboard (role × period) ----------
  async function loadLeaderboard() {
    const title = $("blLbTitle");
    if (title) title.textContent = `${periodLabel(state.period)} ${state.role === "detailer" ? "Detailer" : "Driver"} Leaders`;
    const el = $("blLeaderboard");
    if (!el) return;
    const seq = ++lbSeq;
    const since = periodStart(state.period).toISOString();

    const byUser = {};
    let lbError = null;
    if (state.role === "detailer") {
      const { data, error } = await sb.from("detail_jobs").select("detailer_id,started_at,completed_at").gte("started_at", since);
      if (error) { console.warn("[Backlot] leaderboard", error); lbError = error; }
      (data || []).forEach((j) => {
        if (!j.detailer_id) return;
        const last = j.completed_at || j.started_at;
        const u = byUser[j.detailer_id] || (byUser[j.detailer_id] = { count: 0, first: j.started_at, last });
        u.count++; if (j.started_at < u.first) u.first = j.started_at; if (last > u.last) u.last = last;
      });
    } else {
      const { data, error } = await sb.from("records").select("user_id,ts").gte("ts", since).not("status", "in", "(DETAILING,DETAILED)");
      if (error) { console.warn("[Backlot] leaderboard", error); lbError = error; }
      (data || []).forEach((r) => {
        const u = byUser[r.user_id] || (byUser[r.user_id] = { count: 0, first: r.ts, last: r.ts });
        u.count++; if (r.ts < u.first) u.first = r.ts; if (r.ts > u.last) u.last = r.ts;
      });
    }

    if (seq !== lbSeq) return; // a newer toggle superseded this load
    const ids = Object.keys(byUser);
    if (!ids.length) {
      const who = state.role === "detailer" ? "detailers" : "drivers";
      const when = { today: "yet today", week: "this week", month: "this month", quarter: "this quarter" }[state.period];
      el.innerHTML = `<div class="bl-empty">${lbError ? esc("Query error: " + lbError.message) : `No ${who} active ${when}.`}</div>`;
      return;
    }
    const names = await resolveNames(ids, state.role === "detailer" ? "Detailer" : "Driver");
    if (seq !== lbSeq) return;
    const unit = state.role === "detailer" ? "job" : "car";
    const rows = ids.map((id) => ({ id, name: names[id] || (state.role === "detailer" ? "Detailer" : "Driver"), ...byUser[id] }))
      .sort((a, b) => b.count - a.count);

    el.innerHTML = rows.map((r, i) => `
      <div class="bl-leader-row">
        <div class="bl-leader-rank ${i === 0 ? "is-gold" : ""}">${i + 1}</div>
        <div>
          <div class="bl-leader-name">${esc(r.name)}</div>
          <div class="bl-leader-sub">${esc(paceSub(r.count, r.first, r.last))} · ${esc(fmt.timeAgo(r.last))}</div>
        </div>
        <div class="bl-leader-count" title="${r.count} ${unit}${r.count === 1 ? "" : "s"}">${r.count}</div>
      </div>`).join("");
  }

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
