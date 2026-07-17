// ============================================================
// DRIVERTRAX v3.0 (beta)
// Single-file PWA for rental car lot operations
// ============================================================

const APP_VERSION = "3.0-beta";
const SCHEMA_VERSION = 2;

// Canonical short status code -> visible label shown in record cards / detail.
// Stored value (canonical) stays short; only the displayed text is descriptive.
const STATUS_LABELS = {
  "REWASH": "REWASH/FLUIDS",
  "BODY": "BODY DAMAGE",
  "PM": "PM (MAINT.)",
  "MK": "MK (MECH.)",
  "MR": "MR (RECALL)",
  "OM": "OM (OVER MILES)",
  "TI": "TI(TIRE)",
  "CHECK_IN": "CHECK IN",
  "CHECK_OUT": "CHECK OUT",
  "HOLD": "HOLD",
  "DNR": "DO NOT RENT (DNR)"
};
function statusLabel(s) { return STATUS_LABELS[s] || s || ""; }

// Location label used on every record card. Prefers the GPS-tagged
// parking section (from the parking_sections trigger or the driver's
// "Where is this?" fallback) and falls back to the destination dropdown
// so pre-drop_offs records still render.
function locationLabel(destination, destinationOther, sectionName) {
  if (sectionName) return sectionName;
  if (destination === "OTHER" && destinationOther) return `OTHER: ${destinationOther}`;
  return destination || "";
}
window.locationLabel = locationLabel;

// ============================================================
// Single source of truth for status / destination / condition
// catalogs. Referenced by app.js (entry form), vehicle-notes.js
// (notes form) and detailer.js so the three forms stay aligned.
// ============================================================
const DT_OPTIONS = {
  // Selectable by any role on the NEW ENTRY form + notes form.
  STATUS_BASE: [
    "CLEAN","DIRTY","REWASH","BODY","PM","MK","MR","OM",
    "AUDIT FAIL","WI/DELETE","GLASS","TI","OTHER"
  ],
  // Selectable only by CXR / manager / admin.
  STATUS_PRIVILEGED: ["CHECK_OUT","HOLD","DNR"],
  // System-set by the detailer flow. Not selectable from any form,
  // but appears as a filter option in the records view.
  STATUS_DERIVED: ["DETAILING","DETAILED"],
  // Fallback list only. The real dropdown options come from the
  // parking_sections table via DT_DROPOFFS.getSections() — see
  // populateDestinationSelects(). Kept here so any legacy caller that
  // reads DT_OPTIONS.DESTINATIONS gets a sensible list.
  DESTINATIONS: ["GARAGE","QTA","BACKLOT","ATLANTIC","BRANCH","OTHER"],
  CONDITIONS: [
    { id: "REGULAR",      label: "Regular"      },
    { id: "DETAIL",       label: "Detail"       },
    { id: "PET_HAIR",     label: "Pet Hair"     },
    { id: "SPIFFY",       label: "Spiffy"       },
    { id: "AIR",          label: "Air"          },
    { id: "WASHER_FLUID", label: "Washer Fluid" },
    { id: "FUEL",         label: "Fuel"         },
    { id: "CHARGE",       label: "Charge"       },
    { id: "QUICK_FLIP",   label: "Quick Flip"   },
    { id: "PRIORITY",     label: "Priority"     }
  ],
  FUEL_LEVELS: ["EMPTY","1/4","1/2","3/4","FULL"],
  // End-of-shift tally categories used by the counter panels (Garage, Backlot,
  // Key Up). Garage/Backlot are editable per-device; Key Up is fixed.
  COUNTER_DEFAULTS: {
    garage:   ["Clean", "Dirty", "PM", "MK", "MR", "OM", "Other"],
    bcounter: ["Clean", "Dirty", "PM", "MK", "MR", "OM", "Other"],
    keyup:    ["Clean", "Dirty", "Rail", "Other"]
  }
};
window.DT_OPTIONS = DT_OPTIONS;

const SCHEMA_KEY = "drivertrax_schema_version";

// ============================
// SERVICE WORKER REGISTRATION
// ============================
// ============================
// SPLASH SCREEN
// ============================
const _splashStart = Date.now();
function hideSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  const minDwellMs = 700; // keep splash visible at least this long so it doesn't flash
  const elapsed = Date.now() - _splashStart;
  const wait = Math.max(0, minDwellMs - elapsed);
  setTimeout(() => {
    el.classList.add("hide");
    // Remove from DOM after the fade completes so it doesn't trap pointer events
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
  }, wait);
}
if (document.readyState === "complete") hideSplash();
else window.addEventListener("load", hideSplash);
// Safety fallback so a stuck page can never block the UI forever
setTimeout(hideSplash, 5000);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then((reg) => {
        console.log("Service worker registered:", reg.scope);
      })
      .catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
  });
}

// ============================
// SCHEMA MIGRATION
// ============================
function migrateLocalStorageKeys() {
  // One-time migration: rename old "drivertraxxx_*" keys to "drivertrax_*"
  // (App was renamed from DriverTraxxx -> DriverTrax)
  const oldNewPairs = [
    ["drivertraxxx_records", "drivertrax_records"],
    ["drivertraxxx_schema_version", "drivertrax_schema_version"],
    ["drivertraxxx_shuttle", "drivertrax_shuttle"],
    ["drivertraxxx_transport", "drivertrax_transport"],
    ["drivertraxxx_profile", "drivertrax_profile"],
    ["drivertraxxx_backup", "drivertrax_backup"],
    ["drivertraxxx_backup_time", "drivertrax_backup_time"]
  ];
  let migrated = 0;
  oldNewPairs.forEach(([oldKey, newKey]) => {
    const oldVal = localStorage.getItem(oldKey);
    if (oldVal !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, oldVal);
      localStorage.removeItem(oldKey);
      migrated++;
    }
  });
  if (migrated > 0) console.log(`Migrated ${migrated} key(s) to new naming scheme`);
}
migrateLocalStorageKeys();

function migrateSchema() {
  const stored = parseInt(localStorage.getItem(SCHEMA_KEY) || "1");
  if (stored === SCHEMA_VERSION) return;

  try {
    const records = JSON.parse(localStorage.getItem("drivertrax_records") || "[]");

    if (stored < 2) {
      // v1 -> v2: ensure every record has version field, default missing fields
      records.forEach(r => {
        if (!r.version) r.version = 2;
        if (r.transport === undefined) r.transport = false;
        if (r.tires === undefined) r.tires = [];
      });
      localStorage.setItem("drivertrax_records", JSON.stringify(records));
    }

    localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION.toString());
    console.log(`Migrated schema from v${stored} to v${SCHEMA_VERSION}`);
  } catch(e) {
    console.error("Migration failed:", e);
  }
}
migrateSchema();

// ============================
// GLOBAL ERROR HANDLER
// ============================
window.addEventListener("error", e => {
  console.error("Uncaught error:", e.message, "at", e.filename + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", e => {
  console.warn("Unhandled promise rejection:", e.reason);
});

// ============================
// MAP HELPER (Leaflet wrapper)
// ============================
function createMap(elementId, options = {}) {
  if (!window.L) return null;
  const el = document.getElementById(elementId);
  if (!el) return null;

  // Destroy existing map if present
  if (el._leaflet_map) {
    try { el._leaflet_map.remove(); } catch(e) {}
    el._leaflet_map = null;
    el.innerHTML = "";
  }

  const map = L.map(el, {
    zoomControl: options.zoomControl !== false,
    attributionControl: false
  });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

  el._leaflet_map = map;
  return map;
}

function destroyMap(elementId) {
  const el = document.getElementById(elementId);
  if (!el || !el._leaflet_map) return;
  try { el._leaflet_map.remove(); } catch(e) {}
  el._leaflet_map = null;
  el.innerHTML = "";
}

function createNumberedMarker(num, color, size = 26) {
  if (!window.L) return null;
  return L.divIcon({
    className: "",
    html: `<div class="map-marker-num" style="width:${size}px;height:${size}px;background:#${color};font-size:${Math.round(size*0.4)}px">${num}</div>`,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
    popupAnchor: [0, -(size/2)]
  });
}

function recordPopupHTML(r) {
  const time = DT_FORMAT.timeAgoOrClock(r.timestamp);
  return `
    <div class="map-popup">
      <div class="map-popup__title">${sanitizeText(r.serialId)}</div>
      <div class="map-popup__status">${sanitizeText(statusLabel(r.status))}${r.destination ? " &middot; " + sanitizeText(r.destination) : ""}</div>
      <div class="map-popup__time">${time}</div>
      <button class="map-popup__btn" onclick="openDetail('${r.id}', 'deleteRecord')">View Record</button>
    </div>`;
}

const DB_KEY = "drivertrax_records";
// Cached records - invalidated on every setRecords() call
let _recordsCache = null;
function getRecords() {
  if (_recordsCache === null) {
    _recordsCache = JSON.parse(localStorage.getItem(DB_KEY) || "[]");
  }
  return _recordsCache;
}
function setRecords(r) {
  _recordsCache = r;
  localStorage.setItem(DB_KEY, JSON.stringify(r));
}
function invalidateRecordsCache() { _recordsCache = null; }
function statusClass(s) { return "status-" + s.replace(/[^A-Z]/g,""); }

// --- Fleet records (manager view) ----------------------------------
// Managers don't log cars locally; their Records tab pulls every driver's
// records from Supabase. Cached and refreshed when they open the tab.
let _fleetRecords = [];
let _fleetFetching = null;
function isManagerView() { return !!(window.DT_AUTH && DT_AUTH.isManager()); }
function getEffectiveRecords() { return isManagerView() ? _fleetRecords : getRecords(); }

// Triggered by the Records date inputs — managers need to refetch the fleet
// when the date range changes; drivers just re-render their local set.
function onRecordsDateChange() {
  resetRecordsPage();
  if (isManagerView()) {
    fetchFleetRecords().then(renderRecords);
  } else {
    renderRecords();
  }
}

async function fetchFleetRecords() {
  if (!window.DT_AUTH || !DT_AUTH.client) return;
  if (_fleetFetching) return _fleetFetching;
  _fleetFetching = (async () => {
    try {
      // Honor the current date filter so the manager only pulls what they're looking at.
      // Defaults to today when both filters are empty.
      const fromEl = document.getElementById("fDateFrom");
      const toEl   = document.getElementById("fDateTo");
      const fromStr = fromEl?.value || new Date().toISOString().slice(0, 10);
      const toStr   = toEl?.value   || fromStr;
      const sinceISO = new Date(fromStr + "T00:00:00").toISOString();
      const untilISO = new Date(toStr   + "T23:59:59.999").toISOString();

      const { data, error } = await DT_AUTH.client
        .from("records")
        .select("id,user_id,serial_id,status,status_other,destination,destination_other,section_id,section_name,no_tag,shuttle,transport,shift_num,notes,lat,lng,gps_error,tires,vin_data,ts,mileage,fuel_level,photo_url,photo_urls")
        .gte("ts", sinceISO)
        .lte("ts", untilISO)
        .order("ts", { ascending: false })
        .limit(2000);
      if (error) { console.warn("[Fleet] records load", error); return; }
      // Map driver names so manager cards can show whose entry this is
      const ids = [...new Set((data || []).map(r => r.user_id))];
      const names = {};
      if (ids.length) {
        const { data: profs } = await DT_AUTH.client.from("profiles").select("id,display_name").in("id", ids);
        (profs || []).forEach(p => { names[p.id] = p.display_name || "Driver"; });
      }
      _fleetRecords = (data || []).map(row => ({
        id: row.id,
        serialId: row.serial_id,
        status: row.status,
        statusOther: row.status_other || "",
        destination: row.destination || "",
        destinationOther: row.destination_other || "",
        sectionId: row.section_id || null,
        sectionName: row.section_name || "",
        noTag: !!row.no_tag,
        shuttle: !!row.shuttle,
        transport: !!row.transport,
        shiftNum: row.shift_num,
        notes: row.notes || "",
        lat: row.lat,
        lng: row.lng,
        gpsError: !!row.gps_error,
        tires: row.tires || [],
        vinData: row.vin_data || undefined,
        mileage: Number.isFinite(row.mileage) ? row.mileage : null,
        fuel_level: row.fuel_level || "",
        photo_url: row.photo_url || "",
        photo_urls: Array.isArray(row.photo_urls) ? row.photo_urls : [],
        timestamp: row.ts ? new Date(row.ts).getTime() : Date.now(),
        _driverName: names[row.user_id] || "Driver"
      }));
    } finally { _fleetFetching = null; }
  })();
  return _fleetFetching;
}

// ============================
// INPUT SANITIZATION
// ============================
function sanitizeText(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
}

function sanitizeSerial(str) {
  // Serial IDs: only alphanumeric, hyphens, max 30 chars
  return str.replace(/[^A-Z0-9\-]/g, "").slice(0, 30);
}

function sanitizeNotes(str) {
  // Notes: strip HTML tags, limit to 500 chars
  return str.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").slice(0, 500).trim();
}

function sanitizeName(str) {
  // Names: letters, spaces, hyphens, apostrophes only, max 60 chars
  return str.replace(/[^a-zA-Z0-9 '\-\.]/g, "").slice(0, 60).trim();
}

// ============================
// HAPTICS
// ============================
// Web Vibration API: works on Android Chrome reliably and on iOS 18+ in
// installed PWAs (best-effort). Silently no-ops on desktop / unsupported
// browsers. Must be called from within a user-gesture handler.
const HAPTIC_PATTERNS = {
  tap:     10,                       // light single click (counter +/-)
  scan:    [80, 40, 80],             // brisk double-pulse on successful scan
  success: 30,                       // record saved
  warn:    [40, 30, 40],             // toast warning
  error:   [60, 40, 60, 40, 60]      // toast error
};
function haptic(type = "tap") {
  try {
    if (!navigator.vibrate) return;
    const pattern = HAPTIC_PATTERNS[type] ?? HAPTIC_PATTERNS.tap;
    navigator.vibrate(pattern);
  } catch (e) { /* ignore */ }
}

// ============================
// TOAST
// ============================
function showToast(msg, type = "success") {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = "toast toast-" + type + " toast-show";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = "toast"; }, 2800);
  // Couple haptic feedback to toast type so callers don't have to remember
  if (type === "warn") haptic("warn");
  else if (type === "error") haptic("error");
}

// ============================
// SHIFT DETECTION
// ============================
const SHIFT_GAP_MS = 6 * 60 * 60 * 1000;

function estDateStr(ts) {
  const d = new Date(new Date(ts).toLocaleString("en-US", {timeZone:"America/New_York"}));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// Cached shift grouping - invalidated when records change
let _shiftsCache = null;
let _shiftsCacheKey = null;
function getAllShifts() {
  const records = getRecords();
  // Use record count + last timestamp as cheap cache key
  const key = records.length > 0
    ? records.length + ":" + records[records.length-1].timestamp + ":" + records[0].timestamp
    : "empty";
  if (_shiftsCache !== null && _shiftsCacheKey === key) return _shiftsCache;

  const all = records.slice().sort((a,b) => a.timestamp - b.timestamp);
  if (all.length === 0) {
    _shiftsCache = []; _shiftsCacheKey = key;
    return _shiftsCache;
  }
  const shifts = [[all[0]]];
  for (let i = 1; i < all.length; i++) {
    if (all[i].timestamp - all[i-1].timestamp >= SHIFT_GAP_MS) shifts.push([]);
    shifts[shifts.length-1].push(all[i]);
  }
  _shiftsCache = shifts.map((records, idx) => ({
    shiftIndex: idx,
    date: estDateStr(records[0].timestamp),
    records
  }));
  _shiftsCacheKey = key;
  return _shiftsCache;
}

function getShiftsForDate(dateStr) {
  return getAllShifts().filter(s => s.date === dateStr);
}

function getCurrentShift() {
  const all = getAllShifts();
  return all.length > 0 ? all[all.length-1] : { records: [], shiftIndex: 0, date: "" };
}

function getCurrentShiftRecords() {
  return getCurrentShift().records;
}

function getShiftsByDay(days) {
  const all = getAllShifts();
  const byDay = {};
  days.forEach(d => byDay[d] = []);
  all.forEach(shift => {
    if (byDay[shift.date] !== undefined) byDay[shift.date].push(shift);
  });
  return byDay;
}

function getShiftGroups(sortedRecords) {
  if (sortedRecords.length === 0) return [];
  const shifts = [[sortedRecords[0]]];
  for (let i = 1; i < sortedRecords.length; i++) {
    if (sortedRecords[i].timestamp - sortedRecords[i-1].timestamp >= SHIFT_GAP_MS) shifts.push([]);
    shifts[shifts.length-1].push(sortedRecords[i]);
  }
  return shifts;
}

// ============================
// AVG BANNER
// ============================
function updateAvgBanner() {
  // Driver banner — skip if a manager/detailer view owns the banner.
  if (document.body.classList.contains("is-manager") || document.body.classList.contains("is-detailer")) return;
  const shiftRecords = getCurrentShiftRecords();
  const banner = document.getElementById("avgBanner");
  if (shiftRecords.length < 2) { banner.style.display = "none"; return; }
  const timestamps = shiftRecords.map(r => r.timestamp);
  const gaps = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i-1]);
  const avgMs = gaps.reduce((a,b) => a+b, 0) / gaps.length;
  const mins = Math.round(avgMs / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const timeStr = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  const elapsedMs = timestamps[timestamps.length-1] - timestamps[0];
  const elapsedHrs = elapsedMs / 3600000;
  const cph = elapsedHrs > 0 ? (timestamps.length / elapsedHrs).toFixed(1) : "-";
  const lbl = document.getElementById("avgBannerTimeLabel");
  if (lbl) lbl.textContent = "AVG TRIP TIME";
  document.getElementById("avgBannerTime").textContent = timeStr;
  document.getElementById("avgBannerCph").textContent = cph;
  banner.style.display = "block";
}

// ============================
// FILTER
// ============================
// Debounced search to avoid re-rendering on every keystroke
let _searchDebounceTimer = null;
function debouncedSearchUpdate() {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    resetRecordsPage();
    renderRecords();
  }, 200);
}

// Recent VIN search history shown on the VIN LOOKUP empty state. Persisted
// per-device in localStorage; capped so a noisy day doesn't grow forever.
const RECENT_VIN_KEY = "dt_recent_vin_searches";
const RECENT_VIN_MAX = 10;
function getRecentVinSearches() {
  try { const v = JSON.parse(localStorage.getItem(RECENT_VIN_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function pushRecentVinSearch(term) {
  const t = (term || "").trim();
  if (!t) return;
  const upper = t.toUpperCase();
  const list = getRecentVinSearches().filter(x => x.toUpperCase() !== upper);
  list.unshift(t);
  if (list.length > RECENT_VIN_MAX) list.length = RECENT_VIN_MAX;
  try { localStorage.setItem(RECENT_VIN_KEY, JSON.stringify(list)); } catch {}
}
// Save partial searches (anything ≥3 chars that didn't go through the
// full-VIN path) when the input loses focus, so chips fill in even
// for note/fuzzy searches.
function onSearchBlur() {
  const v = (document.getElementById("fSearch")?.value || "").trim();
  if (v.length >= 3 && !isFullVin(v)) pushRecentVinSearch(v);
}

function getFiltered() {
  const search = document.getElementById("fSearch").value.trim().toUpperCase();
  const status = document.getElementById("fStatus").value;
  const noTagFilter = document.getElementById("fNoTag").value;
  const dest = document.getElementById("fDest").value;
  const from = document.getElementById("fDateFrom").value;
  const to = document.getElementById("fDateTo").value;
  return getEffectiveRecords().filter(r => {
    if (search && !r.serialId.includes(search)) return false;
    if (status && r.status !== status) return false;
    if (noTagFilter === "yes" && !r.noTag) return false;
    if (noTagFilter === "no" && r.noTag) return false;
    if (dest && r.destination !== dest) return false;
    const ds = estDateStr(r.timestamp);
    if (from && ds < from) return false;
    if (to && ds > to) return false;
    return true;
  });
}

function clearFilters() {
  ["fSearch","fDateFrom","fDateTo"].forEach(id => document.getElementById(id).value = "");
  ["fStatus","fNoTag","fDest"].forEach(id => document.getElementById(id).selectedIndex = 0);
  document.getElementById("recordsHeading").textContent = "Filter Records";
  resetRecordsPage();
  renderRecords();
}

function viewByDate(dateStr) {
  document.getElementById("fDateFrom").value = dateStr;
  document.getElementById("fDateTo").value = dateStr;
  document.getElementById("fSearch").value = "";
  document.getElementById("fStatus").selectedIndex = 0;
  document.getElementById("fNoTag").selectedIndex = 0;
  document.getElementById("fDest").selectedIndex = 0;
  document.getElementById("recordsHeading").textContent = "Entries for " + dateStr;
  resetRecordsPage();
  showTab("records");
}

function viewByWeek(fromStr, toStr, label) {
  document.getElementById("fDateFrom").value = fromStr;
  document.getElementById("fDateTo").value = toStr;
  document.getElementById("fSearch").value = "";
  document.getElementById("fStatus").selectedIndex = 0;
  document.getElementById("fNoTag").selectedIndex = 0;
  document.getElementById("fDest").selectedIndex = 0;
  document.getElementById("recordsHeading").textContent = label;
  resetRecordsPage();
  showTab("records");
}

// ============================
// VIN DECODER
// ============================
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;
function isValidVIN(s) { return VIN_REGEX.test(s); }

async function decodeVIN(vin) {
  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.Results || !data.Results.length) return null;
    const map = {};
    data.Results.forEach(r => {
      if (r.Value && r.Value !== "Not Applicable" && r.Value !== "0") map[r.Variable] = r.Value;
    });
    if (!map["Make"] && !map["Model"] && !map["Model Year"]) return null;
    // Engine summary: prefer cylinders + displacement, fall back to just one.
    const cyl = map["Engine Number of Cylinders"];
    const disp = map["Displacement (L)"];
    const engineParts = [];
    if (disp) engineParts.push(`${disp}L`);
    if (cyl) engineParts.push(`${cyl}-cyl`);
    return {
      year: map["Model Year"] || "",
      make: map["Make"] || "",
      model: map["Model"] || "",
      trim: map["Trim"] || "",
      bodyClass: map["Body Class"] || "",
      fuelType: map["Fuel Type - Primary"] || "",
      engine: engineParts.join(" "),
      manufacturer: map["Manufacturer Name"] || "",
      // Extended NHTSA fields surfaced in the VIN history header
      driveType: map["Drive Type"] || "",
      transmission: map["Transmission Style"] || "",
      doors: map["Doors"] || "",
      vehicleType: map["Vehicle Type"] || "",
      plantCity: map["Plant City"] || "",
      plantCountry: map["Plant Country"] || "",
      series: map["Series"] || ""
    };
  } catch(e) { console.warn("VIN decode failed:", e); return null; }
}

// ============================
// NHTSA OPEN RECALLS
// ============================
// Looked up by year+make+model (NHTSA's recallsByVehicle endpoint doesn't take
// a VIN). Cached per session so re-opening the same VIN history doesn't refetch.
const _recallCache = new Map();
async function getRecalls(year, make, model) {
  if (!year || !make || !model) return [];
  const key = `${year}|${String(make).toUpperCase()}|${String(model).toUpperCase()}`;
  if (_recallCache.has(key)) return _recallCache.get(key);
  try {
    const url = `https://api.nhtsa.gov/recalls/recallsByVehicle`
      + `?make=${encodeURIComponent(make)}`
      + `&model=${encodeURIComponent(model)}`
      + `&modelYear=${encodeURIComponent(year)}`;
    const res = await fetch(url);
    if (!res.ok) { _recallCache.set(key, []); return []; }
    const data = await res.json();
    const list = Array.isArray(data?.results) ? data.results : [];
    _recallCache.set(key, list);
    return list;
  } catch (e) {
    console.warn("Recalls fetch failed:", e);
    _recallCache.set(key, []);
    return [];
  }
}

// ============================
// SAVE RECORD
// ============================
// Photos attached to the current NEW ENTRY form (array of resized blobs, pre-upload).
// Wired by initEntryPhotoInput() at boot.
let pendingEntryPhotos = [];

function renderEntryPhotoStrip() {
  const strip = document.getElementById("entryPhotoStrip");
  if (!strip) return;
  if (!pendingEntryPhotos.length) {
    strip.style.display = "none";
    strip.innerHTML = "";
    return;
  }
  strip.style.display = "";
  strip.innerHTML = "";
  pendingEntryPhotos.forEach((blob, idx) => {
    const thumb = document.createElement("div");
    thumb.className = "entry-photo-thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.src = URL.createObjectURL(blob);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Remove photo");
    btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-x"/></svg>`;
    btn.addEventListener("click", () => {
      pendingEntryPhotos.splice(idx, 1);
      renderEntryPhotoStrip();
    });
    thumb.appendChild(img);
    thumb.appendChild(btn);
    strip.appendChild(thumb);
  });
}

function initEntryPhotoInput() {
  const input = document.getElementById("entryPhotoInput");
  if (!input || input.dataset.wired) return;
  input.dataset.wired = "1";

  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const MAX_BYTES = 15 * 1024 * 1024;
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        alert(`"${file.name}" is too large (over 15MB). Skipping.`);
        continue;
      }
      try {
        const blob = await (window.DT_MEDIA?.resizeImageBlob?.(file, 1920, 1080, 0.85) ?? file);
        pendingEntryPhotos.push(blob);
      } catch (e) {
        console.warn("[Entry] photo resize", e);
        alert(`Couldn't process "${file.name}".`);
      }
    }
    input.value = "";
    renderEntryPhotoStrip();
  });
}
document.addEventListener("DOMContentLoaded", initEntryPhotoInput);

function resetEntryPhotoUI() {
  pendingEntryPhotos = [];
  const input = document.getElementById("entryPhotoInput");
  const strip = document.getElementById("entryPhotoStrip");
  if (input) input.value = "";
  if (strip) { strip.style.display = "none"; strip.innerHTML = ""; }
}

