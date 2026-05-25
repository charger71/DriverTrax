// ============================================================
// DRIVERTRAX v2.0
// Single-file PWA for rental car lot operations
// ============================================================

const APP_VERSION = "2.1";
const SCHEMA_VERSION = 2;
const SCHEMA_KEY = "drivertrax_schema_version";

// ============================
// SERVICE WORKER REGISTRATION
// ============================
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
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#${color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.4)}px;font-weight:800;font-family:Arial,sans-serif;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;">${num}</div>`,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
    popupAnchor: [0, -(size/2)]
  });
}

function recordPopupHTML(r) {
  const time = new Date(r.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/New_York"
  });
  return `
    <div style="font-family:Arial,sans-serif;min-width:140px">
      <div style="font-weight:800;font-size:14px;margin-bottom:4px">${sanitizeText(r.serialId)}</div>
      <div style="font-size:12px;color:#555;margin-bottom:6px">${sanitizeText(r.status)}${r.destination ? " &middot; " + sanitizeText(r.destination) : ""}</div>
      <div style="font-size:11px;color:#888;margin-bottom:8px">${time}</div>
      <button onclick="openDetail('${r.id}', 'deleteRecord')" style="background:#00a651;color:#fff;border:none;padding:5px 12px;border-radius:4px;font-size:12px;font-weight:700;cursor:pointer;width:100%">View Record</button>
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

function getFiltered() {
  const search = document.getElementById("fSearch").value.trim().toUpperCase();
  const status = document.getElementById("fStatus").value;
  const noTagFilter = document.getElementById("fNoTag").value;
  const dest = document.getElementById("fDest").value;
  const from = document.getElementById("fDateFrom").value;
  const to = document.getElementById("fDateTo").value;
  return getRecords().filter(r => {
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
    return {
      year: map["Model Year"] || "",
      make: map["Make"] || "",
      model: map["Model"] || "",
      trim: map["Trim"] || "",
      bodyClass: map["Body Class"] || "",
      fuelType: map["Fuel Type - Primary"] || "",
      engine: map["Displacement (L)"] ? `${map["Displacement (L)"]}L` : "",
      manufacturer: map["Manufacturer Name"] || ""
    };
  } catch(e) { console.warn("VIN decode failed:", e); return null; }
}

// ============================
// SAVE RECORD
// ============================
function saveRecord() {
  const serial = sanitizeSerial(document.getElementById("serial").value.trim().toUpperCase());
  if (!serial) { showToast("Please enter or scan a Serial ID.", "error"); return; }
  const statusVal = document.getElementById("status").value;
  if (!statusVal) { showToast("Please select a status.", "error"); return; }

  const saveBtn = document.getElementById("saveBtn");
  const gpsEl = document.getElementById("gpsStatus");
  saveBtn.disabled = true;
  saveBtn.innerHTML = "Getting location...";
  gpsEl.className = "gps-status acquiring";
  gpsEl.textContent = "Acquiring GPS coordinates...";

  const allShifts = getAllShifts();
  const lastShift = allShifts.length > 0 ? allShifts[allShifts.length-1] : null;
  const lastTs = lastShift ? lastShift.records[lastShift.records.length-1].timestamp : null;
  const isNewShift = !lastTs || (Date.now() - lastTs >= SHIFT_GAP_MS);
  const currentShiftNum = isNewShift ? allShifts.length + 1 : allShifts.length || 1;

  const recordData = {
    id: Date.now().toString(),
    serialId: serial,
    status: statusVal,
    tires: statusVal === "TI" ? [...selectedTires] : [],
    destination: document.getElementById("destination").value,
    noTag: document.getElementById("noTag").checked,
    shuttle: document.getElementById("shuttle").checked,
    transport: document.getElementById("transport").checked,
    shiftNum: currentShiftNum,
    notes: sanitizeNotes(document.getElementById("notes").value),
    timestamp: Date.now()
  };

  function doSave(lat, lng, gpsError) {
    if (lat !== null) { recordData.lat = lat; recordData.lng = lng; }
    if (gpsError) { recordData.gpsError = true; }
    const records = getRecords();
    records.unshift(recordData);
    setRecords(records);
    document.getElementById("serial").value = "";
    toggleClearBtn();
    updateVinCount();
    document.getElementById("notes").value = "";
    document.getElementById("status").selectedIndex = 0;
    document.getElementById("tireSelectorSection").style.display = "none";
    resetTires();
    document.getElementById("destination").selectedIndex = 0;
    document.getElementById("noTag").checked = false;
    toggleNoTagStyle();
    document.getElementById("transport").checked = false;
    toggleTransportStyle();
    document.getElementById("manualEntrySection").style.display = "none";
    document.querySelector(".btn-manual-toggle").innerHTML = "Enter Manually";
    saveBtn.disabled = false;
    saveBtn.innerHTML = "SAVE RECORD";
    gpsEl.className = "gps-status";
    gpsEl.textContent = "";
    renderTodayEntries();
    if (gpsError) { showToast("Saved - no GPS location", "warn"); }
    else { showToast("Saved with GPS", "success"); }

    // VIN decode runs AFTER record is saved so the lookup finds it
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

  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      pos => { gpsEl.className = "gps-status got"; gpsEl.textContent = "Location acquired"; doSave(pos.coords.latitude, pos.coords.longitude, false); },
      err => { gpsEl.className = "gps-status err"; gpsEl.textContent = "Location unavailable - saving anyway"; saveBtn.innerHTML = "Saving..."; setTimeout(() => doSave(null, null, true), 800); },
      { timeout: 8000, maximumAge: 30000, enableHighAccuracy: true }
    );
  } else { doSave(null, null, true); }
}

// ============================
// SLIDE MENU
// ============================
function openMenu() {
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
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.getElementById("panel-" + name).classList.add("active");
  const idx = {entry:0, records:1, dashboard:2}[name];
  if (idx !== undefined) document.querySelectorAll(".tab")[idx].classList.add("active");
  if (name === "entry") renderTodayEntries();
  if (name === "records") renderRecords();
  if (name === "dashboard") { applyProfile(); renderDashboard(); }
  if (name === "profile") applyProfile();
}

// ============================
// TIRE SELECTOR
// ============================
let selectedTires = [];

function handleStatusChange() {
  const val = document.getElementById("status").value;
  const section = document.getElementById("tireSelectorSection");
  if (val === "TI") {
    section.style.display = "block";
  } else {
    section.style.display = "none";
    resetTires();
  }
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
  const visible = section.style.display !== "none";
  section.style.display = visible ? "none" : "block";
  btn.innerHTML = visible ? "Enter Manually" : "Hide Manual Entry";
  if (!visible) document.getElementById("serial").focus();
}

function showManualEntry() {
  const section = document.getElementById("manualEntrySection");
  const btn = document.querySelector(".btn-manual-toggle");
  section.style.display = "block";
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

  let html = VIN_KEYS.map(k => {
    const typeClass = /[0-9]/.test(k) ? "vin-key-num" : "vin-key-alpha";
    return `<button class="vin-key ${typeClass}" type="button" onclick="vinKeypadType('${k}')">${k}</button>`;
  }).join("");
  // Arrow keys after X/Y/Z to fill row 7 (5 cols)
  html += `<button class="vin-key vin-key-arrow" type="button" onclick="vinKeypadArrow(-1)" aria-label="Move left">&#9664;</button>`;
  html += `<button class="vin-key vin-key-arrow" type="button" onclick="vinKeypadArrow(1)" aria-label="Move right">&#9654;</button>`;
  // Row 8: backspace (1 col) + DONE (4 cols wide)
  html += `<button class="vin-key vin-key-back" type="button" onclick="vinKeypadBackspace()">&#9003;</button>`;
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
}

