// ============================================================
// DriverTrax drop-off geotagging
//
// Companion to parking-sections-schema.sql. After the driver saves
// a lot drop-off (BACKLOT / QTA / GARAGE), we insert a `drop_offs`
// row with the GPS point. A PostGIS BEFORE INSERT trigger fills in
// `section_id` from the polygon it lands inside. If the trigger
// couldn't match (section_id null), we prompt the driver to name
// the spot and update the row's `location_name`.
//
// Exposed as window.DT_DROPOFFS.record({ serial_id, lat, lng, ... }).
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb  = DT_AUTH.client;
  const $   = (id) => document.getElementById(id);

  // The modal is shared across concurrent drop-off inserts (rare, but
  // possible if the driver taps Save twice quickly). We queue rows and
  // show them one at a time.
  const pendingPrompts = [];
  let promptOpen = false;

  // Cache of parking_sections rows keyed by id. Each entry is
  //   { id, name, status, rings: [[[lat,lng], ...], ...] }
  // rings are already normalized to [lat, lng] (Leaflet order), first ring
  // is the outer boundary, others are holes. `rings` is empty [] for
  // name-only rows (boundary is null in the DB) — those still show in the
  // driver's Location dropdown but never match the auto-tag / conflict
  // checks. Populated from the parking_sections_geo view. Refetched when
  // the trigger returns an id we haven't seen (a section added since this
  // tab loaded) or when a manager saves a new location.
  let sectionsById = null;
  let sectionsList = null;
  let sectionsPromise = null;
  async function loadSections(force) {
    if (sectionsById && !force) return sectionsById;
    if (sectionsPromise && !force) return sectionsPromise;
    sectionsPromise = (async () => {
      const { data, error } = await sb
        .from("parking_sections_geo")
        .select("id,name,status,geojson")
        .order("name", { ascending: true });
      if (error) {
        console.warn("[DT_DROPOFFS] loadSections", error);
        return {};
      }
      const map = {};
      const list = [];
      (data || []).forEach(s => {
        const rings = geoJsonToLatLngRings(s.geojson);
        const entry = { id: s.id, name: s.name, status: s.status, rings };
        map[s.id] = entry;
        list.push(entry);
      });
      sectionsById = map;
      sectionsList = list;
      return map;
    })();
    const map = await sectionsPromise;
    sectionsPromise = null;
    return map;
  }

  // Force-refresh the section cache and fire an event so any UI that
  // renders from the list (destination dropdowns, manager Locations
  // panel) can re-render without a page reload.
  async function refreshSections() {
    await loadSections(true);
    try { document.dispatchEvent(new CustomEvent("dt-sections-change")); }
    catch (_) {}
    return sectionsList || [];
  }
  async function nameFor(sectionId) {
    if (!sectionId) return "";
    let map = await loadSections();
    if (!map[sectionId]) map = await loadSections(true);
    return map[sectionId]?.name || "";
  }

  // GeoJSON Polygon -> array of Leaflet-order rings ([lat, lng]).
  // GeoJSON stores coordinates as [lng, lat]; Leaflet expects [lat, lng].
  function geoJsonToLatLngRings(geo) {
    if (!geo || geo.type !== "Polygon" || !Array.isArray(geo.coordinates)) return [];
    return geo.coordinates.map(ring =>
      ring.map(([lng, lat]) => [lat, lng])
    );
  }

  // Ray-casting point-in-polygon on the outer ring only. Sections don't
  // have holes in practice — a parking lot is a simple polygon — so
  // ignoring inner rings keeps this to ~10 lines and is fast enough.
  function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i];
      const [yj, xj] = ring[j];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  async function detectSection(lat, lng) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    await loadSections();
    for (const s of sectionsList || []) {
      if (s.rings.length && pointInRing(lat, lng, s.rings[0])) {
        return { id: s.id, name: s.name };
      }
    }
    return null;
  }

  async function getSections() {
    await loadSections();
    return sectionsList || [];
  }

  // True when saving a record with this destination should prompt the
  // driver to name the spot if GPS lands outside every polygon.
  //   - blank    → true (driver relies on GPS; a miss means "unknown spot")
  //   - OTHER    → false (driver already typed a freeform label)
  //   - a section that has a polygon → true (lot-facing drop-off)
  //   - a section with no polygon    → false (off-lot place, e.g. BRANCH)
  // Falls back to true if the cache hasn't populated yet — being chatty is
  // safer than silently swallowing a miss.
  function isLotDestination(name) {
    if (!name) return true;
    if (name === "OTHER") return false;
    if (!sectionsList) return true;
    const norm = normalizeName(name);
    return sectionsList.some(s =>
      s.rings.length > 0 && normalizeName(s.name) === norm
    );
  }

  // Normalize a display name / dropdown code for comparison.
  // "Back Lot" and "BACKLOT" both collapse to "BACKLOT".
  function normalizeName(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // Opens the conflict modal and returns Promise<boolean>:
  //   true  = driver clicked "Save anyway"
  //   false = driver clicked "Fix destination" or dismissed
  function showConflictModal(pickedLabel, detectedLabel) {
    return new Promise(resolve => {
      const modal    = $("dropOffConflictModal");
      const pickedEl = $("dropOffConflictPicked");
      const detEl    = $("dropOffConflictDetected");
      const yesBtn   = $("dropOffConflictSave");
      const noBtn    = $("dropOffConflictCancel");
      const closeBt  = $("dropOffConflictClose");
      if (!modal || !yesBtn || !noBtn) { resolve(true); return; }

      pickedEl.textContent = pickedLabel;
      detEl.textContent = detectedLabel;
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");

      function cleanup(result) {
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
        yesBtn.removeEventListener("click", onYes);
        noBtn.removeEventListener("click", onNo);
        closeBt?.removeEventListener("click", onNo);
        modal.removeEventListener("click", onBackdrop);
        resolve(result);
      }
      function onYes() { cleanup(true); }
      function onNo()  { cleanup(false); }
      function onBackdrop(e) { if (e.target === modal) cleanup(false); }

      yesBtn.addEventListener("click", onYes);
      noBtn.addEventListener("click", onNo);
      closeBt?.addEventListener("click", onNo);
      modal.addEventListener("click", onBackdrop);
    });
  }

  // Called by saveRecord after GPS resolves and before doSave. Resolves to
  // true when it's safe to proceed. If GPS lands the driver inside a
  // polygon whose name doesn't collapse to the picked destination code,
  // shows the confirm modal.
  //
  // Explicitly returns true (proceed) when:
  //   - destination is empty or "OTHER"        (no expected section)
  //   - no polygon matches the GPS point       (nothing to disagree with)
  //   - names normalize to the same string     ("Back Lot" == "BACKLOT")
  async function checkConflictAndConfirm(destination, lat, lng) {
    if (!destination || destination === "OTHER") return true;
    const detected = await detectSection(lat, lng);
    if (!detected) return true;
    if (normalizeName(detected.name) === normalizeName(destination)) return true;
    return await showConflictModal(destination, detected.name);
  }

  // Patch the local record so existing screens (fleet, VIN detail, today
  // feed, detail overlay) show the geotagged section immediately. sync.js
  // diffs setRecords() and queues the update for the cloud.
  function patchLocalRecord(recordId, patch) {
    if (!recordId || typeof getRecords !== "function") return;
    const records = getRecords();
    const idx = records.findIndex(r => r.id === recordId);
    if (idx === -1) return;
    Object.assign(records[idx], patch);
    setRecords(records);
    if (typeof renderTodayEntries === "function") {
      try { renderTodayEntries(); } catch (_) {}
    }
  }

  function openPromptFor(row) {
    pendingPrompts.push(row);
    if (!promptOpen) showNext();
  }

  function showNext() {
    const row = pendingPrompts.shift();
    if (!row) { promptOpen = false; return; }
    promptOpen = true;
    const modal  = $("dropOffLocationModal");
    const input  = $("dropOffLocationInput");
    const msgEl  = $("dropOffLocationMsg");
    if (!modal || !input) { promptOpen = false; return; }
    input.value = "";
    DT_UI.setMessage(msgEl, "");
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => input.focus(), 50);

    modal.dataset.dropOffId = row.id;
    modal.dataset.dropOffRecordId = row.record_id || "";
  }

  function closeModal() {
    const modal = $("dropOffLocationModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    delete modal.dataset.dropOffId;
    delete modal.dataset.dropOffRecordId;
    promptOpen = false;
    // Give the fade a moment so the next prompt doesn't stack visibly.
    setTimeout(showNext, 60);
  }

  async function saveLocationName(dropOff, name) {
    const clean = String(name || "").trim().slice(0, 60);
    if (!clean) return { ok: false, reason: "empty" };
    const { error } = await sb
      .from("drop_offs")
      .update({ location_name: clean })
      .eq("id", dropOff.id);
    if (error) {
      if (DT_ERR.isMissing(error)) {
        DT_TOAST.missing("drop-off");
        return { ok: false, reason: "missing" };
      }
      console.warn("[DT_DROPOFFS] update location_name", error);
      return { ok: false, reason: error.message || "error" };
    }
    patchLocalRecord(dropOff.record_id, {
      sectionId: null,
      sectionName: clean
    });
    return { ok: true };
  }

  function wireModal() {
    const modal   = $("dropOffLocationModal");
    const form    = $("dropOffLocationForm");
    const closeBt = $("dropOffLocationClose");
    const skipBt  = $("dropOffLocationSkip");
    if (!modal || !form) return;

    closeBt?.addEventListener("click", closeModal);
    skipBt?.addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = modal.dataset.dropOffId;
      const recordId = modal.dataset.dropOffRecordId;
      if (!id) { closeModal(); return; }
      const input = $("dropOffLocationInput");
      const msgEl = $("dropOffLocationMsg");
      const submit = $("dropOffLocationSubmit");
      const val = input.value.trim();
      if (!val) {
        DT_UI.setMessage(msgEl, "Enter a short location name.", "err");
        return;
      }
      submit.disabled = true;
      DT_UI.setMessage(msgEl, "Saving…", "ok");
      const res = await saveLocationName({ id, record_id: recordId }, val);
      submit.disabled = false;
      if (res.ok) {
        DT_TOAST.show("Drop-off location saved", "success");
        closeModal();
      } else if (res.reason === "empty") {
        DT_UI.setMessage(msgEl, "Enter a short location name.", "err");
      } else if (res.reason !== "missing") {
        DT_UI.setMessage(msgEl, "Couldn't save — try again.", "err");
      } else {
        closeModal();
      }
    });
  }
  document.addEventListener("DOMContentLoaded", wireModal);

  // ----- IDB-backed offline queue ---------------------------------------
  // If the Supabase insert fails (offline, transient 5xx, etc.), we stash
  // the payload in IDB and retry on `online`, on the next record() call,
  // and on next page load. Sync.js has a similar shape for records.
  const QUEUE_STORE = "kv";
  const QUEUE_KEY = "dropoff_queue";
  let queueMemory = null;   // in-memory mirror; null until first load
  let flushing = false;

  async function readQueue() {
    if (queueMemory) return queueMemory;
    const raw = (window.DT_IDB && await DT_IDB.get(QUEUE_STORE, QUEUE_KEY)) || {};
    queueMemory = raw;
    return queueMemory;
  }
  async function writeQueue() {
    if (!window.DT_IDB) return;
    await DT_IDB.set(QUEUE_STORE, QUEUE_KEY, queueMemory || {});
  }
  async function enqueue(payload) {
    const q = await readQueue();
    // Reuse the payload's local_id as the queue key so double-enqueue after
    // an already-pending payload doesn't create dupes on retry.
    q[payload.local_id] = payload;
    await writeQueue();
  }
  async function dequeue(localId) {
    const q = await readQueue();
    delete q[localId];
    await writeQueue();
  }

  async function tryInsert(payload) {
    const { data, error } = await sb
      .from("drop_offs")
      .insert({
        serial_id: payload.serial_id,
        location:  payload.location,
        record_id: payload.record_id,
        user_id:   payload.user_id
      })
      .select("id, section_id, location_name")
      .single();
    return { data, error };
  }

  // On success, do the same write-back / prompt open we'd do inline.
  // `payload.prompt_if_untagged` controls whether an unmatched insert
  // opens the "Where is this?" modal (true = drop-off context, false =
  // silent — e.g. a CHECK_OUT at an off-lot rental spot).
  async function handleInsertResult(payload, data) {
    if (!data) return;
    if (data.section_id) {
      const name = await nameFor(data.section_id);
      patchLocalRecord(payload.record_id, {
        sectionId: data.section_id,
        sectionName: name
      });
    } else if (!data.location_name && payload.prompt_if_untagged !== false) {
      openPromptFor({ ...data, record_id: payload.record_id });
    }
  }

  async function flushQueue() {
    if (flushing) return;
    if (!navigator.onLine) return;
    flushing = true;
    try {
      const q = await readQueue();
      const ids = Object.keys(q);
      for (const id of ids) {
        const payload = q[id];
        const { data, error } = await tryInsert(payload);
        if (error) {
          // Give up until the next flush trigger. Console log so a stuck
          // payload is visible.
          console.warn("[DT_DROPOFFS] queued insert failed", error);
          break;
        }
        await dequeue(id);
        await handleInsertResult(payload, data);
      }
    } finally {
      flushing = false;
    }
  }
  window.addEventListener("online", flushQueue);
  document.addEventListener("DOMContentLoaded", () => { readQueue().then(flushQueue); });

  // Public API. Fire-and-forget-ish: returns a promise that resolves once
  // the row is inserted (queued if offline) and the prompt is opened if
  // section_id is null and promptIfUntagged is true. Never throws.
  async function record({ serial_id, lat, lng, record_id, promptIfUntagged = true }) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    const user = DT_AUTH.getUser();
    const payload = {
      local_id: (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
      serial_id: serial_id || null,
      // PostGIS geography(Point, 4326) accepts WKT via ST_GeogFromText.
      // supabase-js sends this as a string; the PostGIS input parser
      // handles the coercion.
      location: `SRID=4326;POINT(${lng} ${lat})`,
      record_id: record_id || null,
      user_id: user?.id || null,
      prompt_if_untagged: promptIfUntagged
    };

    // Opportunistic: whenever a new drop-off comes in, try to drain any
    // queued ones first so they land in order.
    flushQueue();

    if (!navigator.onLine) {
      await enqueue(payload);
      return null;
    }

    const { data, error } = await tryInsert(payload);
    if (error) {
      console.warn("[DT_DROPOFFS] insert (queued for retry)", error);
      await enqueue(payload);
      return null;
    }
    await handleInsertResult(payload, data);
    return data;
  }

  window.DT_DROPOFFS = { record, getSections, refreshSections, detectSection, checkConflictAndConfirm, isLotDestination, normalizeName };
})();