function saveRecord() {
  let serial = sanitizeSerial(document.getElementById("serial").value.trim().toUpperCase());
  if (!serial) {
    showToast("Please enter or scan a Serial ID.", "error");
    return;
  }
  const statusVal = document.getElementById("status").value;
  if (!statusVal) { showToast("Please select a status.", "error"); return; }

  const saveBtn = document.getElementById("saveBtn");
  const gpsEl = document.getElementById("gpsStatus");
  saveBtn.disabled = true;
  saveBtn.innerHTML = pendingEntryPhotos.length ? "Uploading photos..." : "Getting location...";
  gpsEl.className = "gps-status acquiring";
  gpsEl.textContent = "Acquiring GPS coordinates...";

  const allShifts = getAllShifts();
  const lastShift = allShifts.length > 0 ? allShifts[allShifts.length-1] : null;
  const lastTs = lastShift ? lastShift.records[lastShift.records.length-1].timestamp : null;
  const isNewShift = !lastTs || (Date.now() - lastTs >= SHIFT_GAP_MS);
  const currentShiftNum = isNewShift ? allShifts.length + 1 : allShifts.length || 1;

  const destVal = document.getElementById("destination").value;
  const statusOtherText = sanitizeNotes((document.getElementById("statusOther").value || "").trim()).slice(0, 40);
  const destOtherText = sanitizeNotes((document.getElementById("destinationOther").value || "").trim()).slice(0, 40);
  const mileageRaw = (document.getElementById("mileage")?.value || "").trim();
  const mileageVal = mileageRaw ? parseInt(mileageRaw, 10) : null;
  const fuelVal = (document.getElementById("fuelLevel")?.value || "").trim();
  // Use a UUID instead of a millisecond timestamp so two clients can't
  // generate the same id and collide on upsert (which then triggers an
  // UPDATE against a row owned by someone else, hitting the USING policy).
  const recordData = {
    id: (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2,10)}`),
    serialId: serial,
    status: statusVal,
    statusOther: statusVal === "OTHER" ? statusOtherText : "",
    tires: statusVal === "TI" ? [...selectedTires] : [],
    destination: destVal,
    destinationOther: destVal === "OTHER" ? destOtherText : "",
    conditions: selectedCxrConditions.length ? [...selectedCxrConditions] : [],
    noTag: document.getElementById("noTag").checked,
    shuttle: document.getElementById("shuttle").checked,
    transport: document.getElementById("transport").checked,
    shiftNum: currentShiftNum,
    notes: sanitizeNotes(document.getElementById("notes").value),
    mileage: Number.isFinite(mileageVal) && mileageVal >= 0 ? mileageVal : null,
    fuel_level: fuelVal || null,
    timestamp: Date.now()
  };
  // Fold the Body damage + Tires + Insurance claim collapsibles into
  // the record row. damage.js keeps this state in memory and clears it
  // via DT_DAMAGE.reset() after we finish saving.
  if (window.DT_DAMAGE?.getEntryState) {
    const s = DT_DAMAGE.getEntryState();
    recordData.damage_marks = s.damage_marks;
    recordData.tire_details = s.tire_details;
    recordData.claim_number = s.claim_number;
    recordData.claim_notes = s.claim_notes;
  }

  function doSave(lat, lng, gpsError) {
    if (lat !== null) { recordData.lat = lat; recordData.lng = lng; }
    if (gpsError) { recordData.gpsError = true; }
    const records = getRecords();
    records.unshift(recordData);
    setRecords(records);
    resetEntryPhotoUI();
    document.getElementById("serial").value = "";
    toggleClearBtn();
    updateVinCount();
    document.getElementById("notes").value = "";
    document.getElementById("status").selectedIndex = 0;
    resetTires();
    window.DT_DAMAGE?.reset?.();
    selectedCxrConditions = [];
    renderCxrConditions();
    clearEntryCurrentState();
    document.getElementById("destination").selectedIndex = 0;
    document.getElementById("statusOther").value = "";
    document.getElementById("statusOther").style.display = "none";
    document.getElementById("destinationOther").value = "";
    document.getElementById("destinationOther").style.display = "none";
    document.getElementById("noTag").checked = false;
    toggleNoTagStyle();
    document.getElementById("transport").checked = false;
    toggleTransportStyle();
    const mEl = document.getElementById("mileage"); if (mEl) mEl.value = "";
    const fEl = document.getElementById("fuelLevel"); if (fEl) fEl.selectedIndex = 0;
    const _mes = document.getElementById("manualEntrySection");
    if (_mes) { _mes.classList.add("u-hidden"); _mes.style.display = ""; }
    document.querySelector(".btn-manual-toggle").innerHTML = "Enter Manually";
    saveBtn.disabled = false;
    saveBtn.innerHTML = "Save";
    gpsEl.className = "gps-status";
    gpsEl.textContent = "";
    renderTodayEntries();
    // If the form was opened inline from a VIN history view, put it back and
    // refresh the timeline so the new entry shows immediately. The sync queue
    // normally debounces for ~600ms; flush it now so the timeline's Supabase
    // query actually sees the row we just saved.
    const inlineSlot = document.getElementById("vinTlEntrySlot");
    if (inlineSlot && inlineSlot.contains(document.getElementById("entryFormBody"))) {
      restoreInlineNewEntry();
      const refresh = () => { if (typeof renderVinTimeline === "function") renderVinTimeline(recordData.serialId); };
      const p = window.DT_SYNC?.flush?.();
      if (p && typeof p.then === "function") p.then(refresh, refresh);
      else refresh();
    }
    if (gpsError) { showToast("Saved - no GPS location", "warn"); }
    else { showToast("Saved with GPS", "success"); haptic("success"); }

    // Parking-section geotag: fire for any save with GPS so the section
    // name shows up on the card even when the driver leaves destination
    // blank ("let GPS figure it out"). The prompt "Where is this?" only
    // opens for genuine drop-off contexts — blank destination, or a
    // section that has a polygon on file — so a CHECK_OUT at an off-lot
    // rental spot doesn't pester the driver just because it's outside
    // every polygon. DT_DROPOFFS.isLotDestination reads the live
    // parking_sections cache, so newly-added polygons participate
    // automatically.
    if (
      window.DT_DROPOFFS &&
      !gpsError &&
      typeof lat === "number" &&
      typeof lng === "number"
    ) {
      DT_DROPOFFS.record({
        serial_id: recordData.serialId,
        lat, lng,
        record_id: recordData.id,
        promptIfUntagged: DT_DROPOFFS.isLotDestination(recordData.destination)
      });
    }

    // VIN decode runs AFTER record is saved so the lookup finds it
    // Decode whenever the serial looks like a real VIN. Bad Tag entries
    // are now tied to a real serial too (the flag just means the physical
    // tag is missing/damaged), so we let them decode like any other.
    if (isValidVIN(recordData.serialId)) {
      decodeVIN(recordData.serialId).then(vinData => {
        if (vinData) {
          const recs = getRecords();
          const rec = recs.find(r => r.id === recordData.id);
          if (rec) {
            rec.vinData = vinData;
            setRecords(recs);
            renderTodayEntries();
          }
        }
      });
    }
  }

  (async () => {
    if (pendingEntryPhotos.length) {
      const paths = [];
      for (const blob of pendingEntryPhotos) {
        try {
          const path = await window.DT_MEDIA.uploadPhoto(blob, serial);
          if (path) paths.push(path);
        } catch (e) {
          console.warn("[Entry] photo upload", e);
        }
      }
      if (paths.length) {
        recordData.photo_urls = paths;
      } else {
        showToast("Photo upload failed — saving without photos", "warn");
      }
      saveBtn.innerHTML = "Getting location...";
    }
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        async pos => {
          gpsEl.className = "gps-status got";
          gpsEl.textContent = "Location acquired";
          const lat = pos.coords.latitude, lng = pos.coords.longitude;
          // GPS/dropdown mismatch check: if the driver picked BACKLOT/QTA/GARAGE
          // but GPS lands in a different polygon, prompt before saving.
          if (window.DT_DROPOFFS?.checkConflictAndConfirm) {
            const proceed = await DT_DROPOFFS.checkConflictAndConfirm(recordData.destination, lat, lng);
            if (!proceed) {
              // Driver picked "Fix destination" — restore the Save button and bail.
              // They'll fix the dropdown and hit Save again.
              saveBtn.disabled = false;
              saveBtn.innerHTML = "Save";
              gpsEl.className = "gps-status";
              gpsEl.textContent = "";
              return;
            }
          }
          doSave(lat, lng, false);
        },
        err => { gpsEl.className = "gps-status err"; gpsEl.textContent = "Location unavailable - saving anyway"; saveBtn.innerHTML = "Saving..."; setTimeout(() => doSave(null, null, true), 800); },
        { timeout: 8000, maximumAge: 30000, enableHighAccuracy: true }
      );
    } else { doSave(null, null, true); }
  })();
}

// ============================
// SLIDE MENU
// ============================
function updateMenuGreeting() {
  const el = document.getElementById("menuGreeting");
  if (!el) return;
  const name = window.DT_AUTH?.getProfile?.()?.display_name || "";
  const h = new Date().getHours();
  let text;
  if (h >= 1 && h < 5) {
    text = name ? `GIT TO BED '${name.toUpperCase()}'!` : "GIT TO BED!";
  } else {
    let salutation;
    if (h >= 5 && h < 12) salutation = "Good morning";
    else if (h >= 12 && h < 17) salutation = "Good afternoon";
    else salutation = "Good evening";
    text = name ? `${salutation}, ${name}` : salutation;
  }
  el.textContent = text;
}
document.addEventListener("dt-auth-change", updateMenuGreeting);

function openMenu() {
  updateMenuGreeting();
  document.getElementById("slideMenu").classList.add("open");
  document.getElementById("menuOverlay").classList.add("open");
}
function closeMenu() {
  document.getElementById("slideMenu").classList.remove("open");
  document.getElementById("menuOverlay").classList.remove("open");
}

// ============================
// TABS
// ============================
function showTab(name) {
  // Detailers' "dashboard" tab routes to their detail-jobs dashboard instead
  // of the driver one, so the same nav element gives every role a useful view.
  const visualTab = name; // for the active-class lookup
  if (name === "dashboard" && window.DT_AUTH?.isDetailer?.()) name = "dashboard-detailer";
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.remove("active");
    if (t.hasAttribute("aria-selected")) t.setAttribute("aria-selected", "false");
  });
  document.getElementById("panel-" + name)?.classList.add("active");
  document.querySelectorAll(`.tab[data-tab="${visualTab}"]`).forEach(t => {
    t.classList.add("active");
    if (t.hasAttribute("aria-selected")) t.setAttribute("aria-selected", "true");
  });
  if (name === "entry") { restoreInlineNewEntry(); renderTodayEntries(); }
  if (name === "records") {
    // Search-driven view: don't auto-populate dates, don't render anything
    // until the user types. renderRecords() handles the empty-input state.
    renderRecords();
  }
  if (name === "dashboard") { applyProfile(); renderDashboard(); }
  if (name === "dashboard-detailer" && window.DT_DETAIL?.renderDashboard) {
    DT_DETAIL.renderDashboard();
  }
  if (name === "profile") applyProfile();
  if (name === "keyup") loadKeyUp();
  if (name === "garage") loadGarage();
  if (name === "bcounter") loadBcounter();
  if (name && name.startsWith("backlot-") && window.DT_BACKLOT) {
    DT_BACKLOT.refresh();
  }
  document.dispatchEvent(new CustomEvent("dt-tab-shown", { detail: name }));
}

// ============================
// SHIFT-CLOSE COUNTERS (Garage / Backlot / Key Up)
// ----------------------------
// Single factory shared by three panels. Data lives in localStorage under the
// panel's storageKey as { categories:[string], counts:{cat->number}, notes }.
// History under historyKey as [{ id, timestamp, trigger, categories, counts,
// notes, total }, ...] (newest first, capped at HISTORY_MAX).
// Uses shared helpers per CLAUDE.md: DT_ESC / DT_TOAST / DT_FORMAT.
// ============================
const HISTORY_MAX = 200;

function _counterLoadHistory(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch(e) { return []; }
}
function _counterSaveHistory(key, arr) {
  if (arr.length > HISTORY_MAX) arr = arr.slice(0, HISTORY_MAX);
  localStorage.setItem(key, JSON.stringify(arr));
}
function _counterFormatTs(ts) {
  const d = new Date(ts);
  return `${DT_FORMAT.date(d)}, ${DT_FORMAT.time(d)}`;
}

// Long-press repeater for +/- buttons. Pointer path: fires `onPress()`
// immediately on pointerdown, then every ~80ms after a HOLD_MS hold. The
// follow-up synthetic click on the same button is suppressed (per-button, so
// a gesture on button A never eats the next click on button B). Keyboard
// path: Enter/Space on a real <button> fires a click with no preceding
// pointerdown — that clicks through to a single bump.
//
// Bound EXACTLY ONCE per grid element via a flag — load() rebuilds the tile
// innerHTML on every render, but the parent grid persists, and re-attaching
// listeners each render would stack them and multiply every click.
function _attachLongPress(grid, onPress) {
  if (grid._dtLongPressBound) {
    // Update the closure's onPress ref so cache/state stays fresh across
    // re-renders (e.g. after Edit Categories rewrites the grid).
    grid._dtLongPressBound(onPress);
    return;
  }

  const HOLD_MS = 400;
  const REPEAT_MS = 80;
  const CLICK_SUPPRESS_MS = 400;
  let holdTimer = null;
  let repeatTimer = null;
  let currentBtn = null;
  // Suppression is per-button: a pointer gesture on button A must not eat the
  // next click on button B. Store the button we just handled and the deadline
  // until which its synthetic follow-up click is expected.
  let suppressBtn = null;
  let suppressUntil = 0;
  let handler = onPress;

  const armSuppress = (btn) => {
    suppressBtn = btn;
    suppressUntil = performance.now() + CLICK_SUPPRESS_MS;
  };
  const clear = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
    currentBtn = null;
  };

  grid.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    currentBtn = btn;
    handler(btn);
    armSuppress(btn);
    holdTimer = setTimeout(() => {
      repeatTimer = setInterval(() => {
        if (currentBtn) {
          handler(currentBtn);
          armSuppress(currentBtn);
        }
      }, REPEAT_MS);
    }, HOLD_MS);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach(evt => {
    grid.addEventListener(evt, clear);
  });

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    // Synthetic click from the pointer path we already handled — swallow it.
    if (btn === suppressBtn && performance.now() < suppressUntil) {
      suppressBtn = null;
      return;
    }
    handler(btn);
  });

  grid._dtLongPressBound = (newHandler) => { handler = newHandler; };
}

// Normalize legacy Key Up rows { clean, dirty, rail, other } -> new shape.
function _normalizeCounterEntry(e) {
  if (Array.isArray(e.categories) && e.counts) return e;
  const cats = DT_OPTIONS.COUNTER_DEFAULTS.keyup;
  const counts = {};
  cats.forEach(c => { counts[c] = e[c.toLowerCase()] || 0; });
  return { ...e, categories: cats.slice(), counts };
}

function createCounter(cfg) {
  const {
    storageKey, historyKey,
    gridId, notesId, totalId, historyId,
    shareTitle, defaultCats,
    editable = true,
    editorTitle = "Edit Categories"
  } = cfg;

  function loadData() {
    let data = {};
    try { data = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch(e) {}
    // Migrate legacy Key Up shape { clean, dirty, rail, other, notes }.
    if (!Array.isArray(data.categories) && (data.clean != null || data.dirty != null || data.rail != null || data.other != null)) {
      data = _normalizeCounterEntry(data);
    }
    if (!Array.isArray(data.categories) || data.categories.length === 0) {
      data.categories = defaultCats.slice();
    }
    if (!data.counts || typeof data.counts !== "object") data.counts = {};
    if (typeof data.notes !== "string") data.notes = "";
    return data;
  }

  function saveData(data) {
    localStorage.setItem(storageKey, JSON.stringify(data));
  }

  function totalOf(d) {
    return d.categories.reduce((sum, c) => sum + (d.counts[c] || 0), 0);
  }

  function updateTotal() {
    const el = document.getElementById(totalId);
    if (el) el.textContent = totalOf(loadData());
  }

  function bump(cat, delta) {
    const d = loadData();
    const cur = d.counts[cat] || 0;
    d.counts[cat] = Math.max(0, cur + delta);
    saveData(d);
    const inp = document.querySelector(`#${gridId} input[data-cat="${DT_ESC(cat)}"]`);
    if (inp) inp.value = d.counts[cat] || "";
    updateTotal();
    haptic("tap");
  }

  function load() {
    const data = loadData();
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = "";
    data.categories.forEach(cat => {
      const count = data.counts[cat] || 0;
      const tile = document.createElement("div");
      tile.className = "keyup-tile";
      tile.innerHTML = `
        <div class="keyup-label">${DT_ESC(cat)}</div>
        <div class="tally-controls">
          <button type="button" class="tally-btn" data-action="dec" data-cat="${DT_ESC(cat)}" aria-label="Decrease ${DT_ESC(cat)}">
            <svg class="tally-btn-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <input type="number" inputmode="numeric" min="0" value="${count || ""}" placeholder="0" data-cat="${DT_ESC(cat)}" aria-label="${DT_ESC(cat)} count">
          <button type="button" class="tally-btn" data-action="inc" data-cat="${DT_ESC(cat)}" aria-label="Increase ${DT_ESC(cat)}">
            <svg class="tally-btn-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>`;
      grid.appendChild(tile);
    });
    _attachLongPress(grid, (btn) => {
      bump(btn.dataset.cat, btn.dataset.action === "inc" ? 1 : -1);
    });
    grid.querySelectorAll("input[type='number']").forEach(inp => {
      inp.addEventListener("input", () => {
        const cat = inp.dataset.cat;
        const v = parseInt(inp.value, 10);
        const d = loadData();
        d.counts[cat] = Number.isFinite(v) && v >= 0 ? v : 0;
        saveData(d);
        updateTotal();
      });
    });
    const notesEl = document.getElementById(notesId);
    if (notesEl) notesEl.value = data.notes;
    updateTotal();
    renderHistory();
  }

  function saveNotes() {
    const notesEl = document.getElementById(notesId);
    if (!notesEl) return;
    const d = loadData();
    d.notes = (notesEl.value || "").slice(0, 1000);
    saveData(d);
  }

  function archive(trigger) {
    const d = loadData();
    const total = totalOf(d);
    if (total === 0 && !d.notes.trim()) return;
    const entry = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      trigger: trigger || "manual",
      categories: d.categories.slice(),
      counts: { ...d.counts },
      notes: d.notes,
      total
    };
    const hist = _counterLoadHistory(historyKey);
    hist.unshift(entry);
    _counterSaveHistory(historyKey, hist);
  }

  function reset() {
    if (!confirm(`Reset all ${shareTitle} counts and notes? (Current totals will be saved to History first.)`)) return;
    archive("reset");
    const d = loadData();
    d.counts = {};
    d.notes = "";
    saveData(d);
    load();
    DT_TOAST.show(`${shareTitle} reset (archived to History)`, "success");
  }

  function renderHistory() {
    const container = document.getElementById(historyId);
    if (!container) return;
    const hist = _counterLoadHistory(historyKey);
    if (hist.length === 0) {
      container.innerHTML = '<p class="u-empty-sm">No archived entries yet. Share or Reset to save a snapshot here.</p>';
      return;
    }
    container.innerHTML = hist.map(raw => {
      const e = _normalizeCounterEntry(raw);
      const rows = e.categories.map(c =>
        `<div class="history-line"><span>${DT_ESC(c)}</span><b>${e.counts[c] || 0}</b></div>`
      ).join("");
      const notes = e.notes && e.notes.trim()
        ? `<div class="history-notes">${DT_ESC(e.notes)}</div>` : "";
      return `
        <div class="history-entry">
          <div class="history-head">
            <div>
              <div class="history-date">${DT_ESC(_counterFormatTs(e.timestamp))}</div>
              <div class="history-trigger">${DT_ESC(e.trigger)}</div>
            </div>
            <div class="history-total">${e.total}</div>
          </div>
          <div class="history-body">${rows}</div>
          ${notes}
          <button class="history-del" data-history-del="${DT_ESC(e.id)}">Delete</button>
        </div>`;
    }).join("");
  }

  function buildMessage() {
    const d = loadData();
    const total = totalOf(d);
    const lines = [`${shareTitle} — ${DT_FORMAT.date(new Date())}`];
    d.categories.forEach(c => lines.push(`${c}: ${d.counts[c] || 0}`));
    lines.push(`Total: ${total}`);
    if (d.notes.trim()) lines.push("", `Notes: ${d.notes.trim()}`);
    return lines.join("\n");
  }

  // Persist the current snapshot to Supabase for the Backlot calendar.
  // Fire-and-forget; a network hiccup must not block the share flow.
  async function persistSnapshot() {
    if (!window.DT_AUTH?.client) return;
    const user = DT_AUTH.getUser?.();
    if (!user) return;
    const d = loadData();
    const total = totalOf(d);
    if (total === 0 && !d.notes.trim()) return;
    const section = cfg.section;
    const categories = d.categories.map(c => ({ name: c, count: d.counts[c] || 0 }));
    try {
      const { error } = await DT_AUTH.client.from("counter_snapshots").insert({
        section,
        categories,
        total,
        notes: d.notes.trim() || null,
        created_by: user.id
      });
      if (error) console.warn(`[counters] persist ${section} failed`, error);
    } catch (e) {
      console.warn(`[counters] persist ${section} threw`, e);
    }
  }

  async function share() {
    const text = buildMessage();
    archive("share");
    persistSnapshot();
    renderHistory();
    if (navigator.share) {
      try { await navigator.share({ title: shareTitle, text }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    const sms = "sms:?&body=" + encodeURIComponent(text);
    try { await navigator.clipboard.writeText(text); DT_TOAST.show("Copied — opening Messages", "success"); }
    catch(e) { DT_TOAST.show("Opening Messages", "success"); }
    window.location.href = sms;
  }

  function editCategories() {
    if (!editable) return;
    const d = loadData();
    openCategoryEditor({
      title: editorTitle,
      cats: d.categories.slice(),
      onSave: (newCats) => {
        const cur = loadData();
        const newCounts = {};
        newCats.forEach(c => { if (cur.counts[c] != null) newCounts[c] = cur.counts[c]; });
        cur.categories = newCats;
        cur.counts = newCounts;
        saveData(cur);
        load();
      }
    });
  }

  // History delete: single delegated listener per counter.
  function bindHistoryDelete() {
    const container = document.getElementById(historyId);
    if (!container || container._dtDelBound) return;
    container._dtDelBound = true;
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-history-del]");
      if (!btn) return;
      const id = btn.getAttribute("data-history-del");
      if (!confirm("Delete this archived entry?")) return;
      const arr = _counterLoadHistory(historyKey).filter(x => x.id !== id);
      _counterSaveHistory(historyKey, arr);
      renderHistory();
      DT_TOAST.show("Entry deleted", "success");
    });
  }
  // Bind once when DOM is ready; safe to call on every load() too.
  const originalLoad = load;
  function loadWithBind() { originalLoad(); bindHistoryDelete(); }

  return {
    load: loadWithBind,
    saveNotes,
    reset,
    share,
    editCategories,
    renderHistory,
    buildMessage
  };
}

// ---------- Shared category-editor modal ----------
function openCategoryEditor({ title, cats, onSave }) {
  const modal = document.getElementById("counterCatModal");
  if (!modal) return;
  const titleEl = document.getElementById("counterCatTitle");
  const listEl = document.getElementById("counterCatList");
  const msgEl = document.getElementById("counterCatMsg");
  const addBtn = document.getElementById("counterCatAdd");
  const saveBtn = document.getElementById("counterCatSave");
  const cancelBtn = document.getElementById("counterCatCancel");
  const closeBtn = document.getElementById("counterCatClose");

  titleEl.textContent = title;
  DT_UI.setMessage(msgEl, "");

  function renderRows(items) {
    listEl.innerHTML = "";
    items.forEach((cat, idx) => {
      const row = document.createElement("div");
      row.className = "cat-editor-row";
      row.innerHTML = `
        <input type="text" maxlength="24" value="${DT_ESC(cat)}" aria-label="Category ${idx + 1}">
        <button type="button" class="btn btn-ghost btn-icon" data-move="up" aria-label="Move up">&uarr;</button>
        <button type="button" class="btn btn-ghost btn-icon" data-move="down" aria-label="Move down">&darr;</button>
        <button type="button" class="btn btn-destructive btn-icon" data-remove aria-label="Remove">&times;</button>`;
      listEl.appendChild(row);
    });
  }

  function readRows() {
    return Array.from(listEl.querySelectorAll("input")).map(i => i.value.trim()).filter(Boolean);
  }

  renderRows(cats);

  function onListClick(e) {
    const row = e.target.closest(".cat-editor-row");
    if (!row) return;
    if (e.target.closest("[data-remove]")) {
      row.remove();
      return;
    }
    const moveBtn = e.target.closest("[data-move]");
    if (!moveBtn) return;
    const dir = moveBtn.getAttribute("data-move");
    const sibling = dir === "up" ? row.previousElementSibling : row.nextElementSibling;
    if (sibling) {
      if (dir === "up") listEl.insertBefore(row, sibling);
      else listEl.insertBefore(sibling, row);
    }
  }

  function onAdd() {
    const items = readRows();
    items.push("");
    renderRows(items);
    const inputs = listEl.querySelectorAll("input");
    inputs[inputs.length - 1]?.focus();
  }

  function onSaveClick() {
    const items = readRows();
    if (items.length === 0) {
      DT_UI.setMessage(msgEl, "Need at least one category.", "err");
      return;
    }
    const seen = new Set();
    for (const c of items) {
      const k = c.toLowerCase();
      if (seen.has(k)) {
        DT_UI.setMessage(msgEl, `Duplicate category: ${c}`, "err");
        return;
      }
      seen.add(k);
    }
    close();
    onSave(items);
  }

  function close() {
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    listEl.removeEventListener("click", onListClick);
    addBtn.removeEventListener("click", onAdd);
    saveBtn.removeEventListener("click", onSaveClick);
    cancelBtn.removeEventListener("click", close);
    closeBtn.removeEventListener("click", close);
  }

  listEl.addEventListener("click", onListClick);
  addBtn.addEventListener("click", onAdd);
  saveBtn.addEventListener("click", onSaveClick);
  cancelBtn.addEventListener("click", close);
  closeBtn.addEventListener("click", close);

  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
  const firstInput = listEl.querySelector("input");
  if (firstInput) firstInput.focus();
}

// ---------- Instances ----------
const DT_COUNTERS = {
  garage: createCounter({
    section: "garage",
    storageKey: "drivertrax_garage",
    historyKey: "drivertrax_garage_history",
    gridId: "garageGrid",
    notesId: "garageNotes",
    totalId: "garageTotal",
    historyId: "garageHistory",
    shareTitle: "Garage Count",
    defaultCats: DT_OPTIONS.COUNTER_DEFAULTS.garage,
    editable: true,
    editorTitle: "Edit Garage Categories"
  }),
  bcounter: createCounter({
    section: "bcounter",
    storageKey: "drivertrax_bcounter",
    historyKey: "drivertrax_bcounter_history",
    gridId: "bcounterGrid",
    notesId: "bcounterNotes",
    totalId: "bcounterTotal",
    historyId: "bcounterHistory",
    shareTitle: "Backlot Count",
    defaultCats: DT_OPTIONS.COUNTER_DEFAULTS.bcounter,
    editable: true,
    editorTitle: "Edit Backlot Categories"
  }),
  keyup: createCounter({
    section: "keyup",
    storageKey: "drivertrax_keyup",
    historyKey: "drivertrax_keyup_history",
    gridId: "keyupGrid",
    notesId: "keyupNotes",
    totalId: "keyupTotal",
    historyId: "keyupHistory",
    shareTitle: "Key Up",
    defaultCats: DT_OPTIONS.COUNTER_DEFAULTS.keyup,
    editable: true,
    editorTitle: "Edit Key Up Categories"
  })
};
window.DT_COUNTERS = DT_COUNTERS;

// Global wrappers so existing HTML onclick handlers keep working.
window.loadGarage    = () => DT_COUNTERS.garage.load();
window.saveGarage    = () => DT_COUNTERS.garage.saveNotes();
window.resetGarage   = () => DT_COUNTERS.garage.reset();
window.shareGarage   = () => DT_COUNTERS.garage.share();
window.editGarageCategories = () => DT_COUNTERS.garage.editCategories();

window.loadBcounter    = () => DT_COUNTERS.bcounter.load();
window.saveBcounter    = () => DT_COUNTERS.bcounter.saveNotes();
window.resetBcounter   = () => DT_COUNTERS.bcounter.reset();
window.shareBcounter   = () => DT_COUNTERS.bcounter.share();
window.editBcounterCategories = () => DT_COUNTERS.bcounter.editCategories();

window.loadKeyUp    = () => DT_COUNTERS.keyup.load();
window.saveKeyUp    = () => DT_COUNTERS.keyup.saveNotes();
window.resetKeyUp   = () => DT_COUNTERS.keyup.reset();
window.shareKeyUp   = () => DT_COUNTERS.keyup.share();
window.editKeyUpCategories = () => DT_COUNTERS.keyup.editCategories();

// ============================
// TIRE SELECTOR
// ============================
let selectedTires = [];
let selectedCxrConditions = [];

// Shared condition vocabulary. Pulls from DT_OPTIONS so the entry form,
// detailer form, and any future surface stay aligned.
const ENTRY_CONDITIONS = DT_OPTIONS.CONDITIONS;

function handleStatusChange() {
  // The Body damage + Tires collapsibles live inline in the entry form
  // and are always available regardless of status — nothing status-
  // specific to do here anymore.
  toggleOtherField("status");
}

function renderCxrConditions() {
  const el = document.getElementById("cxrConditions");
  if (!el) return;
  const esc = (s) => sanitizeText(s);
  el.innerHTML = ENTRY_CONDITIONS.map(c => `
    <label class="cond-chip ${selectedCxrConditions.includes(c.id) ? "checked" : ""}">
      <input type="checkbox" value="${c.id}" ${selectedCxrConditions.includes(c.id) ? "checked" : ""}>
      <span>${esc(c.label)}</span>
    </label>
  `).join("");
  el.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("change", () => {
      if (inp.checked) {
        if (!selectedCxrConditions.includes(inp.value)) selectedCxrConditions.push(inp.value);
      } else {
        selectedCxrConditions = selectedCxrConditions.filter(c => c !== inp.value);
      }
      inp.closest(".cond-chip").classList.toggle("checked", inp.checked);
    });
  });
}
// Render the chip row once on load so they're visible regardless of status.
document.addEventListener("DOMContentLoaded", renderCxrConditions);

// Per-user persistence for the collapsible Options / Conditions sections in
// the New Entry form. Default closed; each signed-in user's preference is
// keyed by their auth id so it survives across sessions but doesn't leak
// between accounts on a shared device.
function entryCollapseStorageKey() {
  const uid = window.DT_AUTH?.getUser?.()?.id || "anon";
  return `dt-entry-collapse:${uid}`;
}
function loadEntryCollapseState() {
  try { return JSON.parse(localStorage.getItem(entryCollapseStorageKey()) || "{}") || {}; }
  catch { return {}; }
}
function saveEntryCollapseState(state) {
  try { localStorage.setItem(entryCollapseStorageKey(), JSON.stringify(state)); } catch {}
}
function applyEntryCollapseState() {
  const state = loadEntryCollapseState();
  document.querySelectorAll(".entry-collapse[data-collapse-key]").forEach(el => {
    const key = el.dataset.collapseKey;
    el.open = !!state[key];
    if (el._collapseWired) return;
    el._collapseWired = true;
    el.addEventListener("toggle", () => {
      const cur = loadEntryCollapseState();
      cur[key] = el.open;
      saveEntryCollapseState(cur);
    });
  });
}
document.addEventListener("DOMContentLoaded", applyEntryCollapseState);
document.addEventListener("dt-auth-change", applyEntryCollapseState);

// Privileged status options (CHECK_IN, CHECK_OUT, HOLD, DNR) are CXR /
// manager / admin only. `display:none` on <option> is unreliable across
// browsers, so we add/remove the nodes from the DOM as role changes.
function gateCxrStatusOption() {
  const sel = document.getElementById("status");
  if (!sel) return;
  const allowed = !!(window.DT_AUTH && (DT_AUTH.isCxr?.() || DT_AUTH.isManager?.() || DT_AUTH.isAdmin?.()));
  DT_OPTIONS.STATUS_PRIVILEGED.forEach(code => {
    let opt = sel.querySelector(`option[value="${code}"]`);
    if (allowed) {
      if (!opt) {
        opt = document.createElement("option");
        opt.value = code;
        opt.textContent = statusLabel(code);
        opt.className = "opt-cxr-only";
      }
      if (!opt.isConnected) {
        const otherOpt = sel.querySelector('option[value="OTHER"]');
        sel.insertBefore(opt, otherOpt || null);
      }
    } else if (opt && opt.isConnected) {
      opt.remove();
    }
  });
}
document.addEventListener("dt-auth-change", gateCxrStatusOption);
document.addEventListener("DOMContentLoaded", gateCxrStatusOption);

// ============================================================
// Data-driven Location dropdown
//
// Both the entry form's #destination select and the records filter's
// #fDest select used to be hard-coded (GARAGE/QTA/BACKLOT/ATLANTIC/
// BRANCH/OTHER). Now they're populated from the parking_sections table
// via DT_DROPOFFS.getSections(). "OTHER" is always appended at the end
// as a freeform escape hatch (backed by the existing #destinationOther
// text input; not a parking_sections row).
//
// Called on DOMContentLoaded (initial paint) and on the custom
// `dt-sections-change` event (fires when a manager adds a location via
// the Locations panel — see refreshSections in drop-offs.js).
// ============================================================
async function populateDestinationSelects() {
  if (!window.DT_DROPOFFS) return;
  let sections;
  try {
    sections = await DT_DROPOFFS.getSections();
  } catch (e) {
    console.warn("[destination] getSections", e);
    return;
  }

  // De-dupe by uppercased name so a legacy row and a new admin add can't
  // both show up. Preserve the DB order (name-ascending from the view).
  const seen = new Set();
  const names = [];
  (sections || []).forEach(s => {
    const key = String(s.name || "").trim().toUpperCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    names.push(key);
  });

  const renderInto = (sel, placeholderText) => {
    if (!sel) return;
    const prevValue = sel.value;
    // Rebuild all options except the leading placeholder — that <option
    // value=""> is what the entry form and filter show when nothing's
    // picked. Keep whatever placeholder text HTML already has.
    const placeholder = sel.querySelector('option[value=""]');
    sel.innerHTML = "";
    if (placeholder) {
      sel.appendChild(placeholder);
    } else if (placeholderText) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = placeholderText;
      sel.appendChild(opt);
    }
    names.forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    // Always append OTHER last as a freeform escape hatch — it's not a
    // parking_sections row, and its handling (#destinationOther text
    // input) is wired independently in toggleOtherField().
    if (!seen.has("OTHER")) {
      const other = document.createElement("option");
      other.value = "OTHER";
      other.textContent = "OTHER";
      sel.appendChild(other);
    }
    // Restore prior selection if it still exists after the rebuild.
    if (prevValue && sel.querySelector(`option[value="${CSS.escape(prevValue)}"]`)) {
      sel.value = prevValue;
    }
  };

  renderInto(document.getElementById("destination"), "-- LOCATION --");
  renderInto(document.getElementById("fDest"),       "All Locations");
}
document.addEventListener("DOMContentLoaded", populateDestinationSelects);
document.addEventListener("dt-sections-change", populateDestinationSelects);
window.populateDestinationSelects = populateDestinationSelects;

// Damage set (per-vehicle damage on-file flag) — re-render record surfaces
// so the DAMAGE badge appears/disappears when marks are added/removed
// remotely. damage.js loads and subscribes to the set once per session.
document.addEventListener("dt-damage-set-changed", () => {
  try { if (typeof renderRecords === "function") renderRecords(); } catch (e) { console.warn(e); }
  try { if (typeof renderTodayEntries === "function") renderTodayEntries(); } catch (e) { console.warn(e); }
});

// Generic: when a <select id="X"> is set to "OTHER", show <input id="XOther">
function toggleOtherField(selectId) {
  const sel = document.getElementById(selectId);
  const inp = document.getElementById(selectId + "Other");
  if (!sel || !inp) return;
  const isOther = (sel.value || "").toUpperCase() === "OTHER";
  inp.style.display = isOther ? "block" : "none";
  if (!isOther) inp.value = "";
  else setTimeout(() => inp.focus(), 50);
}

function toggleTire(tire) {
  const btn = document.getElementById("tire-" + tire);
  const idx = selectedTires.indexOf(tire);
  if (idx === -1) {
    selectedTires.push(tire);
    btn.classList.add("selected");
  } else {
    selectedTires.splice(idx, 1);
    btn.classList.remove("selected");
  }
  updateTireLabel();
}

function updateTireLabel() {
  const label = document.getElementById("tireSelectedLabel");
  if (selectedTires.length === 0) {
    label.textContent = "No tires selected";
    label.className = "tire-selected-label";
  } else {
    const order = ["FL","FR","RL","RR"];
    const sorted = order.filter(t => selectedTires.includes(t));
    label.textContent = "Affected: " + sorted.join(", ");
    label.className = "tire-selected-label has-selection";
  }
}

function resetTires() {
  selectedTires = [];
  ["FL","FR","RL","RR"].forEach(t => {
    const btn = document.getElementById("tire-" + t);
    if (btn) btn.classList.remove("selected");
  });
  const label = document.getElementById("tireSelectedLabel");
  if (label) {
    label.textContent = "No tires selected";
    label.className = "tire-selected-label";
  }
}
function toggleManualEntry() {
  const section = document.getElementById("manualEntrySection");
  const btn = document.querySelector(".btn-manual-toggle");
  if (!section || !btn) return;
  const willShow = section.classList.contains("u-hidden");
  section.classList.toggle("u-hidden", !willShow);
  section.style.display = "";
  btn.innerHTML = willShow ? "Hide Manual Entry" : "Enter Manually";
  if (willShow) document.getElementById("serial")?.focus();
}

function showManualEntry() {
  const section = document.getElementById("manualEntrySection");
  const btn = document.querySelector(".btn-manual-toggle");
  if (!section || !btn) return;
  section.classList.remove("u-hidden");
  section.style.display = "";
  btn.innerHTML = "Hide Manual Entry";
}

function clearSerial() {
  const input = document.getElementById("serial");
  input.value = "";
  toggleClearBtn();
  updateVinCount();
  input.focus();
}

function clearEditSerial() {
  const input = document.getElementById("editSerial");
  input.value = "";
  toggleEditClearBtn();
  updateEditVinCount();
  input.focus();
}

function toggleClearBtn() {
  const input = document.getElementById("serial");
  const btn = document.getElementById("serialClearBtn");
  if (btn) btn.style.display = input.value.length > 0 ? "flex" : "none";
}

function toggleEditClearBtn() {
  const input = document.getElementById("editSerial");
  const btn = document.getElementById("editSerialClearBtn");
  if (btn) btn.style.display = input.value.length > 0 ? "flex" : "none";
}

// ============================
// VIN KEYPAD
// ============================
const VIN_KEYS = [
  '1','2','3','4','5',
  '6','7','8','9','0',
  'A','B','C','D','E',
  'F','G','H','J','K',
  'L','M','N','P','R',
  'S','T','U','V','W',
  'X','Y','Z'
];

// Tracks which input the keypad is currently typing into
let _vinKeypadTargetId = "serial";

// Tracks cursor position within the input value (insertion point)
// -1 means "end of string"
let _vinKeypadCursor = -1;