function closeVinKeypad(event) {
  if (event && event.target && event.target.id !== "vinKeypadOverlay") {
    if (event.currentTarget && event.target !== event.currentTarget) return;
  }
  document.getElementById("vinKeypadOverlay").classList.remove("open");
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
  const size = vinData._size || 28;
  const c = "var(--accent)";
  const uid = "v" + Math.random().toString(36).slice(2,7);

  const isElectric = fuel.includes("electric") && !fuel.includes("hybrid");
  const isHybrid = fuel.includes("hybrid") || (fuel.includes("electric") && fuel.includes("gasoline"));

  // Small fuel icon shown separately next to vehicle
  let fuelIcon = "";
  if (isElectric) {
    fuelIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" style="flex-shrink:0" title="Electric"><path d="M13.5 3L5 14h6.5L10 21l9-12h-6.5z" fill="#4d9bff"/></svg>`;
  } else if (isHybrid) {
    fuelIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" style="flex-shrink:0" title="Hybrid"><path d="M12 3C9 3 6 6.5 6 10.5c0 2.2 1 4.2 3 5.5 0-2.2.8-4.5 3-6-1 2.5-1 4.8 0 6 2-1.2 3-3.2 3-5.5C15 6.5 14 3 12 3z" fill="#00c853"/></svg>`;
  }

  let svg = "";
  if (body.includes("pickup") || body.includes("truck")) {
    svg = `<defs><mask id="${uid}"><rect width="24" height="24" fill="white"/><rect x="12" y="7.8" width="7.5" height="4" rx="0.8" fill="black"/><circle cx="6.2" cy="19.2" r="2" fill="black"/><circle cx="18" cy="19.2" r="2" fill="black"/></mask></defs><g mask="url(#${uid})"><rect x="1.5" y="13" width="21" height="6.5" rx="1.5" fill="${c}"/><rect x="10.5" y="7" width="11" height="7" rx="1" fill="${c}"/><rect x="1.5" y="9.5" width="10.5" height="4" rx="1" fill="${c}"/></g>`;
  } else if (body.includes("van") || body.includes("minivan")) {
    svg = `<defs><mask id="${uid}"><rect width="24" height="24" fill="white"/><rect x="2.5" y="7.5" width="8" height="5" rx="0.8" fill="black"/><rect x="13" y="7.5" width="8.5" height="5" rx="0.8" fill="black"/><circle cx="5.5" cy="19.5" r="2" fill="black"/><circle cx="18.5" cy="19.5" r="2" fill="black"/></mask></defs><g mask="url(#${uid})"><rect x="1.5" y="6" width="21" height="14" rx="1.5" fill="${c}"/></g>`;
  } else if (body.includes("suv") || body.includes("sport utility") || body.includes("crossover")) {
    svg = `<defs><mask id="${uid}"><rect width="24" height="24" fill="white"/><rect x="6" y="7.5" width="5" height="4.5" rx="0.8" fill="black"/><rect x="13" y="7.5" width="5" height="4.5" rx="0.8" fill="black"/><circle cx="6.5" cy="19.5" r="2" fill="black"/><circle cx="17.5" cy="19.5" r="2" fill="black"/></mask></defs><g mask="url(#${uid})"><rect x="1.5" y="13" width="21" height="7" rx="1.5" fill="${c}"/><path d="M3 13 L5.5 6.5 L18.5 6.5 L21 13 Z" fill="${c}"/></g>`;
  } else if (body.includes("convertible") || body.includes("roadster")) {
    svg = `<defs><mask id="${uid}"><rect width="24" height="24" fill="white"/><rect x="7" y="11.5" width="4" height="3" rx="0.5" fill="black"/><rect x="13" y="11.5" width="4" height="3" rx="0.5" fill="black"/><circle cx="6.5" cy="20.5" r="2" fill="black"/><circle cx="17.5" cy="20.5" r="2" fill="black"/></mask></defs><g mask="url(#${uid})"><rect x="1.5" y="15" width="21" height="6" rx="1.5" fill="${c}"/><path d="M4.5 15 L7 11 L17 11 L19.5 15 Z" fill="${c}"/></g>`;
  } else if (body.includes("wagon") || body.includes("hatchback")) {
    svg = `<defs><mask id="${uid}"><rect width="24" height="24" fill="white"/><rect x="5" y="8.5" width="5.5" height="4" rx="0.8" fill="black"/><rect x="12.5" y="8.5" width="6" height="4" rx="0.8" fill="black"/><circle cx="6.5" cy="19.5" r="2" fill="black"/><circle cx="17.5" cy="19.5" r="2" fill="black"/></mask></defs><g mask="url(#${uid})"><rect x="1.5" y="13" width="21" height="7" rx="1.5" fill="${c}"/><path d="M3 13 L4.5 8 L20 8 L21.5 13 Z" fill="${c}"/></g>`;
  } else {
    svg = `<defs><mask id="${uid}"><rect width="24" height="24" fill="white"/><rect x="7" y="9.5" width="4" height="4" rx="0.8" fill="black"/><rect x="13" y="9.5" width="4" height="4" rx="0.8" fill="black"/><circle cx="6.5" cy="20" r="2" fill="black"/><circle cx="17.5" cy="20" r="2" fill="black"/></mask></defs><g mask="url(#${uid})"><rect x="1.5" y="14" width="21" height="6.5" rx="1.5" fill="${c}"/><path d="M4.5 14 L7 9 L17 9 L19.5 14 Z" fill="${c}"/></g>`;
  }

  const vehicleIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" style="vertical-align:middle;flex-shrink:0">${svg}</svg>`;
  return { vehicle: vehicleIcon, fuel: fuelIcon };
}

