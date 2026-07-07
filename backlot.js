// ============================================================
// DriverTrax Backlot (manager-only)
// Powers the four manager panels inside index.html:
//   #panel-backlot-stats, -leaderboard, -map, -announce
// Activated when showTab('backlot-*') is called or when the
// is-manager class is on body.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;

  const $ = (id) => document.getElementById(id);
  const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
  const fmtHM = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const esc = window.DT_ESC;

  let map = null;
  let markerLayer = null;
  let realtimeChan = null;
  let pollTimer = null;
  let started = false;
  const LAST_VIEW_KEY = "drivertrax_mgr_alerts_lastview";

  async function loadFleetStats() {
    const since = startOfToday().toISOString();
    const { data: records, error } = await sb.from("records").select("user_id,status,no_tag,ts").gte("ts", since);
    if (error) { console.warn("[Backlot] stats", error); return; }
    const total = records.length;
    const driverIds = new Set(records.map(r => r.user_id));
    const noTag = records.filter(r => r.no_tag).length;

    // Fleet avg banner — avg-of-per-driver avg trip time, and fleet cars/hour
    updateFleetAvgBanner(records);
    $("blStatCars").textContent = total;
    $("blStatDrivers").textContent = driverIds.size;
    $("blStatNoTag").textContent = noTag;
    $("blStatCarsSub").textContent = "since midnight";
    $("blStatDriversSub").textContent = driverIds.size === 1 ? "driver active" : "drivers active";
    $("blStatNoTagSub").textContent = total ? `${Math.round((noTag/total)*100)}% of total` : "";
    const hours = Math.max(1, (Date.now() - startOfToday().getTime()) / 3600000);
    $("blStatRate").textContent = (total / hours).toFixed(1);

    const byStatus = {};
    records.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
    const entries = Object.entries(byStatus).sort((a,b) => b[1]-a[1]);
    const max = entries[0]?.[1] || 1;
    const bd = $("blStatusBreakdown");
    bd.innerHTML = entries.length
      ? entries.map(([s,c]) => `<div class="bl-bar-row"><div class="label">${esc(s)}</div><div class="bar"><span style="width:${(c/max)*100}%"></span></div><div class="count">${c}</div></div>`).join("")
      : `<div class="bl-empty">No cars logged yet today.</div>`;

    // Active drivers list — every driver who logged at least one car today
    // (exclude DETAILING records — those belong to detailers, shown separately)
    const active = {};
    records.filter(r => r.status !== "DETAILING").forEach(r => {
      const a = active[r.user_id] || (active[r.user_id] = { count: 0, last: r.ts });
      a.count++;
      if (r.ts > a.last) a.last = r.ts;
    });
    const activeIds = Object.keys(active);
    const listEl = $("blActiveDrivers");
    if (!listEl) return;
    if (!activeIds.length) {
      listEl.innerHTML = `<div class="bl-empty">No drivers active yet today.</div>`;
      return;
    }
    const { data: profs } = await sb.from("profiles").select("id,display_name").in("id", activeIds);
    const names = {};
    (profs || []).forEach(p => { names[p.id] = p.display_name || "Driver"; });
    const sorted = activeIds
      .map(id => ({ id, name: names[id] || "Driver", ...active[id] }))
      .sort((a, b) => b.last.localeCompare(a.last)) // most-recently-active first
      .slice(0, 5);
    listEl.innerHTML = sorted.map(d => `
      <div class="bl-active-driver">
        <span class="bl-active-name">${esc(d.name)}</span>
        <span class="bl-active-meta">${d.count} car${d.count === 1 ? "" : "s"} · ${esc(window.dtTimeAgo(d.last))}</span>
      </div>
    `).join("");
  }

  async function loadActiveDetailers() {
    const listEl = $("blActiveDetailers");
    if (!listEl) return;
    const since = startOfToday().toISOString();
    const { data: jobs, error } = await sb
      .from("detail_jobs")
      .select("detailer_id,started_at,completed_at")
      .gte("started_at", since);
    if (error) { console.warn("[Backlot] detailers", error); return; }
    if (!jobs || !jobs.length) {
      listEl.innerHTML = `<div class="bl-empty">No detailers active yet today.</div>`;
      return;
    }
    const active = {};
    jobs.forEach(j => {
      const last = j.completed_at || j.started_at;
      const a = active[j.detailer_id] || (active[j.detailer_id] = { count: 0, last });
      a.count++;
      if (last > a.last) a.last = last;
    });
    const ids = Object.keys(active);
    const { data: profs } = await sb.from("profiles").select("id,display_name").in("id", ids);
    const names = {};
    (profs || []).forEach(p => { names[p.id] = p.display_name || "Detailer"; });
    const sorted = ids
      .map(id => ({ id, name: names[id] || "Detailer", ...active[id] }))
      .sort((a, b) => b.last.localeCompare(a.last))
      .slice(0, 5);
    listEl.innerHTML = sorted.map(d => `
      <div class="bl-active-driver">
        <span class="bl-active-name">${esc(d.name)}</span>
        <span class="bl-active-meta">${d.count} job${d.count === 1 ? "" : "s"} · ${esc(window.dtTimeAgo(d.last))}</span>
      </div>
    `).join("");
  }

  function updateFleetAvgBanner(records) {
    // Manager-owned banner — leave it alone for other roles.
    if (!document.body.classList.contains("is-manager")) return;
    const banner = document.getElementById("avgBanner");
    if (!banner) return;
    if (!records || records.length < 2) { banner.style.display = "none"; return; }

    // Per-driver avg gap → avg those across drivers for the fleet number
    const byUser = {};
    records.forEach(r => {
      const ts = new Date(r.ts).getTime();
      (byUser[r.user_id] || (byUser[r.user_id] = [])).push(ts);
    });
    const driverAvgs = [];
    Object.values(byUser).forEach(arr => {
      if (arr.length < 2) return;
      arr.sort((a,b) => a-b);
      const gaps = [];
      for (let i = 1; i < arr.length; i++) gaps.push(arr[i] - arr[i-1]);
      const avg = gaps.reduce((a,b) => a+b, 0) / gaps.length;
      driverAvgs.push(avg);
    });

    let timeStr = "—";
    if (driverAvgs.length) {
      const avgMs = driverAvgs.reduce((a,b) => a+b, 0) / driverAvgs.length;
      const mins = Math.round(avgMs / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      timeStr = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    }
    const hours = Math.max(1/60, (Date.now() - startOfToday().getTime()) / 3600000);
    const cph = (records.length / hours).toFixed(1);
    const lbl = document.getElementById("avgBannerTimeLabel");
    if (lbl) lbl.textContent = "AVG TRIP TIME";
    document.getElementById("avgBannerTime").textContent = timeStr;
    document.getElementById("avgBannerCph").textContent  = cph;
    banner.style.display = "block";
  }

  const lbState = { role: "driver", period: "today" };

  function periodStart(period) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (period === "today") return d;
    if (period === "week") {
      d.setDate(d.getDate() - d.getDay()); // Sunday
      return d;
    }
    if (period === "month") {
      d.setDate(1);
      return d;
    }
    if (period === "quarter") {
      const q = Math.floor(d.getMonth() / 3) * 3;
      d.setMonth(q, 1);
      return d;
    }
    return d;
  }

  function periodLabel(period) {
    return period === "today" ? "Today's"
         : period === "week"  ? "This Week's"
         : period === "month" ? "This Month's"
         : period === "quarter" ? "This Quarter's"
         : "Today's";
  }

  async function loadLeaderboard() {
    const titleEl = $("blLeaderboardTitle");
    if (titleEl) {
      const who = lbState.role === "detailer" ? "Detailer" : "Driver";
      titleEl.textContent = `${periodLabel(lbState.period)} ${who} Leaders`;
    }
    const el = $("blLeaderboard");
    if (!el) return;
    const since = periodStart(lbState.period).toISOString();
    const byUser = {};

    if (lbState.role === "detailer") {
      const { data: jobs, error } = await sb
        .from("detail_jobs")
        .select("detailer_id,started_at,completed_at")
        .gte("started_at", since);
      if (error) { console.warn("[Backlot] leaderboard", error); return; }
      (jobs || []).forEach(j => {
        if (!j.detailer_id) return;
        const last = j.completed_at || j.started_at;
        const u = byUser[j.detailer_id] || (byUser[j.detailer_id] = { count: 0, first: j.started_at, last });
        u.count++;
        if (j.started_at < u.first) u.first = j.started_at;
        if (last > u.last) u.last = last;
      });
    } else {
      const { data: records, error } = await sb
        .from("records")
        .select("user_id,ts,status")
        .gte("ts", since)
        .neq("status", "DETAILING");
      if (error) { console.warn("[Backlot] leaderboard", error); return; }
      (records || []).forEach(r => {
        const u = byUser[r.user_id] || (byUser[r.user_id] = { count: 0, first: r.ts, last: r.ts });
        u.count++;
        if (r.ts < u.first) u.first = r.ts;
        if (r.ts > u.last)  u.last  = r.ts;
      });
    }

    const ids = Object.keys(byUser);
    let names = {};
    if (ids.length) {
      const { data: profiles } = await sb.from("profiles").select("id,display_name").in("id", ids);
      (profiles || []).forEach(p => { names[p.id] = p.display_name || "(no name)"; });
    }
    const fallback = lbState.role === "detailer" ? "Detailer" : "Driver";
    const unit = lbState.role === "detailer" ? "job" : "car";
    const rows = Object.entries(byUser).map(([id,u]) => ({ id, name: names[id] || fallback, ...u }))
      .sort((a,b) => b.count - a.count);

    if (!rows.length) {
      const who = lbState.role === "detailer" ? "detailers" : "drivers";
      const when = lbState.period === "today" ? "yet today"
                 : lbState.period === "week" ? "this week"
                 : lbState.period === "month" ? "this month"
                 : "this quarter";
      el.innerHTML = `<div class="bl-empty">No ${who} active ${when}.</div>`;
      return;
    }
    el.innerHTML = rows.map((r, i) => {
      const spanHrs = (new Date(r.last) - new Date(r.first)) / 3600000;
      const sub = spanHrs >= (1/60)
        ? `${(r.count / Math.max(1/60, spanHrs)).toFixed(1)}/hr · ${esc(window.dtTimeAgo(r.last))}`
        : `${esc(window.dtTimeAgo(r.last))}`;
      return `<div class="bl-leader-row">
        <div class="bl-leader-rank ${i===0?'gold':''}">${i+1}</div>
        <div>
          <div class="bl-leader-name">${esc(r.name)}</div>
          <div class="bl-leader-sub">${sub}</div>
        </div>
        <div class="bl-leader-count" title="${r.count} ${unit}${r.count===1?'':'s'}">${r.count}</div>
      </div>`;
    }).join("");
  }

  function wireLeaderboardControls() {
    const roleSeg = $("blLbRole");
    const periodSeg = $("blLbPeriod");
    if (roleSeg && !roleSeg.dataset.wired) {
      roleSeg.dataset.wired = "1";
      roleSeg.addEventListener("click", (e) => {
        const btn = e.target.closest(".bl-seg-btn");
        if (!btn || !roleSeg.contains(btn)) return;
        lbState.role = btn.dataset.role;
        roleSeg.querySelectorAll(".bl-seg-btn").forEach(b => b.classList.toggle("is-active", b === btn));
        loadLeaderboard();
      });
    }
    if (periodSeg && !periodSeg.dataset.wired) {
      periodSeg.dataset.wired = "1";
      periodSeg.addEventListener("click", (e) => {
        const btn = e.target.closest(".bl-seg-btn");
        if (!btn || !periodSeg.contains(btn)) return;
        lbState.period = btn.dataset.period;
        periodSeg.querySelectorAll(".bl-seg-btn").forEach(b => b.classList.toggle("is-active", b === btn));
        loadLeaderboard();
      });
    }
  }

  function initMap() {
    if (map || !window.L) return;
    map = L.map("blMap", { zoomControl: true }).setView([38.18, -85.74], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap"
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  async function loadMap() {
    initMap();
    if (!map) return;
    const since = startOfToday().toISOString();
    const { data: records, error } = await sb
      .from("records").select("lat,lng,user_id,status,ts,serial_id")
      .gte("ts", since).not("lat", "is", null);
    if (error) { console.warn("[Backlot] map", error); return; }
    markerLayer.clearLayers();
    const bounds = [];
    (records || []).forEach(r => {
      L.circleMarker([r.lat, r.lng], { radius: 6, color: "#00a651", weight: 2, fillColor: "#00a651", fillOpacity: 0.7 })
        .bindPopup(`<b>${esc(r.serial_id)}</b><br>${esc(r.status)}<br>${esc(window.dtTimeAgo(r.ts))}`)
        .addTo(markerLayer);
      bounds.push([r.lat, r.lng]);
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
    else if (bounds.length === 1) map.setView(bounds[0], 15);
    setTimeout(() => map.invalidateSize(), 50);
  }

  async function loadAnnouncements() {
    const { data, error } = await sb.from("announcements").select("*").order("created_at", { ascending: false }).limit(80);
    const el = $("blAnnList");
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }

    const open     = (data || []).filter(a => (a.status || "open") === "open");
    const archived = (data || []).filter(a => (a.status || "open") !== "open");

    // Resolve author names in one round trip
    const authorIds = [...new Set((data || []).map(a => a.author_id))];
    const names = {};
    if (authorIds.length) {
      const { data: profs } = await sb.from("profiles").select("id,display_name").in("id", authorIds);
      (profs || []).forEach(p => { names[p.id] = p.display_name || "Manager"; });
    }
    const ago = (window.DT_ANN && DT_ANN.timeAgo)
      ? DT_ANN.timeAgo
      : (d) => new Date(d).toLocaleString();

    function renderCard(a, isArchived) {
      const status = a.status || "open";
      const actions = isArchived
        ? `<button class="ann-act-del"    data-id="${a.id}">Delete</button>`
        : `<button class="ann-act-close"  data-id="${a.id}">Close</button>
           <button class="ann-act-cancel" data-id="${a.id}">Cancel</button>
           <button class="ann-act-del"    data-id="${a.id}">Delete</button>`;
      const BODY_LIMIT = 220;
      const body = a.body || "";
      const isLong = body.length > BODY_LIMIT;
      const authorName = names[a.author_id] || "Manager";
      // admin actions + status get appended AFTER the thread markup so the
      // visual order is: body → meta → reactions/replies → actions → status
      return `
        <div class="ann-card" data-ann-id="${a.id}" data-status="${esc(status)}" data-archived="${isArchived ? "1" : ""}" data-actions='${esc(actions)}'>
          <div class="ann-body-wrap${isLong ? " is-clamped" : ""}">
            <div class="body">${esc(body)}</div>
            ${isLong ? `<button type="button" class="ann-body-toggle" aria-expanded="false">Show more</button>` : ""}
          </div>
          <div class="meta">
            <span class="ann-time">Posted ${esc(ago(a.created_at))} by <span class="ann-author">${esc(authorName)}</span></span>
          </div>
        </div>`;
    }

    const openHtml     = open.length     ? open.map(a => renderCard(a, false)).join("")     : `<div class="bl-empty">No open alerts.</div>`;
    const archivedHtml = archived.length ? archived.map(a => renderCard(a, true)).join("")  : `<div class="bl-empty">Nothing archived yet.</div>`;

    el.innerHTML = `
      ${openHtml}
      <details class="disclosure">
        <summary class="disclosure-summary">Archived (${archived.length})</summary>
        <div class="disclosure-body edr-archive-list">${archivedHtml}</div>
      </details>
    `;

    // Inject reactions + replies, then append admin actions + status row
    // so they always sit at the bottom of each card
    el.querySelectorAll(".ann-card").forEach(card => {
      if (window.DT_ANN) {
        DT_ANN.injectThreadMarkup(card);
        DT_ANN.renderThread(card, card.dataset.annId);
      }
      // Replace the visible thread block with a collapsed <details> wrapper.
      const thread = card.querySelector(".ann-thread");
      if (thread && !thread.closest(".ann-thread-disclosure")) {
        const details = document.createElement("details");
        details.className = "ann-thread-disclosure";
        const summary = document.createElement("summary");
        summary.innerHTML = `Replies <span class="ann-reply-count">(0)</span>`;
        details.appendChild(summary);
        thread.parentNode.insertBefore(details, thread);
        details.appendChild(thread);

        // Keep the count in sync as renderThread (async) populates the list,
        // and as realtime updates fire later.
        const listEl = thread.querySelector(".ann-reply-list");
        const countEl = summary.querySelector(".ann-reply-count");
        if (listEl && countEl) {
          const update = () => {
            countEl.textContent = `(${listEl.querySelectorAll(".ann-reply").length})`;
          };
          update();
          new MutationObserver(update).observe(listEl, { childList: true });
        }
      }
      const actions = card.dataset.actions || "";
      card.insertAdjacentHTML("beforeend", `<div class="ann-admin-actions">${actions}</div>`);
      if (card.dataset.archived) {
        const s = card.dataset.status || "closed";
        card.insertAdjacentHTML("beforeend", `<div class="ann-card-status status-${s}">${s}</div>`);
      }
      // Clean up data attrs that were only there to ferry HTML into this step
      delete card.dataset.actions;
      delete card.dataset.archived;
    });

    // Admin button wiring is delegated on #blAnnList once in start() — no per-render binding.
  }

  function onAnnListClick(e) {
    const t = e.target;
    if (t.matches(".ann-body-toggle")) {
      const wrap = t.closest(".ann-body-wrap");
      if (!wrap) return;
      const expanded = wrap.classList.toggle("is-expanded");
      wrap.classList.toggle("is-clamped", !expanded);
      t.setAttribute("aria-expanded", expanded ? "true" : "false");
      t.textContent = expanded ? "Show less" : "Show more";
      return;
    }
    const id = t.dataset?.id;
    if (!id) return;
    if (t.matches(".ann-act-close"))  return setAlertStatus(id, "closed");
    if (t.matches(".ann-act-cancel")) return setAlertStatus(id, "cancelled");
    if (t.matches(".ann-act-del"))    return deleteAlert(id);
  }

  async function setAlertStatus(id, status) {
    const verb = status === "closed" ? "close" : "cancel";
    if (!confirm(`Sure you want to ${verb} this alert?`)) return;
    const { error } = await sb.from("announcements").update({ status }).eq("id", id);
    if (error) { alert(error.message); return; }
    loadAnnouncements();
  }

  async function deleteAlert(id) {
    if (!confirm("Delete this alert? Replies and reactions will be removed too.")) return;
    const { error } = await sb.from("announcements").delete().eq("id", id);
    if (error) { alert(error.message); return; }
    loadAnnouncements();
  }

  async function loadEdrList() {
    const { data, error } = await sb.from("extra_driver_requests")
      .select("*, extra_driver_responses(response,driver_id,shifts,created_at)")
      .order("created_at", { ascending: false }).limit(40);
    const el = $("blEdrList");
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }

    const open     = (data || []).filter(r => r.status === "open");
    const archived = (data || []).filter(r => r.status !== "open");

    // Collect every driver_id we need a name for, in one round trip
    const driverIds = [...new Set((data || []).flatMap(r => (r.extra_driver_responses || []).map(x => x.driver_id)))];
    const names = {};
    if (driverIds.length) {
      const { data: profs } = await sb.from("profiles").select("id,display_name").in("id", driverIds);
      (profs || []).forEach(p => { names[p.id] = p.display_name || "Driver"; });
    }

    function renderCard(r, isArchived) {
      const responses = r.extra_driver_responses || [];
      const accepted = responses
        .filter(x => x.response === "yes")
        .sort((a,b) => (a.created_at || "").localeCompare(b.created_at || ""));
      const declined = responses.filter(x => x.response === "no").length;
      const when = new Date(r.shift_time).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      const shiftTags = (r.shifts || []).map(s => `<span class="edr-shift-tag">${esc(s)}</span>`).join("");
      const acceptedHtml = accepted.length ? `
        <div class="edr-accepted-list">
          <div class="lbl">Accepted (${accepted.length}/${r.needed_count})</div>
          ${accepted.map(a => {
            const ts = a.created_at ? window.dtTimeAgo(a.created_at) : "";
            const ash = (a.shifts || []).join(" · ");
            return `<div class="edr-acceptor">
              <span>${esc(names[a.driver_id] || "Driver")}</span>
              ${ash ? `<span class="shifts">${esc(ash)}</span>` : ""}
              <span class="when u-ml-auto">${esc(ts)}</span>
            </div>`;
          }).join("")}
        </div>` : "";
      const actions = isArchived
        ? `<button class="edr-act-del" data-id="${r.id}">Delete</button>`
        : `<button class="edr-act-fill"   data-id="${r.id}">Mark Filled</button>
           <button class="edr-act-cancel" data-id="${r.id}">Cancel</button>
           <button class="edr-act-del"    data-id="${r.id}">Delete</button>`;
      const positionLabel = { driver: "Driver", detailer: "Detailer", cxr: "CXR" }[r.position] || "Driver";
      return `<div class="bl-edr-item" data-id="${r.id}">
        <div class="row"><div>${esc(when)}</div><div class="status status-${esc(r.status)}">${esc(r.status)}</div></div>
        <div class="edr-shift-tags">${shiftTags}</div>
        <div class="row"><div>${r.needed_count} ${esc(positionLabel)}${r.needed_count === 1 ? "" : "s"} needed</div><div>${esc(r.note || "")}</div></div>
        <div class="responses">✅ ${accepted.length} accepted · ❌ ${declined} declined</div>
        ${acceptedHtml}
        <div class="edr-admin-actions">${actions}</div>
      </div>`;
    }

    const openHtml     = open.length     ? open.map(r => renderCard(r, false)).join("")     : `<div class="bl-empty">No open requests.</div>`;
    const archivedHtml = archived.length ? archived.map(r => renderCard(r, true)).join("")  : `<div class="bl-empty">Nothing archived yet.</div>`;

    el.innerHTML = `
      ${openHtml}
      <details class="disclosure">
        <summary class="disclosure-summary">Archived (${archived.length})</summary>
        <div class="disclosure-body edr-archive-list">${archivedHtml}</div>
      </details>
    `;

    // Admin button wiring is delegated on #blEdrList once in start().
  }

  function onEdrListClick(e) {
    const t = e.target;
    const id = t.dataset?.id;
    if (!id) return;
    if (t.matches(".edr-act-fill"))   return setStatus(id, "filled");
    if (t.matches(".edr-act-cancel")) return setStatus(id, "cancelled");
    if (t.matches(".edr-act-del"))    return deleteRequest(id);
  }

  async function setStatus(id, status) {
    const verb = status === "filled" ? "mark as filled" : "cancel";
    if (!confirm(`Sure you want to ${verb} this request?`)) return;
    const { error } = await sb.from("extra_driver_requests").update({ status }).eq("id", id);
    if (error) { alert(error.message); return; }
    loadEdrList();
  }

  async function deleteRequest(id) {
    if (!confirm("Delete this request? This removes the audit trail of who responded.")) return;
    const { error } = await sb.from("extra_driver_requests").delete().eq("id", id);
    if (error) { alert(error.message); return; }
    loadEdrList();
  }

  // ---- unread-reply badge for the manager Alerts tab ----
  function getLastView() {
    const v = localStorage.getItem(LAST_VIEW_KEY);
    return v || new Date(0).toISOString();
  }
  function markAlertsViewed() {
    localStorage.setItem(LAST_VIEW_KEY, new Date().toISOString());
    renderRepliesBadge(0);
  }
  function renderRepliesBadge(n) {
    const el = document.getElementById("tabAlertsMgrBadge");
    if (!el) return;
    if (n > 0) { el.textContent = n; el.classList.remove("hidden"); }
    else { el.classList.add("hidden"); }
  }
  async function loadRepliesBadge() {
    const since = getLastView();
    const user = DT_AUTH.getUser();
    if (!user) return;
    // Count replies (by anyone other than this manager) newer than last view
    const { count, error } = await sb
      .from("announcement_replies")
      .select("*", { count: "exact", head: true })
      .gt("created_at", since)
      .neq("author_id", user.id);
    if (error) { console.warn("[Backlot] replies badge", error); return; }
    renderRepliesBadge(count || 0);
  }

  function refreshAll() {
    // loadMap removed — fleet map is now part of the unified Records panel
    loadFleetStats(); loadActiveDetailers(); loadLeaderboard(); loadAnnouncements(); loadEdrList(); loadRepliesBadge();
  }

  function start() {
    if (started) return;
    started = true;

    $("blAnnList")?.addEventListener("click", onAnnListClick);
    $("blEdrList")?.addEventListener("click", onEdrListClick);
    wireLeaderboardControls();

    // Persist each Alerts-panel disclosure's open/closed state.
    // Recent Alerts + Open Requests default open; the others default closed.
    [
      ["blFcDisclosure",      "dt-bl-fc-open",      false],
      ["blPostDisclosure",    "dt-bl-post-open",    false],
      ["blRecentDisclosure",  "dt-bl-recent-open",  true],
      ["blEdrDisclosure",     "dt-bl-edr-open",     false],
      ["blOpenReqDisclosure", "dt-bl-openreq-open", true]
    ].forEach(([id, key, defaultOpen]) => {
      const el = $(id);
      if (!el) return;
      const saved = localStorage.getItem(key);
      el.open = saved === null ? defaultOpen : saved === "1";
      el.addEventListener("toggle", () => {
        localStorage.setItem(key, el.open ? "1" : "0");
      });
    });

    document.getElementById("blAnnForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = (new FormData(e.target).get("body") || "").trim();
      if (!body) return;
      const user = DT_AUTH.getUser();
      const { error } = await sb.from("announcements").insert({ author_id: user.id, body });
      if (error) { alert(error.message); return; }
      e.target.reset();
      loadAnnouncements();
    });

    document.getElementById("blEdrForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      // CXR can't request extra drivers — only managers/admins post shift requests.
      if (DT_AUTH.isCxr && DT_AUTH.isCxr()) {
        alert("CXR users can't post shift requests.");
        return;
      }
      const fd = new FormData(e.target);
      const shifts = fd.getAll("shifts");
      if (!shifts.length) { alert("Pick at least one shift (AM / MID / PM)."); return; }
      const dateStr = fd.get("shift_date"); // "YYYY-MM-DD"
      if (!dateStr) { alert("Pick a shift date."); return; }
      // Store as midnight local time on the chosen date
      const shiftDate = new Date(dateStr + "T00:00:00");
      const user = DT_AUTH.getUser();
      const position = fd.get("position") || "driver";
      const { error } = await sb.from("extra_driver_requests").insert({
        manager_id: user.id,
        shift_time: shiftDate.toISOString(),
        needed_count: parseInt(fd.get("needed_count"), 10),
        shifts,
        position,
        note: (fd.get("note") || "").trim() || null
      });
      if (error) { alert(error.message); return; }
      e.target.reset();
      loadEdrList();
    });

    refreshAll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshAll, 30000);

    realtimeChan = sb.channel("backlot-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "records" },             () => { loadFleetStats(); loadLeaderboard(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "detail_jobs" },         () => { loadActiveDetailers(); loadLeaderboard(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "announcements" },       loadAnnouncements)
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_requests" }, loadEdrList)
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_responses" }, loadEdrList)
      .on("postgres_changes", { event: "*", schema: "public", table: "announcement_replies" },   loadRepliesBadge)
      .subscribe();

    // Mark alerts viewed whenever the manager opens the Alerts tab
    document.addEventListener("dt-tab-shown", (e) => {
      if (e.detail === "backlot-announce") markAlertsViewed();
    });
  }

  function stop() {
    started = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
    document.getElementById("tabAlertsMgrBadge")?.classList.add("hidden");
  }

  function shouldRunBacklot() {
    return DT_AUTH.isManager() || DT_AUTH.isCxr();
  }
  document.addEventListener("dt-auth-change", () => {
    if (shouldRunBacklot()) start();
    else stop();
  });
  if (shouldRunBacklot()) start();

  // Expose so showTab() can trigger a refresh when switching to a Backlot view
  window.DT_BACKLOT = { refresh: refreshAll, loadMap };
})();
