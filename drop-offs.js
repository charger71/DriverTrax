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
  const esc = window.DT_ESC;

  // The modal is shared across concurrent drop-off inserts (rare, but
  // possible if the driver taps Save twice quickly). We queue rows and
  // show them one at a time.
  const pendingPrompts = [];
  let promptOpen = false;

  // Cache of parking_sections rows so we can map section_id → section_name
  // without a per-drop-off join. Refetched on first record() call and any
  // time the trigger returns an id we haven't seen (a section added since
  // this tab loaded).
  let sectionsById = null;
  let sectionsPromise = null;
  async function loadSections(force) {
    if (sectionsById && !force) return sectionsById;
    if (sectionsPromise) return sectionsPromise;
    sectionsPromise = (async () => {
      const { data, error } = await sb
        .from("parking_sections")
        .select("id,name");
      if (error) {
        console.warn("[DT_DROPOFFS] loadSections", error);
        return {};
      }
      const map = {};
      (data || []).forEach(s => { map[s.id] = s.name; });
      return map;
    })();
    sectionsById = await sectionsPromise;
    sectionsPromise = null;
    return sectionsById;
  }
  async function nameFor(sectionId) {
    if (!sectionId) return "";
    let map = await loadSections();
    if (!map[sectionId]) map = await loadSections(true);
    return map[sectionId] || "";
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

  // Public API. Fire-and-forget-ish: returns a promise that resolves once
  // the row is inserted (and the prompt is opened if section_id is null).
  // Callers shouldn't await the prompt itself — the driver could take a
  // while to type. Errors are logged and toasted; they never re-throw.
  async function record({ serial_id, lat, lng, record_id }) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    const user = DT_AUTH.getUser();
    const payload = {
      serial_id: serial_id || null,
      // PostGIS geography(Point, 4326) accepts WKT via ST_GeogFromText.
      // supabase-js sends this as a string; the PostGIS input parser
      // handles the coercion.
      location: `SRID=4326;POINT(${lng} ${lat})`,
      record_id: record_id || null,
      user_id: user?.id || null
    };
    const { data, error } = await sb
      .from("drop_offs")
      .insert(payload)
      .select("id, section_id, location_name")
      .single();
    if (error) {
      console.warn("[DT_DROPOFFS] insert", error);
      return null;
    }
    if (!data) return null;

    if (data.section_id) {
      const name = await nameFor(data.section_id);
      patchLocalRecord(record_id, {
        sectionId: data.section_id,
        sectionName: name
      });
    } else if (!data.location_name) {
      // Trigger couldn't match; ask the driver. record_id is what we look up
      // in getRecords when they submit — carry it through on the row.
      openPromptFor({ ...data, record_id });
    }
    return data;
  }

  window.DT_DROPOFFS = { record };
})();
