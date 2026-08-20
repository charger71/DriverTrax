// ============================================================
// Backlot — parking-sections map tool
//
// Standalone admin page for capturing/exporting parking-section
// polygon boundaries. Ships with a seeded dataset per lot; edit
// `sections` below to add new coordinates (walk the perimeter
// with a GPS app or click points on Google Earth). Copies the
// GeoJSON or SQL insert to the clipboard for pasting into the
// Supabase editor. No BL_AUTH gate — this tool is opened in a
// new tab from the manager console, which is already gated.
// ============================================================
(function () {

  // -------- DATA ---------------------------------------------------------
  // Each parking section is a polygon of [lat, lng] pairs.
  // status: 'open' | 'full' | 'restricted'
  const sections = [
    {
      id: "GARAGE-LOU",
      name: "Garage",
      capacity: 600, occupied: 0, status: "open",
      coords: [
        [38.18704452729651, -85.74453761903163],
        [38.188302978719136, -85.74147008387757],
        [38.18725623092606, -85.74066205022723],
        [38.18602912540962, -85.74377946400168],
      ],
    },
    // {
    //   id: "RETURNS-LOU",
    //   name: "Returns",
    //   capacity: 100, occupied: 0, status: "open",
    //   coords: [
    //     [38.18757923487743, -85.74293115590422],
    //     [38.18785886128828, -85.74231944807806],
    //     [38.18692564836675, -85.74166533545488],
    //     [38.18665428945734, -85.74228471405515],
    //   ],
    // },
    {
      id: "QTA-LOU",
      name: "QTA",
      capacity: 300, occupied: 0, status: "open",
      coords: [
        [38.18514126468124, -85.74502123917335],
        [38.18542880962902, -85.74439718311915],
        [38.18390649994551, -85.7433283974631],
        [38.18363586378256, -85.74396679963348],
      ],
    },
    {
      id: "BLOT-LOU",
      name: "Back Lot",
      capacity: 400, occupied: 0, status: "open",
      coords: [
        [38.193960328564074, -85.75541612174744],
        [38.19424966878994,  -85.75375373309824],
        [38.194091575819286, -85.75374614228248],
        [38.19398120882505,  -85.75450901926534],
        [38.192331649763354, -85.75407254735973],
        [38.19231673495401,  -85.75453558712046],
        [38.192379377132674, -85.75478228863233],
        [38.19239130897013,  -85.75478987944808],
        [38.19254343972621,  -85.75500242228907],
        [38.19274329729535,  -85.75511248911745],
        [38.19274628024001,  -85.75510869370957],
      ],
    },
    {
      id: "OLOT-LOU",
      name: "Orange Lot",
      capacity: 200, occupied: 0, status: "open",
      coords: [
        [38.19398120882505,  -85.75450901926534],
        [38.194091575819286, -85.75374614228248],
        [38.1940557811368,   -85.75359432596748],
        [38.19333093503054,  -85.75359432596748],
        [38.19333690087156,  -85.75376132391398],
        [38.19232866680172,  -85.75373096065098],
        [38.192331649763354, -85.75407254735973],
      ],
    },
    {
      id: "PA-ATLANTIC-LOU",
      name: "Atlantic/FOB",
      capacity: 20, occupied: 0, status: "open",
      coords: [
        [38.185481485025186, -85.72552918940946],
        [38.18469987139997,  -85.72473594916362],
        [38.184013715122106, -85.72618579497181],
        [38.184088297639256, -85.72707771582243],
        [38.18417481326354,  -85.72732821274215],
        [38.18435381078064,  -85.7274420749784],
        [38.18471777104247,  -85.72738514386027],
        [38.18497134883866,  -85.72696385358618],
        [38.18505488015472,  -85.72628068016868],
        [38.18534127251119,  -85.72577209551346],
      ],
    },
    {
      id: "HS-2F3GJ7",
      name: "Preston North 2F3GJ7",
      capacity: 40, occupied: 0, status: "open",
      coords: [
        [38.18613541080047, -85.72395350904064],
        [38.18647208928971, -85.72321772876019],
        [38.186162562349224, -85.72301046670937],
        [38.185779724577166, -85.72368061400704],
      ],
    },
    {
      id: "TEST71",
      name: "AREA71",
      capacity: 1000, occupied: 0, status: "restricted",
      coords: [
        [38.194468759237076, -85.71734727462919],
        [38.19584511752505,  -85.71546988702076],
        [38.19467246190378,  -85.7144401259072],
        [38.19364843732534,  -85.71632451869326],
      ],
    },
  ];

  // Match .bl-mt-status--* in map-tool.css so list dots and polygons agree.
  const statusColor = { open: "#00a651", full: "#e85550", restricted: "#f0b04a" };

  // -------- Map setup ----------------------------------------------------
  const map = L.map("map", { zoomControl: true }).setView([38.2532, -85.7580], 17);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const layers = {};
  const listEl     = document.getElementById("section-list");
  const coordsText = document.getElementById("coords-text");
  const copyBtn    = document.getElementById("copy-btn");
  const headerMeta = document.getElementById("header-meta");

  let activeId  = null;
  let activeFmt = "geojson";

  // -------- Export helpers ----------------------------------------------
  // Closes the ring (first point = last point) as PostGIS/GeoJSON require.
  function closedRing(coords) {
    const ring = coords.map((c) => [c[1], c[0]]); // [lng, lat] for GeoJSON
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    return ring;
  }

  function toGeoJSON(s) {
    return JSON.stringify({
      type: "Feature",
      properties: { name: s.name, status: s.status, capacity: s.capacity },
      geometry: { type: "Polygon", coordinates: [closedRing(s.coords)] },
    }, null, 2);
  }

  function toSQL(s) {
    const wkt = closedRing(s.coords).map(([lng, lat]) => `${lng} ${lat}`).join(", ");
    return `insert into parking_sections (fleet_id, name, status, boundary)
values (
  :fleet_id,
  '${s.name.replace(/'/g, "''")}',
  '${s.status}',
  ST_GeogFromText('POLYGON((${wkt}))')
);`;
  }

  function renderExport() {
    if (!activeId) return;
    const s = sections.find((x) => x.id === activeId);
    coordsText.textContent = activeFmt === "geojson" ? toGeoJSON(s) : toSQL(s);
    copyBtn.classList.remove("is-hidden");
    copyBtn.textContent = "Copy";
  }

  // -------- Segmented format switcher -----------------------------------
  document.querySelectorAll(".bl-mt-seg .bl-seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".bl-mt-seg .bl-seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      activeFmt = btn.dataset.fmt;
      renderExport();
    });
  });

  // -------- Copy buttons -------------------------------------------------
  function flashCopied(btn, restoreText) {
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = restoreText; }, 1600);
  }

  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(coordsText.textContent).then(() => flashCopied(copyBtn, "Copy"));
  });

  const retagBtn = document.getElementById("retag-btn");
  const retagSql = "select public.retag_drop_offs() as newly_tagged;";
  retagBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(retagSql).then(() => flashCopied(retagBtn, "Copy retag SQL"));
  });

  // -------- Selection ----------------------------------------------------
  function selectSection(id) {
    document.querySelectorAll(".bl-mt-item").forEach((el) => el.classList.toggle("is-active", el.dataset.id === id));
    Object.entries(layers).forEach(([sid, layer]) => {
      layer.setStyle({ weight: sid === id ? 3 : 2, fillOpacity: sid === id ? 0.45 : 0.25 });
    });
    activeId = id;
    renderExport();
    map.fitBounds(layers[id].getBounds(), { padding: [40, 40] });
  }

  // -------- Render polygons + list --------------------------------------
  sections.forEach((s) => {
    const color = statusColor[s.status];
    const poly = L.polygon(s.coords, {
      color, fillColor: color, fillOpacity: 0.25, weight: 2,
    }).addTo(map);

    poly.bindPopup(`<strong>${s.name}</strong><br>${s.occupied}/${s.capacity} occupied — ${s.status}`);
    poly.on("click", () => selectSection(s.id));
    layers[s.id] = poly;

    const item = document.createElement("div");
    item.className = "bl-mt-item";
    item.dataset.id = s.id;
    // No user-authored HTML enters here, so template-literal composition is safe.
    item.innerHTML = `
      <div class="bl-mt-item-name"><span class="bl-mt-item-dot bl-mt-status--${s.status}"></span>${s.name}</div>
      <div class="bl-mt-item-stats">${s.occupied}/${s.capacity} spaces · ${s.status}</div>
    `;
    item.addEventListener("click", () => selectSection(s.id));
    listEl.appendChild(item);
  });

  const totalCap = sections.reduce((a, s) => a + s.capacity, 0);
  const totalOcc = sections.reduce((a, s) => a + s.occupied, 0);
  headerMeta.textContent = `${sections.length} sections · ${totalOcc}/${totalCap} occupied`;

  // Fit map to all sections on load.
  map.fitBounds(L.latLngBounds(sections.flatMap((s) => s.coords)), { padding: [40, 40] });
})();