// ============================
// RECORD CARD HTML (shared)
// ============================
function recordCard(r, onDelete) {
  let vinInfo = "";
  if (r.vinData) {
    const icons = getVehicleSVG(r.vinData);
    const name = [r.vinData.year, r.vinData.make, r.vinData.model].filter(Boolean).map(sanitizeText).join(" ");
    const trim = r.vinData.trim ? `<span style="color:var(--muted);font-size:12px"> ${sanitizeText(r.vinData.trim)}</span>` : "";
    vinInfo = `<div class="record-vin" style="display:flex;align-items:center;gap:6px">${icons.vehicle}${icons.fuel}<span><b>${name}</b>${trim}</span></div>`;
  }
  const safeSerial = sanitizeText(r.serialId || "");
  const safeStatus = sanitizeText(r.status || "");
  const safeDest = r.destination ? sanitizeText(r.destination) : "";
  const safeNotes = r.notes ? sanitizeText(r.notes) : "";
  const safeTires = r.tires && r.tires.length > 0 ? r.tires.map(sanitizeText).join(", ") : "";

  return `
    <div class="record" onclick="openDetail('${r.id}', '${onDelete}')">
      <div class="record-header">
        <div class="record-serial">${safeSerial}</div>
        <div class="record-badges">
          <span class="record-status ${statusClass(r.status)}">${safeStatus}</span>
          ${safeDest ? `<span class="badge-dest"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${safeDest}</span>` : ""}
          ${r.shuttle ? `<span class="badge-shuttle"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="22" height="12" rx="2"/><path d="M16 6V4a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v2"/><line x1="12" y1="6" x2="12" y2="18"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><line x1="1" y1="12" x2="23" y2="12"/></svg> SHUTTLE</span>` : ""}
          ${r.transport ? '<span class="badge-transport">TRANSPORT</span>' : ""}
          ${r.noTag ? '<span class="badge-notag">NO TAG</span>' : ""}
        </div>
      </div>
      ${vinInfo}
      <div class="record-meta"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${new Date(r.timestamp).toLocaleTimeString("en-US", {hour:'2-digit',minute:'2-digit', timeZone:"America/New_York"})}</div>
      ${safeTires ? `<div class="record-meta" style="margin-top:4px">Tires: <b style="color:var(--danger)">${safeTires}</b></div>` : ""}
      ${safeNotes ? `<div class="record-notes">${safeNotes}</div>` : ""}
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
  document.getElementById("todayRecords").innerHTML = sorted.map(r => recordCard(r, "deleteTodayRecord")).join("");
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

function renderRecords() {
  const records = getFiltered();
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / RECORDS_PER_PAGE));

  // Clamp current page if filters reduced the total
  if (recordsCurrentPage > totalPages) recordsCurrentPage = totalPages;
  if (recordsCurrentPage < 1) recordsCurrentPage = 1;

  const startIdx = (recordsCurrentPage - 1) * RECORDS_PER_PAGE;
  const endIdx = Math.min(startIdx + RECORDS_PER_PAGE, total);
  const pageRecords = records.slice(startIdx, endIdx);

  // Update the results count to reflect pagination
  const countEl = document.getElementById("resultsCount");
  if (total === 0) {
    countEl.textContent = "0 records found";
  } else if (total <= RECORDS_PER_PAGE) {
    countEl.textContent = total + " record" + (total !== 1 ? "s" : "") + " found";
  } else {
    countEl.textContent = `Showing ${startIdx + 1}-${endIdx} of ${total} records`;
  }

  if (total === 0) {
    document.getElementById("records").innerHTML =
      '<p style="color:var(--muted);text-align:center;padding:24px">No records match your filters.</p>';
  } else {
    let html = pageRecords.map(r => recordCard(r, "deleteRecord")).join("");
    // Append pagination controls if needed
    if (totalPages > 1) {
      html += renderPaginationControls(recordsCurrentPage, totalPages);
    }
    document.getElementById("records").innerHTML = html;
  }
  renderRecordsMap(); // refresh map if open
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
    new Date(r.timestamp).toLocaleString("en-US", {
      weekday:"short", month:"short", day:"numeric",
      hour:"numeric", minute:"2-digit", timeZone:"America/New_York"
    });

  document.getElementById("detailBadges").innerHTML = `
    <span class="record-status ${statusClass(r.status)}">${sanitizeText(r.status)}</span>
    ${r.destination ? `<span class="badge-dest">${sanitizeText(r.destination)}</span>` : ""}
    ${r.shuttle ? '<span class="badge-shuttle">SHUTTLE</span>' : ""}
    ${r.transport ? '<span class="badge-transport">TRANSPORT</span>' : ""}
    ${r.noTag ? '<span class="badge-notag">NO TAG</span>' : ""}
  `;

  // Vehicle info
  const vinSection = document.getElementById("detailVinSection");
  if (r.vinData) {
    const name = [r.vinData.year, r.vinData.make, r.vinData.model].filter(Boolean).map(sanitizeText).join(" ");
    const trim = sanitizeText(r.vinData.trim || "");
    const specs = [r.vinData.bodyClass, r.vinData.engine, r.vinData.fuelType].filter(Boolean).map(sanitizeText).join("  ·  ");
    const icons = getVehicleSVG({...r.vinData, _size: 36});
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
  if (r.destination) {
    document.getElementById("detailDest").textContent = r.destination;
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
    new Date(r.timestamp).toLocaleString("en-US", {
      weekday:"short", month:"short", day:"numeric",
      hour:"numeric", minute:"2-digit", timeZone:"America/New_York"
    });

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
function exportCSV() {
  const records = getFiltered();
  if (records.length === 0) { showToast("No records to export.", "error"); return; }
  const rows = [["ID","Serial ID","Year","Make","Model","Status","Tires","Destination","Shuttle","Transport","No Tag","Notes","Latitude","Longitude","Timestamp"]];
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
    (r.notes || "").replace(/,/g,";"),
    r.lat !== undefined ? r.lat.toFixed(6) : "",
    r.lng !== undefined ? r.lng.toFixed(6) : "",
    new Date(r.timestamp).toLocaleString()
  ]));
  const csv = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = getDriverFileName("drivertrax", "csv");
  a.click();
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
    el.innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:16px">No records yet - start scanning to build your stats.</p>';
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
      <div class="pr-card highlight" onclick="viewByDate('${bestDayDate}')" style="cursor:pointer">
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
const RANGES = ['7days','30days','3months','6months','1year','alltime'];

function toggleRange(id) {
  const body = document.getElementById('body-' + id);
  const chev = document.getElementById('chev-' + id);
  const tab  = document.getElementById('tab-' + id);
  const isOpen = body.style.display !== 'none';

  // Close all
  RANGES.forEach(r => {
    document.getElementById('body-' + r).style.display = 'none';
    document.getElementById('chev-' + r).innerHTML = '&#9654;';
    document.getElementById('tab-'  + r).classList.remove('active');
  });

  if (!isOpen) {
    body.style.display = 'block';
    chev.innerHTML = '&#9660;';
    tab.classList.add('active');
    renderRange(id);
  }
}

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
    document.getElementById(elId).innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:16px">No entries in this period</p>';
    return;
  }
  const max = Math.max(...nonZero.map(d => byDay[d]));
  document.getElementById(elId).innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>
        <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase">Date</th>
        <th style="padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase"></th>
        <th style="text-align:right;padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase">Cars</th>
      </tr></thead>
      <tbody>
        ${nonZero.map(d => `
          <tr style="cursor:pointer" onclick="viewByDate('${d}')">
            <td style="padding:6px 8px;color:${d===today?'var(--accent)':'var(--text2)'};white-space:nowrap;font-weight:${d===today?'700':'400'}">${labelFn(d)}${d===today?' (today)':''}</td>
            <td style="padding:6px 8px;width:55%">
              <div style="background:var(--accent);height:8px;border-radius:4px;width:${Math.round((byDay[d]/max)*100)}%;min-width:4px"></div>
            </td>
            <td style="padding:6px 8px;text-align:right;font-weight:700;color:var(--text)">${byDay[d]}</td>
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
    document.getElementById(elId).innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:16px">No entries in this period</p>';
    return;
  }
  const max = Math.max(...byWeek.map(w => w.count));
  document.getElementById(elId).innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>
        <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase">Week</th>
        <th style="padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase"></th>
        <th style="text-align:right;padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase">Cars</th>
      </tr></thead>
      <tbody>
        ${byWeek.map(w => `
          <tr style="cursor:pointer" onclick="viewByWeek('${w.start}','${w.end}','${w.start} to ${w.end}')">
            <td style="padding:6px 8px;color:var(--text2);white-space:nowrap">${w.start.slice(5)} - ${w.end.slice(5)}</td>
            <td style="padding:6px 8px;width:55%">
              <div style="background:var(--accent);height:8px;border-radius:4px;width:${Math.round((w.count/max)*100)}%;min-width:4px"></div>
            </td>
            <td style="padding:6px 8px;text-align:right;font-weight:700;color:var(--text)">${w.count}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderRangeMonthTable(elId, all, months) {
  if (!months.length) {
    document.getElementById(elId).innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:16px">No entries in this period</p>';
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
    document.getElementById(elId).innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:16px">No entries in this period</p>';
    return;
  }
  const max = Math.max(...byMonth.map(m => m.count));
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  document.getElementById(elId).innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>
        <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase">Month</th>
        <th style="padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase"></th>
        <th style="text-align:right;padding:6px 8px;color:var(--muted);font-weight:700;font-size:10px;text-transform:uppercase">Cars</th>
      </tr></thead>
      <tbody>
        ${byMonth.map(m => {
          const [yr, mo] = m.key.split('-');
          const fromDate = `${m.key}-01`;
          const toDate = new Date(parseInt(yr), parseInt(mo), 0);
          const toStr = `${yr}-${mo}-${String(toDate.getDate()).padStart(2,'0')}`;
          return `<tr style="cursor:pointer" onclick="viewByWeek('${fromDate}','${toStr}','${m.label}')">
            <td style="padding:6px 8px;color:${m.key===thisMonth?'var(--accent)':'var(--text2)'};font-weight:${m.key===thisMonth?'700':'400'}">${m.label}${m.key===thisMonth?' ·':''}</td>
            <td style="padding:6px 8px;width:55%">
              <div style="background:var(--accent);height:8px;border-radius:4px;width:${Math.round((m.count/max)*100)}%;min-width:4px"></div>
            </td>
            <td style="padding:6px 8px;text-align:right;font-weight:700;color:var(--text)">${m.count}</td>
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
let recordsMapOpen = true;

function toggleRecordsMap() {
  const body = document.getElementById('body-recordsMap');
  const chev = document.getElementById('chev-recordsMap');
  const tab  = document.getElementById('tab-recordsMap');
  recordsMapOpen = body.style.display === 'none';
  body.style.display = recordsMapOpen ? 'block' : 'none';
  chev.innerHTML = recordsMapOpen ? '&#9660;' : '&#9654;';
  tab.classList.toggle('active', recordsMapOpen);
  if (recordsMapOpen) renderRecordsMap();
}

function renderRecordsMap() {
  if (!recordsMapOpen) return;
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
      const time = new Date(r.timestamp).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', timeZone:'America/New_York' });
      const marker = L.marker([r.lat, r.lng], { icon })
        .addTo(recordsLeafletMap)
        .bindPopup(`
          <div style="font-family:Arial,sans-serif;min-width:140px">
            <div style="font-weight:800;font-size:14px;margin-bottom:4px">${sanitizeText(r.serialId)}</div>
            <div style="font-size:12px;color:#555;margin-bottom:4px">${sanitizeText(r.status)}${r.destination ? ' · ' + sanitizeText(r.destination) : ''}</div>
            <div style="font-size:11px;color:#888;margin-bottom:8px">${time}</div>
            <button onclick="document.getElementById('recordsMap')._openDetail('${r.id}')"
              style="background:#00a651;color:#fff;border:none;padding:5px 12px;border-radius:4px;font-size:12px;font-weight:700;cursor:pointer;width:100%">
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

function initLeafletMap() {
  if (leafletMap) return;
  leafletMap = createMap("shiftMap");
}

function clearLeafletMarkers() {
  leafletMarkers.forEach(m => leafletMap.removeLayer(m));
  leafletMarkers = [];
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

  // Force Leaflet to recalculate size after display change
  setTimeout(() => leafletMap.invalidateSize(), 50);

  const bounds = [];

  records.forEach((r, i) => {
    const color = statusMapColor(r.status);
    const num = i + 1;

    // Custom numbered SVG marker
    const icon = createNumberedMarker(num, color, 28);

    const time = new Date(r.timestamp).toLocaleTimeString("en-US", {
      hour:"2-digit", minute:"2-digit", timeZone:"America/New_York"
    });

    const marker = L.marker([r.lat, r.lng], { icon })
      .addTo(leafletMap)
      .bindPopup(`
        <div style="font-family:Arial,sans-serif;min-width:140px">
          <div style="font-weight:800;font-size:14px;margin-bottom:4px">${sanitizeText(r.serialId)}</div>
          <div style="font-size:12px;color:#555;margin-bottom:6px">${sanitizeText(r.status)}${r.destination ? " · " + sanitizeText(r.destination) : ""}</div>
          <div style="font-size:11px;color:#888;margin-bottom:8px">${time}</div>
          <button onclick="document.getElementById('shiftMap')._openDetail('${r.id}')"
            style="background:#00a651;color:#fff;border:none;padding:5px 12px;border-radius:4px;font-size:12px;font-weight:700;cursor:pointer;width:100%">
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
      const time = new Date(r.timestamp).toLocaleTimeString("en-US", {
        hour:"2-digit", minute:"2-digit", timeZone:"America/New_York"
      });
      return `<div class="map-legend-row" onclick="openDetail('${r.id}', 'deleteRecord')">
        <span class="map-legend-num" style="background:#${color}">${i+1}</span>
        <span class="map-legend-serial">${sanitizeText(r.serialId)}</span>
        <span class="record-status ${statusClass(r.status)}" style="font-size:10px">${sanitizeText(r.status)}</span>
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
    <div class="stat-card"><div class="stat-num" style="color:var(--danger)">${noTagCount}</div><div class="stat-label">No Tag</div></div>
  `;

  const statuses = ["CLEAN","DIRTY","PM","MK","MR","AUDIT","WI/DELETE","GLASS","OTHER"];
  const sc = {};
  statuses.forEach(s => sc[s] = 0);
  all.forEach(r => { sc[r.status] !== undefined ? sc[r.status]++ : sc["OTHER"]++; });
  const maxS = Math.max(...Object.values(sc), 1);
  document.getElementById("dashStatus").innerHTML = statuses
    .filter(s => sc[s] > 0)
    .map(s => `
      <div class="bar-row">
        <div class="bar-key">${s}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(sc[s]/maxS*100)}%"></div></div>
        <div class="bar-val">${sc[s]}</div>
      </div>
    `).join("") || '<p style="color:var(--muted);padding:8px">No data yet.</p>';

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
    <table class="day-table" style="width:100%">
      <thead><tr><th>Date</th><th>Shift</th><th>Cars</th><th>Avg</th><th></th></tr></thead>
      <tbody>
        ${days.map(d => {
          const dt = new Date(d+"T12:00:00");
          const dayName = dn[dt.getDay()];
          const isToday = d === today;
          const shifts = byDay[d];

          if (!shifts || shifts.length === 0) {
            return `<tr>
              <td>${d}${isToday ? ' <b style="color:var(--accent)">(today)</b>' : ''}<br><span style="color:var(--muted);font-size:11px">${dayName}</span></td>
              <td style="color:var(--muted)">-</td>
              <td style="color:var(--muted)">0</td>
              <td style="color:var(--muted)">-</td>
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
              ${si === 0 ? `<td rowspan="${shifts.length}">${d}${isToday ? ' <b style="color:var(--accent)">(today)</b>' : ''}<br><span style="color:var(--muted);font-size:11px">${dayName}</span></td>` : ''}
              <td>
                <span style="font-size:11px;font-weight:700;color:var(--accent)">${shiftLabel}</span><br>
                <span style="font-size:10px;color:var(--muted)">${startTime} - ${endTime}</span>
              </td>
              <td><b>${shift.records.length}</b></td>
              <td style="color:var(--accent);font-weight:700">${avg || '<span style="color:var(--muted)">-</span>'}</td>
              <td class="tap-hint">View &#8594;</td>
            </tr>`;
          }).join("");
        }).join("")}
      </tbody>
    </table>`;

  // Week comparison - clickable
  const delta = thisWeekCount - lastWeekCount;
  const dStr = delta>0 ? "&#9650; +"+delta+" vs last week" : delta<0 ? "&#9660; "+delta+" vs last week" : "Same as last week";
  const dColor = delta>0 ? "var(--accent)" : delta<0 ? "var(--danger)" : "var(--muted)";
  document.getElementById("dashWeeks").innerHTML = `
    <div class="stat-card clickable" onclick="viewByWeek('${thisWeekFromStr}','${thisWeekEnd}','This Week')">
      <div class="stat-num">${thisWeekCount}</div><div class="stat-label">This Week &#8594;</div>
    </div>
    <div class="stat-card clickable" onclick="viewByWeek('${lastWeekFromStr}','${lastWeekToStr}','Last Week')">
      <div class="stat-num">${lastWeekCount}</div><div class="stat-label">Last Week &#8594;</div>
    </div>
    <div class="stat-card" style="grid-column:span 2">
      <div class="stat-num" style="font-size:18px;color:${dColor}">${dStr}</div>
      <div class="stat-label">Week-over-Week</div>
    </div>`;
}

// ============================
// BARCODE SCANNER (ZXing)
// ============================
let codeReader = null;
let scannerActive = false;
let torchOn = false;
let activeStream = null;
let lastDecodeTime = 0;
const DECODE_THROTTLE_MS = 200;

function playScanBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
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
  } catch(e) {}
}

function openScanner() {
  const overlay = document.getElementById("scannerOverlay");
  const hint = document.getElementById("scannerHint");
  const dotSvg = '<span class="scanner-dot"><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8" style="vertical-align:middle;display:inline-block"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg></span>';
  overlay.classList.add("open");

  // Lock to portrait orientation while scanning
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock("portrait").catch(() => {});
  }
  hint.className = "scanner-status scanning";
  hint.innerHTML = dotSvg + " Starting camera...";
  torchOn = false;
  lastDecodeTime = 0;
  document.getElementById("torchBtn").classList.remove("on");

  if (!window.ZXing) {
    hint.className = "scanner-status error";
    hint.textContent = "Scanner library not loaded. Check internet and reload.";
    return;
  }

  try {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    codeReader = new ZXing.BrowserMultiFormatReader(hints);
    scannerActive = true;

    // Let ZXing enumerate and pick rear camera - it manages the video element
    codeReader.listVideoInputDevices().then(devices => {
      const rear = devices.find(d => /back|rear|environment/i.test(d.label))
                || devices[devices.length - 1];
      const deviceId = rear ? rear.deviceId : undefined;

      hint.innerHTML = dotSvg + " Scanning...";

      codeReader.decodeFromVideoDevice(deviceId, "scannerVideo", (result, err) => {
        if (!scannerActive) return;

        // Grab stream reference for torch after ZXing sets it up
        const video = document.getElementById("scannerVideo");
        if (video.srcObject && !activeStream) {
          activeStream = video.srcObject;
        }

        if (result) {
          const fmt = result.getBarcodeFormat();
          const code = result.getText().trim().toUpperCase();
          const is2D = fmt === ZXing.BarcodeFormat.QR_CODE ||
                       fmt === ZXing.BarcodeFormat.DATA_MATRIX ||
                       fmt === ZXing.BarcodeFormat.AZTEC ||
                       fmt === ZXing.BarcodeFormat.PDF_417;

          if (is2D) {
            // 2D codes are only allowed if they encode a valid VIN
            // Some 2D codes contain URLs with the VIN embedded - try to extract it
            let extractedVin = null;
            if (isValidVIN(code)) {
              extractedVin = code;
            } else {
              // Look for a 17-char VIN substring inside the decoded text
              const match = code.match(/[A-HJ-NPR-Z0-9]{17}/);
              if (match && isValidVIN(match[0])) {
                extractedVin = match[0];
              }
            }
            if (!extractedVin) return; // not a VIN-bearing QR, ignore
            // Use the extracted VIN as the code
            const flash = document.getElementById("scannerFlash");
            flash.classList.remove("flash");
            void flash.offsetWidth;
            flash.classList.add("flash");
            navigator.vibrate && navigator.vibrate([80, 40, 80]);
            playScanBeep();
            hint.className = "scanner-status success";
            hint.textContent = extractedVin;
            document.getElementById("serial").value = extractedVin;
            toggleClearBtn();
            updateVinCount();
            showManualEntry();
            setTimeout(() => closeScanner(), 600);
            return;
          }
          const flash = document.getElementById("scannerFlash");
          flash.classList.remove("flash");
          void flash.offsetWidth;
          flash.classList.add("flash");
          navigator.vibrate && navigator.vibrate([80, 40, 80]);
          playScanBeep();
          hint.className = "scanner-status success";
          hint.textContent = code;
          document.getElementById("serial").value = code;
          showManualEntry();
          setTimeout(() => closeScanner(), 600);
        }
      });

    }).catch(() => {
      hint.className = "scanner-status error";
      hint.textContent = "Camera access denied. Check permissions.";
    });

  } catch(e) {
    hint.className = "scanner-status error";
    hint.textContent = "Scanner unavailable. Use manual entry.";
  }
}

function closeScanner() {
  scannerActive = false;

  // Unlock orientation
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
  torchOn = false;
  document.getElementById("scannerOverlay").classList.remove("open");
}

function toggleTorch() {
  if (!activeStream) return;
  const track = activeStream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  if (!caps.torch) {
    showToast("Torch not available on this device", "warn");
    return;
  }
  torchOn = !torchOn;
  track.applyConstraints({ advanced: [{ torch: torchOn }] });
  document.getElementById("torchBtn").classList.toggle("on", torchOn);
}


// ============================
// PROFILE
// ============================
const PROFILE_KEY = "drivertrax_profile";

function getProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}"); } catch(e) { return {}; }
}

function saveProfile() {
  const name = sanitizeName(document.getElementById("profileName").value.trim());
  if (!name) { showToast("Please enter your name.", "error"); return; }
  const location = document.getElementById("profileLocation").value;
  const profile = { name, location };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  applyProfile();
  showToast("Profile saved", "success");
}

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
  if (locSelect && location) locSelect.value = location;
}

function getDriverFileName(base, ext) {
  const profile = getProfile();
  const name = profile.name ? "_" + profile.name.replace(/\s+/g,"_") : "";
  const date = new Date().toISOString().slice(0,10);
  return `${base}${name}_${date}.${ext}`;
}
const BACKUP_KEY = "drivertrax_backup";
const BACKUP_TIME_KEY = "drivertrax_backup_time";
const BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function runBackup(manual = false) {
  const records = getRecords();
  const backupData = { records, timestamp: Date.now(), version: 1 };
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backupData));
    localStorage.setItem(BACKUP_TIME_KEY, Date.now().toString());
    updateBackupStatus();
    if (manual) showToast("Backup saved", "success");
  } catch(e) {
    if (manual) showToast("Backup failed - storage may be full", "error");
  }
}

function updateBackupStatus() {
  const ts = localStorage.getItem(BACKUP_TIME_KEY);
  const backup = localStorage.getItem(BACKUP_KEY);
  const timeEl = document.getElementById("lastBackupTime");
  const countEl = document.getElementById("backupRecordCount");
  const menuStatus = document.getElementById("menuSyncStatus");

  if (!ts || !timeEl) return;

  const d = new Date(parseInt(ts));
  const timeStr = d.toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit", timeZone:"America/New_York"});
  const dateStr = d.toLocaleDateString("en-US", {month:"short", day:"numeric", timeZone:"America/New_York"});

  if (timeEl) timeEl.textContent = `${dateStr} at ${timeStr}`;

  if (backup && countEl) {
    try {
      const parsed = JSON.parse(backup);
      countEl.textContent = parsed.records ? parsed.records.length + " records" : "-";
    } catch(e) { countEl.textContent = "-"; }
  }

  if (menuStatus) menuStatus.textContent = `Backed up ${timeStr}`;
}

function restoreBackup() {
  const backup = localStorage.getItem(BACKUP_KEY);
  if (!backup) { showToast("No backup found", "error"); return; }
  if (!confirm("Restore from last backup? This will overwrite your current records.")) return;
  try {
    const parsed = JSON.parse(backup);
    if (!parsed.records) throw new Error("Invalid backup");
    setRecords(parsed.records);
    renderTodayEntries();
    updateBackupStatus();
    showToast(`Restored ${parsed.records.length} records`, "success");
  } catch(e) {
    showToast("Restore failed - backup may be corrupt", "error");
  }
}

function exportJSON() {
  const records = getRecords();
  if (records.length === 0) { showToast("No records to export", "error"); return; }
  const data = { records, profile: getProfile(), exportedAt: new Date().toISOString(), version: 1 };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = getDriverFileName("drivertrax_backup", "json");
  a.click();
  showToast(`Exported ${records.length} records`, "success");
}

function importJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("importStatus");
  statusEl.textContent = "Reading file...";

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed.records || !Array.isArray(parsed.records)) throw new Error("Invalid format");

      const existing = getRecords();
      // Merge - avoid duplicates by id
      const existingIds = new Set(existing.map(r => r.id));
      const newRecords = parsed.records.filter(r => !existingIds.has(r.id));
      const merged = [...existing, ...newRecords].sort((a,b) => b.timestamp - a.timestamp);

      if (!confirm(`Import ${newRecords.length} new records? (${parsed.records.length - newRecords.length} duplicates skipped)`)) {
        statusEl.textContent = "";
        event.target.value = "";
        return;
      }

      setRecords(merged);
      if (parsed.profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(parsed.profile));
      applyProfile();
      renderTodayEntries();
      runBackup();
      statusEl.textContent = `Imported ${newRecords.length} new records`;
      showToast(`Imported ${newRecords.length} records`, "success");
    } catch(err) {
      statusEl.textContent = "Invalid file - could not import";
      showToast("Import failed - invalid file", "error");
    }
    event.target.value = "";
  };
  reader.readAsText(file);
}

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
  document.getElementById("weatherAlert").style.display = "none";
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
    document.getElementById("weatherAlertMsg").textContent = "SDF WEATHER ALERT: " + unique.join(" - ");
    alertEl.style.display = "block";
  } else {
    alertEl.style.display = "none";
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
runBackup();
setInterval(runBackup, BACKUP_INTERVAL_MS);
updateBackupStatus();
applyProfile();
renderTodayEntries();
// ============================
// BLUETOOTH (HID) BARCODE SCANNER
// ============================
// Bluetooth scanners send a fast burst of keystrokes ending in Enter.
// We buffer keys arriving in quick succession and route the result into
// the active Serial field, bypassing the readonly attribute on the input.
(function () {
  const SCANNER_CHAR_GAP_MS = 50;   // max ms between chars to count as a scanner
  const SCANNER_MIN_LENGTH = 4;     // ignore stray Enter presses
  let buffer = "";
  let lastKeyTime = 0;

  function isEntryScreenActive() {
    // Only fire on New Entry tab or when the Edit overlay is open
    const entryPanel = document.getElementById("panel-entry");
    const editOverlay = document.getElementById("editOverlay");
    const editOpen = editOverlay && editOverlay.classList.contains("open");
    const entryVisible = entryPanel && entryPanel.classList.contains("active");
    return editOpen || entryVisible;
  }

  function targetInput() {
    const editOverlay = document.getElementById("editOverlay");
    if (editOverlay && editOverlay.classList.contains("open")) {
      return document.getElementById("editSerial");
    }
    return document.getElementById("serial");
  }

  function commitScan(code) {
    code = code.trim().toUpperCase();
    if (code.length < SCANNER_MIN_LENGTH) return;

    // If a 17-char VIN is embedded in a longer payload (e.g. URL), pull it out
    let value = code;
    if (!isValidVIN(code)) {
      const m = code.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m && isValidVIN(m[0])) value = m[0];
    }

    const input = targetInput();
    if (!input) return;

    input.value = value;

    // Trigger the same UI updates the camera scanner uses
    if (input.id === "serial") {
      showManualEntry();
      toggleClearBtn();
      updateVinCount();
    } else {
      toggleEditClearBtn();
      updateEditVinCount();
    }

    // Feedback: vibrate + beep (same as camera scan)
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    try { playScanBeep(); } catch (e) {}

    // Close the on-screen VIN keypad if it happens to be open
    const kp = document.getElementById("vinKeypadOverlay");
    if (kp && kp.classList.contains("open")) {
      kp.classList.remove("open");
    }
  }

  document.addEventListener("keydown", function (e) {
    // Only intercept on the New Entry tab or when the Edit overlay is open
    if (!isEntryScreenActive()) { buffer = ""; return; }

    // Don't interfere with editable text fields (Notes, etc.)
    const tag = (e.target && e.target.tagName) || "";
    const isTextarea = tag === "TEXTAREA";
    const isEditableText = tag === "INPUT" && !e.target.readOnly &&
      !["button", "checkbox", "radio", "submit"].includes(e.target.type);
    if (isTextarea || isEditableText) { buffer = ""; return; }

    const now = Date.now();
    const gap = now - lastKeyTime;
    lastKeyTime = now;

    if (e.key === "Enter") {
      if (buffer.length >= SCANNER_MIN_LENGTH) {
        e.preventDefault();
        commitScan(buffer);
      }
      buffer = "";
      return;
    }

    // Reset buffer if too much time passed (human typing, not a scanner)
    if (gap > SCANNER_CHAR_GAP_MS) buffer = "";

    // Only capture printable single characters
    if (e.key.length === 1) {
      buffer += e.key;
      e.preventDefault(); // keep keystrokes from leaking into the page
    }
  }, true); // capture phase, so we beat the readonly input
})();
