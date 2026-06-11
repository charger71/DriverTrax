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
  const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

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
    const active = {};
    records.forEach(r => {
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
      .sort((a, b) => b.last.localeCompare(a.last)); // most-recently-active first
    listEl.innerHTML = sorted.map(d => `
      <div class="bl-active-driver">
        <span class="bl-active-name">${esc(d.name)}</span>
        <span class="bl-active-meta">${d.count} car${d.count === 1 ? "" : "s"} · ${esc(window.dtTimeAgo(d.last))}</span>
      </div>
    `).join("");
  }

  function updateFleetAvgBanner(records) {
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
    document.getElementById("avgBannerTime").textContent = timeStr;
    document.getElementById("avgBannerCph").textContent  = cph;
    banner.style.display = "block";
  }

  async function loadLeaderboard() {
    const since = startOfToday().toISOString();
    const { data: records, error } = await sb.from("records").select("user_id,ts").gte("ts", since);
    if (error) { console.warn("[Backlot] leaderboard", error); return; }
    const byUser = {};
    records.forEach(r => {
      const u = byUser[r.user_id] || (byUser[r.user_id] = { count: 0, first: r.ts, last: r.ts });
      u.count++;
      if (r.ts < u.first) u.first = r.ts;
      if (r.ts > u.last)  u.last  = r.ts;
    });
    const ids = Object.keys(byUser);
    let names = {};
    if (ids.length) {
      const { data: profiles } = await sb.from("profiles").select("id,display_name").in("id", ids);
      (profiles || []).forEach(p => { names[p.id] = p.display_name || "(no name)"; });
    }
    const rows = Object.entries(byUser).map(([id,u]) => ({ id, name: names[id] || "Driver", ...u }))
      .sort((a,b) => b.count - a.count);
    const el = $("blLeaderboard");
    if (!rows.length) { el.innerHTML = `<div class="bl-empty">No drivers active yet today.</div>`; return; }
    el.innerHTML = rows.map((r, i) => {
      const hrs = Math.max(1/60, (new Date(r.last) - new Date(r.first)) / 3600000);
      const rate = (r.count / hrs).toFixed(1);
      return `<div class="bl-leader-row">
        <div class="bl-leader-rank ${i===0?'gold':''}">${i+1}</div>
        <div>
          <div class="bl-leader-name">${esc(r.name)}</div>
          <div class="bl-leader-sub">${rate}/hr · ${esc(window.dtTimeAgo(r.last))}</div>
        </div>
        <div class="bl-leader-count">${r.count}</div>
      </div>`;
    }).join("");
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
      // admin actions + status get appended AFTER the thread markup so the
      // visual order is: meta → body → reactions/replies → actions → status
      return `
        <div class="ann-card" data-ann-id="${a.id}" data-status="${esc(status)}" data-archived="${isArchived ? "1" : ""}" data-actions='${esc(actions)}'>
          <div class="meta">
            <span class="ann-author">${esc(names[a.author_id] || "Manager")}</span>
            <span class="ann-time">${esc(ago(a.created_at))}</span>
          </div>
          <div class="body">${esc(a.body)}</div>
        </div>`;
    }

    const openHtml     = open.length     ? open.map(a => renderCard(a, false)).join("")     : `<div class="bl-empty">No open alerts.</div>`;
    const archivedHtml = archived.length ? archived.map(a => renderCard(a, true)).join("")  : `<div class="bl-empty">Nothing archived yet.</div>`;

    el.innerHTML = `
      ${openHtml}
      <details class="edr-archive">
        <summary>Archived (${archived.length})</summary>
        <div class="edr-archive-list">${archivedHtml}</div>
      </details>
    `;

    // Inject reactions + replies, then append admin actions + status row
    // so they always sit at the bottom of each card
    el.querySelectorAll(".ann-card").forEach(card => {
      if (window.DT_ANN) {
        DT_ANN.injectThreadMarkup(card);
        DT_ANN.renderThread(card, card.dataset.annId);
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

    // Wire admin buttons (must come after the buttons exist in the DOM)
    el.querySelectorAll(".ann-act-close").forEach(b => b.addEventListener("click", () => setAlertStatus(b.dataset.id, "closed")));
    el.querySelectorAll(".ann-act-cancel").forEach(b => b.addEventListener("click", () => setAlertStatus(b.dataset.id, "cancelled")));
    el.querySelectorAll(".ann-act-del").forEach(b => b.addEventListener("click", () => deleteAlert(b.dataset.id)));
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
              <span class="when" style="margin-left:auto">${esc(ts)}</span>
            </div>`;
          }).join("")}
        </div>` : "";
      const actions = isArchived
        ? `<button class="edr-act-del" data-id="${r.id}">Delete</button>`
        : `<button class="edr-act-fill"   data-id="${r.id}">Mark Filled</button>
           <button class="edr-act-cancel" data-id="${r.id}">Cancel</button>
           <button class="edr-act-del"    data-id="${r.id}">Delete</button>`;
      return `<div class="bl-edr-item" data-id="${r.id}">
        <div class="row"><div>${esc(when)}</div><div class="status status-${esc(r.status)}">${esc(r.status)}</div></div>
        <div class="edr-shift-tags">${shiftTags}</div>
        <div class="row" style="margin-top:6px"><div>${r.needed_count} needed</div><div>${esc(r.note || "")}</div></div>
        <div class="responses">✅ ${accepted.length} accepted · ❌ ${declined} declined</div>
        ${acceptedHtml}
        <div class="edr-admin-actions">${actions}</div>
      </div>`;
    }

    const openHtml     = open.length     ? open.map(r => renderCard(r, false)).join("")     : `<div class="bl-empty">No open requests.</div>`;
    const archivedHtml = archived.length ? archived.map(r => renderCard(r, true)).join("")  : `<div class="bl-empty">Nothing archived yet.</div>`;

    el.innerHTML = `
      ${openHtml}
      <details class="edr-archive">
        <summary>Archived (${archived.length})</summary>
        <div class="edr-archive-list">${archivedHtml}</div>
      </details>
    `;

    // Wire up admin buttons
    el.querySelectorAll(".edr-act-fill").forEach(b => b.addEventListener("click", () => setStatus(b.dataset.id, "filled")));
    el.querySelectorAll(".edr-act-cancel").forEach(b => b.addEventListener("click", () => setStatus(b.dataset.id, "cancelled")));
    el.querySelectorAll(".edr-act-del").forEach(b => b.addEventListener("click", () => deleteRequest(b.dataset.id)));
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
    loadFleetStats(); loadLeaderboard(); loadAnnouncements(); loadEdrList(); loadRepliesBadge();
  }

  function start() {
    if (started) return;
    started = true;

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
      const fd = new FormData(e.target);
      const shifts = fd.getAll("shifts");
      if (!shifts.length) { alert("Pick at least one shift (AM / MID / PM)."); return; }
      const dateStr = fd.get("shift_date"); // "YYYY-MM-DD"
      if (!dateStr) { alert("Pick a shift date."); return; }
      // Store as midnight local time on the chosen date
      const shiftDate = new Date(dateStr + "T00:00:00");
      const user = DT_AUTH.getUser();
      const { error } = await sb.from("extra_driver_requests").insert({
        manager_id: user.id,
        shift_time: shiftDate.toISOString(),
        needed_count: parseInt(fd.get("needed_count"), 10),
        shifts,
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