function buildVinKeypad() {
  const grid = document.getElementById("vinKeypadGrid");
  if (!grid) return;
  if (grid.dataset.built === "1") return;

  // Build key HTML using grid auto-flow. The "0" key is explicitly placed in
  // col 4 spanning rows 1-3 (a tall key next to 1-9). Layout:
  //   1  2  3  [0 span 3 rows]
  //   4  5  6  [0]
  //   7  8  9  [0]
  //   A  B  C   D
  //   E  F  G   H
  //   J  K  L   M
  //   N  P  R   S
  //   T  U  V   W
  //   X  Y  Z   DELETE
  //   [        DONE span 4        ]
  const keyBtn = (k) => {
    const typeClass = /[0-9]/.test(k) ? "vin-key-num" : "vin-key-alpha";
    const tallClass = k === "0" ? " vin-key-zero-tall" : "";
    return `<button class="vin-key ${typeClass}${tallClass}" type="button" onclick="vinKeypadType('${k}')">${k}</button>`;
  };

  let html = "";
  // 0 placed first with explicit grid coords; auto-flow skips its cells.
  html += keyBtn("0");
  // Digits 1-9 fill cols 1-3 of rows 1-3
  for (let i = 1; i <= 9; i++) html += keyBtn(String(i));
  // Letters A-W fill rows 4-8 (20 letters)
  ["A","B","C","D","E","F","G","H","J","K","L","M","N","P","R","S","T","U","V","W"].forEach(k => { html += keyBtn(k); });
  // Row 9: X Y Z + DELETE
  html += keyBtn("X") + keyBtn("Y") + keyBtn("Z");
  html += `<button class="vin-key vin-key-delete" type="button" onclick="vinKeypadBackspace()" aria-label="Delete">`
       +  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H8l-7 7 7 7h13a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>`
       +  `DEL</button>`;
  // Row 10: DONE (spans full row)
  html += `<button class="vin-key vin-key-done" type="button" onclick="closeVinKeypad()">DONE</button>`;
  grid.innerHTML = html;
  grid.dataset.built = "1";
}

function openVinKeypad(targetId) {
  _vinKeypadTargetId = targetId || "serial";
  buildVinKeypad();
  const overlay = document.getElementById("vinKeypadOverlay");
  if (!overlay) return;
  overlay.classList.add("open");

  // Start with cursor at end of existing value
  const input = document.getElementById(_vinKeypadTargetId);
  _vinKeypadCursor = input ? input.value.length : 0;

  syncKeypadDisplay();
  if (input) input.blur();

  // Focus the hidden HID-capture input so external Bluetooth/USB barcode
  // scanners can deliver keystrokes. iOS Safari does not fire keydown
  // events for HID input when a readonly field is focused, so we park
  // focus on a hidden non-readonly input instead. inputmode="none" keeps
  // the on-screen keyboard from appearing.
  if (typeof focusHidScannerInput === "function") focusHidScannerInput();
}

function closeVinKeypad(event) {
  if (event && event.target && event.target.id !== "vinKeypadOverlay") {
    if (event.currentTarget && event.target !== event.currentTarget) return;
  }
  document.getElementById("vinKeypadOverlay").classList.remove("open");
  // Programmatic writes (the keypad mutates input.value directly) don't fire
  // 'input' events, so dispatch a custom one so other modules can react.
  const input = document.getElementById(_vinKeypadTargetId);
  if (input && input.value) {
    document.dispatchEvent(new CustomEvent("dt-vin-scanned", { detail: input.value }));
  }
}

function vinKeypadType(ch) {
  const input = document.getElementById(_vinKeypadTargetId);
  if (!input) return;
  if (input.value.length >= 30) return;

  const pos = _vinKeypadCursor;
  const before = input.value.slice(0, pos);
  const after = input.value.slice(pos);
  input.value = (before + ch + after).toUpperCase();
  _vinKeypadCursor = pos + 1;

  syncKeypadDisplay();
  if (_vinKeypadTargetId === "serial") { toggleClearBtn(); updateVinCount(); }
  else { toggleEditClearBtn(); updateEditVinCount(); }
  if (navigator.vibrate) navigator.vibrate(8);
}

function vinKeypadClear() {
  const input = document.getElementById(_vinKeypadTargetId);
  if (!input) return;
  if (!input.value) return;
  input.value = "";
  _vinKeypadCursor = 0;
  syncKeypadDisplay();
  if (_vinKeypadTargetId === "serial") { toggleClearBtn(); updateVinCount(); }
  else { toggleEditClearBtn(); updateEditVinCount(); }
  if (navigator.vibrate) navigator.vibrate(15);
}

function vinKeypadBackspace() {
  const input = document.getElementById(_vinKeypadTargetId);
  if (!input) return;
  if (_vinKeypadCursor <= 0) return; // nothing to delete

  const pos = _vinKeypadCursor;
  const before = input.value.slice(0, pos - 1);
  const after = input.value.slice(pos);
  input.value = before + after;
  _vinKeypadCursor = pos - 1;

  syncKeypadDisplay();
  if (_vinKeypadTargetId === "serial") { toggleClearBtn(); updateVinCount(); }
  else { toggleEditClearBtn(); updateEditVinCount(); }
  if (navigator.vibrate) navigator.vibrate(8);
}

function vinKeypadArrow(direction) {
  const input = document.getElementById(_vinKeypadTargetId);
  if (!input) return;
  const len = input.value.length;
  _vinKeypadCursor = Math.max(0, Math.min(len, _vinKeypadCursor + direction));
  syncKeypadDisplay();
  if (navigator.vibrate) navigator.vibrate(5);
}

function vinKeypadCopy() {
  const input = document.getElementById(_vinKeypadTargetId);
  if (!input || !input.value) return;
  const val = input.value;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(val)
      .then(() => showToast("Copied to clipboard", "success"))
      .catch(() => showToast("Copy failed", "error"));
  } else {
    showToast("Clipboard not available on this browser", "warn");
  }
  if (navigator.vibrate) navigator.vibrate(8);
}

function vinKeypadPaste() {
  const input = document.getElementById(_vinKeypadTargetId);
  if (!input) return;

  // Use the Clipboard API where available
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(text => {
      applyPastedVin(text);
    }).catch(() => {
      showToast("Couldn't access clipboard - try long-pressing the input", "warn");
    });
  } else {
    showToast("Clipboard not available on this browser", "warn");
  }
}

function applyPastedVin(text) {
  const input = document.getElementById(_vinKeypadTargetId);
  if (!input) return;

  // Filter to only valid VIN chars (uppercase letters except I/O/Q + digits)
  // and truncate at 30 chars (input maxlength)
  const cleaned = text
    .toUpperCase()
    .replace(/[^A-HJ-NPR-Z0-9]/g, "")
    .slice(0, 30);

  if (!cleaned) {
    showToast("Clipboard had no valid VIN characters", "warn");
    return;
  }

  input.value = cleaned;
  _vinKeypadCursor = cleaned.length; // cursor at end after paste
  syncKeypadDisplay();
  if (_vinKeypadTargetId === "serial") { toggleClearBtn(); updateVinCount(); }
  else { toggleEditClearBtn(); updateEditVinCount(); }
  if (navigator.vibrate) navigator.vibrate(8);

  if (cleaned.length === 17) {
    showToast("Pasted VIN", "success");
  } else if (cleaned.length < text.length) {
    showToast(`Pasted ${cleaned.length} chars (invalid chars removed)`, "warn");
  } else {
    showToast(`Pasted ${cleaned.length} characters`, "success");
  }
}

function syncKeypadDisplay() {
  const input = document.getElementById(_vinKeypadTargetId);
  const display = document.getElementById("vinKeypadDisplay");
  const count = document.getElementById("vinKeypadCount");
  if (!input) return;

  if (display) {
    const val = input.value;
    if (val.length === 0) {
      display.innerHTML = '<span class="vin-cursor">|</span>';
    } else {
      const pos = Math.max(0, Math.min(val.length, _vinKeypadCursor));
      const before = val.slice(0, pos);
      const after = val.slice(pos);
      display.innerHTML =
        escapeHtml(before) +
        '<span class="vin-cursor">|</span>' +
        escapeHtml(after);
    }
  }
  if (count) {
    const len = input.value.length;
    count.textContent = `${len} / 17`;
    count.classList.toggle("valid", len === 17);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================
// BLUETOOTH / USB HID BARCODE SCANNER
// ============================
// External barcode scanners (Bluetooth or USB) present as HID keyboards:
// they "type" the barcode at very high speed and end with Enter. Our
// Serial ID inputs are readonly (they open a custom on-screen keypad on
// focus), and iOS Safari silently swallows HID keystrokes when a readonly
// input is focused. To work around this we:
//   1. Create a hidden, NON-readonly input parked off-screen.
//   2. Park focus on it whenever the VIN keypad or edit panel is open.
//   3. Listen for `input` events on it (iOS DOES fire input events here)
//      AND a global `keydown` listener (covers desktop/Android too).
//   4. Route the captured value into the active serial target.
//
// inputmode="none" prevents iOS from showing its on-screen keyboard while
// the hidden input is focused; HID keystrokes still arrive normally.
let hidScannerInput = null;
function focusHidScannerInput() {
  if (!hidScannerInput) return;
  try {
    hidScannerInput.value = "";
    // Defer to after the current tap/focus cycle so iOS accepts the focus shift.
    setTimeout(() => {
      try { hidScannerInput.focus({ preventScroll: true }); } catch(e) {
        try { hidScannerInput.focus(); } catch(_) {}
      }
    }, 0);
  } catch(e) {}
}

(function () {
  const MAX_GAP_MS = 80;     // gap between scanner keys; humans type much slower
  const FLUSH_DELAY_MS = 120;
  const MIN_SCAN_LEN = 3;

  function activeTargetId() {
    const kp = document.getElementById("vinKeypadOverlay");
    if (kp && kp.classList.contains("open")) return _vinKeypadTargetId;
    const edit = document.getElementById("editOverlay");
    if (edit && edit.classList.contains("open")) return "editSerial";
    return "serial";
  }

  function shouldCaptureNow() {
    const kp = document.getElementById("vinKeypadOverlay");
    if (kp && kp.classList.contains("open")) return true;
    const edit = document.getElementById("editOverlay");
    if (edit && edit.classList.contains("open")) return true;
    // Also capture when the entry panel is visible and no real text input is focused
    const el = document.activeElement;
    if (!el || el === document.body || el === hidScannerInput) return true;
    if (el.tagName === "INPUT" && el.readOnly) return true;
    return false;
  }

  function applyToTarget(rawValue) {
    const cleaned = sanitizeSerial((rawValue || "").toUpperCase());
    if (!cleaned || cleaned.length < MIN_SCAN_LEN) return;

    const targetId = activeTargetId();
    const input = document.getElementById(targetId);
    if (!input) return;
    input.value = cleaned;

    if (targetId === "serial") {
      if (typeof toggleClearBtn === "function") toggleClearBtn();
      if (typeof updateVinCount === "function") updateVinCount();
      if (typeof showManualEntry === "function") showManualEntry();
    } else if (targetId === "editSerial") {
      if (typeof toggleEditClearBtn === "function") toggleEditClearBtn();
      if (typeof updateEditVinCount === "function") updateEditVinCount();
    }

    const kp = document.getElementById("vinKeypadOverlay");
    if (kp && kp.classList.contains("open")) {
      _vinKeypadCursor = cleaned.length;
      if (typeof syncKeypadDisplay === "function") syncKeypadDisplay();
    }

    if (navigator.vibrate) navigator.vibrate(20);
    if (typeof showToast === "function") showToast(`Scanned ${cleaned}`, "success");
  }

  // ---- Hidden capture input (iOS-friendly path) ----
  function createHidScannerInput() {
    if (hidScannerInput) return;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.id = "hidScannerInput";
    inp.setAttribute("inputmode", "none");
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("autocorrect", "off");
    inp.setAttribute("autocapitalize", "off");
    inp.setAttribute("spellcheck", "false");
    inp.setAttribute("aria-hidden", "true");
    inp.tabIndex = -1;
    inp.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;" +
      "pointer-events:none;border:0;padding:0;margin:0;background:transparent;" +
      "color:transparent;caret-color:transparent;font-size:16px;z-index:-1;";
    document.body.appendChild(inp);
    hidScannerInput = inp;

    let flushTimer = null;
    function flushFromHidden() {
      clearTimeout(flushTimer);
      flushTimer = null;
      const v = hidScannerInput.value;
      hidScannerInput.value = "";
      applyToTarget(v);
    }

    // Most scanners terminate with Enter — flush on Enter immediately
    hidScannerInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        flushFromHidden();
      }
    });

    // Fallback: if no Enter terminator, flush after a short idle window
    hidScannerInput.addEventListener("input", function () {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushFromHidden, FLUSH_DELAY_MS);
    });

    // If something else steals focus while we still need it, take it back
    hidScannerInput.addEventListener("blur", function () {
      setTimeout(() => {
        if (shouldCaptureNow() && document.activeElement !== hidScannerInput) {
          try { hidScannerInput.focus({ preventScroll: true }); } catch(e) {}
        }
      }, 50);
    });
  }

  if (document.body) createHidScannerInput();
  else document.addEventListener("DOMContentLoaded", createHidScannerInput);

  // ---- Document-level keydown fallback (desktop / Android) ----
  let buf = "";
  let firstAt = 0;
  let lastAt = 0;
  let docFlushTimer = null;

  function docFlush() {
    clearTimeout(docFlushTimer);
    docFlushTimer = null;
    const raw = buf;
    const span = lastAt - firstAt;
    buf = "";
    if (raw.length < MIN_SCAN_LEN) return;
    if (raw.length > 1 && span / (raw.length - 1) > MAX_GAP_MS) return;
    applyToTarget(raw);
  }

  document.addEventListener("keydown", function (e) {
    // Skip when the user is actively typing in a normal editable input
    const el = document.activeElement;
    if (el && el !== hidScannerInput && el.tagName === "INPUT" && !el.readOnly && !el.disabled) {
      const t = (el.type || "text").toLowerCase();
      if (["text","search","email","url","tel","password","number"].includes(t)) return;
    }
    if (el && el !== hidScannerInput && (el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const now = performance.now();
    const gap = now - lastAt;

    if (e.key === "Enter") {
      if (buf.length >= MIN_SCAN_LEN) {
        e.preventDefault();
        docFlush();
      }
      return;
    }
    if (e.key.length !== 1) return;
    if (buf.length > 0 && gap > MAX_GAP_MS) buf = "";
    if (buf.length === 0) firstAt = now;
    buf += e.key;
    lastAt = now;
    clearTimeout(docFlushTimer);
    docFlushTimer = setTimeout(docFlush, FLUSH_DELAY_MS);
  }, true);
})();

function updateVinCount() {
  const input = document.getElementById("serial");
  const c = document.getElementById("vinCharCount");
  if (!c || !input) return;
  const len = input.value.length;
  c.textContent = `${len} / 17`;
  c.classList.toggle("valid", len === 17);
}

function updateEditVinCount() {
  const input = document.getElementById("editSerial");
  const c = document.getElementById("editVinCharCount");
  if (!c || !input) return;
  const len = input.value.length;
  c.textContent = `${len} / 17`;
  c.classList.toggle("valid", len === 17);
}
function toggleNoTagStyle() {
  const checked = document.getElementById("noTag").checked;
  document.getElementById("noTagRow").classList.toggle("checked", checked);
}

const SHUTTLE_KEY = "drivertrax_shuttle";
const TRANSPORT_KEY = "drivertrax_transport";

function toggleShuttleStyle() {
  const checked = document.getElementById("shuttle").checked;
  document.getElementById("shuttleRow").classList.toggle("shuttle-checked", checked);
  localStorage.setItem(SHUTTLE_KEY, checked ? "1" : "0");
}

function toggleTransportStyle() {
  const checked = document.getElementById("transport").checked;
  document.getElementById("transportRow").classList.toggle("transport-checked", checked);
  localStorage.setItem(TRANSPORT_KEY, checked ? "1" : "0");
}

// ============================
// RECORD CARD HTML (shared)
// ============================
// ============================
// VEHICLE SVG ICONS - silhouettes with negative space
// ============================
function getVehicleSVG(vinData) {
  if (!vinData) return { vehicle: "", fuel: "" };
  const body = (vinData.bodyClass || "").toLowerCase();
  const fuel = (vinData.fuelType || "").toLowerCase();
  // _size is the icon's rendered WIDTH. Height scales from the viewBox so every
  // body type occupies the same horizontal footprint (consistent across pickups,
  // SUVs, sedans, etc.).
  const size = vinData._size || 40;
  const c = "var(--accent)";
  const uid = "v" + Math.random().toString(36).slice(2,7);

  const isElectric = fuel.includes("electric") && !fuel.includes("hybrid");
  const isHybrid = fuel.includes("hybrid") || (fuel.includes("electric") && fuel.includes("gasoline"));

  // Small fuel icon shown separately next to vehicle
  let fuelIcon = "";
  if (isElectric) {
    fuelIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="u-flex-shrink-0" viewBox="0 0 24 24" width="14" height="14" title="Electric"><path d="M13.5 3L5 14h6.5L10 21l9-12h-6.5z" fill="#4d9bff"/></svg>`;
  } else if (isHybrid) {
    fuelIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="u-flex-shrink-0" viewBox="0 0 24 24" width="14" height="14" title="Hybrid"><path d="M12 3C9 3 6 6.5 6 10.5c0 2.2 1 4.2 3 5.5 0-2.2.8-4.5 3-6-1 2.5-1 4.8 0 6 2-1.2 3-3.2 3-5.5C15 6.5 14 3 12 3z" fill="#00c853"/></svg>`;
  }

  let svg = "";
  // Most icons share a square 24x24 viewBox. Branches with a different
  // native aspect ratio (e.g. the long/low convertible silhouette) can
  // override this so they render at their natural proportions.
  let viewBox = "0 0 24 24";
  if (body.includes("pickup") || body.includes("truck")) {
    viewBox = "0 0 243 81";
    svg = `<g transform="translate(-627.61523,-51.044731)"><path d="m 736.21875,52.009766 c -18.98746,1.25917 -20.47537,1.84041 -37.55664,14.68164 -6.29913,4.73551 -12.14913,8.964028 -13,9.398438 -0.85088,0.43441 -7.17188,1.336966 -14.04688,2.003906 -15.70713,1.52373 -28.28189,3.622041 -33.66992,5.619141 -5.04738,1.87084 -6.33008,4.777509 -6.33008,14.349609 0,5.52722 -0.32768,6.81497 -2,7.85938 -1.70476,1.06462 -2,2.33239 -2,8.58593 0,7.93522 0.84504,9.49507 6.25196,11.55078 1.996,0.75887 2.74804,1.73659 2.74804,3.57032 0,2.36303 0.32026,2.52539 5,2.52539 h 5 v -6.68555 c 0,-11.32595 5.77584,-19.59193 15.61133,-22.3457 12.40635,-3.47357 25.96148,5.53331 27.16406,18.04883 l 0.47852,4.98242 33.12305,-0.006 c 20.88954,-0.11416 41.77338,-0.65052 62.66015,-0.99414 h 8.69922 l 0.53711,-4 c 0.75528,-5.63098 5.12207,-12.57158 9.89844,-15.73242 5.84299,-3.86673 14.6619,-4.31589 20.75,-1.05665 5.71968,3.062 10.05851,8.49404 11.58398,14.50196 0.66844,2.63259 1.61634,4.77953 2.10547,4.76953 10.76629,-0.2128 29.09175,-1.822 30.07813,-2.64063 0.75446,-0.62614 1.31054,-3.16779 1.31054,-5.99023 0,-4.29436 -0.30692,-5.01839 -2.47265,-5.8418 -2.45132,-0.93199 -2.47469,-1.06071 -2.75,-15.224607 l -0.27735,-14.285156 -8.5,-0.332031 c -4.675,-0.18214 -23.90891,0.259347 -42.75,0.367187 l -27.41015,0.224609 c -1.36679,-19.993093 -1.33023,-24.788346 -4.33985,-26.6875 -5.62497,-3.54951 -36.36163,-1.849136 -45.89648,-1.216796 z m 39.7147,5.299429 c 0.30485,6.128268 -0.63478,22.983771 -0.63478,22.983771 h -20.97836 l 3.15385,-22.41586 c 1.88473,-0.345468 18.45929,-0.567911 18.45929,-0.567911 z m -29.87035,-0.159409 -4.53846,23.14318 h -44.5637 c 0,0 -0.22529,-2.137651 0.31054,-3.025391 1.78432,-2.95622 19.36219,-15.828391 23.20854,-16.937951 4.13179,-1.680057 16.48278,-3.489031 25.58308,-3.179838 z" fill="${c}"/></g>`;
  } else if (body.includes("van") || body.includes("minivan")) {
    viewBox = "0 0 243 91";
    svg = `<g transform="translate(-875.38488,-170.36395)"><path d="m 1043.873,170.81836 c -47.48452,0.82955 -71.46123,0.31972 -80.25581,1.38476 -7.4392,0.90091 -12.13915,0.73488 -25.49024,10.375 l -29.51562,21.15235 -11.86914,5.65625 c -16.624,7.92202 -17.83583,9.32336 -19.01563,22.01758 -0.3563,3.83333 -1.0306,7.20793 -1.5,7.49804 -1.3719,0.84787 -0.98305,11.16694 0.56055,14.86133 1.6922,4.04982 3.71242,5.2564 10.76562,6.42969 10.0577,1.67307 9.82032,1.7678 9.82032,-3.92188 0,-14.26789 14.0352,-23.83545 26.5,-18.06445 7.5885,3.51338 11.5,9.52386 11.5,17.66992 v 4.43555 l 25.25,-0.002 c 13.8875,-9.2e-4 39.76245,-0.29914 57.49995,-0.66211 l 32.25,-0.66016 v -4.64258 c 0,-12.21234 13.9245,-21.41358 25.6836,-16.9707 6.2955,2.37858 12.3164,10.88199 12.3164,17.39648 0,3.46894 0.081,3.53907 4.0391,3.53907 9.4863,0 23.4665,-2.11871 24.7109,-3.7461 1.8362,-2.40138 1.6474,-14.67919 -0.25,-16.2539 -1.2198,-1.01232 -1.5009,-4.25651 -1.5019,-17.3711 0,-24.62215 -4.1922,-46.78527 -7.7441,-49.4414 -1.4273,-1.06739 -13.3372,-1.56046 -63.754,-0.67969 z m 29.0411,5.62891 h 25.5605 c 1.8343,0 3.3125,1.47827 3.3125,3.3125 v 24.06445 c 0,1.83422 -1.4782,3.31055 -3.3125,3.31055 h -29.5605 c -1.8343,0 -3.6133,-1.50115 -3.3125,-3.31055 l 4,-24.06445 c 0.3008,-1.80941 1.4782,-3.3125 3.3125,-3.3125 z m -84.18754,0.0234 h 64.83204 c 1.8316,0 3.6073,1.49997 3.3066,3.30664 l -4,24.0293 c -0.3007,1.80666 -1.475,3.30469 -3.3066,3.30469 h -60.83204 c -1.83153,0 -3.30468,-1.47316 -3.30468,-3.30469 v -24.0293 c 0,-1.83154 1.47315,-3.30664 3.30468,-3.30664 z m -20.93945,1.96875 c 2.52598,0.0736 4.25823,0.3591 4.73828,0.9375 0.9224,1.11184 1.87107,6.41854 -0.31445,18.60157 -1.25125,6.97496 -3.41628,9.4339 -8.76953,8.93359 -2.0749,-0.19392 -22.22014,2.1025 -42.23243,2.8125 -3.14361,0.11153 -5.43641,-1.53578 -4.16601,-3.76172 2.0343,-3.56427 24.64286,-19.75807 27.09765,-20.99805 1.50281,-0.7591 9.13779,-5.8315 14.14649,-6.19531 3.65405,-0.26541 6.97401,-0.40371 9.5,-0.33008 z" fill="${c}"/></g>`;
  } else if (body.includes("suv") || body.includes("sport utility") || body.includes("crossover")) {
    viewBox = "0 0 230 87";
    svg = `<g transform="translate(-355.37356,-54.290382)"><path d="m 418.00951,129.86282 c -4.30246,-13.58303 -6.61641,-17.87202 -10.45228,-19.37367 -1.67712,-0.65655 -7.21371,-0.88997 -14.19505,-0.59844 -10.873,0.45404 -11.5599,0.61093 -13.73229,3.13648 -1.25773,1.4622 -3.02667,5.23021 -3.93097,8.37337 -2.47897,8.61633 -4.47994,13.21491 -5.74981,13.21403 -0.62778,-4.3e-4 -3.93875,-1.32415 -7.35771,-2.94159 -7.02943,-3.32549 -7.5649,-4.35259 -7.08983,-13.59929 0.28237,-5.49605 0.50008,-5.98555 2.80612,-6.30915 3.26548,-0.45823 3.96502,-1.71156 3.99026,-7.14918 0.0336,-7.233516 1.65863,-11.615626 4.77499,-12.876236 3.38468,-1.36916 12.41905,-2.65179 36.11304,-5.12705 10.10805,-1.05597 18.46287,-2.04972 18.56625,-2.20833 2.64174,-4.05289 22.00033,-26.76498 23.27004,-27.3011 2.50154,-1.05627 42.1509,-2.30368 84.99896,-2.67416 35.11196,-0.3036 36.27291,-0.25228 38.16482,1.68688 1.07319,1.1 3.87122,7.85 6.21784,15 3.90954,11.91214 4.31416,14.12618 4.83519,26.45789 0.56345,13.335636 0.59132,13.463176 3.06861,14.041646 2.31249,0.53998 2.52191,1.07511 2.7921,7.13472 0.2243,5.03036 -0.0774,6.8576 -1.29964,7.872 -1.54715,1.28401 -21.37551,5.15388 -22.60791,4.41234 -0.33849,-0.20367 -2.31461,-4.90022 -4.39137,-10.43677 -2.20181,-5.86995 -4.64351,-10.67414 -5.85706,-11.52415 -1.53374,-1.07427 -5.14344,-1.45768 -13.72377,-1.45768 -14.97716,0 -15.18113,0.1499 -20.78692,15.27711 l -4.22838,11.41025 -18.69852,0.65349 c -10.28419,0.35943 -29.61103,0.65477 -42.94853,0.65632 l -24.25,0.003 v 3 c 0,2.45912 -0.41247,3 -2.28776,3 -2.04274,0 -2.68646,-1.25871 -6.01042,-11.75256 z m 45.50976,-41.903866 12.71157,-0.64832 0.50016,-4.09763 c 0.27508,-2.25369 0.77329,-7.81012 1.10714,-12.34762 l 0.607,-8.25 -14.31873,0.0153 c -7.87529,0.008 -14.86923,0.36507 -15.54208,0.79255 -2.20884,1.40335 -18.23772,23.44609 -17.69175,24.3295 0.631,1.02097 14.88523,1.11107 32.62669,0.20621 z m 58.91635,-2.18881 c 0.45181,-0.47111 -1.7468,-17.6061 -3.07041,-23.92953 -0.0316,-0.15113 -7.37002,-0.15113 -16.30752,0 l -16.25,0.27477 -0.28079,12.87285 -0.2808,12.87285 17.7808,-0.71809 c 9.77943,-0.39496 18.06336,-1.01274 18.40872,-1.37285 z m 42.27285,-4.65476 c -0.1562,-6.29718 -4.15325,-18.29716 -6.5157,-19.5615 -1.38353,-0.74045 -6.39483,-0.86047 -15.58738,-0.37331 l -13.54828,0.71798 0.53974,5.10841 c 0.29685,2.80963 1.07633,8.15684 1.73217,11.88268 l 1.19243,6.77426 16.14312,-0.27426 16.14312,-0.27426 z" fill="${c}"/></g>`;
  } else if (body.includes("convertible") || body.includes("roadster")) {
    viewBox = "0 0 234 67";
    svg = `<g transform="translate(-261.99973,-222.01649)"><path d="m 364.66406,222.19141 c -6.67003,2.08204 -13.43736,5.81306 -25.71094,12.78515 -15.11536,8.58639 -15.76055,8.84453 -26,10.39844 -35.90205,5.4484 -46.66806,9.82589 -49.7871,20.23633 -1.3701,4.57297 -1.49948,7.93997 -0.56446,14.76172 0.74878,5.4629 1.76121,6.15701 10.85156,7.45117 3.30001,0.46981 7.4625,0.90946 9.25,0.97656 l 3.25,0.12305 v -5.18555 c 0,-25.57908 35.14023,-26.44703 36.83008,-0.91016 l 0.42383,6.40626 21.62305,-0.6543 c 11.89299,-0.35915 35.17326,-0.6533 51.73437,-0.6543 l 30.11133,-0.002 L 427.21289,282 c 0.66643,-7.34953 2.96312,-11.36509 8.66211,-15.14453 3.51551,-2.33141 5.52455,-2.93164 9.80078,-2.93164 2.95802,0 6.63906,0.65035 8.17969,1.44726 6.20454,3.20849 11.0763,11.40135 11.0918,18.65039 l 0.006,2.59961 10.75,-1.83007 c 12.57741,-2.14268 15.61729,-3.24703 18.28516,-6.63868 2.48143,-3.15463 2.76322,-13.64608 0.45508,-16.9414 -0.831,-1.18643 -2.14922,-5.81447 -2.92969,-10.28516 -0.78048,-4.47069 -1.95547,-8.77617 -2.61133,-9.5664 -4.46294,-3.1975 0.92117,-3.00686 -6.5957,-8.74415 0,0 -34.5843,-0.94746 -47.07422,2.3086 -2.16414,0.56418 -8.11676,2.24609 -8.83203,2.24609 h -3.53711 c -2.21964,0 -2.40119,6.52039 -2.40119,6.52039 l -2.12133,0.74196 -24.8017,0.47007 v -3.51757 c 0,-2.30124 -1.85306,-4.1543 -4.15429,-4.1543 h -3.53907 c -2.30123,0 -3.7209,1.75339 -4.15429,4.1543 l -0.7343,4.06791 -27.67977,0.8774 c -7.95486,0.31516 -14.53666,0.53812 -16.32422,0.54101 l -1.15484,-0.7263 -0.84516,-1.20516 c 6.29702,-4.88564 24.98414,-15.28152 30.69922,-17.0039 3.86149,-1.16375 1.9896,-6.99607 -0.98828,-5.74414 z" fill="${c}"/></g>`;
  } else if (body.includes("wagon") || body.includes("hatchback")) {
    viewBox = "0 0 234 79";
    svg = `<g transform="translate(-894.97198,-52.069096)"><path d="m 1043.0039,52.097656 c -14.1368,-0.17136 -26.6363,0.426498 -33.2344,1.845703 -12.41543,2.67049 -25.80953,8.508514 -39.49997,17.214844 -9.97637,6.34441 -13.0873,7.411279 -27.71289,9.511719 -22.25989,3.19684 -33.91272,6.514904 -40.48437,11.527344 -4.74429,3.61865 -4.08304,4.371443 2.02734,2.308593 2.9318,-0.98977 8.4443,-2.07301 12.25,-2.40625 l 6.91992,-0.605468 -4.5,4.060547 c -5.84048,5.269892 -9.48051,6.933232 -16.86523,7.705082 -5.61463,0.58685 -6.07975,0.82812 -6.66016,3.4707 -0.85644,3.89938 0.43209,13.89964 2.14063,16.61328 1.73571,2.75679 6.21903,5.14065 11.71093,6.22656 2.29548,0.45389 5.55195,0.87525 7.23633,0.93555 l 3.0625,0.10937 0.0176,-6.25 c 0.0369,-13.15515 9.46951,-22.75 22.36523,-22.75 5.69927,0 11.01502,2.29628 15.34766,6.62891 4.26397,4.26398 5.89733,8.17877 6.41016,15.36328 l 0.46484,6.50781 21.13477,-0.2207 c 11.62404,-0.12144 34.23921,-0.50905 50.25581,-0.86133 l 29.1211,-0.64062 0.5195,-5.72656 c 0.6046,-6.66725 2.3424,-10.44796 6.8086,-14.81446 4.5843,-4.48201 8.9072,-6.23633 15.3711,-6.23633 11.7993,0 20.0835,7.95886 21.9766,21.11329 l 0.6641,4.61328 4.6132,-0.86133 c 6.0345,-1.12736 10.2481,-3.66738 13.1426,-7.91992 2.0026,-2.94218 2.256,-4.22519 1.7344,-8.78125 -0.336,-2.93487 -1.2771,-6.62585 -2.0918,-8.20118 -0.8146,-1.57531 -1.4805,-4.63311 -1.4805,-6.79687 v -3.935547 c 0,0 2.6091,-6.895962 0.3477,-9.230469 l -2.4238,-2.603515 c -7.3065,-7.844408 -15.9652,-13.760296 -18.6446,-15.259766 -1.6353,-0.91521 -1.6265,-1.094827 0.1524,-3.060547 1.0394,-1.14847 1.6099,-2.366651 1.2695,-2.707031 -0.3404,-0.34038 -9.5248,-1.741914 -20.4102,-3.115234 -13.1462,-1.658535 -28.9197,-2.600125 -43.0566,-2.771485 z m -6.7344,6.042969 c 7.2193,0.0084 13.0158,0.112505 17.9668,0.341797 v 19.09375 c -5.9668,0.755292 -12.6448,1.415242 -20.0429,1.980469 -21.6457,1.65375 -65.42387,2.533513 -65.42387,1.314453 0,-1.47143 14.8353,-10.849571 23.41406,-14.800782 15.70471,-7.233239 19.72961,-7.957887 44.08591,-7.929687 z m 25.6465,0.855469 c 2.7563,0.25164 5.2862,0.565653 7.7539,0.951172 16.6051,2.59417 23.082,6.56792 16.3496,10.03125 -5.0489,2.597294 -13.0556,4.76316 -24.1035,6.511718 z" fill="${c}"/></g>`;
  } else {
    viewBox = "0 0 234 70";
    svg = `<g transform="translate(-56.96902,-76.384689)"><path d="m 68.423077,145.20961 c -9.09036,-1.29416 -10.10311,-1.98967 -10.85189,-7.45257 -0.93502,-6.82175 -0.80647,-10.18877 0.56363,-14.76174 3.11904,-10.41044 13.8862,-14.7864 49.788263,-20.2348 10.23944,-1.55391 10.88463,-1.81195 26,-10.398338 25.48518,-14.47704 27.22399,-14.98748 53.66525,-15.75385 29.09734,-0.84336 34.14334,0.18086 60.58452,12.29725 13.83657,6.34046 21.15155,8.40213 29.81144,8.40213 2.86071,0 5.15962,0.56116 5.88638,1.43685 0.65586,0.79026 1.83105,5.094678 2.61153,9.565368 0.78047,4.47069 2.09896,9.09923 2.92996,10.28566 2.30814,3.29532 2.02624,13.78727 -0.45519,16.9419 -2.66787,3.39165 -5.70748,4.49509 -18.28488,6.63777 l -10.74901,1.8312 -0.006,-2.59938 c -0.0155,-7.24904 -4.88866,-15.44196 -11.0932,-18.65045 -1.54063,-0.79691 -5.22168,-1.44892 -8.1797,-1.44892 -4.27623,0 -6.28415,0.6008 -9.79966,2.93221 -5.69899,3.77944 -7.99567,7.79484 -8.6621,15.14437 l -0.53712,5.92342 -30.11111,0.002 c -16.56111,0.001 -39.84173,0.2963 -51.73472,0.65545 l -21.6236,0.653 -0.42386,-6.40545 c -1.68985,-25.53687 -36.828933,-24.66836 -36.828933,0.91072 v 5.18428 l -3.25,-0.12194 c -1.7875,-0.0671 -5.95,-0.50633 -9.25,-0.97614 z m 89.415763,-41.89129 c 11.90375,-0.51637 21.6861,-1.36643 22.02443,-1.91385 0.90214,-1.459698 4.3634,-19.126518 3.84818,-19.641738 -0.8434,-0.8434 -16.80468,1.61507 -23.09049,3.55656 -5.70314,1.76152 -24.40087,12.11862 -30.69788,17.004258 l -2.5,1.93967 4.5,-0.008 c 2.475,-0.004 14.13709,-0.426 25.91576,-0.93694 z m 64.37991,-2.61562 c 13.13989,-0.57604 13.87043,-0.718878 15.36829,-3.004908 2.12488,-3.24296 1.09723,-4.30733 -8.97342,-9.29406 -9.10908,-4.51058 -13.73953,-5.61848 -27.77057,-6.64454 l -9.58003,-0.70056 -1.06123,9.87453 c -0.58367,5.43099 -0.8668,10.198768 -0.62917,10.595058 0.23764,0.39629 4.5762,0.50874 9.64126,0.24989 5.06506,-0.25884 15.41725,-0.74278 23.00487,-1.07541 z" fill="${c}"/></g>`;
  }

  const [, , vbW, vbH] = viewBox.split(/\s+/).map(Number);
  const iconH = Math.round(size * (vbH / vbW));
  const vehicleIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="u-icon u-flex-shrink-0" viewBox="${viewBox}" width="${size}" height="${iconH}">${svg}</svg>`;
  return { vehicle: vehicleIcon, fuel: fuelIcon };
}

