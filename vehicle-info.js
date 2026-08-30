// ============================================================
// DriverTrax Vehicle Info — plate, plate state, SIPP class code
//
// The three things about a car that NHTSA can't tell us. They live on
// `public.vehicles` (one row per VIN) rather than on `records`, because
// they describe the car, not the visit — see vehicle-plate-sipp-schema.sql.
//
// Mounts a read-only chip row into the VIN HISTORY header (app.js
// renderVinTimeline drops a #vinTlVehicleInfo div for it) and owns
// #vehicleInfoModal for editing. Any signed-in user can edit, matching the
// vehicles RLS policies.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb  = DT_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  // SIPP / ACRISS class codes. Backed by the sipp_codes table — managers add
  // / edit / delete them in Backlot (see sipp-codes-schema.sql,
  // backlot/sipp-codes.js). This list is only the fallback: used until the
  // live fetch below resolves, and kept as-is if the table doesn't exist yet
  // or the fetch fails, so a fresh install or an outage never blocks the
  // plate/class editor. Also mirrors the "Car SIPP Codes" table in the
  // Training panel (index.html) — keep the two in step. LCAR / LDAR ship as
  // one row there; a dropdown needs them apart.
  const FALLBACK_SIPP_CODES = [
    { code: "ECAR",  label: "Economy" },
    { code: "CCAR",  label: "Compact" },
    { code: "ICAR",  label: "Intermediate / Midsize" },
    { code: "SCAR",  label: "Standard" },
    { code: "FCAR",  label: "Full Size" },
    { code: "PCAR",  label: "Premium" },
    { code: "LCAR",  label: "Luxury", luxury: true },
    { code: "LDAR",  label: "Luxury (4-door)", luxury: true },
    { code: "STAR",  label: "Convertible" },
    { code: "IFAR",  label: "Midsize SUV" },
    { code: "SFAR",  label: "SUV" },
    { code: "XPAR",  label: "Sport Utility" },
    { code: "IJAR",  label: "Intermediate All-Terrain 2 Door" },
    { code: "FJAR",  label: "Full Size All-Terrain 4 Door" },
    { code: "MVAR",  label: "Minivan" },
    { code: "GCAR",  label: "Minivan (Grand Caravan)" },
    { code: "XVARP", label: "15 Person Van" }
  ];
  let SIPP_CODES = FALLBACK_SIPP_CODES;
  let SIPP_BY_CODE = new Map(SIPP_CODES.map(s => [s.code, s]));
  function sippLabel(code) {
    return SIPP_BY_CODE.get(String(code || "").toUpperCase())?.label || "";
  }
  // Luxury classes route to Premiere/Wall instead of the mileage-only
  // Executive/Emerald/Enterprise-Alamo tiers — see mileageRouteDestination
  // in app.js. Manager-set per code (sipp-codes-luxury-schema.sql), not
  // hardcoded, so the set can grow without a deploy.
  function isLuxury(code) {
    return !!SIPP_BY_CODE.get(String(code || "").toUpperCase())?.luxury;
  }

  // Kicked off once at load. fillSelects() below reads SIPP_CODES lazily (at
  // first editor open) so it usually already sees the live list; if the
  // editor was opened before this resolved, the success handler refreshes
  // the already-filled <select> in place.
  (async function loadSippCodes() {
    try {
      const { data, error } = await sb.from("sipp_codes").select("code,label,is_luxury").order("code");
      if (error || !data || !data.length) return; // keep the fallback
      SIPP_CODES = data.map(s => ({ code: s.code, label: s.label, luxury: !!s.is_luxury }));
      SIPP_BY_CODE = new Map(SIPP_CODES.map(s => [s.code, s]));
      const form = $("vehicleInfoForm");
      if (form && form.dataset.filled) {
        const current = form.elements.sipp.value;
        form.elements.sipp.innerHTML = sippOptionsHtml();
        form.elements.sipp.value = current;
      }
    } catch (e) {
      console.warn("[vehicle-info] sipp_codes load failed, using built-in list", e);
    }
  })();

  // Issuing jurisdictions: 50 states + DC + PR. Stored as the two-letter code.
  const US_STATES = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
    "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
    "NJ","NM","NY","NC","ND","OH","OK","OR","PA","PR","RI","SC","SD","TN","TX",
    "UT","VT","VA","WA","WV","WI","WY"
  ];

  // Plates are alphanumeric with the occasional hyphen. sanitizeSerial (app.js)
  // already enforces exactly that character set — uppercase first so lowercase
  // typing isn't stripped, then cap at plate length rather than VIN length.
  function normalizePlate(str) {
    return sanitizeSerial(String(str || "").toUpperCase().replace(/\s+/g, "")).slice(0, 10);
  }

  // VIN -> { plate, plateState, sipp }. Populated by load(); dropped for one
  // VIN on save so the next render reads the new values.
  const _cache = new Map();
  // Flipped once if Postgres reports the columns aren't there (42703), i.e.
  // vehicle-plate-sipp-schema.sql hasn't been run on this project yet. Every
  // surface then renders nothing instead of erroring on each VIN opened.
  let _schemaMissing = false;

  const EMPTY = { plate: "", plateState: "", sipp: "" };
  const isEmpty = (info) => !info || (!info.plate && !info.plateState && !info.sipp);

  async function load(vin, opts) {
    const key = String(vin || "").toUpperCase();
    if (!key || _schemaMissing) return null;
    if (!opts?.force && _cache.has(key)) return _cache.get(key);
    const { data, error } = await sb
      .from("vehicles")
      .select("serial_id,plate,plate_state,sipp")
      .eq("serial_id", key)
      .maybeSingle();
    if (error) {
      // 42703 = undefined_column. Anything else is transient — don't cache it.
      if (error.code === "42703") {
        _schemaMissing = true;
        console.warn("[vehicle-info] vehicles.plate/plate_state/sipp missing — run vehicle-plate-sipp-schema.sql");
      } else {
        console.warn("[vehicle-info] load failed", error);
      }
      return null;
    }
    const info = data
      ? { plate: data.plate || "", plateState: data.plate_state || "", sipp: data.sipp || "" }
      : { ...EMPTY };
    _cache.set(key, info);
    return info;
  }

  function invalidate(vin) {
    if (vin) _cache.delete(String(vin).toUpperCase());
    else _cache.clear();
  }

  // One eyebrow (.field-label — the app's own label component) over one
  // badge, each a column in .vin-id-row. Plate folds its state into the same
  // badge as a colored "NY-" prefix rather than a second badge; SIPP folds
  // its expansion into the same badge as "ICAR — Intermediate / Midsize"
  // rather than trailing text, since a second free-floating span isn't a
  // component this app has anywhere else. Returns "" when there's nothing to
  // show, so the caller can omit an empty group entirely.
  function plateGroupHtml(info) {
    if (!info?.plate) return "";
    const statePrefix = info.plateState
      ? `<span class="vin-id-plate-state">${esc(info.plateState)}</span>-`
      : "";
    return `
      <div class="vin-id-group">
        <span class="field-label vin-id-eyebrow">Plate</span>
        <span class="vin-id-plate">${statePrefix}${esc(info.plate)}</span>
      </div>`;
  }
  function sippGroupHtml(info) {
    if (!info?.sipp) return "";
    const desc = sippLabel(info.sipp);
    const descHtml = desc ? ` <span class="vin-id-sipp-desc">— ${esc(desc)}</span>` : "";
    return `
      <div class="vin-id-group">
        <span class="field-label vin-id-eyebrow">SIPP Code</span>
        <span class="vin-id-sipp">${esc(info.sipp)}${descHtml}</span>
      </div>`;
  }

  // Render into a host element and wire its edit affordance. Re-entrant:
  // saving calls straight back into this with the same host.
  function render(host, vin, info) {
    if (isEmpty(info)) {
      host.innerHTML = `
        <button type="button" class="btn btn-secondary btn--sm btn--block btn--dashed vin-id-add">
          + Add plate &amp; class
        </button>`;
    } else {
      // Plate, SIPP and Edit are the row's three items, spaced evenly by
      // .vin-id-row (see app.css) — Edit sits at the badges' baseline rather
      // than up on an eyebrow line, since it isn't labeling a value.
      host.innerHTML = `
        <div class="vin-id-row">
          ${plateGroupHtml(info)}
          ${sippGroupHtml(info)}
          <button type="button" class="btn btn-secondary btn--sm vin-id-edit" aria-label="Edit plate and class">Edit</button>
        </div>`;
    }
    host.querySelector(".vin-id-add, .vin-id-edit")?.addEventListener("click", () => {
      openEditor(vin, () => mount(host, vin, { force: true }));
    });
  }

  async function mount(host, vin, opts) {
    if (!host || !vin) return;
    const info = await load(vin, opts);
    if (!info) { host.innerHTML = ""; return; }
    render(host, vin, info);
  }

  // ---------- editor modal ----------

  let _editVin = "";
  let _onSaved = null;

  function sippOptionsHtml() {
    return `<option value="">-- SIPP --</option>` +
      SIPP_CODES.map(s => `<option value="${s.code}">${esc(s.code)} — ${esc(s.label)}</option>`).join("");
  }

  function fillSelects() {
    const form = $("vehicleInfoForm");
    if (!form || form.dataset.filled) return;
    form.dataset.filled = "1";
    form.elements.plateState.innerHTML =
      `<option value="">--</option>` +
      US_STATES.map(s => `<option value="${s}">${s}</option>`).join("");
    form.elements.sipp.innerHTML = sippOptionsHtml();
  }

  function openEditor(vin, onSaved) {
    const modal = $("vehicleInfoModal");
    const form  = $("vehicleInfoForm");
    if (!modal || !form) return;
    _editVin = String(vin || "").toUpperCase();
    _onSaved = typeof onSaved === "function" ? onSaved : null;
    fillSelects();
    const info = _cache.get(_editVin) || EMPTY;
    form.elements.plate.value      = info.plate || "";
    form.elements.plateState.value = info.plateState || "";
    form.elements.sipp.value       = info.sipp || "";
    const vinEl = $("vehicleInfoVin");
    if (vinEl) vinEl.textContent = _editVin;
    DT_UI.setMessage($("vehicleInfoModalMsg"), "");
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => form.elements.plate.focus(), 50);
  }

  function closeEditor() {
    const modal = $("vehicleInfoModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    DT_UI.setMessage($("vehicleInfoModalMsg"), "");
    _editVin = "";
    _onSaved = null;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form   = $("vehicleInfoForm");
    const msg    = $("vehicleInfoModalMsg");
    const submit = $("vehicleInfoModalSubmit");
    if (!form || !_editVin) return;

    const plate      = normalizePlate(form.elements.plate.value);
    const plateState = (form.elements.plateState.value || "").toUpperCase();
    const sipp       = (form.elements.sipp.value || "").toUpperCase();

    if (plateState && !plate) {
      DT_UI.setMessage(msg, "Enter a plate, or clear the state.", "err");
      return;
    }
    if (sipp && !SIPP_BY_CODE.has(sipp)) {
      DT_UI.setMessage(msg, "Pick a SIPP code from the list.", "err");
      return;
    }

    submit.disabled = true;
    DT_UI.setMessage(msg, "Saving…", "ok");

    // Upsert, not update: a VIN can be looked up before the records trigger
    // has created its vehicles row (rare, but a plate typed off a car that
    // hasn't been scanned yet would otherwise silently no-op).
    const vin = _editVin;
    const { error } = await sb.from("vehicles").upsert({
      serial_id:   vin,
      plate:       plate || null,
      plate_state: plateState || null,
      sipp:        sipp || null,
      updated_at:  new Date().toISOString()
    }, { onConflict: "serial_id" });

    submit.disabled = false;
    if (error) {
      if (error.code === "42703") {
        _schemaMissing = true;
        DT_UI.setMessage(msg, "Plate fields aren't set up on this database yet.", "err");
        return;
      }
      DT_UI.setMessage(msg, error.message || "Save failed", "err");
      return;
    }

    _cache.set(vin, { plate, plateState, sipp });
    const saved = _onSaved;
    DT_TOAST.show(isEmpty({ plate, plateState, sipp }) ? "Plate & class cleared" : "Plate & class saved", "success");
    closeEditor();
    if (saved) saved();
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("vehicleInfoModalClose")?.addEventListener("click", closeEditor);
    $("vehicleInfoModalCancel")?.addEventListener("click", closeEditor);
    $("vehicleInfoModal")?.addEventListener("click", (e) => {
      if (e.target.id === "vehicleInfoModal") closeEditor();
    });
    $("vehicleInfoForm")?.addEventListener("submit", onSubmit);
    // Uppercase as they type — plates are stored and matched uppercase.
    $("vehicleInfoForm")?.elements?.plate?.addEventListener("input", (e) => {
      const pos = e.target.selectionStart;
      e.target.value = normalizePlate(e.target.value);
      try { e.target.setSelectionRange(pos, pos); } catch (_) {}
    });
  });

  window.DT_VEHICLE_INFO = {
    load, mount, invalidate, openEditor, closeEditor,
    plateGroupHtml, sippGroupHtml, sippLabel, isLuxury, normalizePlate,
    get SIPP_CODES() { return SIPP_CODES; },
    US_STATES
  };
})();
