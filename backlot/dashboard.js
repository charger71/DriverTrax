// ============================================================
// Backlot — Live Lot Dashboard
//   Mounts into #section-dashboard. KPIs + Leaflet lot map +
//   throughput chart, backed by Supabase (vehicles / records /
//   fleet_counts). Realtime + 30s poll.
//
// Data model (shared backend, read-only here):
//   vehicles  — one row per VIN: current_status, last_lat/lng,
//               last_seen_at, last_user_id  → lot state + map
//   records   — append-only scan log: ts, status, user_id, source
//               → "logged today", drivers on shift, throughput
//   fleet_counts — singleton returns/rentals counts
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;

  // SDF Enterprise rental lot (north of the terminal).
  const SDF = [38.1860797, -85.7422692];

  // Status → lot category (see app status catalog).
  const READY   = new Set(["CLEAN", "DETAILED"]);
  const DIRTY   = new Set(["DIRTY", "REWASH", "DETAILING", "GLASS"]);
  const SERVICE = new Set(["PM", "MK", "MR", "OM", "BODY", "TI", "HOLD", "DNR", "AUDIT FAIL", "WI/DELETE"]);
  function categoryOf(status) {
    const s = (status || "").toUpperCase();
    if (READY.has(s)) return "ready";
    if (DIRTY.has(s)) return "dirty";
    if (SERVICE.has(s)) return "service";
    return "other";
  }
  // Friendly status labels come from the shared catalog (catalogs.js).
  const label = (s) => (window.BL_STATUS_LABEL ? BL_STATUS_LABEL(s) : s) || "—";

  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

  let map = null, pinLayer = null, sectionLayer = null;
  let sectionsRendered = false;
  let realtimeChan = null, pollTimer = null, started = false;

  // Section-filter state: latest raw fetch is cached so re-rendering with a
  // different selection doesn't require a new round trip. sections[] mirrors
  // parking_sections_geo with its Leaflet polygon so click/style updates can
  // reach the layer without re-querying the LayerGroup.
  let selectedSectionId = null;
  let sections = [];                                             // { id, name, status, rings, poly }
  let latest = { vehicles: [], records: [], fc: null, detailJobs: [] };

  function initMap() {
    if (map || !window.L || !$("blLotMap")) return;
    map = L.map("blLotMap", { zoomControl: true, scrollWheelZoom: false, attributionControl: true })
      .setView(SDF, 16);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20, attribution: "© OpenStreetMap, © CARTO",
    }).addTo(map);
    // Sections go under the vehicle pins so a dense cluster of markers
    // stays readable on top of the boundary fills.
    sectionLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
  }

  // GeoJSON Polygon -> Leaflet-order [lat, lng] rings.
  function geoToRings(geo) {
    if (!geo || geo.type !== "Polygon" || !Array.isArray(geo.coordinates)) return [];
    return geo.coordinates.map(ring => ring.map(([lng, lat]) => [lat, lng]));
  }

  // Ray-casting point-in-ring; rings are in Leaflet [lat, lng] order.
  function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [latI, lngI] = ring[i];
      const [latJ, lngJ] = ring[j];
      const intersect = ((lngI > lng) !== (lngJ > lng)) &&
        (lat < (latJ - latI) * (lng - lngI) / (lngJ - lngI) + latI);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  // Outer ring includes, subsequent rings (holes) exclude.
  function pointInPolygon(latlng, rings) {
    if (!rings.length) return false;
    const [lat, lng] = latlng;
    if (!pointInRing(lat, lng, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(lat, lng, rings[i])) return false;
    }
    return true;
  }
  function selectedSection() {
    return sections.find(s => s.id === selectedSectionId) || null;
  }

  // Fetch polygons once per session and drop them onto sectionLayer. Same
  // status-color scheme as the driver-app shift map. Polygons are interactive
  // so clicking one toggles the section filter; pins live in a higher pane so
  // they still receive their own clicks first.
  async function ensureSectionOverlay() {
    if (sectionsRendered || !map) return;
    sectionsRendered = true;
    const { data, error } = await sb.from("parking_sections_geo").select("id,name,status,geojson");
    if (error) { console.warn("[Backlot] parking_sections_geo", error); return; }
    const statusColor = { open: "#00a651", full: "#e85550", restricted: "#f0b04a" };
    // Leaflet needs a real color string, so resolve the token once for the
    // unknown-status fallback instead of hardcoding a near-match.
    const infoToken = getComputedStyle(document.documentElement).getPropertyValue("--info").trim() || "#4a9eff";
    sections = [];
    (data || []).forEach(s => {
      const rings = geoToRings(s.geojson);
      if (!rings.length) return;
      const color = statusColor[s.status] || infoToken;
      const poly = L.polygon(rings, {
        color, fillColor: color, fillOpacity: 0.10, weight: 1.5, className: "bl-section-poly"
      });
      poly.bindTooltip(s.name, { permanent: false, direction: "center", className: "bl-section-label" });
      poly.on("click", () => selectSection(s.id));
      sectionLayer.addLayer(poly);
      sections.push({ id: s.id, name: s.name, status: s.status, rings, poly, baseColor: color });
    });
    populateSectionSelect();
    applySelectionStyling();
  }

  // Fill the header <select> with "All sections" + a name-sorted list of
  // every section polygon we loaded, then reflect the current selection.
  function populateSectionSelect() {
    const sel = $("blMapSectionSelect");
    if (!sel) return;
    const opts = [`<option value="">All sections</option>`];
    sections
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(s => { opts.push(`<option value="${esc(s.id)}">${esc(s.name)}</option>`); });
    sel.innerHTML = opts.join("");
    syncSectionSelect();
  }
  function syncSectionSelect() {
    const sel = $("blMapSectionSelect");
    if (sel) sel.value = selectedSectionId || "";
  }

  // Repaint the polygon layer to reflect selection: the chosen section pops
  // (thicker outline, denser fill) and the rest fade back so it's obvious
  // what the KPIs are scoped to.
  function applySelectionStyling() {
    sections.forEach(s => {
      if (!s.poly) return;
      if (!selectedSectionId) {
        s.poly.setStyle({ weight: 1.5, fillOpacity: 0.10 });
      } else if (s.id === selectedSectionId) {
        s.poly.setStyle({ weight: 3, fillOpacity: 0.30 });
        s.poly.bringToFront();
      } else {
        s.poly.setStyle({ weight: 1, fillOpacity: 0.04 });
      }
    });
  }

  function selectSection(id) {
    if (selectedSectionId === id) { clearSection(); return; }
    selectedSectionId = id;
    applySelectionStyling();
    syncSectionSelect();
    applyRender();
  }
  function clearSection() {
    selectedSectionId = null;
    applySelectionStyling();
    syncSectionSelect();
    applyRender();
  }

  async function loadAll() {
    const since = startOfToday().toISOString();
    const [vehRes, recRes, fcRes, djRes] = await Promise.all([
      sb.from("vehicles").select("serial_id,current_status,last_lat,last_lng,last_seen_at,last_user_id"),
      sb.from("records").select("user_id,ts,status,section_id").gte("ts", since),
      sb.from("fleet_counts").select("returns_count,rentals_count,updated_at").eq("id", "global").maybeSingle(),
      sb.from("detail_jobs").select("detailer_id,started_at").gte("started_at", since),
    ]);
    if (vehRes.error) console.warn("[Backlot] vehicles", vehRes.error);
    if (recRes.error) console.warn("[Backlot] records", recRes.error);
    if (djRes.error)  console.warn("[Backlot] detail_jobs", djRes.error);

    latest = {
      vehicles:   vehRes.data || [],
      records:    recRes.data || [],
      fc:         fcRes.data  || null,
      detailJobs: djRes.data  || [],
    };
    // We might have polygons that used to reference records/vehicles but
    // aren't in this fetch's data anymore. Selection survives fine — it's
    // just polygon id — but if the section itself vanished we drop it.
    if (selectedSectionId && sections.length && !sections.some(s => s.id === selectedSectionId)) {
      selectedSectionId = null;
    }
    await applyRender();
  }

  // Reads `latest` + `selectedSectionId` and paints the whole dashboard.
  // Split from loadAll so clicking a section can repaint without refetching.
  async function applyRender() {
    const sel = selectedSection();
    const vehiclesAll = latest.vehicles;
    const recordsAll  = latest.records;

    const vehiclesFiltered = sel
      ? vehiclesAll.filter(v => v.last_lat != null && v.last_lng != null && pointInPolygon([v.last_lat, v.last_lng], sel.rings))
      : vehiclesAll;
    const recordsFiltered = sel
      ? recordsAll.filter(r => r.section_id === sel.id)
      : recordsAll;

    renderKpis(vehiclesFiltered, recordsFiltered, latest.fc, latest.detailJobs);
    renderThroughput(recordsFiltered);
    await renderMap(vehiclesFiltered);
    renderBySection();

    const sub = $("blDashSub");
    if (sub) {
      const totalInv = vehiclesAll.length;
      const filteredNote = sel ? ` · ${vehiclesFiltered.length} in ${esc(sel.name)}` : "";
      sub.textContent = `SDF Enterprise · ${totalInv} in inventory${filteredNote} · updated ${fmt.time(new Date())}`;
    }
  }

  function renderKpis(vehicles, records, fc, detailJobs) {
    // lot-state counts from current vehicle inventory
    const cat = { ready: 0, dirty: 0, service: 0, other: 0 };
    vehicles.forEach((v) => { cat[categoryOf(v.current_status)]++; });

    // activity from today's records (exclude detailer-set statuses from driver counts)
    const DETAILER_STATUS = new Set(["DETAILING", "DETAILED"]);
    const cars = records.length;
    const drivers = new Set(records.filter((r) => !DETAILER_STATUS.has(r.status)).map((r) => r.user_id)).size;
    const detailers = new Set((detailJobs || []).map((j) => j.detailer_id).filter(Boolean)).size;

    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set("blKpiCars", cars);
    set("blKpiDrivers", drivers);
    set("blKpiDetailers", detailers);
    set("blKpiReady", cat.ready);
    set("blKpiDirty", cat.dirty);
    set("blKpiService", cat.service);
    set("blKpiDriversSub", drivers === 1 ? "driver active today" : "drivers active today");
    set("blKpiDetailersSub", detailers === 1 ? "detailer active today" : "detailers active today");

    set("blKpiReturns", fc ? fc.returns_count : "—");
    set("blKpiRentals", fc ? fc.rentals_count : "—");
    const rs = $("blKpiReturnsSub");
    if (rs) rs.textContent = fc && fc.updated_at ? `as of ${fmt.timeAgo(fc.updated_at)}` : "on lot";

    // legend counts
    set("blLegendReady", cat.ready);
    set("blLegendDirty", cat.dirty);
    set("blLegendService", cat.service);
    set("blLegendOther", cat.other);
  }

  // "By Section" tile: today's drop_offs bucketed by polygon name, with
  // typed-name fallback (from "Where is this?") and "Unspecified" for
  // rows that never matched or got named. Same shape as the driver-app
  // tile so managers see the same data on both surfaces.
  //
  // Rows for known sections carry data-section-id, so clicking one drives
  // the same selection filter as clicking a polygon on the map. Rows with
  // no polygon id (typed fallback, "Unspecified") are read-only.
  async function renderBySection() {
    const el = $("blDashBySection");
    if (!el) return;
    const since = startOfToday().toISOString();
    const { data, error } = await sb
      .from("drop_offs")
      .select("id,section_id,location_name,parking_sections(name)")
      .gte("created_at", since);
    if (error) {
      console.warn("[Backlot] drop_offs by section", error);
      el.innerHTML = `<div class="bl-empty">Couldn't load section counts.</div>`;
      return;
    }
    const rows = data || [];
    if (!rows.length) {
      el.innerHTML = `<div class="bl-empty">No drop-offs yet today.</div>`;
      return;
    }
    // Aggregate by section_id when we have one so the row can link back to
    // the polygon; fall back to the name string for unmatched drops.
    const buckets = new Map(); // key -> { sectionId, name, count }
    rows.forEach(r => {
      const name = r.parking_sections?.name || r.location_name || "Unspecified";
      const key = r.section_id || `name:${name}`;
      const existing = buckets.get(key);
      if (existing) existing.count++;
      else buckets.set(key, { sectionId: r.section_id || null, name, count: 1 });
    });
    const entries = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
    const max = Math.max(...entries.map(e => e.count), 1);
    el.innerHTML = entries.map(e => {
      const isSelected = e.sectionId && e.sectionId === selectedSectionId;
      const isDim = selectedSectionId && !isSelected;
      const cls = [
        "bar-row",
        e.sectionId ? "is-clickable" : "",
        isSelected ? "is-selected" : "",
        isDim ? "is-dim" : "",
      ].filter(Boolean).join(" ");
      const sidAttr = e.sectionId ? ` data-section-id="${esc(e.sectionId)}"` : "";
      return `
      <div class="${cls}"${sidAttr}>
        <div class="bar-key">${esc(e.name)}</div>
        <div class="bar-track"><div class="bar-fill" data-pct="${Math.round(e.count / max * 100)}"></div></div>
        <div class="bar-val">${e.count}</div>
      </div>
    `;
    }).join("");
    // CSP blocks inline style="…"; set widths via DOM API after render.
    el.querySelectorAll(".bar-fill").forEach((bar) => { bar.style.width = bar.dataset.pct + "%"; });
  }

  async function renderMap(vehicles) {
    initMap();
    if (!map) return;
    ensureSectionOverlay();
    const pinned = vehicles.filter((v) => v.last_lat != null && v.last_lng != null);

    // Resolve driver names for popups in one round trip.
    const ids = [...new Set(pinned.map((v) => v.last_user_id).filter(Boolean))];
    const names = {};
    if (ids.length) {
      const { data } = await sb.from("profiles").select("id,display_name").in("id", ids);
      (data || []).forEach((p) => { names[p.id] = p.display_name || ""; });
    }

    pinLayer.clearLayers();
    const bounds = [];
    pinned.forEach((v) => {
      const c = categoryOf(v.current_status);
      const cls = c === "ready" ? "" : ` bl-lot-pin--${c}`;
      const icon = L.divIcon({ className: "", html: `<div class="bl-lot-pin${cls}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
      const who = names[v.last_user_id] ? ` · ${esc(names[v.last_user_id])}` : "";
      L.marker([v.last_lat, v.last_lng], { icon }).addTo(pinLayer)
        .bindPopup(`<b>${esc(v.serial_id)}</b><br>${esc(label(v.current_status))}<br>${esc(fmt.timeAgo(v.last_seen_at))}${who}`);
      bounds.push([v.last_lat, v.last_lng]);
    });

    const meta = $("blMapMeta");
    if (meta) {
      const scope = selectedSectionId ? " in section" : "";
      meta.textContent = pinned.length ? `${pinned.length} located${scope}` : (selectedSectionId ? "no GPS pins in this section yet" : "no GPS pins yet");
    }

    // Framing: when a section is selected, frame the polygon (even if empty)
    // so the user sees the section boundary; otherwise fit to the pins.
    const sel = selectedSection();
    if (sel && sel.poly) {
      map.fitBounds(sel.poly.getBounds(), { padding: [30, 30], maxZoom: 19 });
    } else if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 18 });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 17);
    }
    setTimeout(() => map.invalidateSize(), 60);
  }

  function fmtHour(h) {
    const ap = h < 12 ? "A" : "P";
    let hh = h % 12; if (hh === 0) hh = 12;
    return hh + ap;
  }

  function renderThroughput(records) {
    const el = $("blThroughput");
    const foot = $("blThroughputFoot");
    if (!el) return;
    if (!records.length) {
      el.innerHTML = `<div class="bl-empty">No cars logged yet today.</div>`;
      if (foot) foot.textContent = "";
      return;
    }
    const curHour = new Date().getHours();
    let firstHour = curHour;
    records.forEach((r) => { const h = new Date(r.ts).getHours(); if (h < firstHour) firstHour = h; });
    // Keep the window readable: at most ~13 hourly buckets.
    const startHour = Math.max(firstHour, curHour - 12);

    const buckets = [];
    for (let h = startHour; h <= curHour; h++) buckets.push({ h, n: 0 });
    records.forEach((r) => {
      const h = new Date(r.ts).getHours();
      const b = buckets.find((x) => x.h === h);
      if (b) b.n++;
    });
    const max = Math.max(1, ...buckets.map((b) => b.n));
    const peakN = Math.max(...buckets.map((b) => b.n));

    el.innerHTML = buckets.map((b) => {
      const pct = Math.round((b.n / max) * 100);
      const peak = b.n === peakN && b.n > 0 ? " is-peak" : "";
      return `<div class="col"><div class="bar-track"><div class="bar${peak}" data-pct="${pct}" title="${b.n} car${b.n === 1 ? "" : "s"}"></div></div><div class="hr">${fmtHour(b.h)}</div></div>`;
    }).join("");
    // CSP blocks inline style="…"; set heights via DOM API after render.
    el.querySelectorAll(".bar").forEach((bar) => { bar.style.height = bar.dataset.pct + "%"; });

    if (foot) {
      const peakBucket = buckets.find((b) => b.n === peakN);
      foot.innerHTML = `<span>${records.length} logged today</span><span>Peak: ${fmtHour(peakBucket.h)} · ${peakN} cars</span>`;
    }
  }

  function start() {
    if (started) return;
    started = true;
    $("blDashRefresh")?.addEventListener("click", loadAll);
    // Section picker in the map card head — value "" means "clear filter".
    $("blMapSectionSelect")?.addEventListener("change", (e) => {
      const v = e.target.value;
      if (v) selectSection(v); else clearSection();
    });
    // Delegated click on the "By Section" tile — rows carrying a
    // data-section-id drive the same selection filter as the polygons.
    $("blDashBySection")?.addEventListener("click", (e) => {
      const row = e.target.closest("[data-section-id]");
      if (row) selectSection(row.dataset.sectionId);
    });
    loadAll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(loadAll, 30000);
    realtimeChan = sb.channel("backlot-dash")
      .on("postgres_changes", { event: "*", schema: "public", table: "records" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "vehicles" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "fleet_counts" }, loadAll)
      .subscribe();
  }

  function stop() {
    started = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  document.addEventListener("bl-auth-change", () => {
    if (BL_AUTH.canEnter()) start(); else stop();
  });
  if (BL_AUTH.canEnter()) start();

  // Leaflet needs a visible, sized container — refresh + resize when the
  // dashboard section becomes active.
  document.addEventListener("bl-section-shown", (e) => {
    if (e.detail !== "dashboard") return;
    initMap();
    if (map) setTimeout(() => map.invalidateSize(), 60);
    if (started) loadAll();
  });

  window.BL_DASHBOARD = { refresh: loadAll };
})();