// ============================
// RECORD CARD HTML (shared)
// ============================
function recordCard(r, onDelete, onClickAttr) {
  const esc = sanitizeText;
  let vehicleLine = "";
  if (r.vinData) {
    const icons = getVehicleSVG({ ...r.vinData, _size: 36 });
    const name = [r.vinData.year, r.vinData.make, r.vinData.model, r.vinData.trim]
      .filter(Boolean).map(esc).join(" ");
    if (name) {
      vehicleLine = `<div class="vin-tl-vehicle">${icons.vehicle}${icons.fuel}<span class="vin-tl-vehicle-name">${name}</span></div>`;
    }
  }
  const safeSerial = esc(r.serialId || "");
  const statusDisplay = r.status === "OTHER" && r.statusOther ? `OTHER: ${r.statusOther}` : statusLabel(r.status);
  const destDisplay = locationLabel(r.destination, r.destinationOther, r.sectionName);
  const safeStatus = esc(statusDisplay);
  const safeDest = destDisplay ? esc(destDisplay) : "";
  const safeNotes = r.notes ? esc(r.notes) : "";
  const safeTires = r.tires && r.tires.length > 0 ? r.tires.map(esc).join(", ") : "";

  const isPriority = Array.isArray(r.conditions) && r.conditions.includes("PRIORITY");
  const priorityPill = isPriority ? `<span class="vin-tl-priority-pill">PRIORITY</span>` : "";
  const mileagePart = Number.isFinite(r.mileage) ? `<span class="vin-tl-mileage-val">${r.mileage.toLocaleString()}<span class="vin-tl-mileage-unit"> mi</span></span>` : "";
  const meterLine   = mileagePart ? `<div class="vin-tl-meters">${mileagePart}</div>` : "";
  const extraBadges = [
    safeDest ? `<span class="badge-dest"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${safeDest}</span>` : "",
    r.shuttle ? `<span class="badge-shuttle"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="22" height="12" rx="2"/><path d="M16 6V4a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v2"/><line x1="12" y1="6" x2="12" y2="18"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><line x1="1" y1="12" x2="23" y2="12"/></svg> SHUTTLE</span>` : "",
    r.transport ? '<span class="badge-transport">TRANSPORT</span>' : "",
    r.noTag ? '<span class="badge-notag">BAD TAG</span>' : "",
    (r.damage_marks && r.damage_marks.length) ? '<span class="badge-damage">DAMAGE</span>' : ""
  ].filter(Boolean).join("");

  const countLine = `<div class="vin-tl-count"><svg xmlns="http://www.w3.org/2000/svg" class="u-icon-mr-1" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${DT_FORMAT.timeAgoOrClock(r.timestamp)}${r._driverName ? ` · <b class="vin-tl-count-driver">${esc(r._driverName)}</b>` : ""}</div>`;

  const headerRight = `<div class="vin-tl-header-right">${countLine}${meterLine}</div>`;

  const pillRow = `<div class="vin-tl-pill-row vin-tl-pill-row--bottom"><span class="vin-tl-status-pill ${statusClass(r.status)}">${safeStatus}</span>${priorityPill}${extraBadges}</div>`;

  return `
    <div class="record vin-tl-header" onclick="${onClickAttr || `openDetail('${r.id}', '${onDelete}')`}">
      <div class="vin-tl-header-top">
        ${headerRight}
      </div>
      <div class="vin-tl-vin">${safeSerial}</div>
      ${vehicleLine}
      ${safeTires ? `<div class="vin-tl-count vin-tl-count--mt">Tires: <b class="vin-tl-tires-val">${safeTires}</b></div>` : ""}
      ${pillRow}
      ${safeNotes ? `<div class="record-notes record-notes--mt">${safeNotes}</div>` : ""}
    </div>`;
}

// ============================
// TODAY'S ENTRIES (entry tab)
// ============================
function renderTodayEntries() {
  const now = new Date();
  const todayEST = estDateStr(now.getTime());
  const todayShifts = getShiftsForDate(todayEST);
  const currentShift = getCurrentShift();
  const isCurrentShiftToday = currentShift.date === todayEST;
  const shiftRecords = isCurrentShiftToday ? currentShift.records : [];
  const shiftNum = isCurrentShiftToday ? todayShifts.length : 0;

  document.getElementById("todayCount").textContent = shiftRecords.length;
  updateAvgBanner();
  document.querySelector(".today-title").textContent =
    shiftNum > 1 ? `Shift ${shiftNum} Entries` : "Today's Entries";

  if (shiftRecords.length === 0) {
    document.getElementById("todayRecords").innerHTML = '<div class="today-empty">No entries yet this shift.</div>';
    return;
  }
  const sorted = [...shiftRecords].reverse();
  document.getElementById("todayRecords").innerHTML = sorted.map(r =>
    recordCard(r, "deleteTodayRecord", `openVinDetailPanel('${sanitizeText(r.serialId || "")}')`)
  ).join("");
}

function deleteTodayRecord(id) {
  if (!confirm("Delete this record? This cannot be undone.")) return;
  setRecords(getRecords().filter(r => r.id !== id));
  renderTodayEntries();
}

function deleteRecord(id) {
  if (!confirm("Delete this record? This cannot be undone.")) return;
  setRecords(getRecords().filter(r => r.id !== id));
  renderRecords();
}

// ============================
// RENDER RECORDS TAB
// ============================
// ============================
// RECORDS PAGINATION
// ============================
const RECORDS_PER_PAGE = 25;
let recordsCurrentPage = 1;

function changeRecordsPage(page) {
  recordsCurrentPage = page;
  renderRecords();
  // Scroll back up to the records list
  const el = document.getElementById("recordsHeading");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetRecordsPage() {
  recordsCurrentPage = 1;
}

// VIN check digit isn't enforced — just shape. 17 chars, no I/O/Q.
function isFullVin(s) { return /^[A-HJ-NPR-Z0-9]{17}$/i.test(s); }

// Empty-state for the VIN LOOKUP search panel: show up to 5 recent
// searches as clickable chips, or fall back to the original prompt if
// the user hasn't searched anything yet on this device.
function renderRecentVinEmptyState(container) {
  const recent = getRecentVinSearches().slice(0, 5);
  if (!recent.length) {
    container.innerHTML = `<p class="records-prompt">Type a VIN to start.</p>`;
    return;
  }
  const chips = recent.map(t =>
    `<button type="button" class="vin-recent-chip" data-term="${sanitizeText(t)}">${sanitizeText(t)}</button>`
  ).join("");
  container.innerHTML = `
    <div class="vin-recent-wrap">
      <div class="vin-recent-head">
        <span class="vin-recent-label">Recent searches</span>
        <button type="button" class="vin-recent-clear" id="vinRecentClear">Clear</button>
      </div>
      <div class="vin-recent-row">${chips}</div>
    </div>`;
  container.querySelectorAll(".vin-recent-chip").forEach(b => {
    b.addEventListener("click", () => {
      const input = document.getElementById("fSearch");
      if (!input) return;
      input.value = b.dataset.term;
      resetRecordsPage();
      renderRecords();
    });
  });
  const clearBtn = container.querySelector("#vinRecentClear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    try { localStorage.removeItem(RECENT_VIN_KEY); } catch {}
    renderRecentVinEmptyState(container);
  });
}

function renderRecords() {
  const searchVal = (document.getElementById("fSearch")?.value || "").trim();
  const countEl   = document.getElementById("resultsCount");
  const container = document.getElementById("records");

  // No search → empty state, no list, no markers.
  if (!searchVal) {
    if (countEl)   countEl.textContent = "";
    if (container) renderRecentVinEmptyState(container);
    _renderRecordsMapMarkers([]);
    renderVinDetailList([]);
    return;
  }

  // Full VIN → timeline view
  if (isFullVin(searchVal)) {
    pushRecentVinSearch(searchVal.toUpperCase());
    return renderVinTimeline(searchVal.toUpperCase());
  }

  // Partial term → fuzzy search across the cloud
  return renderFuzzyResults(searchVal);
}

// Fuzzy search: matches against records.serial_id + records.notes (plus
// vehicles vin_data make/model/year) across every signed-in user.
async function renderFuzzyResults(term) {
  const container = document.getElementById("records");
  const countEl   = document.getElementById("resultsCount");
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;

  // Honor the collapsible filters too
  const fStatus = document.getElementById("fStatus")?.value || "";
  const fNoTag  = document.getElementById("fNoTag")?.value  || "";
  const fDest   = document.getElementById("fDest")?.value   || "";
  const fFrom   = document.getElementById("fDateFrom")?.value || "";
  const fTo     = document.getElementById("fDateTo")?.value   || "";

  container.innerHTML = `<p class="records-prompt">Searching…</p>`;
  if (countEl) countEl.textContent = "";

  // Quote-safe — Supabase .or() expects a comma-separated filter string
  const safe = term.replace(/[%,]/g, " ").replace(/'/g, "''");
  const upTerm = safe.toUpperCase();

  let recsQ = sb.from("records")
    .select("id,user_id,serial_id,status,status_other,destination,destination_other,section_id,section_name,no_tag,shuttle,transport,ts,lat,lng,notes,vin_data,tires,gps_error,shift_num,mileage,fuel_level,photo_url,photo_urls")
    .or(`serial_id.ilike.%${upTerm}%,notes.ilike.%${safe}%,vin_data->>make.ilike.%${safe}%,vin_data->>model.ilike.%${safe}%`)
    .order("ts", { ascending: false })
    .limit(200);
  if (fStatus) recsQ = recsQ.eq("status", fStatus);
  if (fNoTag === "yes") recsQ = recsQ.eq("no_tag", true);
  if (fNoTag === "no")  recsQ = recsQ.eq("no_tag", false);
  if (fDest)   recsQ = recsQ.eq("destination", fDest);
  if (fFrom)   recsQ = recsQ.gte("ts", new Date(fFrom + "T00:00:00").toISOString());
  if (fTo)     recsQ = recsQ.lte("ts", new Date(fTo   + "T23:59:59.999").toISOString());

  const [recRes, vehRes] = await Promise.all([
    recsQ,
    sb.from("vehicles")
      .select("serial_id,current_status,current_status_other,current_destination,current_destination_other,section_id,section_name,last_lat,last_lng,last_seen_at,vin_data,entered_inventory_at")
      .or(`serial_id.ilike.%${upTerm}%,vin_data->>make.ilike.%${safe}%,vin_data->>model.ilike.%${safe}%,vin_data->>year.ilike.%${safe}%`)
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(100)
  ]);

  const recRows  = recRes.data  || [];
  let vehRows    = vehRes.data  || [];
  // Apply the same filters the records list honors so the inventory section
  // stays in sync with what the user is filtering by.
  if (fStatus) vehRows = vehRows.filter(v => v.current_status === fStatus);
  if (fDest)   vehRows = vehRows.filter(v => v.current_destination === fDest);

  // Map driver names for record cards (manager-style augmentation)
  const userIds = [...new Set(recRows.map(r => r.user_id))];
  const names = {};
  if (userIds.length) {
    const { data: profs } = await sb.from("profiles").select("id,display_name").in("id", userIds);
    (profs || []).forEach(p => { names[p.id] = p.display_name || "Driver"; });
  }
  // Convert records to the local-record shape so recordCard() can render them
  const cards = recRows.map(row => ({
    id: row.id,
    serialId: row.serial_id,
    status: row.status,
    statusOther: row.status_other || "",
    destination: row.destination || "",
    destinationOther: row.destination_other || "",
    sectionId: row.section_id || null,
    sectionName: row.section_name || "",
    noTag: !!row.no_tag,
    shuttle: !!row.shuttle,
    transport: !!row.transport,
    shiftNum: row.shift_num,
    notes: row.notes || "",
    lat: row.lat, lng: row.lng,
    gpsError: !!row.gps_error,
    tires: row.tires || [],
    vinData: row.vin_data || undefined,
    mileage: Number.isFinite(row.mileage) ? row.mileage : null,
    fuel_level: row.fuel_level || "",
    photo_url: row.photo_url || "",
    photo_urls: Array.isArray(row.photo_urls) ? row.photo_urls : [],
    timestamp: row.ts ? new Date(row.ts).getTime() : Date.now(),
    _driverName: names[row.user_id]
  }));

  if (!cards.length && !vehRows.length) {
    container.innerHTML = `<p class="records-prompt">No matches for <b>${sanitizeText(term)}</b>.</p>`;
    if (countEl) countEl.textContent = "0 results";
    _renderRecordsMapMarkers([]);
    renderVinDetailList([]);
    return;
  }

  const esc = (s) => sanitizeText(s);
  const ago = (d) => DT_FORMAT.timeAgo(d);

  const vehHtml = vehRows.length ? `
    <div class="records-search-section">
      <div class="records-section-label">${vehRows.length} VIN${vehRows.length === 1 ? "" : "s"} in inventory</div>
      ${vehRows.map(v => {
        const statusDisp = v.current_status === "OTHER" && v.current_status_other
          ? `OTHER: ${v.current_status_other}`
          : statusLabel(v.current_status);
        const destDisp = locationLabel(v.current_destination, v.current_destination_other, v.section_name);
        const vd = v.vin_data || {};
        const vehName = [vd.year, vd.make, vd.model].filter(Boolean).join(" ");
        const pin = (Number.isFinite(v.last_lat) && Number.isFinite(v.last_lng))
          ? ` · <a href="https://www.google.com/maps?q=${v.last_lat},${v.last_lng}" target="_blank" rel="noopener" class="vin-tl-gps" onclick="event.stopPropagation()"><svg class="ico-pin" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 22s-7-7.58-7-13a7 7 0 0 1 14 0c0 5.42-7 13-7 13zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg></a>` : "";
        const statusPill = v.current_status
          ? `<span class="record-status ${statusClass(v.current_status)}">${esc(statusDisp)}</span>`
          : "";
        return `
          <div class="vin-detail-row vin-inv-row" data-vin="${esc(v.serial_id)}">
            <div>
              <div class="vin-detail-vin">${esc(v.serial_id)}</div>
              <div class="vin-detail-sub">
                ${statusPill}${destDisp ? ` · ${esc(destDisp)}` : ""}
                ${vehName ? ` · ${esc(vehName)}` : ""}
                · ${esc(ago(v.last_seen_at || v.entered_inventory_at))}${pin}
              </div>
            </div>
          </div>`;
      }).join("")}
    </div>` : "";

  const recHtml = cards.length
    ? `<div class="records-search-section"><div class="records-section-label">${cards.length} record${cards.length === 1 ? "" : "s"}</div>${cards.map(r => recordCard(r, "deleteRecord")).join("")}</div>`
    : "";

  container.innerHTML = vehHtml + recHtml;
  const totalResults = vehRows.length + cards.length;
  if (countEl) countEl.textContent = `${totalResults} result${totalResults === 1 ? "" : "s"}`;

  // Tap an inventory row → open that VIN's full timeline
  container.querySelectorAll(".vin-inv-row").forEach(row => {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => {
      document.getElementById("fSearch").value = row.dataset.vin;
      renderVinTimeline(row.dataset.vin.toUpperCase());
    });
  });

  // Map: latest GPS per VIN, capped to 25 by recency
  const pins = [];
  vehRows.forEach(v => {
    if (Number.isFinite(v.last_lat) && Number.isFinite(v.last_lng)) {
      pins.push({ lat: v.last_lat, lng: v.last_lng, label: v.serial_id, ts: new Date(v.last_seen_at || 0).getTime() || 0 });
    }
  });
  cards.forEach(c => {
    if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
      pins.push({ lat: c.lat, lng: c.lng, label: c.serialId, ts: c.timestamp || 0 });
    }
  });
  _renderRecordsMapMarkers(pins);

  const vinItems = [];
  vehRows.forEach(v => {
    const vd = v.vin_data || {};
    const vehName = [vd.year, vd.make, vd.model].filter(Boolean).join(" ");
    vinItems.push({
      vin: v.serial_id, ts: v.last_seen_at || null, vehicle: vehName,
      status: v.current_status, statusOther: v.current_status_other,
      destination: v.current_destination, destinationOther: v.current_destination_other,
      lat: v.last_lat, lng: v.last_lng
    });
  });
  cards.forEach(c => {
    const v = c.vinData ? [c.vinData.year, c.vinData.make, c.vinData.model].filter(Boolean).join(" ") : "";
    vinItems.push({
      vin: c.serialId, ts: c.timestamp || null, vehicle: v,
      status: c.status, statusOther: c.statusOther,
      destination: c.destination, destinationOther: c.destinationOther,
      lat: c.lat, lng: c.lng
    });
  });
  renderVinDetailList(vinItems);
}

// Drop markers on the records map for an arbitrary list. Used by the
// fuzzy-results renderer and the empty path.
//
// The map element is hidden until the user opens the <details> disclosure, so
// Leaflet may not be initialized yet when search runs. We cache the latest
// pin set in _lastSearchPins; the disclosure toggle handler replays it.
let _lastSearchPins = null;
function _renderRecordsMapMarkers(pins) {
  _lastSearchPins = pins;
  const disc = document.getElementById("recordsMapDisclosure");
  const mapEl = document.getElementById("recordsMap");
  const emptyEl = document.getElementById("recordsMapEmpty");

  // If the disclosure isn't open yet, just stash. It will replay on open.
  if (!disc || !disc.open) return;

  if (!pins.length) {
    if (mapEl) mapEl.style.display = "none";
    if (emptyEl) emptyEl.style.display = "flex";
    return;
  }
  if (!window.L) return;

  if (emptyEl) emptyEl.style.display = "none";
  if (mapEl) mapEl.style.display = "block";

  // Lazy-init the Leaflet instance if this is the first render after open.
  if (!recordsLeafletMap) {
    recordsLeafletMap = createMap("recordsMap");
    if (!recordsLeafletMap) return;
  }
  // Clear existing markers
  if (Array.isArray(recordsMapMarkers)) {
    recordsMapMarkers.forEach(m => recordsLeafletMap.removeLayer(m));
    recordsMapMarkers = [];
  }
  // Latest GPS per VIN, cap at 25 by recency
  const byVin = new Map();
  pins.forEach(p => {
    const key = String(p.label || "").toUpperCase();
    const cur = byVin.get(key);
    if (!cur || (p.ts || 0) > (cur.ts || 0)) byVin.set(key, p);
  });
  const deduped = Array.from(byVin.values())
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 25);
  document.getElementById("recordsMapEmpty").style.display = "none";
  const bounds = [];
  deduped.forEach(p => {
    const m = L.circleMarker([p.lat, p.lng], { radius: 7, color: "#00a651", weight: 2, fillColor: "#00a651", fillOpacity: 0.7 })
      .bindPopup(`<b>${sanitizeText(p.label)}</b>`)
      .addTo(recordsLeafletMap);
    recordsMapMarkers.push(m);
    bounds.push([p.lat, p.lng]);
  });
  if (bounds.length > 1) recordsLeafletMap.fitBounds(bounds, { padding: [30, 30] });
  else recordsLeafletMap.setView(bounds[0], 15);
  setTimeout(() => recordsLeafletMap.invalidateSize(), 50);
}

// Read-only detail panel for a cloud record row inside the VIN timeline.
// Layout mirrors the #detailSheet template (detail-header / -badges / -body / -actions).
function openVinRecordDetail(r, profileCache) {
  const body = document.getElementById("recordDetailBody");
  if (!body) return;
  const esc = (s) => sanitizeText(s);
  const p = profileCache?.get?.(r.user_id) || null;
  const name = esc(p?.display_name || "Someone");
  const roleRaw = p?.role ? esc(p.role) : "";
  const authorId = esc(r.user_id || "");
  const avatarUrl = p?.avatar_url ? esc(p.avatar_url) : "";
  const initials = (p?.display_name || "?").trim().split(/\s+/).slice(0,2).map(s => s[0] || "").join("").toUpperCase() || "?";
  const avatarHtml = avatarUrl
    ? `<div class="detail-author-avatar"><img src="${avatarUrl}" alt=""></div>`
    : `<div class="detail-author-avatar">${esc(initials)}</div>`;
  const authorBlock = `<div class="detail-author">
    ${avatarHtml}
    <div class="detail-author-text">
      <button type="button" class="detail-author-name" onclick="openContactCard('${authorId}')">${name}</button>
      ${roleRaw ? `<div class="detail-author-role role-${roleRaw}">${roleRaw}</div>` : ""}
    </div>
  </div>`;
  const statusDisp = r.status === "OTHER" && r.status_other ? `OTHER: ${r.status_other}` : statusLabel(r.status);
  const destDisp   = locationLabel(r.destination, r.destination_other, r.section_name);
  const when = (() => { try { return new Date(r.ts).toLocaleString(); } catch { return ""; } })();
  const vd = r.vin_data || null;
  const vehicle = vd ? [vd.year, vd.make, vd.model].filter(Boolean).join(" ") : "";

  const badges = [
    `<span class="record-status ${statusClass(r.status)}">${esc(statusDisp)}</span>`,
    destDisp ? `<span class="badge-dest">${esc(destDisp)}</span>` : "",
    r.shuttle ? '<span class="badge-shuttle">SHUTTLE</span>' : "",
    r.transport ? '<span class="badge-transport">TRANSPORT</span>' : "",
    r.no_tag ? '<span class="badge-notag">BAD TAG</span>' : "",
    (r.damage_marks && r.damage_marks.length) ? '<span class="badge-damage">DAMAGE</span>' : ""
  ].filter(Boolean).join("");

  const hasGps = Number.isFinite(r.lat) && Number.isFinite(r.lng);
  const gpsAction = hasGps
    ? `<a class="btn btn-secondary" href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener">Open in Maps</a>` : "";

  const vinSpecs = vd
    ? [vd.bodyClass, vd.engine, vd.fuelType].filter(Boolean).map(esc).join("  ·  ")
    : "";
  const vehicleIcon = vd ? getVehicleSVG({ ...vd, _size: 48 }) : null;

  const condList = Array.isArray(r.conditions) && r.conditions.length
    ? r.conditions.map(id => esc(DT_OPTIONS.CONDITIONS.find(c => c.id === id)?.label || id)).join(", ")
    : "";

  const rows = [
    Number.isFinite(r.mileage) ? `<div class="detail-row"><span class="detail-label">Mileage</span><span class="detail-val">${r.mileage.toLocaleString()} mi</span></div>` : "",
    r.fuel_level ? `<div class="detail-row"><span class="detail-label">Fuel</span><span class="detail-val">${esc(r.fuel_level)}</span></div>` : "",
    condList ? `<div class="detail-row"><span class="detail-label">Conditions</span><span class="detail-val">${condList}</span></div>` : "",
    r.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-val">${esc(r.notes)}</span></div>` : "",
    r.source ? `<div class="detail-row"><span class="detail-label">Source</span><span class="detail-val">${esc(r.source)}</span></div>` : "",
    hasGps ? `<div class="detail-row"><span class="detail-label">GPS</span><span class="detail-val">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</span></div>` : ""
  ].filter(Boolean).join("");

  // photo_urls is the canonical multi-photo list; legacy rows may still have
  // a single photo_url. Paths are storage keys — sign them and inject after render.
  const photoPaths = (Array.isArray(r.photo_urls) && r.photo_urls.length)
    ? r.photo_urls
    : (r.photo_url ? [r.photo_url] : []);
  const galleryId = photoPaths.length ? `recordPhotoGallery_${r.id}` : "";
  const photoBlock = photoPaths.length
    ? `<div class="detail-map-section"><div id="${galleryId}" class="record-photo-gallery">${
        photoPaths.map((_, i) => `<img data-idx="${i}" alt="Record photo" role="button" tabindex="0" data-a11y-kb="1">`).join("")
      }</div></div>` : "";
  if (photoPaths.length && window.DT_MEDIA?.signPhotoPaths) {
    DT_MEDIA.signPhotoPaths(photoPaths).then(signed => {
      const root = document.getElementById(galleryId);
      if (!root) return;
      photoPaths.forEach((path, i) => {
        const url = signed[path];
        if (!url) return;
        const el = root.querySelector(`img[data-idx="${i}"]`);
        if (!el) return;
        el.src = url;
        el.onclick = () => window.open(url, "_blank", "noopener");
      });
    }).catch(() => {});
  }

  const mapBlock = hasGps
    ? `<div class="detail-map-section">
         <div class="detail-map-title">Location</div>
         <div id="vinRecordDetailMap" class="detail-map"></div>
       </div>` : "";

  body.innerHTML = `
    <div class="detail-header">
      <div class="detail-header-left">
        <div class="detail-time">${esc(when)}</div>
        ${authorBlock}
      </div>
      <button class="btn btn-destructive btn-icon detail-close" onclick="closeRecordDetailOverlay()" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="detail-vin-section">
      <div class="detail-vin-container">
        ${vehicleIcon ? `<div class="detail-vin-icon">${vehicleIcon.vehicle}${vehicleIcon.fuel}</div>` : ""}
        <div class="detail-serial">${esc(r.serial_id || "")}</div>
        ${vehicle ? `<div class="detail-vin-info">
          <div class="detail-vin-name">${esc(vehicle)}${vd?.trim ? `  ${esc(vd.trim)}` : ""}</div>
          ${vinSpecs ? `<div class="detail-vin-specs">${vinSpecs}</div>` : ""}
        </div>` : ""}
      </div>
    </div>
    ${badges ? `<div class="detail-badges">${badges}</div>` : ""}
    <div class="detail-body">${rows}</div>
    <div id="vinRecordDamagePanel" class="detail-damage-panel"></div>
    <div id="vinRecordTirePanel" class="detail-tire-panel"></div>
    ${photoBlock}
    ${mapBlock}
    ${gpsAction ? `<div class="detail-actions detail-actions--single detail-actions--mt">${gpsAction}</div>` : ""}
  `;
  if (window.DT_DAMAGE) {
    DT_DAMAGE.renderDamageViewer(document.getElementById("vinRecordDamagePanel"), r);
    DT_DAMAGE.renderTireViewer(document.getElementById("vinRecordTirePanel"), r);
  }
  document.getElementById("recordDetailOverlay").classList.add("open");

  if (hasGps && window.L) {
    setTimeout(() => {
      const m = createMap("vinRecordDetailMap");
      if (!m) return;
      m.setView([r.lat, r.lng], 17);
      const color = statusMapColor(r.status);
      const icon = createNumberedMarker("P", color, 32);
      L.marker([r.lat, r.lng], { icon }).addTo(m);
    }, 80);
  }
}

function closeRecordDetailOverlay() {
  document.getElementById("recordDetailOverlay")?.classList.remove("open");
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.getElementById("contactOverlay")?.classList.contains("open")) closeContactCard();
  if (document.getElementById("recordDetailOverlay")?.classList.contains("open")) closeRecordDetailOverlay();
});

// ============================
// CONTACT CARD — opened by clicking an author name on a record detail.
// Fetches the full profile (name/email/phone/role/home_airport) and renders
// a simple read-only sheet with click-to-call/click-to-email actions.
// ============================
window.openContactCard = async function openContactCard(userId) {
  if (!userId) return;
  const body = document.getElementById("contactBody");
  const overlay = document.getElementById("contactOverlay");
  if (!body || !overlay || !window.DT_AUTH) return;
  body.innerHTML = `<div class="u-empty">Loading…</div>`;
  overlay.classList.add("open");
  const esc = (s) => sanitizeText(s);
  try {
    const { data } = await DT_AUTH.client
      .from("profiles")
      .select("id,display_name,email,phone,role,home_airport,avatar_url")
      .eq("id", userId).maybeSingle();
    if (!data) {
      body.innerHTML = `<div class="u-empty">Contact not found.</div>`;
      return;
    }
    const name  = esc(data.display_name || "Unknown");
    const role  = data.role ? esc(data.role) : "";
    const email = data.email ? esc(data.email) : "";
    const phone = data.phone ? esc(data.phone) : "";
    const loc   = data.home_airport ? esc(data.home_airport) : "";
    const avatar = data.avatar_url
      ? `<div class="contact-avatar"><img src="${esc(data.avatar_url)}" alt=""></div>`
      : `<div class="contact-avatar">${esc((data.display_name || "?").trim().split(/\s+/).slice(0,2).map(s=>s[0]||"").join("").toUpperCase() || "?")}</div>`;
    const rows = [
      email ? `<div class="contact-row"><span class="contact-row-label">Email</span><span class="contact-row-val"><a href="mailto:${email}">${email}</a></span></div>` : "",
      phone ? `<div class="contact-row"><span class="contact-row-label">Phone</span><span class="contact-row-val"><a href="tel:${phone}">${phone}</a></span></div>` : "",
      loc   ? `<div class="contact-row"><span class="contact-row-label">Location</span><span class="contact-row-val">${loc}</span></div>` : ""
    ].filter(Boolean).join("");
    body.innerHTML = `
      <div class="contact-card">
        ${avatar}
        <div class="contact-name">${name}</div>
        ${role ? `<div class="contact-role role-${role}">${role}</div>` : ""}
        ${rows ? `<div class="contact-rows">${rows}</div>` : ""}
      </div>
    `;
  } catch (e) {
    console.warn("[contact] load failed", e);
    body.innerHTML = `<div class="u-empty">Couldn't load contact.</div>`;
  }
};
window.closeContactCard = function closeContactCard() {
  document.getElementById("contactOverlay")?.classList.remove("open");
};

// ============================
// VIN TIMELINE — every event for a single asset, oldest visit last
// ============================
const _vinProfileCache = new Map();
async function _vinFetchProfiles(ids) {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const missing = [...new Set(ids)].filter(id => id && !_vinProfileCache.has(id));
  if (!missing.length) return;
  const { data } = await sb.from("profiles").select("id,display_name,role,avatar_url").in("id", missing);
  (data || []).forEach(p => _vinProfileCache.set(p.id, p));
}

// Page size + shared state for the .vin-tl-list pagination. A single active
// timeline is fine — either the main VIN LOOKUP results OR the inline
// entry-form notes render at a time, never both.
const VIN_TL_PAGE_SIZE = 10;
let _activeVinTimeline = null;

// Build the HTML for one event row. Extracted so both the initial render
// and changeVinTimelinePage() can produce identical markup.
function _buildVinTimelineRowHtml(ev) {
  const esc = sanitizeText;
  const r = ev.r;
  const statusDisp = r.status === "OTHER" && r.status_other ? `OTHER: ${r.status_other}` : statusLabel(r.status);
  const destDisp   = locationLabel(r.destination, r.destination_other, r.section_name);
  const condChips = Array.isArray(r.conditions) && r.conditions.length
    ? `<div class="vin-tl-cond-row">${r.conditions.map(id => {
        const label = DT_OPTIONS.CONDITIONS.find(c => c.id === id)?.label || id;
        return `<span class="vin-tl-cond-chip" data-cond="${esc(id)}">${esc(label)}</span>`;
      }).join("")}</div>` : "";
  const when = DT_FORMAT.timeAgo(ev.ts);
  const damageBadge = (r.damage_marks && r.damage_marks.length) ? '<span class="badge-damage">DAMAGE</span>' : "";
  const safeTires = Array.isArray(r.tires) && r.tires.length ? r.tires.map(esc).join(", ") : "";
  const tiresLine = safeTires ? `<div class="vin-tl-count vin-tl-count--mt">Tires: <b class="vin-tl-tires-val">${safeTires}</b></div>` : "";
  return `
    <div class="vin-tl-row vin-tl-record" data-record-id="${esc(r.id)}">
      <div class="vin-tl-head">
        <div class="vin-tl-badges">
          <span class="record-status ${statusClass(r.status)}">${esc(statusDisp)}</span>
          ${destDisp ? `<span class="record-location">${esc(destDisp)}</span>` : ""}
          ${damageBadge}
        </div>
        <span class="vin-tl-time">${esc(when)}</span>
      </div>
      ${condChips}
      ${tiresLine}
      ${r.notes ? `<div class="vin-tl-body">${esc(r.notes)}</div>` : ""}
    </div>`;
}

