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

  async function loadFleetStats() {
    const since = startOfToday().toISOString();
    const { data: records, error } = await sb.from("records").select("user_id,status,no_tag,ts").gte("ts", since);
    if (error) { console.warn("[Backlot] stats", error); return; }
    const total = records.length;
    const driverIds = new Set(records.map(r => r.user_id));
    const noTag = records.filter(r => r.no_tag).length;
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
          <div class="bl-leader-sub">${rate}/hr · last ${fmtHM(new Date(r.last))}</div>
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
        .bindPopup(`<b>${esc(r.serial_id)}</b><br>${esc(r.status)}<br>${fmtHM(new Date(r.ts))}`)
        .addTo(markerLayer);
      bounds.push([r.lat, r.lng]);
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
    else if (bounds.length === 1) map.setView(bounds[0], 15);
    setTimeout(() => map.invalidateSize(), 50);
  }

  async function loadAnnouncements() {
    const { data, error } = await sb.from("announcements").select("*").order("created_at", { ascending: false }).limit(50);
    const el = $("blAnnList");
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }
    if (!data || !data.length) { el.innerHTML = `<div class="bl-empty">No announcements yet.</div>`; return; }
    el.innerHTML = data.map(a => `
      <div class="bl-ann-item">
        <button class="del" data-id="${a.id}">delete</button>
        <div class="meta">${esc(new Date(a.created_at).toLocaleString())}</div>
        <div class="body">${esc(a.body)}</div>
      </div>`).join("");
    el.querySelectorAll(".del").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this announcement?")) return;
      await sb.from("announcements").delete().eq("id", b.dataset.id);
      loadAnnouncements();
    }));
  }

  async function loadEdrList() {
    const { data, error } = await sb.from("extra_driver_requests")
      .select("*, extra_driver_responses(response,driver_id)")
      .order("created_at", { ascending: false }).limit(20);
    const el = $("blEdrList");
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }
    if (!data || !data.length) { el.innerHTML = `<div class="bl-empty">No open requests.</div>`; return; }
    el.innerHTML = data.map(r => {
      const responses = r.extra_driver_responses || [];
      const yes = responses.filter(x => x.response === "yes").length;
      const no  = responses.filter(x => x.response === "no").length;
      return `<div class="bl-edr-item">
        <div class="row"><div>${esc(new Date(r.shift_time).toLocaleString())}</div><div class="status">${esc(r.status)}</div></div>
        <div class="row"><div>${r.needed_count} needed${r.duration_minutes ? ` · ${r.duration_minutes} min` : ""}</div><div>${esc(r.note || "")}</div></div>
        <div class="responses">✅ ${yes} accepted · ❌ ${no} declined</div>
      </div>`;
    }).join("");
  }

  function refreshAll() {
    loadFleetStats(); loadLeaderboard(); loadMap(); loadAnnouncements(); loadEdrList();
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
      const user = DT_AUTH.getUser();
      const { error } = await sb.from("extra_driver_requests").insert({
        manager_id: user.id,
        shift_time: new Date(fd.get("shift_time")).toISOString(),
        needed_count: parseInt(fd.get("needed_count"), 10),
        duration_minutes: fd.get("duration_minutes") ? parseInt(fd.get("duration_minutes"), 10) : null,
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
      .on("postgres_changes", { event: "*", schema: "public", table: "records" },             () => { loadFleetStats(); loadLeaderboard(); loadMap(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "announcements" },       loadAnnouncements)
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_requests" }, loadEdrList)
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_responses" }, loadEdrList)
      .subscribe();
  }

  function stop() {
    started = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  document.addEventListener("dt-auth-change", () => {
    if (DT_AUTH.isManager()) start();
    else stop();
  });
  if (DT_AUTH.isManager()) start();

  // Expose so showTab() can trigger a refresh when switching to a Backlot view
  window.DT_BACKLOT = { refresh: refreshAll, loadMap };
})();