function _buildVinTimelinePagerHtml(current, total) {
  if (total <= 1) return "";
  const prev = current <= 1 ? "disabled" : "";
  const next = current >= total ? "disabled" : "";
  return `
    <div class="pagination vin-tl-pager">
      <button type="button" class="page-btn page-nav" ${prev} onclick="changeVinTimelinePage(${current - 1})">&#8592; Prev</button>
      <div class="page-numbers"><span class="vin-tl-page-info">Page ${current} of ${total}</span></div>
      <button type="button" class="page-btn page-nav" ${next} onclick="changeVinTimelinePage(${current + 1})">Next &#8594;</button>
    </div>`;
}

function _wireVinTimelineRowClicks(container, records) {
  const recordsById = new Map(records.map(r => [r.id, r]));
  container.querySelectorAll('.vin-tl-record').forEach(row => {
    if (row._wired) return;
    row._wired = true;
    row.style.cursor = 'pointer';
    row.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      const r = recordsById.get(row.dataset.recordId);
      if (r) openVinRecordDetail(r, _vinProfileCache);
    });
  });
}

// Global pager click target — same pattern as changeRecordsPage.
function changeVinTimelinePage(page) {
  const st = _activeVinTimeline;
  if (!st || !st.container) return;
  const total = Math.max(1, Math.ceil(st.events.length / VIN_TL_PAGE_SIZE));
  const clamped = Math.min(Math.max(1, page), total);
  st.page = clamped;
  const start = (clamped - 1) * VIN_TL_PAGE_SIZE;
  const slice = st.events.slice(start, start + VIN_TL_PAGE_SIZE);
  const listEl = st.container.querySelector(".vin-tl-list");
  if (!listEl) return;
  listEl.innerHTML = slice.map(_buildVinTimelineRowHtml).join("");
  const newPagerHtml = _buildVinTimelinePagerHtml(clamped, total);
  const existingPager = st.container.querySelector(".vin-tl-pager");
  if (existingPager && newPagerHtml) existingPager.outerHTML = newPagerHtml;
  else if (existingPager) existingPager.remove();
  else if (newPagerHtml) listEl.insertAdjacentHTML("afterend", newPagerHtml);
  _wireVinTimelineRowClicks(st.container, st.records);
  listEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function renderVinTimeline(vin, opts) {
  opts = opts || {};
  const container = opts.container || document.getElementById("records");
  const countEl   = opts.countEl !== undefined ? opts.countEl : document.getElementById("resultsCount");
  if (!container || !window.DT_AUTH) return;
  if (countEl) countEl.textContent = `VIN history`;
  container.innerHTML = `<div class="vin-tl-empty">Loading…</div>`;
  const sb = DT_AUTH.client;

  const { data: recordsData } = await sb.from("records")
    .select("id,user_id,serial_id,status,status_other,destination,destination_other,section_id,section_name,no_tag,shuttle,transport,ts,lat,lng,notes,vin_data,mileage,fuel_level,photo_url,photo_urls,conditions,damage_marks,tires,tire_details,claim_number,claim_notes")
    .eq("serial_id", vin)
    .order("ts", { ascending: false });

  const records = recordsData || [];
  if (!records.length) {
    container.innerHTML = `<div class="vin-tl-empty">No history for <b>${sanitizeText(vin)}</b>.</div>`;
    renderVinDetailList([]);
    return;
  }
  {
    const vd = records.find(r => r.vin_data)?.vin_data;
    const veh = vd ? [vd.year, vd.make, vd.model].filter(Boolean).join(" ") : "";
    const items = records.map(r => ({
      vin, ts: r.ts, vehicle: veh,
      status: r.status, statusOther: r.status_other,
      destination: r.destination, destinationOther: r.destination_other,
      lat: r.lat, lng: r.lng
    }));
    renderVinDetailList(items);
  }

  await _vinFetchProfiles(records.map(r => r.user_id));

  const events = records
    .map(r => ({ ts: new Date(r.ts).getTime(), kind: "record", r }))
    .sort((a, b) => b.ts - a.ts);

  const ago = (input) => DT_FORMAT.timeAgo(input);
  const esc = (s) => sanitizeText(s);

  // First record carrying NHTSA-decoded vin_data is the source of truth for
  // both the vehicle line in the header and the inline subtitle on every note.
  const headerVin = (() => {
    const r = records.find(x => x.vin_data);
    return r ? r.vin_data : null;
  })();
  const headerVehicle = headerVin
    ? (() => {
        const v = headerVin;
        // Primary line: year + make + model + trim (NHTSA-decoded).
        const nameParts = [v.year, v.make, v.model, v.trim || v.series]
          .filter(Boolean).map(esc);
        const name = nameParts.join(" ");
        if (!name) return "";
        const icons = getVehicleSVG({ ...v, _size: 36 });
        // Secondary line: body / engine / fuel / drivetrain / doors. Each cell
        // becomes a small chip so it stays readable when the VIN has lots of
        // decoded fields.
        const drive = v.driveType ? v.driveType.replace(/\s*Wheel Drive\s*/i, "WD").trim() : "";
        const trans = v.transmission ? v.transmission.replace(/Automatic/i, "Auto") : "";
        const doors = v.doors ? `${v.doors}-door` : "";
        const plant = [v.plantCity, v.plantCountry].filter(Boolean).join(", ");
        const chips = [v.bodyClass, v.engine, v.fuelType, drive, trans, doors]
          .filter(Boolean)
          .map(s => `<span class="vin-tl-chip">${esc(s)}</span>`)
          .join("");
        const mfg = v.manufacturer
          ? `<div class="vin-tl-mfg">${esc(v.manufacturer)}${plant ? ` &nbsp;·&nbsp; ${esc(plant)}` : ""}</div>`
          : (plant ? `<div class="vin-tl-mfg">${esc(plant)}</div>` : "");
        return `
          <div class="vin-tl-vehicle">${icons.vehicle}${icons.fuel}<span class="vin-tl-vehicle-name">${name}</span></div>
          ${chips ? `<div class="vin-tl-chips">${chips}</div>` : ""}
          ${mfg}
        `;
      })()
    : "";

  // Paginate: only render the first VIN_TL_PAGE_SIZE events. changeVinTimelinePage()
  // handles subsequent page loads without re-fetching from Supabase.
  const totalPages = Math.max(1, Math.ceil(events.length / VIN_TL_PAGE_SIZE));
  const html = events.slice(0, VIN_TL_PAGE_SIZE).map(_buildVinTimelineRowHtml).join("");
  const pagerHtml = _buildVinTimelinePagerHtml(1, totalPages);

  const latestRec = records[0] || null;
  const latestStatus = latestRec?.status || "";
  const latestStatusDisp = latestRec
    ? (latestRec.status === "OTHER" && latestRec.status_other ? `OTHER: ${latestRec.status_other}` : statusLabel(latestRec.status))
    : "";
  const mfStream = records
    .map(r => ({ ts: r.ts ? +new Date(r.ts) : 0, mileage: r.mileage, fuel_level: r.fuel_level }))
    .sort((a, b) => b.ts - a.ts);
  const latestMileage = mfStream.find(x => Number.isFinite(x.mileage))?.mileage ?? null;
  const latestFuel    = mfStream.find(x => x.fuel_level)?.fuel_level ?? null;
  const FUEL_PCT = { "EMPTY": 0, "1/4": 25, "1/2": 50, "3/4": 75, "FULL": 100 };
  const fuelGauge = latestFuel ? (() => {
    const pct = FUEL_PCT[latestFuel] ?? 0;
    const lowCls = pct <= 25 ? " is-low" : pct <= 50 ? " is-mid" : "";
    return `
      <div class="vin-tl-fuel">
        <div class="vin-tl-fuel-head">
          <span class="vin-tl-fuel-label"><svg class="ico-fuel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="11" height="18" rx="1"/><line x1="3" y1="9" x2="14" y2="9"/><path d="M14 13h3a2 2 0 0 1 2 2v2a1.5 1.5 0 0 0 3 0V8l-3-3"/></svg>FUEL</span>
          <span class="vin-tl-fuel-value">${esc(latestFuel)}</span>
        </div>
        <div class="vin-tl-fuel-gauge${lowCls}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Fuel level ${esc(latestFuel)}">
          <div class="vin-tl-fuel-fill" style="width:${pct}%"></div>
          <div class="vin-tl-fuel-ticks"><span></span><span></span><span></span></div>
        </div>
        <div class="vin-tl-fuel-scale"><span>E</span><span>¼</span><span>½</span><span>¾</span><span>F</span></div>
      </div>`;
  })() : "";
  const latestIsPriority = Array.isArray(latestRec?.conditions) && latestRec.conditions.includes("PRIORITY");
  const headerMod = latestIsPriority         ? "vin-tl-header--priority"
                  : latestStatus === "HOLD"  ? "vin-tl-header--hold"
                  : latestStatus === "DNR"   ? "vin-tl-header--dnr"
                  : "";
  const statusPill = latestStatus
    ? `<span class="vin-tl-status-pill ${statusClass(latestStatus)}">${esc(latestStatusDisp)}</span>`
    : "";
  const mileageLine = Number.isFinite(latestMileage)
    ? `<div class="vin-tl-mileage"><svg class="ico-mileage" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 16a9 9 0 0 1 18 0"/><path d="M12 16 16 10"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/></svg>${latestMileage.toLocaleString()} mi</div>` : "";
  const headerRight = (statusPill || mileageLine)
    ? `<div class="vin-tl-header-right">${statusPill}${mileageLine}</div>` : "";

  // Aggregate damage marks + latest tire state across every record for this VIN.
  // Damage is deduped by (panel_id + damage_type), keeping the most recent
  // occurrence. Tire state is whichever record most recently reported it.
  const aggDamageMap = new Map();
  const aggTireDetails = {};
  let aggClaimNum = "";
  let aggClaimNotes = "";
  let aggLegacyTires = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (Array.isArray(rec.damage_marks)) {
      rec.damage_marks.forEach(m => {
        const key = `${m.panel_id}|${m.damage_type}`;
        aggDamageMap.set(key, m);
      });
    }
    if (rec.tire_details && typeof rec.tire_details === "object") {
      Object.entries(rec.tire_details).forEach(([pos, val]) => { aggTireDetails[pos] = val; });
    }
    if (rec.claim_number) { aggClaimNum = rec.claim_number; aggClaimNotes = rec.claim_notes || ""; }
    if (Array.isArray(rec.tires) && rec.tires.length) aggLegacyTires = rec.tires;
  }
  const aggDamageMarks = Array.from(aggDamageMap.values());
  const hasAggDamage = aggDamageMarks.length > 0 || aggClaimNum;
  const hasAggTire = Object.keys(aggTireDetails).length > 0 || aggLegacyTires.length > 0;
  const aggDamageCount = aggDamageMarks.length;
  const aggTireFlagged = DT_DAMAGE
    ? DT_DAMAGE.TIRE_POSITIONS.filter(pos => {
        const t = aggTireDetails[pos];
        return (t && t.condition && t.condition !== "OK") || aggLegacyTires.includes(pos);
      }).length
    : 0;
  const aggDamagePanel = hasAggDamage ? `
    <details class="disclosure vin-tl-collapse" id="vinTlDamageCollapse">
      <summary class="disclosure-summary">
        <span class="field-label">Body damage on file</span>
        <span class="disclosure-count">${aggDamageCount ? `${aggDamageCount} mark${aggDamageCount === 1 ? "" : "s"}` : (aggClaimNum ? "claim" : "")}</span>
      </summary>
      <div class="disclosure-body"><div id="vinTlDamageMount"></div></div>
    </details>` : "";
  const aggTirePanel = hasAggTire ? `
    <details class="disclosure vin-tl-collapse" id="vinTlTireCollapse">
      <summary class="disclosure-summary">
        <span class="field-label">Tires — latest</span>
        <span class="disclosure-count">${aggTireFlagged ? `${aggTireFlagged} flagged` : ""}</span>
      </summary>
      <div class="disclosure-body"><div id="vinTlTireMount"></div></div>
    </details>` : "";

  container.innerHTML = `
    <div class="vin-tl-header ${headerMod}">
      <div class="vin-tl-header-top">
        <div class="vin-tl-label">VIN HISTORY</div>
        ${headerRight}
      </div>
      <div class="vin-tl-vin">${esc(vin)}</div>
      ${headerVehicle}
      <div class="vin-tl-count">${events.length} event${events.length === 1 ? "" : "s"}</div>
      ${fuelGauge}
      <div id="vinTlRecalls" class="vin-tl-recalls" hidden></div>
      ${aggDamagePanel}
      ${aggTirePanel}
    </div>
    <div class="vin-tl-actions">
      <button type="button" class="btn btn-primary vin-tl-new-entry" onclick="openInlineNewEntry('${esc(vin)}')">+ New Entry</button>
    </div>
    <div id="vinTlEntrySlot" class="vin-tl-entry-slot"></div>
    <div class="vin-tl-list">${html}</div>
    ${pagerHtml}
  `;
  if (window.DT_DAMAGE) {
    if (hasAggDamage) {
      DT_DAMAGE.renderDamageViewer(document.getElementById("vinTlDamageMount"), {
        damage_marks: aggDamageMarks,
        claim_number: aggClaimNum,
        claim_notes: aggClaimNotes
      });
    }
    if (hasAggTire) {
      DT_DAMAGE.renderTireViewer(document.getElementById("vinTlTireMount"), {
        tire_details: aggTireDetails,
        tires: aggLegacyTires
      });
    }
  }
  // Fetch NHTSA open recalls for this year/make/model and inject a badge +
  // collapsible detail panel into the header once results land. Fire-and-forget
  // so the timeline renders immediately even if the API is slow.
  if (headerVin?.year && headerVin?.make && headerVin?.model) {
    getRecalls(headerVin.year, headerVin.make, headerVin.model).then(list => {
      const panel = container.querySelector('#vinTlRecalls');
      if (!panel || !list.length) return;
      const rows = list.map(r => {
        const id = sanitizeText(r.NHTSACampaignNumber || "");
        const comp = sanitizeText(r.Component || "Recall");
        const summary = sanitizeText(r.Summary || "");
        const link = id ? `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(id)}` : "";
        const titleHtml = link
          ? `<a class="recall-title" href="${link}" target="_blank" rel="noopener">${comp}</a>`
          : `<span class="recall-title">${comp}</span>`;
        return `
          <li class="recall-row">
            ${titleHtml}
            ${id ? `<span class="recall-id">${id}</span>` : ""}
            ${summary ? `<div class="recall-summary">${summary}</div>` : ""}
          </li>`;
      }).join("");
      panel.hidden = false;
      panel.innerHTML = `
        <button type="button" class="recall-toggle" aria-expanded="false">
          <span class="recall-badge">${list.length}</span>
          <span class="recall-toggle-label">OPEN RECALL${list.length === 1 ? "" : "S"}</span>
          <svg class="recall-chevron icon icon--sm" aria-hidden="true"><use href="#icon-chevron-down"/></svg>
        </button>
        <ul class="recall-list" hidden>${rows}</ul>
      `;
      const btn = panel.querySelector('.recall-toggle');
      const ul = panel.querySelector('.recall-list');
      btn.addEventListener('click', () => {
        const open = ul.hasAttribute('hidden');
        if (open) ul.removeAttribute('hidden'); else ul.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', String(open));
      });
    });
  }

  // Stash the state before wiring clicks so the pager can find it.
  _activeVinTimeline = { container, events, records, page: 1 };
  _wireVinTimelineRowClicks(container, records);

  container._vinTimelineVin = vin;

  const pins = [];
  records.forEach(r => { if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) pins.push({ lat: r.lat, lng: r.lng, label: r.serial_id, ts: new Date(r.ts).getTime() || 0 }); });
  _renderRecordsMapMarkers(pins);
}

function renderPaginationControls(current, total) {
  const prevDisabled = current <= 1;
  const nextDisabled = current >= total;

  // Build numbered page buttons (max 5 visible: current ± 2)
  let pageButtons = "";
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);

  if (start > 1) {
    pageButtons += `<button class="page-btn" onclick="changeRecordsPage(1)">1</button>`;
    if (start > 2) pageButtons += `<span class="page-ellipsis">...</span>`;
  }
  for (let i = start; i <= end; i++) {
    pageButtons += `<button class="page-btn ${i === current ? 'active' : ''}" onclick="changeRecordsPage(${i})">${i}</button>`;
  }
  if (end < total) {
    if (end < total - 1) pageButtons += `<span class="page-ellipsis">...</span>`;
    pageButtons += `<button class="page-btn" onclick="changeRecordsPage(${total})">${total}</button>`;
  }

  return `
    <div class="pagination">
      <button class="page-btn page-nav" ${prevDisabled ? 'disabled' : ''} onclick="changeRecordsPage(${current - 1})">&#8592; Prev</button>
      <div class="page-numbers">${pageButtons}</div>
      <button class="page-btn page-nav" ${nextDisabled ? 'disabled' : ''} onclick="changeRecordsPage(${current + 1})">Next &#8594;</button>
    </div>`;
}

// ============================
// RECORD DETAIL OVERLAY
// ============================
let _detailDeleteFn = null;
let _currentDetailRecordId = null;

function openDetail(id, onDelete) {
  const records = getRecords();
  const r = records.find(rec => rec.id === id);
  if (!r) return;

  _currentDetailRecordId = id;

  document.getElementById("detailSerial").textContent = r.serialId || "";
  document.getElementById("detailTime").textContent =
    (window.dtTimeAgo && window.dtTimeAgo(r.timestamp))
    || new Date(r.timestamp).toLocaleString("en-US", { weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZone:"America/New_York" });

  const detailStatusLabel = r.status === "OTHER" && r.statusOther ? `OTHER: ${r.statusOther}` : statusLabel(r.status);
  const detailDestLabel = locationLabel(r.destination, r.destinationOther, r.sectionName);
  document.getElementById("detailBadges").innerHTML = `
    <span class="record-status ${statusClass(r.status)}">${sanitizeText(detailStatusLabel)}</span>
    ${detailDestLabel ? `<span class="badge-dest">${sanitizeText(detailDestLabel)}</span>` : ""}
    ${r.shuttle ? '<span class="badge-shuttle">SHUTTLE</span>' : ""}
    ${r.transport ? '<span class="badge-transport">TRANSPORT</span>' : ""}
    ${r.noTag ? '<span class="badge-notag">BAD TAG</span>' : ""}
    ${(r.damage_marks && r.damage_marks.length) ? '<span class="badge-damage">DAMAGE</span>' : ""}
  `;


  // Vehicle info
  const vinSection = document.getElementById("detailVinSection");
  if (r.vinData) {
    const name = [r.vinData.year, r.vinData.make, r.vinData.model].filter(Boolean).map(sanitizeText).join(" ");
    const trim = sanitizeText(r.vinData.trim || "");
    const specs = [r.vinData.bodyClass, r.vinData.engine, r.vinData.fuelType].filter(Boolean).map(sanitizeText).join("  ·  ");
    const icons = getVehicleSVG({...r.vinData, _size: 72});
    document.getElementById("detailVinIcon").innerHTML = icons.vehicle + icons.fuel;
    document.getElementById("detailVinName").textContent = name + (trim ? "  " + trim : "");
    document.getElementById("detailVinSpecs").textContent = specs;
    vinSection.style.display = "flex";
  } else {
    vinSection.style.display = "none";
  }

  // Tires row
  const tiresRow = document.getElementById("detailTiresRow");
  if (r.tires && r.tires.length > 0) {
    document.getElementById("detailTires").textContent = r.tires.join(", ");
    tiresRow.style.display = "flex";
  } else { tiresRow.style.display = "none"; }

  // Destination row
  const destRow = document.getElementById("detailDestRow");
  if (detailDestLabel) {
    document.getElementById("detailDest").textContent = detailDestLabel;
    destRow.style.display = "flex";
  } else { destRow.style.display = "none"; }

  // Notes row
  const notesRow = document.getElementById("detailNotesRow");
  if (r.notes) {
    document.getElementById("detailNotes").textContent = r.notes;
    notesRow.style.display = "flex";
  } else { notesRow.style.display = "none"; }

  // Shift
  document.getElementById("detailShift").textContent = r.shiftNum ? `Shift ${r.shiftNum}` : "-";

  // Map
  const noGps = document.getElementById("detailNoGps");
  if (r.lat && r.lng) {
    noGps.style.display = "none";
    const mapDiv = document.getElementById("detailMapFrame");
    if (!window.L) {
      mapDiv.style.display = "none";
      noGps.style.display = "block";
      noGps.textContent = "Map unavailable";
    } else {
      mapDiv.style.display = "block";
      // Small delay to ensure element is visible before Leaflet init
      setTimeout(() => {
        const m = createMap("detailMapFrame");
        if (!m) return;
        m.setView([r.lat, r.lng], 17);
        const color = statusMapColor(r.status);
        const icon = createNumberedMarker("P", color, 32);
        L.marker([r.lat, r.lng], { icon }).addTo(m);
        mapDiv._leaflet_map = m;
      }, 80);
    }
  } else {
    const mapDiv = document.getElementById("detailMapFrame");
    if (mapDiv._leaflet_map) {
      mapDiv._leaflet_map.remove();
      mapDiv._leaflet_map = null;
    }
    mapDiv.style.display = "none";
    mapDiv.innerHTML = "";
    noGps.style.display = "block";
  }

  // Delete button
  _detailDeleteFn = () => {
    if (!confirm("Delete this record? This cannot be undone.")) return;
    setRecords(getRecords().filter(rec => rec.id !== id));
    closeDetail();
    if (onDelete === "deleteTodayRecord") renderTodayEntries();
    else renderRecords();
  };
  document.getElementById("detailDeleteBtn").onclick = _detailDeleteFn;

  document.getElementById("detailOverlay").classList.add("open");
}

function closeDetail() {
  document.getElementById("detailOverlay").classList.remove("open");
  const mapDiv = document.getElementById("detailMapFrame");
  if (mapDiv && mapDiv._leaflet_map) {
    mapDiv._leaflet_map.remove();
    mapDiv._leaflet_map = null;
  }
  if (mapDiv) mapDiv.innerHTML = "";
}

// ============================
// EDIT RECORD
// ============================
function openEdit() {
  if (!_currentDetailRecordId) return;
  const records = getRecords();
  const r = records.find(rec => rec.id === _currentDetailRecordId);
  if (!r) return;

  document.getElementById("editSerial").value = r.serialId || "";
  document.getElementById("editNotes").value = r.notes || "";
  document.getElementById("editTime").textContent =
    (window.dtTimeAgo && window.dtTimeAgo(r.timestamp))
    || new Date(r.timestamp).toLocaleString("en-US", { weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZone:"America/New_York" });

  toggleEditClearBtn();
  updateEditVinCount();

  // Hide any leftover status message
  const status = document.getElementById("editVinStatus");
  status.style.display = "none";
  status.textContent = "";

  // Close the detail overlay underneath so we don't stack
  document.getElementById("detailOverlay").classList.remove("open");
  document.getElementById("editOverlay").classList.add("open");
}

function closeEdit() {
  document.getElementById("editOverlay").classList.remove("open");
}

function saveEdit() {
  if (!_currentDetailRecordId) return;
  const records = getRecords();
  const idx = records.findIndex(rec => rec.id === _currentDetailRecordId);
  if (idx === -1) {
    showToast("Record not found", "error");
    return;
  }

  const newSerial = sanitizeSerial(
    document.getElementById("editSerial").value.trim().toUpperCase()
  );
  const newNotes = sanitizeNotes(document.getElementById("editNotes").value);

  if (!newSerial) {
    showToast("Serial ID cannot be empty", "warn");
    return;
  }

  const oldSerial = records[idx].serialId;
  const serialChanged = oldSerial !== newSerial;

  // Apply text changes immediately
  records[idx].serialId = newSerial;
  records[idx].notes = newNotes;

  // If VIN changed, clear stale vinData so the new lookup replaces it
  if (serialChanged) {
    records[idx].vinData = null;
  }

  setRecords(records);

  const saveBtn = document.getElementById("editSaveBtn");

  if (serialChanged && isValidVIN(newSerial)) {
    // Re-fetch NHTSA data for the new VIN
    const status = document.getElementById("editVinStatus");
    status.style.display = "block";
    status.className = "gps-status";
    status.textContent = "Looking up vehicle info...";
    saveBtn.disabled = true;

    decodeVIN(newSerial).then(vinData => {
      const recs = getRecords();
      const rec = recs.find(rr => rr.id === _currentDetailRecordId);
      if (rec) {
        rec.vinData = vinData || null;
        setRecords(recs);
      }
      showToast("Record updated - VIN refreshed", "success");
      saveBtn.disabled = false;
      closeEdit();
      renderRecords();
      renderTodayEntries();
    }).catch(() => {
      showToast("Record saved (VIN lookup failed)", "warn");
      saveBtn.disabled = false;
      closeEdit();
      renderRecords();
      renderTodayEntries();
    });
  } else {
    showToast("Record updated", "success");
    closeEdit();
    renderRecords();
    renderTodayEntries();
  }
}

// ============================
// EXPORT CSV
// ============================
function csvEscape(v) {
  let s = v === undefined || v === null ? "" : String(v);
  // Defuse spreadsheet formula injection: leading =, +, -, @, tab, CR
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // Quote any field containing a quote, comma, or newline; escape quotes by doubling
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCSV() {
  const records = getFiltered();
  if (records.length === 0) { showToast("No records to export.", "error"); return; }
  const rows = [["ID","Serial ID","Year","Make","Model","Status","Tires","Location","Shuttle","Transport","Bad Tag","Notes","Latitude","Longitude","Timestamp"]];
  records.forEach(r => rows.push([
    r.id, r.serialId,
    r.vinData ? r.vinData.year : "",
    r.vinData ? r.vinData.make : "",
    r.vinData ? r.vinData.model : "",
    r.status,
    r.tires && r.tires.length > 0 ? r.tires.join("|") : "",
    r.destination || "",
    r.shuttle ? "YES" : "NO",
    r.transport ? "YES" : "NO",
    r.noTag ? "YES" : "NO",
    r.notes || "",
    r.lat !== undefined ? r.lat.toFixed(6) : "",
    r.lng !== undefined ? r.lng.toFixed(6) : "",
    new Date(r.timestamp).toLocaleString()
  ]));
  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = getDriverFileName("drivertrax", "csv");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================
// DASHBOARD
// ============================
function startOfWeek(d) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() - dt.getDay());
  dt.setHours(0,0,0,0);
  return dt;
}

function isoDate(d) { return d.toISOString().slice(0,10); }

// ============================
// PERSONAL RECORDS
// ============================
function renderPersonalRecords() {
  const el = document.getElementById("dashPersonalRecords");
  if (!el) return;

  const all = getRecords();
  if (all.length === 0) {
    el.innerHTML = '<p class="u-empty">No records yet - start scanning to build your stats.</p>';
    return;
  }

  const allShifts = getAllShifts();

  // --- Best shift (most records in a single shift) ---
  let bestShift = null, bestShiftCount = 0;
  allShifts.forEach(shift => {
    if (shift.records.length > bestShiftCount) {
      bestShiftCount = shift.records.length;
      bestShift = shift;
    }
  });
  const bestShiftDate = bestShift ? bestShift.date : "-";

  // --- Best day (most records in a single EST calendar day) ---
  const byDay = {};
  all.forEach(r => {
    const d = estDateStr(r.timestamp);
    byDay[d] = (byDay[d] || 0) + 1;
  });
  const bestDayEntry = Object.entries(byDay).sort((a,b) => b[1]-a[1])[0];
  const bestDayCount = bestDayEntry ? bestDayEntry[1] : 0;
  const bestDayDate  = bestDayEntry ? bestDayEntry[0] : "-";

  // --- Best avg trip time in a shift (lowest avg gap = fastest) ---
  let bestAvgShift = null, bestAvgMs = Infinity;
  allShifts.forEach(shift => {
    if (shift.records.length < 2) return;
    const ts = shift.records.map(r => r.timestamp).sort((a,b) => a-b);
    let totalGap = 0;
    for (let i = 1; i < ts.length; i++) totalGap += ts[i] - ts[i-1];
    const avg = totalGap / (ts.length - 1);
    if (avg < bestAvgMs) { bestAvgMs = avg; bestAvgShift = shift; }
  });
  const bestAvgMins = bestAvgShift ? Math.round(bestAvgMs / 60000) : null;
  const bestAvgDate = bestAvgShift ? bestAvgShift.date : "-";

  // --- Current active streak (consecutive calendar days with at least 1 entry) ---
  const today = estDateStr(Date.now());
  const daysWithEntries = new Set(Object.keys(byDay));
  let streak = 0;
  let checkDate = new Date();
  // If no entry today, check if yesterday breaks the streak
  if (!daysWithEntries.has(today)) {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    if (!daysWithEntries.has(estDateStr(yesterday.getTime()))) {
      streak = 0;
    } else {
      checkDate = yesterday;
    }
  }
  if (daysWithEntries.has(estDateStr(checkDate.getTime()))) {
    let d = new Date(checkDate);
    while (daysWithEntries.has(estDateStr(d.getTime()))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
  }

  // --- Longest streak ever ---
  const allDays = [...daysWithEntries].sort();
  let longestStreak = 0, currentRun = 0, prevDate = null;
  allDays.forEach(d => {
    if (!prevDate) { currentRun = 1; }
    else {
      const prev = new Date(prevDate + "T12:00:00");
      const curr = new Date(d + "T12:00:00");
      const diffDays = Math.round((curr - prev) / 86400000);
      currentRun = diffDays === 1 ? currentRun + 1 : 1;
    }
    if (currentRun > longestStreak) longestStreak = currentRun;
    prevDate = d;
  });

  // --- Total days worked ---
  const totalDays = Object.keys(byDay).length;

  // --- All time avg per day ---
  const allTimeAvg = totalDays > 0 ? Math.round(all.length / totalDays) : 0;

  const streakEmoji = streak >= 7 ? "&#128293;&#128293;" : streak >= 3 ? "&#128293;" : "&#9733;";

  el.innerHTML = `
    <div class="pr-grid">
      <div class="pr-card highlight" onclick="viewByDate('${bestDayDate}')">
        <div class="pr-label">Best Day</div>
        <div class="pr-value">${bestDayCount}</div>
        <div class="pr-sub">${bestDayDate}</div>
      </div>
      <div class="pr-card highlight">
        <div class="pr-label">Best Shift</div>
        <div class="pr-value">${bestShiftCount}</div>
        <div class="pr-sub">${bestShiftDate}</div>
      </div>
      <div class="pr-card">
        <div class="pr-label">Fastest Avg</div>
        <div class="pr-value">${bestAvgMins !== null ? bestAvgMins + "m" : "--"}</div>
        <div class="pr-sub">avg trip time${bestAvgDate !== "-" ? "<br>" + bestAvgDate : ""}</div>
      </div>
      <div class="pr-card">
        <div class="pr-label">Avg Per Day</div>
        <div class="pr-value">${allTimeAvg}</div>
        <div class="pr-sub">over ${totalDays} day${totalDays !== 1 ? "s" : ""}</div>
      </div>
      <div class="pr-card ${streak >= 3 ? "highlight" : ""}">
        <div class="pr-label">Current Streak ${streakEmoji}</div>
        <div class="pr-value">${streak}</div>
        <div class="pr-sub">day${streak !== 1 ? "s" : ""} in a row</div>
      </div>
      <div class="pr-card">
        <div class="pr-label">Longest Streak</div>
        <div class="pr-value">${longestStreak}</div>
        <div class="pr-sub">day${longestStreak !== 1 ? "s" : ""} record</div>
      </div>
    </div>`;
}

// ============================
// COLLAPSIBLE RANGE VIEWS
// ============================
// The radio-group behavior (only one open at a time) is handled natively by
// <details name="dash-range">. We just listen for opens to lazy-render each range.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('.dash-range[data-range]').forEach(el => {
    el.addEventListener('toggle', () => {
      if (el.open) renderRange(el.dataset.range);
    });
  });
});

function renderRange(id) {
  const now = new Date();
  const today = estDateStr(now.getTime());
  const all = getRecords();

  let cutoff, groupFn, labelFn, title;

  if (id === '7days') {
    // Already rendered by renderDashboard - just ensure visible
    return;
  } else if (id === '30days') {
    cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 30);
    groupFn = r => estDateStr(r.timestamp);
    labelFn = d => d.slice(5);
    title = 'Last 30 Days';
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      days.push(estDateStr(d.getTime()));
    }
    renderRangeTable('dash30days', all, days, groupFn, labelFn, today);
  } else if (id === '3months') {
    cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 3);
    const weeks = getWeekBuckets(now, 13);
    renderRangeWeekTable('dash3months', all, weeks, today);
  } else if (id === '6months') {
    cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 6);
    const weeks = getWeekBuckets(now, 26);
    renderRangeWeekTable('dash6months', all, weeks, today);
  } else if (id === '1year') {
    const months = getMonthBuckets(now, 12);
    renderRangeMonthTable('dash1year', all, months);
  } else if (id === 'alltime') {
    const months = getAllMonthBuckets(all);
    renderRangeMonthTable('dashAlltime', all, months);
  }
}

function getWeekBuckets(now, count) {
  const weeks = [];
  for (let i = count - 1; i >= 0; i--) {
    const end = new Date(now); end.setDate(end.getDate() - (i * 7));
    const start = new Date(end); start.setDate(start.getDate() - 6);
    weeks.push({ start: estDateStr(start.getTime()), end: estDateStr(end.getTime()) });
  }
  return weeks;
}

function getMonthBuckets(now, count) {
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    months.push(key);
  }
  return months;
}

function getAllMonthBuckets(records) {
  if (!records.length) return [];
  const keys = new Set();
  records.forEach(r => {
    const d = new Date(r.timestamp);
    keys.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  });
  return [...keys].sort();
}

function renderRangeTable(elId, all, days, groupFn, labelFn, today) {
  const byDay = {};
  days.forEach(d => byDay[d] = 0);
  all.forEach(r => {
    const k = groupFn(r);
    if (byDay[k] !== undefined) byDay[k]++;
  });
  const nonZero = days.filter(d => byDay[d] > 0);
  if (!nonZero.length) {
    document.getElementById(elId).innerHTML = '<p class="u-empty">No entries in this period</p>';
    return;
  }
  const max = Math.max(...nonZero.map(d => byDay[d]));
  document.getElementById(elId).innerHTML = `
    <table class="stat-table">
      <thead><tr>
        <th>Date</th>
        <th></th>
        <th class="right">Cars</th>
      </tr></thead>
      <tbody>
        ${nonZero.map(d => `
          <tr class="u-cursor-pointer" onclick="viewByDate('${d}')">
            <td class="nowrap${d===today?" u-text-accent day-cell-row-today":""}">${labelFn(d)}${d===today?' (today)':''}</td>
            <td class="label">
              <div class="stat-bar" style="width:${Math.round((byDay[d]/max)*100)}%"></div>
            </td>
            <td class="right">${byDay[d]}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderRangeWeekTable(elId, all, weeks, today) {
  const byWeek = weeks.map(w => {
    const count = all.filter(r => {
      const d = estDateStr(r.timestamp);
      return d >= w.start && d <= w.end;
    }).length;
    return { ...w, count };
  }).filter(w => w.count > 0);

  if (!byWeek.length) {
    document.getElementById(elId).innerHTML = '<p class="u-empty">No entries in this period</p>';
    return;
  }
  const max = Math.max(...byWeek.map(w => w.count));
  document.getElementById(elId).innerHTML = `
    <table class="stat-table">
      <thead><tr>
        <th>Week</th>
        <th></th>
        <th class="right">Cars</th>
      </tr></thead>
      <tbody>
        ${byWeek.map(w => `
          <tr class="u-cursor-pointer" onclick="viewByWeek('${w.start}','${w.end}','${w.start} to ${w.end}')">
            <td class="nowrap">${w.start.slice(5)} - ${w.end.slice(5)}</td>
            <td class="label">
              <div class="stat-bar" style="width:${Math.round((w.count/max)*100)}%"></div>
            </td>
            <td class="right">${w.count}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderRangeMonthTable(elId, all, months) {
  if (!months.length) {
    document.getElementById(elId).innerHTML = '<p class="u-empty">No entries in this period</p>';
    return;
  }
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const byMonth = months.map(m => {
    const count = all.filter(r => {
      const d = new Date(r.timestamp);
      const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      return k === m;
    }).length;
    const [yr, mo] = m.split('-');
    return { key: m, label: `${monthNames[parseInt(mo)-1]} ${yr}`, count };
  }).filter(m => m.count > 0);

  if (!byMonth.length) {
    document.getElementById(elId).innerHTML = '<p class="u-empty">No entries in this period</p>';
    return;
  }
  const max = Math.max(...byMonth.map(m => m.count));
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  document.getElementById(elId).innerHTML = `
    <table class="stat-table">
      <thead><tr>
        <th>Month</th>
        <th></th>
        <th class="right">Cars</th>
      </tr></thead>
      <tbody>
        ${byMonth.map(m => {
          const [yr, mo] = m.key.split('-');
          const fromDate = `${m.key}-01`;
          const toDate = new Date(parseInt(yr), parseInt(mo), 0);
          const toStr = `${yr}-${mo}-${String(toDate.getDate()).padStart(2,'0')}`;
          return `<tr class="u-cursor-pointer" onclick="viewByWeek('${fromDate}','${toStr}','${m.label}')">
            <td class="${m.key===thisMonth?'u-text-accent day-cell-row-today':''}">${m.label}${m.key===thisMonth?' ·':''}</td>
            <td class="label">
              <div class="stat-bar" style="width:${Math.round((m.count/max)*100)}%"></div>
            </td>
            <td class="right">${m.count}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ============================
// RECORDS MAP
// ============================
let recordsLeafletMap = null;
let recordsMapMarkers = [];
// Records map view — native <details> handles the open/close; we just lazy-render on open.
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("recordsMapDisclosure");
  if (!el) return;
  el.addEventListener("toggle", () => {
    if (!el.open) return;
    // If a search has run, prefer its pin set over the full filtered list.
    if (_lastSearchPins !== null) {
      _renderRecordsMapMarkers(_lastSearchPins);
      setTimeout(() => recordsLeafletMap && recordsLeafletMap.invalidateSize(), 50);
    } else {
      renderRecordsMap();
    }
  });
});

// Build a deduped list of VINs from whatever was just rendered into #records,
// each row linking to the VIN Detail modal.
function renderVinDetailList(items) {
  const el = document.getElementById('vinDetailList');
  if (!el) return;
  const seen = new Map();
  const tsNum = (t) => {
    if (!t && t !== 0) return 0;
    if (typeof t === "number") return t;
    const n = new Date(t).getTime();
    return Number.isFinite(n) ? n : 0;
  };
  // Dedup by VIN — collapse multiple events into one row. Keep the values
  // from the most recent event for status / destination / location, since the
  // user wants to see "what's true right now" not the aggregate.
  (items || []).forEach(it => {
    if (!it || !it.vin) return;
    const key = String(it.vin).toUpperCase();
    const t = tsNum(it.ts);
    const cur = seen.get(key) || { vin: key, last: -Infinity, vehicle: it.vehicle || "" };
    if (t > cur.last) {
      cur.last = t;
      // Carry forward only fields the new event actually provided.
      if (it.status) cur.status = it.status;
      if (it.statusOther) cur.statusOther = it.statusOther;
      if (it.destination) cur.destination = it.destination;
      if (it.destinationOther) cur.destinationOther = it.destinationOther;
      if (Number.isFinite(it.lat) && Number.isFinite(it.lng)) {
        cur.lat = it.lat; cur.lng = it.lng;
      }
    }
    if (!cur.vehicle && it.vehicle) cur.vehicle = it.vehicle;
    seen.set(key, cur);
  });
  const rows = Array.from(seen.values()).sort((a, b) => b.last - a.last);
  if (!rows.length) {
    el.innerHTML = `<div class="u-empty">No VINs in current results.</div>`;
    return;
  }
  const esc = (s) => sanitizeText(s);
  const ago = (input) => input ? DT_FORMAT.timeAgo(input) : "";
  el.innerHTML = rows.map(r => {
    const statusDisp = r.status === "OTHER" && r.statusOther
      ? `OTHER: ${r.statusOther}`
      : (r.status ? statusLabel(r.status) : "");
    const statusPill = r.status
      ? `<span class="record-status ${statusClass(r.status)}">${esc(statusDisp)}</span>`
      : "";
    const destDisp = locationLabel(r.destination, r.destinationOther, r.sectionName);
    const pin = (Number.isFinite(r.lat) && Number.isFinite(r.lng))
      ? `<a class="vin-tl-gps" href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener" onclick="event.stopPropagation()" aria-label="Open last location in Maps"><svg class="ico-pin" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 22s-7-7.58-7-13a7 7 0 0 1 14 0c0 5.42-7 13-7 13zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg></a>`
      : "";
    const subParts = [
      r.vehicle ? esc(r.vehicle) : "",
      destDisp ? esc(destDisp) : "",
      r.last ? esc(ago(r.last)) : ""
    ].filter(Boolean).join(" · ");
    return `
      <div class="vin-detail-row" data-vin="${esc(r.vin)}">
        <div class="vin-detail-main">
          <div class="vin-detail-vin">${esc(r.vin)}</div>
          ${subParts ? `<div class="vin-detail-sub">${subParts}</div>` : ""}
        </div>
        <div class="vin-detail-side">
          ${statusPill}
          ${pin}
        </div>
      </div>`;
  }).join("");
  el.querySelectorAll('.vin-detail-row').forEach(row => {
    row.addEventListener('click', () => openVinDetailPanel(row.dataset.vin));
  });
}

// Move the New Entry form into the VIN-detail view so the user can submit
// without leaving the VIN history context. The form node is the live DOM
// (#entryFormBody) — moving it preserves IDs, event handlers, and any
// in-progress state. restoreInlineNewEntry() puts it back in #entryFormHome.
function openInlineNewEntry(vin) {
  const slot = document.getElementById("vinTlEntrySlot");
  const body = document.getElementById("entryFormBody");
  if (!slot || !body) return;
  if (body.parentElement !== slot) {
    slot.innerHTML = `<div class="vin-tl-entry-close-row"><button type="button" class="btn btn-destructive" onclick="restoreInlineNewEntry()">Close</button></div>`;
    slot.appendChild(body);
  }
  // Prefill VIN and make sure the manual-entry section is visible so the
  // serial field can be edited without forcing the user to tap "Enter Manually".
  const serial = document.getElementById("serial");
  if (serial) serial.value = vin || "";
  const manualSection = document.getElementById("manualEntrySection");
  if (manualSection) manualSection.style.display = "";
  // The scan + manual-toggle buttons aren't useful inline — VIN is already
  // known. Hide them while the form lives in the VIN history view.
  const headerBtns = document.getElementById("entryHeaderButtons");
  if (headerBtns) headerBtns.style.display = "none";
  if (typeof toggleClearBtn === "function") toggleClearBtn();
  if (typeof updateVinCount === "function") updateVinCount();
  // Populate the current-state banner + placeholder hints on the form fields
  // (status / destination / mileage / fuel). The scan flow does this via the
  // dt-vin-scanned event; inline opening has to trigger it manually.
  if (vin && typeof renderEntryCurrentState === "function") renderEntryCurrentState(vin);
  // Hide the New Entry trigger button while the form is open.
  const trigger = document.querySelector(".vin-tl-new-entry");
  if (trigger) trigger.style.display = "none";
  slot.scrollIntoView({ behavior: "smooth", block: "start" });
}

function restoreInlineNewEntry() {
  const home = document.getElementById("entryFormHome");
  const body = document.getElementById("entryFormBody");
  if (!home || !body) return;
  if (body.parentElement !== home) home.appendChild(body);
  const slot = document.getElementById("vinTlEntrySlot");
  if (slot) slot.innerHTML = "";
  const trigger = document.querySelector(".vin-tl-new-entry");
  if (trigger) trigger.style.display = "";
  const headerBtns = document.getElementById("entryHeaderButtons");
  if (headerBtns) headerBtns.style.display = "";
}

async function openVinDetailPanel(vin) {
  const title = document.getElementById('vinDetailTitle');
  const body  = document.getElementById('vinDetailBody');
  if (!body || !window.DT_AUTH) return;
  if (title) title.textContent = vin;
  body.innerHTML = `<div class="u-empty">Loading…</div>`;
  if (typeof showTab === "function") showTab('vin-detail');
  renderVinTimeline(vin, { container: body, countEl: null });
}


function renderRecordsMap() {
  const disc = document.getElementById("recordsMapDisclosure");
  if (!disc || !disc.open) return;
  const records = getFiltered().filter(r => r.lat && r.lng);
  const mapEl = document.getElementById('recordsMap');
  const emptyEl = document.getElementById('recordsMapEmpty');

  if (!records.length) {
    mapEl.style.display = 'none';
    emptyEl.style.display = 'flex';
    return;
  }

  if (!window.L) {
    emptyEl.style.display = 'flex';
    emptyEl.textContent = 'Map unavailable - library not loaded';
    return;
  }

  emptyEl.style.display = 'none';
  mapEl.style.display = 'block';

  setTimeout(() => {
    if (!recordsLeafletMap) {
      recordsLeafletMap = createMap('recordsMap');
      if (!recordsLeafletMap) return;
    } else {
      recordsMapMarkers.forEach(m => recordsLeafletMap.removeLayer(m));
      recordsMapMarkers = [];
    }

    recordsLeafletMap.invalidateSize();
    const bounds = [];

    records.forEach((r, i) => {
      const color = statusMapColor(r.status);
      const icon = createNumberedMarker(i+1, color, 26);
      const time = DT_FORMAT.timeAgoOrClock(r.timestamp);
      const marker = L.marker([r.lat, r.lng], { icon })
        .addTo(recordsLeafletMap)
        .bindPopup(`
          <div class="map-popup">
            <div class="map-popup__title">${sanitizeText(r.serialId)}</div>
            <div class="map-popup__status">${sanitizeText(statusLabel(r.status))}${r.destination ? ' · ' + sanitizeText(r.destination) : ''}</div>
            <div class="map-popup__time">${time}</div>
            <button class="map-popup__btn" onclick="document.getElementById('recordsMap')._openDetail('${r.id}')">
              View Record
            </button>
          </div>`, { maxWidth: 200 });
      recordsMapMarkers.push(marker);
      bounds.push([r.lat, r.lng]);
    });

    document.getElementById('recordsMap')._openDetail = (id) => openDetail(id, 'deleteRecord');

    if (bounds.length === 1) recordsLeafletMap.setView(bounds[0], 17);
    else recordsLeafletMap.fitBounds(bounds, { padding: [32, 32] });
  }, 80);
}

// ============================
// SHIFT MAP (Leaflet.js + OpenStreetMap)
// ============================
let activeShiftMapIndex = null;
let leafletMap = null;
let leafletMarkers = [];
let leafletSectionLayer = null;
let leafletSectionsRendered = false;

function initLeafletMap() {
  if (leafletMap) return;
  leafletMap = createMap("shiftMap");
}

function clearLeafletMarkers() {
  leafletMarkers.forEach(m => leafletMap.removeLayer(m));
  leafletMarkers = [];
}

// Draw each parking_sections polygon on the shift map so drivers can see
// their pins in context. Loaded once per session; the DT_DROPOFFS cache
// handles the fetch. Skipped if the sections view isn't reachable.
async function ensureShiftMapSections() {
  if (leafletSectionsRendered || !leafletMap || !window.L || !window.DT_DROPOFFS) return;
  leafletSectionsRendered = true;
  let sections = [];
  try { sections = await DT_DROPOFFS.getSections(); }
  catch (e) { console.warn("[shift map] sections load", e); return; }
  if (!sections.length) return;
  const statusColor = { open: "#00a651", full: "#e85550", restricted: "#f0b04a" };
  leafletSectionLayer = L.layerGroup().addTo(leafletMap);
  sections.forEach(s => {
    if (!s.rings.length) return;
    const color = statusColor[s.status] || "#4d9bff";
    const poly = L.polygon(s.rings, {
      color, fillColor: color, fillOpacity: 0.10, weight: 1.5, interactive: false
    });
    poly.bindTooltip(s.name, { permanent: false, direction: "center", className: "map-section-label" });
    leafletSectionLayer.addLayer(poly);
  });
}

function renderShiftMap(shiftIndex) {
  const allShifts = getAllShifts();
  const mapEl = document.getElementById("shiftMap");
  const emptyMsg = document.getElementById("shiftMapEmpty");
  const legend = document.getElementById("shiftMapLegend");

  if (!allShifts.length) {
    mapEl.style.display = "none";
    emptyMsg.classList.remove("hidden");
    if (legend) legend.innerHTML = "";
    return;
  }

  if (shiftIndex === undefined || shiftIndex === null) {
    shiftIndex = allShifts.length - 1;
  }
  activeShiftMapIndex = shiftIndex;

  document.querySelectorAll(".shift-map-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.shift) === shiftIndex);
  });

  const shift = allShifts[shiftIndex];
  const records = shift.records.filter(r => r.lat && r.lng);

  if (records.length === 0) {
    mapEl.style.display = "none";
    emptyMsg.classList.remove("hidden");
    emptyMsg.textContent = "No GPS entries for this shift";
    if (legend) legend.innerHTML = "";
    return;
  }

  if (!window.L) {
    emptyMsg.classList.remove("hidden");
    emptyMsg.textContent = "Map unavailable - library not loaded";
    return;
  }

  emptyMsg.classList.add("hidden");
  mapEl.style.display = "block";

  // Init map if needed
  initLeafletMap();
  clearLeafletMarkers();
  ensureShiftMapSections();

  // Force Leaflet to recalculate size after display change
  setTimeout(() => leafletMap.invalidateSize(), 50);

  const bounds = [];

  records.forEach((r, i) => {
    const color = statusMapColor(r.status);
    const num = i + 1;

    // Custom numbered SVG marker
    const icon = createNumberedMarker(num, color, 28);

    const time = DT_FORMAT.timeAgoOrClock(r.timestamp);

    const marker = L.marker([r.lat, r.lng], { icon })
      .addTo(leafletMap)
      .bindPopup(`
        <div class="map-popup">
          <div class="map-popup__title">${sanitizeText(r.serialId)}</div>
          <div class="map-popup__status">${sanitizeText(statusLabel(r.status))}${r.destination ? " · " + sanitizeText(r.destination) : ""}</div>
          <div class="map-popup__time">${time}</div>
          <button class="map-popup__btn" onclick="document.getElementById('shiftMap')._openDetail('${r.id}')">
            View Record
          </button>
        </div>
      `, { maxWidth: 200 });

    marker.on("click", () => {});
    leafletMarkers.push(marker);
    bounds.push([r.lat, r.lng]);
  });

  // Store openDetail reference on the map element for popup button
  document.getElementById("shiftMap")._openDetail = (id) => {
    openDetail(id, "deleteRecord");
  };

  // Fit map to all markers
  if (bounds.length === 1) {
    leafletMap.setView(bounds[0], 17);
  } else {
    leafletMap.fitBounds(bounds, { padding: [32, 32] });
  }

  // Build tap legend
  if (legend) {
    legend.innerHTML = records.map((r, i) => {
      const color = statusMapColor(r.status);
      const time = DT_FORMAT.timeAgoOrClock(r.timestamp);
      return `<div class="map-legend-row" onclick="openDetail('${r.id}', 'deleteRecord')">
        <span class="map-legend-num" style="background:#${color}">${i+1}</span>
        <span class="map-legend-serial">${sanitizeText(r.serialId)}</span>
        <span class="record-status map-legend-status ${statusClass(r.status)}">${sanitizeText(statusLabel(r.status))}</span>
        <span class="map-legend-time">${time}</span>
        <span class="map-legend-arrow">&#8594;</span>
      </div>`;
    }).join("");
  }
}

function statusMapColor(status) {
  const map = {
    "CLEAN":"00a651","DIRTY":"e85550",
    "REWASH":"3dcfcf","TOP OFF FLUID":"6aadff",
    "PM":"4d9bff","MK":"f0b04a","MR":"e85550","OM":"b87be8",
    "AUDIT FAIL":"e85550","TI":"e85550","GLASS":"4d9bff",
    "OTHER":"888888","WI/DELETE":"e85550"
  };
  return map[status] || "888888";
}

function renderShiftMapControls() {
  const allShifts = getAllShifts();
  const controls = document.getElementById("shiftMapControls");
  if (!controls) return;
  if (allShifts.length === 0) { controls.innerHTML = ""; return; }

  const recent = allShifts.slice(-5);
  controls.innerHTML = recent.map((shift, idx) => {
    const realIndex = allShifts.length - recent.length + idx;
    const label = shift.date === estDateStr(Date.now()) ? "Today" : shift.date.slice(5);
    return `<button class="shift-map-btn" data-shift="${realIndex}"
      onclick="renderShiftMap(${realIndex})">
      Shift ${realIndex + 1} &nbsp;·&nbsp; ${label}
    </button>`;
  }).join("");

  renderShiftMap(allShifts.length - 1);
}

// ============================
// DASHBOARD QUOTE
// ============================
const CAR_QUOTES = [
  { text: "If I had asked people what they wanted, they would have said faster horses.", attr: "Henry Ford" },
  { text: "I couldn't find the sports car of my dreams, so I built it myself.", attr: "Ferdinand Porsche" },
  { text: "Everything in life is somewhere else, and you get there in a car.", attr: "E.B. White" },
  { text: "Racing is life. Anything before or after is just waiting.", attr: "Steve McQueen" },
  { text: "The cars we drive say a lot about us.", attr: "Alexandra Paul" },
  { text: "The best car safety device is a rear-view mirror with a cop in it.", attr: "Dudley Moore" },
  { text: "I spent a lot of money on booze, birds, and fast cars. The rest I just squandered.", attr: "George Best" },
  { text: "A car is like a mother-in-law - if you let it, it will rule your life.", attr: "Jaime Lerner" },
  { text: "There's a lot of stress, but once you get in the car, all that goes out the window.", attr: "Danica Patrick" },
  { text: "Straight roads are for fast cars, turns are for fast drivers.", attr: "Colin McRae" }
];

function renderQuote() {
  const q = CAR_QUOTES[Math.floor(Math.random() * CAR_QUOTES.length)];
  const el = document.getElementById("dashQuote");
  if (el) {
    el.innerHTML = `<div class="dash-quote-text">"${sanitizeText(q.text)}"</div><div class="dash-quote-attr">- ${sanitizeText(q.attr)}</div>`;
  }
}

// "By Section" tile — bars showing fleet-wide drop-offs grouped by parking
// section over the last 7 days. Runs the spec's coalesce(section, entered
// name, "Unspecified") join and buckets counts by label. Manager/CXR/admin
// only; caller gates on role before firing.
async function renderDashSection() {
  const el = document.getElementById("dashSection");
  if (!el || !window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from("drop_offs")
    .select("id,section_id,location_name,parking_sections(name)")
    .gte("created_at", since);
  if (error) {
    console.warn("[renderDashSection]", error);
    el.innerHTML = '<p class="dash-empty-inline">Couldn\'t load section counts.</p>';
    return;
  }
  const rows = data || [];
  if (!rows.length) {
    el.innerHTML = '<p class="dash-empty-inline">No drop-offs in the last 7 days.</p>';
    return;
  }
  const counts = {};
  rows.forEach(r => {
    const label = r.parking_sections?.name || r.location_name || "Unspecified";
    counts[label] = (counts[label] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, n]) => n), 1);
  el.innerHTML = entries.map(([label, n]) => `
    <div class="bar-row">
      <div class="bar-key">${sanitizeText(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(n / max * 100)}%"></div></div>
      <div class="bar-val">${n}</div>
    </div>
  `).join("");
}

function renderDashboard() {
  renderQuote();
  renderShiftMapControls();
  renderRange('7days');
  renderPersonalRecords();
  const all = getRecords();
  const now = new Date();
  const today = estDateStr(now.getTime());
  const thisWeekStart = startOfWeek(now);
  const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(thisWeekStart);

  let todayCount=0, thisWeekCount=0, lastWeekCount=0, noTagCount=0;
  all.forEach(r => {
    const d = new Date(r.timestamp);
    if (isoDate(d) === today) todayCount++;
    if (d >= thisWeekStart) thisWeekCount++;
    if (d >= lastWeekStart && d < lastWeekEnd) lastWeekCount++;
    if (r.noTag) noTagCount++;
  });

  const thisWeekEnd = isoDate(now);
  const thisWeekFromStr = isoDate(thisWeekStart);
  const lastWeekFromStr = isoDate(lastWeekStart);
  const lastWeekToStr = isoDate(new Date(lastWeekEnd.getTime() - 86400000));

  document.getElementById("dashOverview").innerHTML = `
    <div class="stat-card clickable" onclick="viewByDate('${today}')">
      <div class="stat-num">${todayCount}</div><div class="stat-label">Today &#8594;</div>
    </div>
    <div class="stat-card clickable" onclick="viewByWeek('${thisWeekFromStr}','${thisWeekEnd}','This Week')">
      <div class="stat-num">${thisWeekCount}</div><div class="stat-label">This Week &#8594;</div>
    </div>
    <div class="stat-card"><div class="stat-num">${all.length}</div><div class="stat-label">Total</div></div>
    <div class="stat-card"><div class="stat-num stat-num--danger">${noTagCount}</div><div class="stat-label">Bad Tag</div></div>
  `;

  const statuses = ["CLEAN","DIRTY","REWASH","BODY","PM","MK","MR","OM","AUDIT FAIL","WI/DELETE","GLASS","TI","OTHER"];
  const sc = {};
  statuses.forEach(s => sc[s] = 0);
  all.forEach(r => { sc[r.status] !== undefined ? sc[r.status]++ : sc["OTHER"]++; });
  const maxS = Math.max(...Object.values(sc), 1);
  document.getElementById("dashStatus").innerHTML = statuses
    .filter(s => sc[s] > 0)
    .map(s => `
      <div class="bar-row">
        <div class="bar-key">${sanitizeText(statusLabel(s))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(sc[s]/maxS*100)}%"></div></div>
        <div class="bar-val">${sc[s]}</div>
      </div>
    `).join("") || '<p class="dash-empty-inline">No data yet.</p>';

  // Manager-only "By Section" tile (from parking_sections + drop_offs).
  // The CSS gate hides the container for drivers, but avoid firing the
  // query for them either.
  if (DT_AUTH?.isManager?.() || DT_AUTH?.isCxr?.() || DT_AUTH?.isAdmin?.()) {
    renderDashSection();
  }

  // Last 7 days - use EST dates to match shift grouping
  const days = [];
  for (let i=6; i>=0; i--) {
    const d = new Date(now); d.setDate(d.getDate()-i);
    days.push(estDateStr(d.getTime()));
  }

  // Group shifts by their start date (EST) for last 7 days
  const byDay = getShiftsByDay(days);

  function avgTripTime(timestamps) {
    if (timestamps.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i-1]);
    const avgMs = gaps.reduce((a,b) => a+b, 0) / gaps.length;
    const mins = Math.round(avgMs / 60000);
    if (mins < 60) return mins + "m";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit", timeZone:"America/New_York"});
  }

  const dn = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  document.getElementById("dashDays").innerHTML = `
    <table class="day-table">
      <thead><tr><th>Date</th><th>Shift</th><th>Cars</th><th>Avg</th><th></th></tr></thead>
      <tbody>
        ${days.map(d => {
          const dt = new Date(d+"T12:00:00");
          const dayName = dn[dt.getDay()];
          const isToday = d === today;
          const shifts = byDay[d];

          if (!shifts || shifts.length === 0) {
            return `<tr>
              <td>${d}${isToday ? ' <b class="day-cell-today">(today)</b>' : ''}<br><span class="day-cell-name">${dayName}</span></td>
              <td class="day-cell-muted">-</td>
              <td class="day-cell-muted">0</td>
              <td class="day-cell-muted">-</td>
              <td></td>
            </tr>`;
          }

          return shifts.map((shift, si) => {
            const shiftLabel = shifts.length > 1 ? `Shift ${si+1}` : "Shift 1";
            const timestamps = shift.records.map(r => r.timestamp);
            const startTime = fmtTime(timestamps[0]);
            const endTime = fmtTime(timestamps[timestamps.length-1]);
            const avg = avgTripTime(timestamps);
            return `<tr class="has-entries" onclick="viewByDate('${d}')">
              ${si === 0 ? `<td rowspan="${shifts.length}">${d}${isToday ? ' <b class="day-cell-today">(today)</b>' : ''}<br><span class="day-cell-name">${dayName}</span></td>` : ''}
              <td>
                <span class="day-cell-shift">${shiftLabel}</span><br>
                <span class="day-cell-shift-t">${startTime} - ${endTime}</span>
              </td>
              <td><b>${shift.records.length}</b></td>
              <td class="day-cell-avg">${avg || '<span class="day-cell-muted">-</span>'}</td>
              <td class="tap-hint">View &#8594;</td>
            </tr>`;
          }).join("");
        }).join("")}
      </tbody>
    </table>`;

  // Week comparison - clickable
  const delta = thisWeekCount - lastWeekCount;
  const dStr = delta>0 ? "&#9650; +"+delta+" vs last week" : delta<0 ? "&#9660; "+delta+" vs last week" : "Same as last week";
  const dCls = delta>0 ? "stat-num--up" : delta<0 ? "stat-num--danger" : "stat-num--flat";
  document.getElementById("dashWeeks").innerHTML = `
    <div class="stat-card clickable" onclick="viewByWeek('${thisWeekFromStr}','${thisWeekEnd}','This Week')">
      <div class="stat-num">${thisWeekCount}</div><div class="stat-label">This Week &#8594;</div>
    </div>
    <div class="stat-card clickable" onclick="viewByWeek('${lastWeekFromStr}','${lastWeekToStr}','Last Week')">
      <div class="stat-num">${lastWeekCount}</div><div class="stat-label">Last Week &#8594;</div>
    </div>
    <div class="stat-card stat-card--wide">
      <div class="stat-num stat-num--sm ${dCls}">${dStr}</div>
      <div class="stat-label">Week-over-Week</div>
    </div>`;
}

// ============================
// BARCODE SCANNER
// Uses native BarcodeDetector when available (fast path),
// falls back to ZXing-JS for iOS Safari and older browsers.
// ============================

// --- Scanner state ---
let scannerActive = false;
let torchOn = false;
let activeStream = null;
let codeReader = null;          // ZXing reader (fallback path only)
let detectionLoopId = null;     // requestAnimationFrame id (native path)
let roiCanvas = null;           // offscreen canvas for ROI cropping
let roiCtx = null;
let lastDecodeTime = 0;
let lastCandidate = null;       // for double-confirm on 1D reads
let lastCandidateAt = 0;
let hardModeTimer = null;       // delayed TRY_HARDER fallback (ZXing path)
let hardModeOn = false;

// --- Tuning ---
const DECODE_THROTTLE_MS = 80;         // min ms between native-path decode attempts
const CONFIRM_WINDOW_MS = 800;         // 1D codes must repeat within this window (default)
const HARD_MODE_DELAY_MS = 700;        // wait this long before flipping ZXing to TRY_HARDER
const TARGET_WIDTH = 1280;             // camera width (sweet spot for speed vs. distance)
const TARGET_HEIGHT = 720;             // camera height

// iOS gets the slow ZXing-JS path (no BarcodeDetector on Safari) so we tune
// more aggressively for it: bigger frame, immediate TRY_HARDER, ROI cropping,
// shorter 1D confirm window, and we prefer the 1× wide camera.
function isIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS posing as Mac
}
const IS_IOS = isIOS();
const IOS_TARGET_WIDTH = 1280;
const IOS_TARGET_HEIGHT = 720;
const IOS_CONFIRM_WINDOW_MS = 500;
const ROI_DECODE_INTERVAL_MS = 90;     // ZXing ROI decode tick on iOS path

let confirmWindowMs = IS_IOS ? IOS_CONFIRM_WINDOW_MS : CONFIRM_WINDOW_MS;
let zxingRoiLoopId = null;             // RAF id for the iOS ROI decode loop
let zxingRoiCanvas = null;
let zxingRoiCtx = null;

// Scanner escalation: when a scan is taking too long, progressively offer help
// rather than auto-closing silently. Hard cap at the end protects battery.
const SCAN_TIMEOUT_MS = 45000;         // hard cap: auto-close after this
let scannerEscalationTimers = [];
let scannerStartedAt = 0;

// ROI crop matches the visible scan strip in CSS:
// horizontal band from 33%–67% vertically, 4%–96% horizontally.
const ROI = { xPct: 0.04, yPct: 0.33, wPct: 0.92, hPct: 0.34 };

// Formats we accept. 1D = the actual lot tags. 2D = VIN-bearing codes.
const ALLOWED_1D = new Set(["code_39", "code_128"]);
const ALLOWED_2D = new Set(["qr_code", "data_matrix", "pdf417", "aztec"]);

// Reuse a single AudioContext across scans. iOS Safari caps live contexts at
// ~4-6; allocating one per beep silently kills audio (and slows the page) after
// a handful of scans.
let _beepCtx = null;
function playScanBeep() {
  try {
    if (!_beepCtx) {
      _beepCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_beepCtx.state === "suspended") {
      try { _beepCtx.resume(); } catch(e) {}
    }
    const ctx = _beepCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(1480, ctx.currentTime);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch(e) {} };
  } catch(e) {}
}

// ---------- Result handling ----------

// Try to extract a 17-char VIN from arbitrary 2D payload (may be URL etc.)
function extractVinFromText(text) {
  const t = (text || "").trim().toUpperCase();
  if (isValidVIN(t)) return t;
  const m = t.match(/[A-HJ-NPR-Z0-9]{17}/);
  return (m && isValidVIN(m[0])) ? m[0] : null;
}

// Common success path. Returns true if accepted (caller should stop scanning).
// is2D codes only accepted when they carry a valid VIN.
function acceptScanResult(rawText, is2D) {
  const code = (rawText || "").trim().toUpperCase();
  if (!code) return false;

  let finalCode = code;
  if (is2D) {
    const vin = extractVinFromText(code);
    if (!vin) return false; // ignore non-VIN 2D codes
    finalCode = vin;
  } else {
    // 1D codes: accept on first read. A previous "double-confirm" gate (require
    // the same value twice within 500–800ms) was rejecting legitimate scans
    // when the decoder only produced one good read before the user moved.
    // We instead trust the format restriction + decoder checksums (Code 128
    // has an internal check digit; Code 39 reads we restrict to alnum), and
    // add a brief re-accept lockout so the same code can't fire twice in a row.
    const now = performance.now();
    const cleaned = code.replace(/[^A-Z0-9\-]/g, "");
    if (cleaned.length < 4) return false; // ignore junk reads
    if (lastCandidate === cleaned && (now - lastCandidateAt) < 1500) {
      // same code, fired moments ago — don't re-trigger
      return false;
    }
    lastCandidate = cleaned;
    lastCandidateAt = now;
    finalCode = cleaned;
  }

  const flash = document.getElementById("scannerFlash");
  if (flash) {
    flash.classList.remove("flash");
    void flash.offsetWidth;
    flash.classList.add("flash");
  }
  haptic("scan");
  playScanBeep();

  const hint = document.getElementById("scannerHint");
  hint.className = "scanner-status success";
  hint.textContent = finalCode;

  if (scanTarget === "search") {
    const fs = document.getElementById("fSearch");
    if (fs) {
      fs.value = finalCode;
      // Mirror what the user typing in fSearch does — trigger the debounced search.
      fs.dispatchEvent(new Event("input", { bubbles: true }));
    }
    scanTarget = "entry"; // one-shot; reset for next time
    setTimeout(() => closeScanner(), 600);
    return true;
  }

  document.getElementById("serial").value = finalCode;
  toggleClearBtn();
  updateVinCount();
  showManualEntry();
  // Let other modules (detailer.js, etc.) react to a successful scan
  document.dispatchEvent(new CustomEvent("dt-vin-scanned", { detail: finalCode }));
  setTimeout(() => closeScanner(), 600);
  return true;
}

// ---------- Camera setup ----------

async function pickIOSBackCameraDeviceId() {
  // iPhone exposes labels like:
  //   "Back Camera"           (the standard 1× wide — what we want)
  //   "Back Dual Camera"      (wide + telephoto composite — also OK)
  //   "Back Triple Camera"    (composite — usually defaults to wide, OK)
  //   "Back Ultra Wide Camera" (0.5× — softer, bad close-focus → avoid)
  //   "Back Telephoto Camera" (zoomed in — bad close-focus → avoid)
  // We pick the first plain/dual/triple, never the ultra-wide or telephoto.
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
    // Labels are blank until permission is granted at least once. Trigger a
    // throw-away getUserMedia first to unlock the labels.
    let primed = null;
    try {
      primed = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    } catch(e) {}
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (primed) { try { primed.getTracks().forEach(t => t.stop()); } catch(e) {} }

    const cams = devices.filter(d => d.kind === "videoinput");
    const isBad = (label) => /ultra ?wide|telephoto/i.test(label);
    const isPreferred = (label) => /back/i.test(label) && !isBad(label);
    const preferred = cams.find(c => isPreferred(c.label));
    if (preferred) return preferred.deviceId;
    // Fallback: any non-bad back camera; else first back camera; else first.
    const anyBack = cams.find(c => /back|rear|environment/i.test(c.label) && !isBad(c.label));
    return (anyBack || cams[0] || null)?.deviceId || null;
  } catch (e) {
    return null;
  }
}

async function startCameraStream() {
  const targetW = IS_IOS ? IOS_TARGET_WIDTH : TARGET_WIDTH;
  const targetH = IS_IOS ? IOS_TARGET_HEIGHT : TARGET_HEIGHT;

  // On iOS, try to lock to the 1× wide back camera. iPhone's "facingMode: environment"
  // often picks the ultrawide which softens the image and ruins close-focus on barcodes.
  let deviceId = null;
  if (IS_IOS) deviceId = await pickIOSBackCameraDeviceId();

  const videoConstraints = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: targetW }, height: { ideal: targetH }, focusMode: "continuous", advanced: [{ focusMode: "continuous" }] }
    : { facingMode: { ideal: "environment" }, width: { ideal: targetW }, height: { ideal: targetH }, focusMode: "continuous", advanced: [{ focusMode: "continuous" }] };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
  } catch (e) {
    // Fallback 1: drop deviceId pinning (some iOS builds reject `exact`).
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: targetW }, height: { ideal: targetH } }
      });
    } catch (e2) {
      // Fallback 2: drop resolution hints entirely.
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } }
      });
    }
  }
}

function attachStreamToVideo(stream) {
  const video = document.getElementById("scannerVideo");
  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  video.muted = true;
  return new Promise((resolve) => {
    if (video.readyState >= 2) return resolve(video);
    video.onloadedmetadata = () => resolve(video);
  });
}

// ---------- Native BarcodeDetector path ----------

function nativeDetectorSupported() {
  if (!("BarcodeDetector" in window)) return false;
  return true;
}

async function runNativeDetector(video) {
  // Only request formats we actually accept; this is much faster than "all".
  const formats = ["code_39", "code_128", "qr_code", "data_matrix", "pdf417", "aztec"];
  let detector;
  try {
    // Some browsers expose getSupportedFormats; intersect when available.
    if (typeof BarcodeDetector.getSupportedFormats === "function") {
      const supported = await BarcodeDetector.getSupportedFormats();
      const filtered = formats.filter(f => supported.includes(f));
      detector = new BarcodeDetector({ formats: filtered.length ? filtered : formats });
    } else {
      detector = new BarcodeDetector({ formats });
    }
  } catch (e) {
    return false; // signal caller to try fallback
  }

  // Prepare offscreen canvas sized to the ROI of the video.
  roiCanvas = document.createElement("canvas");
  roiCtx = roiCanvas.getContext("2d", { willReadFrequently: true });

  const tick = async () => {
    if (!scannerActive) return;
    const now = performance.now();
    if (now - lastDecodeTime < DECODE_THROTTLE_MS) {
      detectionLoopId = requestAnimationFrame(tick);
      return;
    }
    lastDecodeTime = now;

    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) {
      detectionLoopId = requestAnimationFrame(tick);
      return;
    }

    // Crop ROI from the video frame so the detector only sees the scan strip.
    const sx = Math.floor(vw * ROI.xPct);
    const sy = Math.floor(vh * ROI.yPct);
    const sw = Math.floor(vw * ROI.wPct);
    const sh = Math.floor(vh * ROI.hPct);
    if (roiCanvas.width !== sw || roiCanvas.height !== sh) {
      roiCanvas.width = sw;
      roiCanvas.height = sh;
    }
    try {
      roiCtx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    } catch (e) {
      detectionLoopId = requestAnimationFrame(tick);
      return;
    }

    try {
      const results = await detector.detect(roiCanvas);
      if (results && results.length && scannerActive) {
        // Pick the largest detected code (most likely the one user is aiming at).
        let best = results[0];
        let bestArea = 0;
        for (const r of results) {
          const b = r.boundingBox;
          const a = b ? (b.width * b.height) : 0;
          if (a > bestArea) { bestArea = a; best = r; }
        }
        const fmt = (best.format || "").toLowerCase();
        const is2D = ALLOWED_2D.has(fmt);
        const is1D = ALLOWED_1D.has(fmt);
        if (is2D || is1D) {
          const accepted = acceptScanResult(best.rawValue, is2D);
          if (accepted) return; // closeScanner cleans up the loop
        }
      }
    } catch (e) {
      // Detector hiccuped on this frame; keep going.
    }

    detectionLoopId = requestAnimationFrame(tick);
  };

  detectionLoopId = requestAnimationFrame(tick);
  return true;
}

// ---------- ZXing fallback path ----------

function buildZxingHints(tryHarder) {
  const hints = new Map();
  // Restrict formats — this is the single biggest ZXing speed win.
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.CODE_39,
    ZXing.BarcodeFormat.CODE_128,
    ZXing.BarcodeFormat.QR_CODE,
    ZXing.BarcodeFormat.DATA_MATRIX,
    ZXing.BarcodeFormat.PDF_417,
    ZXing.BarcodeFormat.AZTEC
  ]);
  if (tryHarder) hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  return hints;
}

function runZxingFallback() {
  if (!window.ZXing) {
    const hint = document.getElementById("scannerHint");
    hint.className = "scanner-status error";
    hint.textContent = "Scanner library not loaded. Check internet and reload.";
    return;
  }

  // iOS: keep OUR stream alive, decode an ROI crop of the center band ourselves.
  // This avoids letting ZXing reacquire (which would re-trigger camera selection
  // and lose the wide-camera pick) and dramatically speeds up 1D decoding by
  // shrinking the search space.
  if (IS_IOS && tryRunZxingWithROI()) return;

  // Non-iOS fallback (rare — Android Chrome uses BarcodeDetector path): original
  // ZXing flow that auto-acquires its own stream.
  hardModeOn = false;
  codeReader = new ZXing.BrowserMultiFormatReader(buildZxingHints(false));

  const startDecode = () => {
    codeReader.decodeFromVideoDevice(null, "scannerVideo", (result, err) => {
      if (!scannerActive) return;
      const video = document.getElementById("scannerVideo");
      if (video.srcObject && !activeStream) activeStream = video.srcObject;
      if (result) {
        const fmt = result.getBarcodeFormat();
        const is2D = fmt === ZXing.BarcodeFormat.QR_CODE ||
                     fmt === ZXing.BarcodeFormat.DATA_MATRIX ||
                     fmt === ZXing.BarcodeFormat.AZTEC ||
                     fmt === ZXing.BarcodeFormat.PDF_417;
        acceptScanResult(result.getText(), is2D);
      }
    });
  };
  startDecode();
  hardModeTimer = setTimeout(() => {
    if (!scannerActive || hardModeOn) return;
    hardModeOn = true;
    try { codeReader.reset(); } catch(e) {}
    codeReader = new ZXing.BrowserMultiFormatReader(buildZxingHints(true));
    startDecode();
  }, HARD_MODE_DELAY_MS);
}

// iOS-tuned ZXing loop: TRY_HARDER from the start, ROI-cropped frames.
// Uses ZXing's low-level primitives (HTMLCanvasElementLuminanceSource +
// HybridBinarizer + MultiFormatReader.decode) instead of the high-level
// BrowserCodeReader.decodeFromCanvas, which is missing in @zxing/library
// 0.18.x. Returns true if the loop started.
function tryRunZxingWithROI() {
  try {
    const video = document.getElementById("scannerVideo");
    if (!video || !video.srcObject) return false;
    if (!ZXing.MultiFormatReader || !ZXing.HTMLCanvasElementLuminanceSource ||
        !ZXing.HybridBinarizer || !ZXing.BinaryBitmap) {
      console.warn("[Scanner] ZXing primitives missing — falling back to high-level path");
      return false;
    }

    hardModeOn = true; // try-harder from tick 0 on iOS
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(buildZxingHints(true));

    if (!zxingRoiCanvas) {
      zxingRoiCanvas = document.createElement("canvas");
      zxingRoiCtx = zxingRoiCanvas.getContext("2d", { willReadFrequently: true });
    }

    let lastTick = 0;
    let logged = false;
    const tick = (ts) => {
      if (!scannerActive) return;
      if (ts - lastTick >= ROI_DECODE_INTERVAL_MS && video.readyState >= 2) {
        lastTick = ts;
        const vw = video.videoWidth, vh = video.videoHeight;
        if (vw && vh) {
          // Use the FULL frame on iOS rather than a narrow strip: 1D codes
          // are often held outside the center band, and ZXing's
          // GlobalHistogramBinarizer (under HybridBinarizer) handles the
          // larger image fine in TRY_HARDER mode.
          if (zxingRoiCanvas.width !== vw) zxingRoiCanvas.width = vw;
          if (zxingRoiCanvas.height !== vh) zxingRoiCanvas.height = vh;
          zxingRoiCtx.drawImage(video, 0, 0, vw, vh);

          if (!logged) {
            console.log("[Scanner] iOS decode loop running", { vw, vh });
            logged = true;
          }

          try {
            const luminance = new ZXing.HTMLCanvasElementLuminanceSource(zxingRoiCanvas);
            const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
            const result = reader.decode(bitmap);
            if (result) {
              const fmt = result.getBarcodeFormat();
              console.log("[Scanner] decoded", { fmt, text: result.getText() });
              const is2D = fmt === ZXing.BarcodeFormat.QR_CODE ||
                           fmt === ZXing.BarcodeFormat.DATA_MATRIX ||
                           fmt === ZXing.BarcodeFormat.AZTEC ||
                           fmt === ZXing.BarcodeFormat.PDF_417;
              acceptScanResult(result.getText(), is2D);
            }
          } catch (e) {
            // NotFoundException is expected on most ticks — ignore quietly.
          } finally {
            try { reader.reset(); } catch (_) {}
          }
        }
      }
      zxingRoiLoopId = requestAnimationFrame(tick);
    };
    zxingRoiLoopId = requestAnimationFrame(tick);
    return true;
  } catch (e) {
    console.warn("ROI ZXing loop failed to start:", e && e.message);
    return false;
  }
}

// ---------- Escalation ----------

function setScannerHint(text, cls) {
  const hint = document.getElementById("scannerHint");
  if (!hint) return;
  hint.className = "scanner-status " + (cls || "scanning");
  const dotSvg = '<span class="scanner-dot"><svg xmlns="http://www.w3.org/2000/svg" class="u-icon" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg></span>';
  hint.innerHTML = dotSvg + " " + text;
}

function startScannerEscalation() {
  clearScannerEscalation();
  scannerStartedAt = performance.now();
  const kbBtn = document.getElementById("scannerKbBtn");
  if (kbBtn) kbBtn.classList.remove("btn--pulse");

  // 3s: hold-steady hint
  scannerEscalationTimers.push(setTimeout(() => {
    if (!scannerActive) return;
    setScannerHint("Hold steady &middot; fill the box with the barcode");
  }, 3000));

  // 6s: torch nudge (and auto-suggest if off)
  scannerEscalationTimers.push(setTimeout(() => {
    if (!scannerActive) return;
    const torchHint = torchOn ? "Try a different angle" : "Try the flashlight";
    setScannerHint(torchHint);
    const torchBtn = document.getElementById("torchBtn");
    if (torchBtn && !torchOn) torchBtn.classList.add("btn--pulse-torch");
  }, 6000));

  // 10s: hand attention from the torch nudge over to the keyboard button so
  //      the user can bail in one tap.
  scannerEscalationTimers.push(setTimeout(() => {
    if (!scannerActive) return;
    const torchBtn = document.getElementById("torchBtn");
    if (torchBtn) torchBtn.classList.remove("btn--pulse-torch");
    const kb = document.getElementById("scannerKbBtn");
    if (kb) kb.classList.add("btn--pulse");
    setScannerHint("Trouble reading? Try moving closer or tap the keyboard to enter manually");
  }, 10000));

  // 20s: stronger warning
  scannerEscalationTimers.push(setTimeout(() => {
    if (!scannerActive) return;
    setScannerHint("Tag may be damaged &mdash; manual entry recommended", "error");
  }, 20000));

  // 45s: hard cap, close scanner
  scannerEscalationTimers.push(setTimeout(() => {
    if (!scannerActive) return;
    setScannerHint("Scanner timed out", "error");
    showToast("Scanner timed out - try again or enter manually", "error");
    setTimeout(() => closeScanner(), 800);
  }, SCAN_TIMEOUT_MS));
}

function clearScannerEscalation() {
  scannerEscalationTimers.forEach(t => clearTimeout(t));
  scannerEscalationTimers = [];
  const torchBtn = document.getElementById("torchBtn");
  if (torchBtn) torchBtn.classList.remove("btn--pulse-torch");
  const kbBtn = document.getElementById("scannerKbBtn");
  if (kbBtn) kbBtn.classList.remove("btn--pulse");
}

// Tap "Enter Manually" / Keyboard from inside the scanner overlay
function openScannerManualEntry() {
  // If the scanner was opened from records search, return the user to that
  // input rather than the entry-tab serial field.
  const wasSearch = scanTarget === "search";
  closeScanner(); // resets scanTarget
  if (wasSearch) {
    const fs = document.getElementById("fSearch");
    if (fs) {
      fs.focus();
      if (typeof openVinKeypad === "function") {
        try { openVinKeypad("fSearch"); } catch(e) {}
      }
    }
    return;
  }
  showManualEntry();
  const serial = document.getElementById("serial");
  if (serial) {
    serial.focus();
    // VIN keypad takes over on tap; trigger it so the user can start typing immediately
    if (typeof openVinKeypad === "function") {
      try { openVinKeypad("serial"); } catch(e) {}
    }
  }
}

// ---------- Public API ----------

// "entry" (default) → write to #serial on the entry tab.
// "search"          → write to #fSearch and re-run the records search.
let scanTarget = "entry";
function openScannerForSearch() {
  scanTarget = "search";
  openScanner();
}

async function openScanner() {
  // Guard against re-entry: if a previous session is still considered active
  // (e.g. the page was backgrounded and the camera track died without us
  // tearing down), close it first so we start from a clean state instead of
  // running two decode loops against a dead stream.
  if (scannerActive) {
    try { closeScanner(); } catch(e) {}
  }

  const overlay = document.getElementById("scannerOverlay");
  const hint = document.getElementById("scannerHint");
  const dotSvg = '<span class="scanner-dot"><svg xmlns="http://www.w3.org/2000/svg" class="u-icon" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg></span>';
  overlay.classList.add("open");

  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock("portrait").catch(() => {});
  }
  hint.className = "scanner-status scanning";
  hint.innerHTML = dotSvg + " Starting camera...";

  // iOS users get a closer-distance tip — Safari's softer pipeline reads
  // small barcodes more reliably at 4-6" than 6-8".
  const tipEl = document.getElementById("scannerTip");
  if (tipEl) {
    tipEl.innerHTML = IS_IOS
      ? "Hold tag horizontal &middot; 4-6 inches away"
      : "Hold tag horizontal &middot; 6-8 inches away";
  }

  torchOn = false;
  scannerActive = true;
  lastDecodeTime = 0;
  lastCandidate = null;
  lastCandidateAt = 0;
  document.getElementById("torchBtn").classList.remove("on");

  try {
    const stream = await startCameraStream();
    activeStream = stream;
    const video = await attachStreamToVideo(stream);

    // Some Androids need an explicit play() after metadata loads.
    try { await video.play(); } catch(e) {}

    hint.innerHTML = dotSvg + " Scanning...";
    startScannerEscalation();

    if (nativeDetectorSupported()) {
      const ok = await runNativeDetector(video);
      if (!ok) {
        // BarcodeDetector constructor failed — fall through to ZXing on the same stream.
        runZxingFallback();
      }
    } else {
      // No native detector (iOS Safari, older Chrome).
      // On iOS we keep OUR stream + run a custom ROI decode loop. On other browsers
      // we let ZXing manage its own stream (release ours first to avoid double-acquire).
      if (!IS_IOS) {
        if (activeStream) {
          activeStream.getTracks().forEach(t => t.stop());
          activeStream = null;
        }
        const v = document.getElementById("scannerVideo");
        v.srcObject = null;
      }
      runZxingFallback();
    }
  } catch (e) {
    hint.className = "scanner-status error";
    hint.textContent = "Camera access denied. Check permissions.";
    scannerActive = false;
  }
}

function closeScanner() {
  scanTarget = "entry"; // never leak a one-shot search mode into the next session
  scannerActive = false;
  clearScannerEscalation();

  if (detectionLoopId) {
    cancelAnimationFrame(detectionLoopId);
    detectionLoopId = null;
  }
  if (zxingRoiLoopId) {
    cancelAnimationFrame(zxingRoiLoopId);
    zxingRoiLoopId = null;
  }
  if (hardModeTimer) {
    clearTimeout(hardModeTimer);
    hardModeTimer = null;
  }
  if (screen.orientation && screen.orientation.unlock) {
    try { screen.orientation.unlock(); } catch(e) {}
  }
  if (codeReader) {
    try { codeReader.reset(); } catch(e) {}
    codeReader = null;
  }
  if (activeStream) {
    activeStream.getTracks().forEach(t => t.stop());
    activeStream = null;
  }
  const video = document.getElementById("scannerVideo");
  if (video) {
    try { video.pause(); } catch(e) {}
    video.srcObject = null;
  }
  roiCanvas = null;
  roiCtx = null;
  torchOn = false;
  hardModeOn = false;
  lastCandidate = null;
  document.getElementById("scannerOverlay").classList.remove("open");
}

// iOS Safari ends the camera track when the tab is hidden (lock screen, app
// switch, incoming notification). The decode loop would keep running against
// a dead stream and the user would have to force-close the app to recover.
// Tear down on hide so the next openScanner() acquires a fresh stream.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && scannerActive) {
    try { closeScanner(); } catch(e) {}
  }
});
window.addEventListener("pagehide", () => {
  if (scannerActive) {
    try { closeScanner(); } catch(e) {}
  }
});

// ============================
// SCANBOT SDK (DISABLED — kept for future re-enable)
// ============================
/* Scanbot trial flow disabled. The button in index.html is commented
   out; this whole block stays here so we can revive it without rewriting.
   To re-enable: remove this opening /* and the closing one before TORCH below,
   then uncomment the button in index.html.

// Loads on first tap of the "Scan with Scanbot (beta)" button. Runs in
// license-free trial mode (~60s per session) — enough to evaluate read
// reliability on iPhone vs. the existing ZXing path. To go production
// we'd need a paid license key set in SCANBOT_LICENSE.
const SCANBOT_VERSION = "5";                                       // major version pin
const SCANBOT_SDK_URL = "https://cdn.jsdelivr.net/npm/scanbot-web-sdk@5/bundle/ScanbotSDK.min.js";
const SCANBOT_ENGINE_PATH = "https://cdn.jsdelivr.net/npm/scanbot-web-sdk@5/bundle/bin/complete/";
// Trial license — domain-bound to localhost + charger71.github.io.
// 60 s/session cap; reload to reset. Replace with paid key for production.
const SCANBOT_LICENSE =
  "LFW8qn0iYWUSo8e8LxKhsic8cXJA+6" +
  "Ym6onxKt8obw2IYbyK614CLXO6hwoC" +
  "OaB+XsTBJtgZgTEVTf+LdN6WZQhBkL" +
  "aylHNg/fGpRaJ8oHIdFWvZvmSZN7Xb" +
  "12qQtpmbgg3c2smAzPdVj1VdPr+18U" +
  "M5qC6NcPDYbs493Yl/flPc5KE2jlss" +
  "+BsBkHiZyf2ABztHnJMxA2s0skupOJ" +
  "MoBevJgusfUV+PLJwfIbinVZZxMlKI" +
  "12r2AW+vZQRDpvzMr8hdu9z6w82uq+" +
  "JFqqplfKH5D3IXrNz2ABwxJLhpK/4i" +
  "UK7Vlaiv0fwHNvWLGQknBiHpzzg6vP" +
  "FCYoWoz0Lx8Q==\nU2NhbmJvdFNESw" +
  "psb2NhbGhvc3R8d3d3LmRyaXZlcnRy" +
  "YXguc2l0ZQoxNzgwMjcxOTk5CjgzOD" +
  "g2MDcKOA==\n";


let _scanbotSDK = null;          // resolved SDK instance after init
let _scanbotLoading = null;      // Promise so concurrent taps don't race
let _scanbotScanner = null;      // active scanner instance (for cleanup)

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) { existing.dataset.loaded === "1" ? resolve() : existing.addEventListener("load", resolve); return; }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

async function ensureScanbotSDK() {
  if (_scanbotSDK) return _scanbotSDK;
  if (_scanbotLoading) return _scanbotLoading;
  _scanbotLoading = (async () => {
    if (!window.ScanbotSDK) {
      await loadScript(SCANBOT_SDK_URL);
    }
    if (!window.ScanbotSDK || typeof window.ScanbotSDK.initialize !== "function") {
      throw new Error("ScanbotSDK global not available after script load (CDN path or API may have changed)");
    }
    _scanbotSDK = await window.ScanbotSDK.initialize({
      licenseKey: SCANBOT_LICENSE,
      enginePath: SCANBOT_ENGINE_PATH
    });
    return _scanbotSDK;
  })();
  try { return await _scanbotLoading; }
  finally { _scanbotLoading = null; }
}

async function openScanbotScanner() {
  const hostId = "scanbotHost";
  // Lazily inject a host container the first time
  let host = document.getElementById(hostId);
  if (!host) {
    host = document.createElement("div");
    host.id = hostId;
    host.style.cssText = "position:fixed;inset:0;z-index:1500;background:#000;display:none";
    document.body.appendChild(host);
  }
  host.style.display = "block";
  // Add a close button overlay since the SDK UI may not include one.
  // Mounted on document.body (not host) at a very high z-index so the
  // Scanbot SDK can't render on top of it.
  let closeBtn = document.getElementById("scanbotCloseBtn");
  if (!closeBtn) {
    closeBtn = document.createElement("button");
    closeBtn.id = "scanbotCloseBtn";
    closeBtn.className = "scanbot-close";
    closeBtn.setAttribute("aria-label", "Close scanner");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.style.cssText =
      "position:fixed;" +
      "top:calc(env(safe-area-inset-top,0px) + 12px);" +
      "right:calc(env(safe-area-inset-right,0px) + 12px);" +
      "z-index:2147483647;" +
      "width:44px;height:44px;display:flex;align-items:center;justify-content:center;" +
      "border-radius:50%;border:1px solid rgba(255,255,255,0.35);" +
      "background:rgba(0,0,0,0.65);color:#fff;cursor:pointer;" +
      "-webkit-tap-highlight-color:transparent;touch-action:manipulation;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.4);padding:0;";
    closeBtn.onclick = closeScanbotScanner;
    document.body.appendChild(closeBtn);
  }
  closeBtn.style.display = "flex";

  showToast("Loading Scanbot…", "success");
  try {
    const sdk = await ensureScanbotSDK();
    // Scanbot Web SDK has renamed the format-restriction key across versions:
    //   v3 / v4: `barcodeFormats: [...]`
    //   v5+:     `acceptedFormats: [...]`
    //   some builds also accept: `barcodeFormatConfigurations: [{ formats: [...] }]`
    // Pass under all of them — unknown keys are ignored.
    const FORMATS = ["CODE_39", "CODE_128", "QR_CODE", "DATA_MATRIX", "PDF_417", "AZTEC", "EAN_13", "EAN_8", "UPC_A", "UPC_E", "ITF"];
    const config = {
      containerId: hostId,
      barcodeFormats: FORMATS,
      acceptedFormats: FORMATS,
      barcodeFormatConfigurations: [{ formats: FORMATS }],
      preferredCamera: "back",
      onBarcodesDetected: (result) => {
        try {
          const list = (result && (result.barcodes || result.results)) || [];
          const first = list[0];
          if (!first) return;
          const raw = (first.text || first.textWithExtension || first.rawText || "").trim().toUpperCase();
          if (!raw) return;
          const fmt = first.format || first.symbology || first.barcodeFormat || "";
          // Diagnostic: log what Scanbot detected so we know its format strings
          console.log("[Scanbot] detected", { format: fmt, text: raw });
          const is2D = /QR|DATA_?MATRIX|PDF_?417|AZTEC/i.test(fmt);
          // Reuse the existing acceptance path: it handles VIN extraction,
          // beep/haptic, populating the Serial input, and closing.
          const accepted = acceptScanResult(raw, is2D);
          if (accepted) closeScanbotScanner();
        } catch (e) {
          console.warn("Scanbot result handling failed:", e);
        }
      },
      onError: (err) => {
        console.error("Scanbot error:", err);
        showToast("Scanbot error: " + (err && err.message ? err.message : "see console"), "error");
      }
    };
    // Different Scanbot Web SDK versions expose this under different names.
    // Try the most likely ones in order.
    const factory = sdk.createBarcodeScanner || sdk.createBarcodeScannerView || sdk.UI && sdk.UI.createBarcodeScanner;
    if (!factory) throw new Error("createBarcodeScanner not found on SDK (API may have moved)");
    _scanbotScanner = await factory.call(sdk, config);
  } catch (e) {
    console.error(e);
    showToast("Couldn't start Scanbot: " + (e && e.message ? e.message : "unknown"), "error");
    host.style.display = "none";
    const cb = document.getElementById("scanbotCloseBtn");
    if (cb) cb.style.display = "none";
  }
}

async function closeScanbotScanner() {
  const host = document.getElementById("scanbotHost");
  try {
    if (_scanbotScanner) {
      if (typeof _scanbotScanner.dispose === "function") await _scanbotScanner.dispose();
      else if (typeof _scanbotScanner.destroy === "function") await _scanbotScanner.destroy();
      else if (typeof _scanbotScanner.close === "function") await _scanbotScanner.close();
    }
  } catch (e) { } // ignore
  _scanbotScanner = null;
  if (host) host.style.display = "none";
  const closeBtn = document.getElementById("scanbotCloseBtn");
  if (closeBtn) closeBtn.style.display = "none";
}
*/ // end SCANBOT disabled block

async function toggleTorch() {
  // ZXing path may not have populated activeStream yet — grab from the video element.
  if (!activeStream) {
    const v = document.getElementById("scannerVideo");
    if (v && v.srcObject) activeStream = v.srcObject;
  }
  if (!activeStream) {
    showToast("Camera not ready yet — try again in a moment", "warn");
    return;
  }
  const track = activeStream.getVideoTracks()[0];
  if (!track || track.readyState !== "live") {
    showToast("Camera not ready yet — try again in a moment", "warn");
    return;
  }

  // Probe capabilities (some browsers don't expose this at all).
  const caps = (typeof track.getCapabilities === "function") ? track.getCapabilities() : {};
  const settings = (typeof track.getSettings === "function") ? track.getSettings() : {};
  const torchSupported = ("torch" in caps) || ("torch" in settings);
  if (!torchSupported) {
    showToast("Flashlight not available on this device", "warn");
    return;
  }

  const desired = !torchOn;
  const btn = document.getElementById("torchBtn");

  // Try 1: standard applyConstraints({advanced:[{torch}]}). Works on most Android Chromium.
  try {
    await track.applyConstraints({ advanced: [{ torch: desired }] });
    torchOn = desired;
    if (btn) btn.classList.toggle("on", torchOn);
    return;
  } catch (e1) {
    // Fall through to ImageCapture fallback.
    console.warn("Torch applyConstraints failed:", e1 && e1.message);
  }

  // Try 2: ImageCapture.setOptions / track.applyConstraints with constraints style.
  try {
    if (typeof window.ImageCapture === "function") {
      const ic = new ImageCapture(track);
      const photoCaps = await ic.getPhotoCapabilities();
      if (photoCaps && photoCaps.fillLightMode &&
          photoCaps.fillLightMode.indexOf(desired ? "flash" : "off") !== -1) {
        // Some browsers expose torch via fillLightMode on the photo settings.
        await ic.setOptions({ fillLightMode: desired ? "flash" : "off" });
        torchOn = desired;
        if (btn) btn.classList.toggle("on", torchOn);
        return;
      }
    }
  } catch (e2) {
    console.warn("Torch ImageCapture fallback failed:", e2 && e2.message);
  }

  showToast("Couldn't toggle flashlight on this device", "error");
}


// ============================
// PROFILE
// ============================
const PROFILE_KEY = "drivertrax_profile";
const THEME_KEY = "dt_theme";

function getProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}"); } catch(e) { return {}; }
}

// ============================
// THEME — system | dark | light. Persisted to localStorage immediately
// and synced to profiles.theme_preference on the next saveProfile() call.
// Pre-paint init lives inline in index.html <head> to avoid flash on load.
// ============================
function getTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return (t === "light" || t === "dark" || t === "system") ? t : "system";
  } catch(e) { return "system"; }
}

function resolveTheme(pref) {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return pref;
}

function applyTheme(pref) {
  // data-theme always holds the RESOLVED value (light/dark) so CSS only needs one
  // light-theme block. The user preference (system/light/dark) lives in localStorage.
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute("data-theme", resolved);
  const meta = document.getElementById("metaThemeColor")
            || document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "light" ? "#f1ede5" : "#13161a");
  // Reflect the user-facing preference in the segmented control
  document.querySelectorAll(".theme-toggle-btn").forEach(btn => {
    const on = btn.dataset.themeValue === pref;
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
}

async function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch(e) {}
  applyTheme(pref);
  // Cloud sync — fire-and-forget; falls back silently if offline or no auth
  if (window.DT_AUTH && DT_AUTH.getUser()) {
    try {
      await DT_AUTH.client
        .from("profiles")
        .update({ theme_preference: pref })
        .eq("id", DT_AUTH.getUser().id);
    } catch(e) { /* offline / RLS / column missing — local pref still wins */ }
  }
}

// React to OS-level theme changes when user is on "system"
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (getTheme() === "system") applyTheme("system");
  });
}

function extractAirportCode(text) {
  const m = /\(([A-Z]{3,4})\)/.exec(text || "");
  return m ? m[1] : (text || "").trim().toUpperCase();
}

async function saveProfile() {
  const name = sanitizeName(document.getElementById("profileName").value.trim());
  if (!name) { showToast("Please enter your name.", "error"); return; }
  const location = extractAirportCode(document.getElementById("profileLocation").value);
  const profile = { name, location };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  applyProfile();

  // Push to Supabase so the manager Backlot view + leaderboard see the right name
  if (window.DT_AUTH && DT_AUTH.getUser()) {
    const userId = DT_AUTH.getUser().id;
    const { error } = await DT_AUTH.client
      .from("profiles")
      .update({ display_name: name, home_airport: location || null })
      .eq("id", userId);
    if (error) {
      console.warn("[Profile] cloud sync failed", error);
      showToast("Saved locally — cloud sync failed", "warn");
      return;
    }
    // Refresh the cached profile on DT_AUTH so other UI reads the new name immediately
    const { data: fresh } = await DT_AUTH.client.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (fresh && DT_AUTH._setProfile) DT_AUTH._setProfile(fresh);
  }
  showToast("Profile saved", "success");
}

// Copy the cloud profile down into localStorage so the rest of the app can keep
// reading the simple { name, location } shape it expects. Runs whenever the
// auth profile changes.
function syncProfileFromCloud() {
  if (!window.DT_AUTH) return;
  const cp = DT_AUTH.getProfile();
  if (!cp) return;
  const current = getProfile();
  const merged = {
    name:     cp.display_name  || current.name     || "",
    location: cp.home_airport  || current.location || ""
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(merged));

  // Theme: cloud wins on initial sign-in (so the pref follows the user across devices),
  // but only when nothing is locally set yet — otherwise the local choice stays authoritative.
  if (cp.theme_preference && !localStorage.getItem(THEME_KEY)) {
    const pref = cp.theme_preference;
    if (pref === "light" || pref === "dark" || pref === "system") {
      try { localStorage.setItem(THEME_KEY, pref); } catch(e) {}
      applyTheme(pref);
    }
  }

  applyProfile();
}
document.addEventListener("dt-auth-change", syncProfileFromCloud);

function previewProfileName() {
  const name = sanitizeName(document.getElementById("profileName").value.trim());
  const el = document.getElementById("dashDriverNameText");
  if (el && name) {
    el.textContent = name;
    document.getElementById("dashDriverName").style.display = "block";
  }
}

function applyProfile() {
  const profile = getProfile();
  const name = profile.name || "";
  const location = profile.location || "";
  const nameEl = document.getElementById("dashDriverNameText");
  const nameSection = document.getElementById("dashDriverName");
  const locationEl = document.getElementById("dashDriverLocation");

  if (nameEl) nameEl.textContent = name;
  if (nameSection) nameSection.style.display = name ? "block" : "none";
  if (locationEl) locationEl.textContent = location ? location : "";

  const nameInput = document.getElementById("profileName");
  const locSelect = document.getElementById("profileLocation");
  if (nameInput && name) nameInput.value = name;
  if (locSelect && location) {
    // The saved value is the airport code (e.g. "SDF"); find the matching option.
    const match = Array.from(locSelect.options).find(o => extractAirportCode(o.value) === location);
    if (match) locSelect.value = match.value;
  }

  // Role pill — pulled from the cloud profile (read-only)
  const roleEl = document.getElementById("profileRole");
  if (roleEl) {
    const role = (window.DT_AUTH && DT_AUTH.getProfile() && DT_AUTH.getProfile().role) || "";
    const label = { driver: "Driver", cxr: "CXR", manager: "Manager", admin: "Admin", detailer: "Detailer" }[role] || "—";
    roleEl.textContent = label;
    roleEl.className = "profile-role-pill" + (role ? " role-" + role : "");
  }

  // Avatar preview — falls back to initials when no headshot is uploaded.
  renderProfileAvatarPreview();
  initProfileAvatarHandlers();

  // Theme toggle — reflect current preference in the segmented control
  applyTheme(getTheme());

  // PIN status + button visibility
  const pinStatus = document.getElementById("profilePinStatus");
  const btnSet    = document.getElementById("btnSetPin");
  const btnChange = document.getElementById("btnChangePin");
  const btnRemove = document.getElementById("btnRemovePin");
  if (pinStatus && btnSet) {
    const hasPin = !!(window.DT_AUTH && DT_AUTH.hasPin && DT_AUTH.hasPin());
    pinStatus.textContent = hasPin ? "PIN set" : "No PIN set";
    pinStatus.className = "profile-pin-status " + (hasPin ? "on" : "off");
    btnSet.style.display    = hasPin ? "none" : "";
    btnChange.style.display = hasPin ? "" : "none";
    btnRemove.style.display = hasPin ? "" : "none";
  }
}

// Refresh Profile when the PIN state changes
document.addEventListener("dt-pin-change", () => applyProfile());

// ============================
// PROFILE AVATAR — upload/remove. Stored at profile-avatars/{userId}/avatar.jpg
// in a public bucket; profiles.avatar_url holds the resolved public URL.
// ============================
function renderProfileAvatarPreview() {
  const el = document.getElementById("profileAvatarPreview");
  const removeBtn = document.getElementById("profileAvatarRemove");
  if (!el) return;
  const cp = window.DT_AUTH?.getProfile?.() || null;
  const url = cp?.avatar_url || "";
  if (url) {
    el.innerHTML = `<img src="${sanitizeText(url)}" alt="">`;
    if (removeBtn) removeBtn.style.display = "";
  } else {
    const initials = (cp?.display_name || "?").trim().split(/\s+/).slice(0,2).map(s => s[0] || "").join("").toUpperCase() || "?";
    el.textContent = initials;
    if (removeBtn) removeBtn.style.display = "none";
  }
}

function initProfileAvatarHandlers() {
  const input = document.getElementById("profileAvatarInput");
  const removeBtn = document.getElementById("profileAvatarRemove");
  if (!input || input.dataset.wired) return;
  input.dataset.wired = "1";

  const setStatus = (msg, isErr) => {
    const s = document.getElementById("profileAvatarStatus");
    if (!s) return;
    s.textContent = msg || "";
    s.style.color = isErr ? "var(--danger)" : "var(--muted)";
  };

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!window.DT_AUTH || !DT_AUTH.getUser()) { setStatus("Sign in first.", true); return; }
    const MAX = 10 * 1024 * 1024;
    if (file.size > MAX) { setStatus("Photo too large (>10MB).", true); input.value = ""; return; }
    try {
      setStatus("Uploading…");
      const blob = await (window.DT_MEDIA?.resizeImageBlob?.(file, 512, 512, 0.85) ?? file);
      const userId = DT_AUTH.getUser().id;
      const path = `${userId}/avatar.jpg`;
      const sb = DT_AUTH.client;
      const { error: upErr } = await sb.storage.from("profile-avatars")
        .upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "0" });
      if (upErr) throw upErr;
      const { data: pub } = sb.storage.from("profile-avatars").getPublicUrl(path);
      const bust = `${pub.publicUrl}?v=${Date.now()}`;
      const { error: updErr } = await sb.from("profiles").update({ avatar_url: bust }).eq("id", userId);
      if (updErr) throw updErr;
      const { data: fresh } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
      if (fresh && DT_AUTH._setProfile) DT_AUTH._setProfile(fresh);
      renderProfileAvatarPreview();
      setStatus("Photo updated.");
    } catch (e) {
      console.warn("[Profile] avatar upload", e);
      setStatus("Upload failed.", true);
    } finally {
      input.value = "";
    }
  });

  removeBtn?.addEventListener("click", async () => {
    if (!window.DT_AUTH || !DT_AUTH.getUser()) return;
    if (!confirm("Remove your profile photo?")) return;
    try {
      setStatus("Removing…");
      const userId = DT_AUTH.getUser().id;
      const sb = DT_AUTH.client;
      await sb.storage.from("profile-avatars").remove([`${userId}/avatar.jpg`]).catch(() => {});
      const { error } = await sb.from("profiles").update({ avatar_url: null }).eq("id", userId);
      if (error) throw error;
      const { data: fresh } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
      if (fresh && DT_AUTH._setProfile) DT_AUTH._setProfile(fresh);
      renderProfileAvatarPreview();
      setStatus("Photo removed.");
    } catch (e) {
      console.warn("[Profile] avatar remove", e);
      setStatus("Remove failed.", true);
    }
  });
}

// Show the full VIN history (records + notes) for the VIN just scanned/typed
// into the entry panel. Previously this only mounted the notes widget, so the
// driver couldn't see prior status changes (CLEAN, DIRTY, PM, etc.) for the
// same VIN — making it easy to log a duplicate.
document.addEventListener("dt-vin-scanned", (e) => {
  const vin = (e.detail || "").toUpperCase();
  const target = document.getElementById("entryVinNotes");
  if (target && vin && typeof renderVinTimeline === "function") {
    renderVinTimeline(vin, { container: target, countEl: null });
  } else if (target && !vin) {
    target.innerHTML = "";
  }
  renderEntryCurrentState(vin);

  // Body damage + Tires collapsibles are now purely local form fields
  // driven by damage.js — no VIN-scoped side effects to run here.
});

// Render a read-only banner of the vehicle's current state (status, destination,
// last mileage / fuel) under the scan area, and pre-fill the Destination select.
// Status stays blank intentionally so the user has to make a deliberate pick.
async function renderEntryCurrentState(vin) {
  const el = document.getElementById("entryCurrentState");
  if (!el || !window.DT_AUTH) return;
  if (!vin) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "";
  el.classList.remove("is-empty");
  el.classList.remove("is-priority");
  el.innerHTML = `<div class="ecs-label">Current state</div><div>Loading…</div>`;
  const sb = DT_AUTH.client;
  // The vehicles row may lag behind records (it's populated by an out-of-band
  // process). Fetching the latest record directly means a VIN with history
  // always shows real state, even before the vehicles row catches up.
  // RLS may deny the records query for drivers when the matching rows belong
  // to other users — we surface that as "no history yet" rather than letting
  // the rejection break the page or noise up the console.
  const [vehRes, latestRecRes, latestMF] = await Promise.all([
    sb.from("vehicles")
      .select("current_status,current_status_other,current_destination,current_destination_other,last_seen_at,vin_data,current_conditions,needs_new_tag")
      .eq("serial_id", vin).maybeSingle()
      .then(r => r, () => ({ data: null })),
    sb.from("records")
      .select("status,status_other,destination,destination_other,ts")
      .eq("serial_id", vin)
      .order("ts", { ascending: false })
      .limit(1).maybeSingle()
      .then(r => r, () => ({ data: null })),
    (window.DT_MEDIA ? DT_MEDIA.getLatestMileageAndFuel(vin) : Promise.resolve({ mileage: null, fuel: null }))
      ?.catch?.(() => ({ mileage: null, fuel: null }))
  ]);
  const v = vehRes?.data;
  const r = latestRecRes?.data;
  const hasHistory = !!v || !!r || Number.isFinite(latestMF?.mileage) || !!latestMF?.fuel;
  if (!hasHistory) {
    el.classList.add("is-empty");
    el.innerHTML = `<div class="ecs-label">Current state</div><div>New to inventory — no history yet.</div>`;
    return;
  }
  const esc = (s) => sanitizeText(s);
  // Prefer the vehicles snapshot when present; fall back to the most recent record.
  const curStatus      = v?.current_status      ?? r?.status      ?? "";
  const curStatusOther = v?.current_status_other ?? r?.status_other ?? "";
  const curDest        = v?.current_destination ?? r?.destination ?? "";
  const curDestOther   = v?.current_destination_other ?? r?.destination_other ?? "";
  const lastSeenAt     = v?.last_seen_at ?? r?.ts ?? null;
  const statusDisp = curStatus === "OTHER" && curStatusOther
    ? `OTHER: ${curStatusOther}` : statusLabel(curStatus);
  const destDisp = locationLabel(curDest, curDestOther, v?.section_name ?? r?.section_name);
  const parts = [];
  if (statusDisp)        parts.push(`<span class="ecs-val">${esc(statusDisp)}</span>`);
  if (destDisp)          parts.push(`<span class="ecs-val">${esc(destDisp)}</span>`);
  if (Number.isFinite(latestMF?.mileage)) parts.push(`<span class="ecs-val">${latestMF.mileage.toLocaleString()} mi</span>`);
  if (latestMF?.fuel)    parts.push(`<span class="ecs-val">${esc(latestMF.fuel)}</span>`);
  if (Array.isArray(v?.current_conditions) && v.current_conditions.length) {
    const labels = v.current_conditions.map(id => (DT_OPTIONS.CONDITIONS.find(c => c.id === id)?.label) || id);
    parts.push(`<span class="ecs-val">${esc(labels.join(", "))}</span>`);
    if (v.current_conditions.includes("PRIORITY")) el.classList.add("is-priority");
  }
  if (v?.needs_new_tag) {
    parts.push(`<span class="badge-notag">BAD TAG</span>`);
  }
  const ago = lastSeenAt ? DT_FORMAT.timeAgo(lastSeenAt) : "";
  el.innerHTML = `
    <div class="ecs-label">Current state${ago ? ` · ${esc(ago)}` : ""}</div>
    <div>${parts.length ? parts.join('<span class="ecs-sep">·</span>') : "No prior status."}</div>
  `;

  // Pre-select the current status (when one exists and matches an option) so
  // the user can submit without changing it. Previously we overloaded the
  // placeholder text with the current value, which made the same status
  // appear twice in the dropdown and left the form un-submittable until the
  // user re-picked it.
  const statusSel = document.getElementById("status");
  if (statusSel?.options.length) {
    statusSel.options[0].text = "-- STATUS --";
    if (curStatus && Array.from(statusSel.options).some(o => o.value === curStatus)) {
      statusSel.value = curStatus;
      if (curStatus === "OTHER" && curStatusOther) {
        const so = document.getElementById("statusOther");
        if (so) so.value = curStatusOther;
      }
      if (typeof handleStatusChange === "function") handleStatusChange();
    }
  }
  setSelectPlaceholderHint("destination", "-- LOCATION --", curDest
    ? (curDest === "OTHER" && curDestOther ? `OTHER: ${curDestOther}` : curDest)
    : "");
  setInputPlaceholderHint("mileage", "optional", Number.isFinite(latestMF?.mileage)
    ? latestMF.mileage.toLocaleString()
    : "");
  setSelectPlaceholderHint("fuelLevel",   "-- FUEL --",     latestMF?.fuel || "");

  // Carry over the vehicle's current conditions into the entry form so the
  // detailer doesn't have to re-tick every chip on a follow-up visit. They can
  // still uncheck any that no longer apply before saving.
  if (Array.isArray(v?.current_conditions) && v.current_conditions.length) {
    selectedCxrConditions = v.current_conditions.slice();
    if (typeof renderCxrConditions === "function") renderCxrConditions();
    // Force the Conditions collapsible open so the carried-over chips are
    // actually visible — otherwise the panel hides what the user just inherited.
    const condCollapse = document.getElementById("entryConditionsCollapse");
    if (condCollapse) condCollapse.open = true;
  }
}

// Replace the first option's label with the prior value when one exists,
// otherwise restore the original default label.
function setSelectPlaceholderHint(id, defaultLabel, lastVal) {
  const sel = document.getElementById(id);
  if (!sel || !sel.options.length) return;
  sel.options[0].text = lastVal || defaultLabel;
}

function setInputPlaceholderHint(id, defaultPlaceholder, lastVal) {
  const el = document.getElementById(id);
  if (!el) return;
  el.placeholder = lastVal || defaultPlaceholder;
}

// Clear the banner when the entry form resets (after save, after clearing serial).
// Also restore the field placeholders so stale "last: X" hints don't leak
// onto the next VIN's pre-fill.
function clearEntryCurrentState() {
  const el = document.getElementById("entryCurrentState");
  if (el) { el.style.display = "none"; el.innerHTML = ""; }
  setSelectPlaceholderHint("status",      "-- STATUS --",   "");
  setSelectPlaceholderHint("destination", "-- LOCATION --", "");
  setSelectPlaceholderHint("fuelLevel",   "-- FUEL --",     "");
  setInputPlaceholderHint("mileage", "optional", "");
  // Drop any carried-over conditions so the next VIN doesn't inherit them.
  selectedCxrConditions = [];
  if (typeof renderCxrConditions === "function") renderCxrConditions();
}

// Force a manual sync — push any queued local changes, then pull cloud state.
async function forceSync() {
  if (!window.DT_SYNC) { showToast("Sync not loaded", "error"); return; }
  showToast("Syncing…", "info");
  try {
    await DT_SYNC.flush();
    await DT_SYNC.pull();
    showToast("Sync complete", "success");
  } catch (e) {
    console.warn("[Sync] force sync failed", e);
    showToast("Sync failed — see console", "error");
  }
}

// Wire PIN buttons once on load
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btnSetPin")?.addEventListener("click", openPinSetupModal);
  document.getElementById("btnChangePin")?.addEventListener("click", openPinSetupModal);
  document.getElementById("btnRemovePin")?.addEventListener("click", () => {
    if (!confirm("Remove the PIN on this device? Email + password will be required next time you open the app.")) return;
    if (window.DT_AUTH && DT_AUTH.removePin) DT_AUTH.removePin();
    applyProfile();
    showToast("PIN removed", "success");
  });
  document.getElementById("btnSendOwnReset")?.addEventListener("click", async () => {
    if (!window.DT_AUTH || !DT_AUTH.getUser()) { showToast("Not signed in", "error"); return; }
    const email = DT_AUTH.getUser().email;
    if (!email) { showToast("No email on this account", "error"); return; }
    if (!confirm(`Send a password-reset email to ${email}?`)) return;
    const { error } = await DT_AUTH.client.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname
    });
    if (error) { showToast(error.message, "error"); return; }
    showToast("Reset link sent — check your email", "success");
  });
});

function openPinSetupModal() {
  // Reuse auth.js's PIN setup form — it's already wired and writes via DT_AUTH.setPin internally
  const modal = document.getElementById("dt-auth-modal");
  if (!modal) return;
  // Switch the visible form, hide the tabs strip, and show the modal
  ["signin","signup","forgot","reset","pin-unlock","pin-setup"].forEach(n => {
    const f = document.getElementById("dt-form-" + n);
    if (f) f.classList.toggle("hidden", n !== "pin-setup");
  });
  const tabs = modal.querySelector(".dt-auth-tabs");
  if (tabs) tabs.style.display = "none";
  modal.classList.add("show");
}

function getDriverFileName(base, ext) {
  const profile = getProfile();
  const name = profile.name ? "_" + profile.name.replace(/\s+/g,"_") : "";
  const date = new Date().toISOString().slice(0,10);
  return `${base}${name}_${date}.${ext}`;
}
// ============================
// BACKUP / EXPORT / IMPORT
// ============================
// Snapshots are stored in IndexedDB (rotating, last 3 slots) plus one
// reserved "pre-restore" slot that's written automatically before any
// restore so the user can always undo. A small timestamp marker in
// localStorage drives the "Last backup" status row without needing an
// async IDB hit on every render.
const BACKUP_TIME_KEY = "drivertrax_backup_time";   // ms timestamp of newest slot
const BACKUP_INTERVAL_MS = 30 * 60 * 1000;          // 30 min
const BACKUP_STALE_MS = 24 * 60 * 60 * 1000;        // 24 h → warn user
const BACKUP_MAX_SLOTS = 3;
const PRE_RESTORE_KEY = "pre_restore";              // string key in `backups` store
// Legacy localStorage key from the v1 single-slot backup. Migrated into
// IDB on first run, then deleted.
const LEGACY_BACKUP_KEY = "drivertrax_backup";

// Every localStorage key the user has any business backing up. Anything
// that doesn't match these prefixes (sync queues, transient counters)
// is excluded so we never round-trip stale internal state on restore.
const BACKUP_KEY_PREFIXES = ["drivertrax_", "dt_"];
const BACKUP_EXCLUDE_KEYS = new Set([
  LEGACY_BACKUP_KEY,
  BACKUP_TIME_KEY,
  "drivertrax_sync_queue",
  "drivertrax_sync_snapshot"
]);

function snapshotLocalStorage() {
  const snap = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || BACKUP_EXCLUDE_KEYS.has(k)) continue;
    if (!BACKUP_KEY_PREFIXES.some(p => k.startsWith(p))) continue;
    snap[k] = localStorage.getItem(k);
  }
  return snap;
}

function snapshotRecordCount(snap) {
  try { return JSON.parse(snap[DB_KEY] || "[]").length; } catch { return 0; }
}

async function runBackup(manual = false) {
  if (!window.DT_IDB) {
    if (manual) showToast("Backup unavailable - storage locked", "error");
    return;
  }
  const ts = Date.now();
  const snap = snapshotLocalStorage();
  const entry = {
    ts,
    version: 2,
    recordCount: snapshotRecordCount(snap),
    keys: snap
  };
  const ok = await DT_IDB.set("backups", ts, entry);
  if (!ok) {
    if (manual) showToast("Backup failed - storage may be full", "error");
    return;
  }
  // Rotate: keep newest BACKUP_MAX_SLOTS plus the reserved pre_restore key.
  try {
    const allKeys = await DT_IDB.keys("backups");
    const numericKeys = allKeys.filter(k => typeof k === "number").sort((a, b) => b - a);
    for (const old of numericKeys.slice(BACKUP_MAX_SLOTS)) {
      await DT_IDB.del("backups", old);
    }
  } catch {}
  localStorage.setItem(BACKUP_TIME_KEY, ts.toString());
  updateBackupStatus();
  renderBackupSlots();
  if (manual) showToast("Backup saved", "success");
}

function updateBackupStatus() {
  const ts = localStorage.getItem(BACKUP_TIME_KEY);
  const timeEl = document.getElementById("lastBackupTime");
  const staleEl = document.getElementById("backupStaleWarning");

  if (!ts) {
    if (timeEl) timeEl.textContent = "—";
    if (staleEl) staleEl.style.display = "none";
    return;
  }

  const tsNum = parseInt(ts);
  const d = new Date(tsNum);
  const timeStr = d.toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit", timeZone:"America/New_York"});
  const dateStr = d.toLocaleDateString("en-US", {month:"short", day:"numeric", timeZone:"America/New_York"});

  if (timeEl) timeEl.textContent = `${dateStr} at ${timeStr}`;

  // Stale warning: if we haven't backed up in > 24h, the auto-backup is
  // probably failing (quota, locked storage). Surface it.
  if (staleEl) {
    const stale = (Date.now() - tsNum) > BACKUP_STALE_MS;
    staleEl.style.display = stale ? "" : "none";
  }
}

async function listBackups() {
  if (!window.DT_IDB) return [];
  const all = await DT_IDB.values("backups");
  return all
    .filter(b => b && typeof b.ts === "number")
    .sort((a, b) => b.ts - a.ts);
}

async function renderBackupSlots() {
  const el = document.getElementById("backupSlots");
  if (!el) return;
  const slots = await listBackups();
  if (slots.length === 0) {
    el.innerHTML = '<div class="data-status-row"><span class="data-label">No snapshots yet.</span></div>';
    return;
  }
  el.innerHTML = slots.map((s, i) => {
    const d = new Date(s.ts);
    const time = d.toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit", timeZone:"America/New_York"});
    const date = d.toLocaleDateString("en-US", {month:"short", day:"numeric", timeZone:"America/New_York"});
    const label = i === 0 ? "Latest" : `Slot ${i + 1}`;
    return `
      <div class="data-status-row backup-slot-row">
        <div class="backup-slot-info">
          <div class="data-label">${label} · ${sanitizeText(date)} at ${sanitizeText(time)}</div>
          <div class="data-value">${s.recordCount} records</div>
        </div>
        <button class="btn btn-secondary" onclick="restoreFromBackup(${s.ts})">Restore</button>
      </div>`;
  }).join("");
}

async function restoreFromBackup(ts) {
  if (!window.DT_IDB) { showToast("Restore unavailable", "error"); return; }
  const entry = await DT_IDB.get("backups", ts);
  if (!entry || !entry.keys) { showToast("Snapshot not found", "error"); return; }
  if (!confirm(`Restore ${entry.recordCount} records from ${new Date(ts).toLocaleString()}? Your current state will be saved as an undo point.`)) return;

  // Save current state as the pre-restore undo slot before mutating.
  const undo = {
    ts: Date.now(),
    version: 2,
    recordCount: getRecords().length,
    keys: snapshotLocalStorage()
  };
  await DT_IDB.set("backups", PRE_RESTORE_KEY, undo);

  applySnapshot(entry.keys);
  showToast(`Restored ${entry.recordCount} records — use Undo if this was wrong`, "success");
  renderBackupSlots();
  updatePreRestoreUI();
}

async function undoRestore() {
  if (!window.DT_IDB) return;
  const undo = await DT_IDB.get("backups", PRE_RESTORE_KEY);
  if (!undo || !undo.keys) { showToast("Nothing to undo", "error"); return; }
  if (!confirm("Undo the last restore? Current state will be replaced.")) return;
  applySnapshot(undo.keys);
  await DT_IDB.del("backups", PRE_RESTORE_KEY);
  updatePreRestoreUI();
  showToast("Restore undone", "success");
}

async function updatePreRestoreUI() {
  const btn = document.getElementById("undoRestoreBtn");
  if (!btn || !window.DT_IDB) return;
  const undo = await DT_IDB.get("backups", PRE_RESTORE_KEY);
  btn.style.display = undo ? "" : "none";
}

// Overwrite local state with a captured key/value map, then re-render.
function applySnapshot(keys) {
  // Remove any backup-eligible key not present in the snapshot so the
  // restore is a true replacement, not a merge.
  const toDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || BACKUP_EXCLUDE_KEYS.has(k)) continue;
    if (!BACKUP_KEY_PREFIXES.some(p => k.startsWith(p))) continue;
    if (!(k in keys)) toDelete.push(k);
  }
  for (const k of toDelete) localStorage.removeItem(k);
  for (const k in keys) localStorage.setItem(k, keys[k]);

  invalidateRecordsCache();
  applyProfile();
  renderTodayEntries();
  try { if (typeof renderRecords === "function") renderRecords(); } catch {}
  try { if (typeof renderDashboard === "function") renderDashboard(); } catch {}
}

function exportJSON() {
  const records = getRecords();
  if (records.length === 0) { showToast("No records to export", "error"); return; }
  const snap = snapshotLocalStorage();
  const data = {
    version: 2,
    exportedAt: new Date().toISOString(),
    recordCount: snapshotRecordCount(snap),
    keys: snap,
    // Back-compat fields so an older client can still read its own records
    // out of a v2 file without choking.
    records,
    profile: getProfile()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = getDriverFileName("drivertrax_backup", "json");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${records.length} records`, "success");
}

function importJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("importStatus");
  if (statusEl) statusEl.textContent = "Reading file...";

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      const isV2 = parsed.version === 2 && parsed.keys;
      const rawRecords = parsed.records || (isV2 ? safeParseRecords(parsed.keys[DB_KEY]) : null);
      if (!Array.isArray(rawRecords)) throw new Error("Invalid format");

      // Validate/coerce id on every record. ids flow into inline onclick
      // strings elsewhere, so untrusted values would be an XSS vector.
      const cleanRecords = [];
      let rejected = 0;
      for (const r of rawRecords) {
        if (!r || typeof r !== "object") { rejected++; continue; }
        const idStr = String(r.id);
        if (!/^\d+$/.test(idStr)) { rejected++; continue; }
        cleanRecords.push({ ...r, id: idStr });
      }

      const existing = getRecords();
      const existingIds = new Set(existing.map(r => r.id));
      const newRecords = cleanRecords.filter(r => !existingIds.has(r.id));
      const merged = [...existing, ...newRecords].sort((a,b) => b.timestamp - a.timestamp);

      const dupCount = cleanRecords.length - newRecords.length;
      const baseMsg = `Import ${newRecords.length} new records? (${dupCount} duplicates skipped${rejected ? `, ${rejected} invalid rejected` : ""})`;
      if (!confirm(baseMsg)) {
        if (statusEl) statusEl.textContent = "";
        event.target.value = "";
        return;
      }

      setRecords(merged);

      // Profile clobber guard: only overwrite the local profile if the
      // current user has no name set, or explicitly opts in.
      const incomingProfile = parsed.profile
        || (isV2 && parsed.keys[PROFILE_KEY] ? safeParseObj(parsed.keys[PROFILE_KEY]) : null);
      if (incomingProfile) {
        const current = getProfile();
        const currentName = (current.name || "").trim();
        const incomingName = (incomingProfile.name || "").trim();
        const namesDiffer = currentName && incomingName && currentName !== incomingName;
        const shouldOverwrite = !currentName ||
          (namesDiffer && confirm(`Overwrite profile "${currentName}" with "${incomingName}" from the file?`));
        if (shouldOverwrite) {
          localStorage.setItem(PROFILE_KEY, JSON.stringify(incomingProfile));
          applyProfile();
        }
      }

      renderTodayEntries();
      runBackup();
      if (statusEl) statusEl.textContent = `Imported ${newRecords.length} new records`;
      showToast(`Imported ${newRecords.length} records`, "success");
    } catch(err) {
      if (statusEl) statusEl.textContent = "Invalid file - could not import";
      showToast("Import failed - invalid file", "error");
    }
    event.target.value = "";
  };
  reader.readAsText(file);
}

function safeParseRecords(raw) { try { return JSON.parse(raw || "[]"); } catch { return null; } }
function safeParseObj(raw) { try { return JSON.parse(raw); } catch { return null; } }

// One-time: migrate the v1 single-slot backup from localStorage into IDB
// so users who haven't backed up since the rewrite still have a snapshot.
async function migrateLegacyBackup() {
  if (!window.DT_IDB) return;
  const raw = localStorage.getItem(LEGACY_BACKUP_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.records)) {
      const ts = parsed.timestamp || Date.now();
      const keys = { [DB_KEY]: JSON.stringify(parsed.records) };
      await DT_IDB.set("backups", ts, {
        ts,
        version: 2,
        recordCount: parsed.records.length,
        keys
      });
    }
  } catch {}
  localStorage.removeItem(LEGACY_BACKUP_KEY);
}

// Re-render the slot list whenever the user opens the Data panel.
document.addEventListener("dt-tab-shown", (e) => {
  if (e.detail === "data") { renderBackupSlots(); updatePreRestoreUI(); }
});

// ============================
// WEATHER ALERT (SDF / Louisville 40213)
// ============================
const EXTREME_CODES = {
  55:"Heavy Drizzle",
  65:"Heavy Rain", 67:"Heavy Freezing Rain",
  75:"Heavy Snow", 77:"Snow Grains",
  82:"Violent Rain Showers", 85:"Heavy Snow Showers", 86:"Heavy Snow Showers",
  95:"Thunderstorm", 96:"Thunderstorm + Hail", 99:"Thunderstorm + Heavy Hail"
};

const ALERT_DISMISSED_KEY = "drivertrax_alert_dismissed";

function dismissWeatherAlert() {
  document.getElementById("weatherAlert").classList.remove("show");
  localStorage.setItem(ALERT_DISMISSED_KEY, Date.now().toString());
}

function testWeatherAlert() {
  localStorage.removeItem(ALERT_DISMISSED_KEY);
  checkWeatherAlert();
}

async function checkWeatherAlert() {
  const dismissed = parseInt(localStorage.getItem(ALERT_DISMISSED_KEY) || "0");
  if (Date.now() - dismissed < 30 * 60 * 1000) return;

  const alerts = [];

  // NWS official alerts for SDF area
  try {
    const nwsRes = await fetch("https://api.weather.gov/alerts/active?point=38.1741,-85.7368", {
      headers: { "Accept": "application/geo+json", "User-Agent": "DriverTrax/1.0 (louisville-airport-ops)" }
    });
    if (nwsRes.ok) {
      const nwsData = await nwsRes.json();
      if (nwsData.features && nwsData.features.length > 0) {
        nwsData.features.forEach(f => {
          const event = f.properties && f.properties.event;
          if (event) alerts.push(event);
        });
      }
    }
  } catch(e) { console.warn("NWS fetch failed:", e.message); }

  // Open-Meteo backup for extreme conditions
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=38.1741&longitude=-85.7368&current=temperature_2m,weather_code,windspeed_10m&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=America%2FNew_York";
    const res = await fetch(url);
    const raw = await res.text();
    const data = JSON.parse(raw);
    const c = data.current;
    if (c) {
      const code = c.weather_code !== undefined ? c.weather_code : c.weathercode;
      const temp = Math.round(c.temperature_2m);
      const wind = Math.round(c.windspeed_10m);
      if (EXTREME_CODES[code]) alerts.push(EXTREME_CODES[code]);
      if (temp <= 20) alerts.push(`Extreme Cold: ${temp}F`);
      if (temp >= 100) alerts.push(`Extreme Heat: ${temp}F`);
      if (wind >= 30) alerts.push(`High Winds: ${wind}mph`);
    }
  } catch(e) { console.warn("Open-Meteo fetch failed:", e.message); }

  const unique = [...new Set(alerts)];
  const alertEl = document.getElementById("weatherAlert");
  if (unique.length > 0) {
    document.getElementById("weatherAlertMsg").textContent = "SDF WEATHER ALERT: " + unique.join(" • ");
    alertEl.classList.add("show");
  } else {
    alertEl.classList.remove("show");
  }
}

// ============================
// INIT
// ============================
if (localStorage.getItem(SHUTTLE_KEY) === "1") {
  document.getElementById("shuttle").checked = true;
  document.getElementById("shuttleRow").classList.add("shuttle-checked");
}
if (localStorage.getItem(TRANSPORT_KEY) === "1") {
  document.getElementById("transport").checked = true;
  document.getElementById("transportRow").classList.add("transport-checked");
}
checkWeatherAlert();
setInterval(checkWeatherAlert, 15 * 60 * 1000);
migrateLegacyBackup().then(() => {
  runBackup();
  setInterval(runBackup, BACKUP_INTERVAL_MS);
});
updateBackupStatus();
applyProfile();
renderTodayEntries();
