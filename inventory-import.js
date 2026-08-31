// ============================================================
// DriverTrax Inventory Import (manager-only)
//   Bulk-loads fleet data pasted from Google Sheets (Available /
//   Rented / In-Maintenance) into `vehicles` and, for the
//   maintenance sheet, `service_jobs` + `service_vendors`.
//
//   Re-runnable: matches existing rows by serial_id (the sheet's
//   VIN column) and only ever overwrites the columns this tool
//   owns — real driver-scan fields (last_seen_at, section_id, ...)
//   and job lifecycle fields (opened_at, returned_at, ...) are
//   always echoed back unchanged, never omitted-and-hoped-for,
//   since bulk .upsert() column-omission semantics aren't
//   something to depend on for data integrity.
//
//   Mounts into #panel-inventory-import; wired from the Import
//   Inventory menu item.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb  = DT_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  const BATCH_SIZE = 500;
  const STATUS_CODE_ALIASES = { BD: "BODY", WI: "WI/DELETE" };
  const SHEET_LABELS = { available: "Available", rented: "Rented", maintenance: "In Maintenance" };
  const HEADER_KEY_MAP = {
    vin: "vin", sippcode: "sipp", make: "make", model: "model", unit: "unit",
    odometer: "odometer", state: "state", lp: "lp",
    lastlocationnote: "lastLocationNote", description: "description",
    holdcodes: "holdCodes", expectedreturn: "expectedReturn",
    reason: "reason", vendor: "vendor", offlot: "offLot", ecd: "ecd"
  };

  let currentPlan = null;

  // -------- parsing --------

  function normalizeHeader(h) {
    return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function detectDelimiter(headerLine) {
    const tabs = (headerLine.match(/\t/g) || []).length;
    const commas = (headerLine.match(/,/g) || []).length;
    return tabs >= commas ? "\t" : ",";
  }

  // Quote-aware state machine, not a line-split — pasted cells can contain
  // literal newlines inside quotes (e.g. a multi-code Hold Codes cell).
  function parseDelimited(text, delimiter) {
    const rows = []; let row = [], field = "", inQuotes = false, i = 0;
    while (i < text.length) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === "") { inQuotes = true; i++; continue; }
      if (c === delimiter) { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function mapHeaders(headerRow) {
    const map = {};
    headerRow.forEach((h, i) => {
      const key = HEADER_KEY_MAP[normalizeHeader(h)];
      if (key) map[key] = i;
    });
    return map;
  }

  function detectSheetType(fieldMap) {
    if ("expectedReturn" in fieldMap) return "rented";
    if ("reason" in fieldMap || "offLot" in fieldMap || "ecd" in fieldMap) return "maintenance";
    if ("holdCodes" in fieldMap) return "available";
    return null;
  }

  // -------- field parsing --------

  function parseOdometer(raw) {
    const s = String(raw || "").trim();
    if (!s) return { value: null, warn: false };
    const n = parseInt(s.replace(/[,\s]/g, ""), 10);
    if (!Number.isFinite(n) || n < 0) return { value: null, warn: true };
    return { value: n, warn: false };
  }

  // Sheets renders dates M/D/YYYY. Calendar-validated so e.g. 2/30 doesn't
  // silently roll over to March 2 (Date's own normalization would allow it).
  function parseDateMDY(raw) {
    const s = String(raw || "").trim();
    if (!s) return { value: null, warn: false };
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return { value: null, warn: true };
    const month = parseInt(m[1], 10), day = parseInt(m[2], 10), year = parseInt(m[3], 10);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
      return { value: null, warn: true };
    }
    return { value: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, warn: false };
  }

  function mapStatusCode(raw) {
    const code = String(raw || "").trim().toUpperCase();
    return STATUS_CODE_ALIASES[code] || code;
  }

  function parseHoldCodes(raw) {
    if (!raw) return [];
    return String(raw).split(/\r\n|\r|\n|,/).map(s => s.trim().toUpperCase()).filter(Boolean).map(mapStatusCode);
  }

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // A row's DB identity: the sheet's short VIN, unless it resolved (exact or
  // suffix match, see buildPlan) to an existing row with a different real id.
  function resolveSerialId(r, plan) {
    const existing = plan.existingVehicles.get(r.vin);
    return existing ? existing.serial_id : r.vin;
  }

  // -------- row validation --------

  function buildRow(sheetType, fieldMap, rawRow, lineNo) {
    const get = (key) => (fieldMap[key] != null ? String(rawRow[fieldMap[key]] || "").trim() : "");
    const errors = [], warnings = [];

    const vin = sanitizeSerial(get("vin").toUpperCase());
    if (!vin) errors.push(`Row ${lineNo}: missing/invalid VIN`);

    const odo = parseOdometer(get("odometer"));
    if (odo.warn) warnings.push(`Row ${lineNo}: unreadable odometer "${get("odometer")}"`);

    const holdCodes = parseHoldCodes(get("holdCodes"));

    let currentStatus = "", expectedReturn = null, reason = "", vendor = "", offLot = false, ecd = null;

    if (sheetType === "available") {
      currentStatus = holdCodes.length ? holdCodes[0] : "CLEAN";
    } else if (sheetType === "rented") {
      currentStatus = "CHECK_OUT";
      const er = parseDateMDY(get("expectedReturn"));
      if (er.warn) warnings.push(`Row ${lineNo}: unreadable expected return date "${get("expectedReturn")}"`);
      expectedReturn = er.value;
    } else if (sheetType === "maintenance") {
      reason = get("reason").toUpperCase();
      if (!reason) errors.push(`Row ${lineNo}: missing Reason code`);
      currentStatus = mapStatusCode(reason);
      vendor = get("vendor").slice(0, 60);
      offLot = /^y/i.test(get("offLot"));
      const ecdParsed = parseDateMDY(get("ecd"));
      if (ecdParsed.warn) warnings.push(`Row ${lineNo}: unreadable ECD "${get("ecd")}"`);
      ecd = ecdParsed.value;
    }

    return {
      lineNo, vin,
      // plate/sipp normalization matches vehicle-info.js's normalizePlate()
      // exactly, so a value written by import and one typed into that
      // editor look identical (same charset, same case, same length cap).
      sipp: get("sipp").slice(0, 20).toUpperCase() || null,
      unitNumber: get("unit").slice(0, 20) || null,
      make: get("make").slice(0, 40),
      model: get("model").slice(0, 40),
      odometer: odo.value,
      plate: sanitizeSerial(get("lp").toUpperCase().replace(/\s+/g, "")).slice(0, 10) || null,
      plateState: get("state").slice(0, 2).toUpperCase() || null,
      holdCodes,
      description: sanitizeNotes(get("description")) || null,
      lastLocationNote: sanitizeNotes(get("lastLocationNote")) || null,
      expectedReturn, currentStatus, reason, vendor, offLot, ecd,
      errors, warnings
    };
  }

  function validateAndBuildRows(dataRows, sheetType, fieldMap) {
    const built = [];
    dataRows.forEach((rawRow, idx) => {
      if (rawRow.every(c => !String(c || "").trim())) return; // blank paste line, not worth reporting
      built.push(buildRow(sheetType, fieldMap, rawRow, idx + 2)); // +2: header is row 1
    });

    const lastIndexByVin = new Map();
    built.forEach((row, i) => { if (row.vin) lastIndexByVin.set(row.vin, i); });

    const good = [], errors = [], warnings = [];
    built.forEach((row, i) => {
      if (row.vin && lastIndexByVin.get(row.vin) !== i) {
        errors.push(`Row ${row.lineNo}: duplicate VIN ${row.vin}, later row in this paste wins`);
        return;
      }
      if (row.errors.length) { errors.push(...row.errors); return; }
      warnings.push(...row.warnings);
      good.push(row);
    });
    return { good, errors, warnings };
  }

  // -------- preview (read-only) --------

  async function buildPlan(good, sheetType) {
    const vins = good.map(r => r.vin);
    const existingVehicles = new Map();
    for (const chunk of chunkArray(vins, BATCH_SIZE)) {
      const { data, error } = await sb.from("vehicles").select("*").in("serial_id", chunk);
      if (error) throw new Error("Vehicle lookup failed: " + error.message);
      (data || []).forEach(v => existingVehicles.set(v.serial_id, v));
    }

    // A sheet's short VIN (the real VIN's last 8 characters — position 10
    // model year + 11 plant + 12-17 serial) may already be a full 17-char
    // row from a real driver scan that happened before this car ever showed
    // up on an Enterprise sheet. Match onto that real row (keyed by the
    // short code here, same as an exact match) rather than creating a
    // second, disconnected placeholder — the reverse direction (placeholder
    // first, real scan later) is handled server-side in
    // fn_records_sync_vehicle(), see vehicle-vin-suffix-reconcile-schema.sql.
    // Only applies when no exact 8-char row already exists; a placeholder
    // that's already coexisting with a real row is a pre-existing duplicate
    // this pass doesn't try to auto-heal.
    const unmatched = vins.filter(v => !existingVehicles.has(v));
    for (const chunk of chunkArray(unmatched, 50)) {
      if (!chunk.length) continue;
      const orClause = chunk.map(v => `serial_id.like.%${v}`).join(",");
      const { data, error } = await sb.from("vehicles").select("*").or(orClause);
      if (error) throw new Error("Vehicle suffix lookup failed: " + error.message);
      (data || []).forEach(v => {
        if (v.serial_id.length !== 17) return;
        const suffix = v.serial_id.slice(-8);
        if (chunk.includes(suffix)) existingVehicles.set(suffix, v);
      });
    }

    const vendorMap = new Map();
    const newVendorNames = [];
    const existingJobs = new Map();
    if (sheetType === "maintenance") {
      const { data: allVendors, error: vErr } = await sb.from("service_vendors").select("id,name");
      if (vErr) throw new Error("Vendor lookup failed: " + vErr.message);
      (allVendors || []).forEach(v => vendorMap.set(v.name.trim().toLowerCase(), v.id));
      const seen = new Set();
      good.forEach(r => {
        if (!r.vendor) return;
        const key = r.vendor.toLowerCase();
        if (!vendorMap.has(key) && !seen.has(key)) { seen.add(key); newVendorNames.push(r.vendor); }
      });

      // Job lookups use the resolved real serial_id too, so a car already
      // carrying a full-VIN identity gets matched on that VIN, not the
      // sheet's short code (jobs live on whichever id vehicles ended up
      // keyed by for this car).
      const jobVins = [...new Set(vins.map(v => (existingVehicles.get(v) || { serial_id: v }).serial_id))];
      for (const chunk of chunkArray(jobVins, BATCH_SIZE)) {
        const { data, error } = await sb.from("service_jobs").select("*").in("serial_id", chunk).neq("state", "CLOSED");
        if (error) throw new Error("Service job lookup failed: " + error.message);
        (data || []).forEach(j => existingJobs.set(j.serial_id + "|" + j.job_type, j));
      }
    }

    const newVehicles = good.filter(r => !existingVehicles.has(r.vin));
    const updatedVehicles = good.filter(r => existingVehicles.has(r.vin));
    const jobKey = r => resolveSerialId(r, { existingVehicles }) + "|" + r.currentStatus;
    const newJobs = sheetType === "maintenance" ? good.filter(r => !existingJobs.has(jobKey(r))) : [];
    const updatedJobs = sheetType === "maintenance" ? good.filter(r => existingJobs.has(jobKey(r))) : [];

    // Flag codes absent from DriverTrax's own status vocabulary — not codes
    // that merely lack a friendly STATUS_LABELS entry (e.g. CLEAN has none
    // and reads fine as-is; that's not the same thing as a novel import code).
    const knownStatusCodes = new Set([
      ...(DT_OPTIONS.STATUS_BASE || []), ...(DT_OPTIONS.STATUS_PRIVILEGED || []), ...(DT_OPTIONS.STATUS_DERIVED || [])
    ]);
    const unrecognizedCodes = [...new Set(good.map(r => r.currentStatus).filter(Boolean))]
      .filter(code => !knownStatusCodes.has(code));

    return { sheetType, good, existingVehicles, vendorMap, newVendorNames, existingJobs, newVehicles, updatedVehicles, newJobs, updatedJobs, unrecognizedCodes };
  }

  // -------- commit (writes) --------

  function buildVinData(existingVinData, make, model) {
    if (existingVinData && Object.keys(existingVinData).length && existingVinData._source !== "import") {
      return existingVinData; // real NHTSA decode or legacy data — never overwrite
    }
    return { ...(existingVinData || {}), make, model, _source: "import" };
  }

  function buildVehicleInsertPayload(r, plan, userId, now) {
    return {
      serial_id: r.vin,
      current_status: r.currentStatus,
      current_destination: (plan.sheetType === "maintenance" && r.offLot) ? "VENDOR: " + r.vendor : null,
      // plate / plate_state / sipp are vehicle-info.js's columns (see
      // vehicle-plate-sipp-schema.sql) — reused rather than duplicated.
      plate: r.plate, plate_state: r.plateState, sipp: r.sipp,
      unit_number: r.unitNumber, mileage: r.odometer,
      hold_codes: r.holdCodes.length ? r.holdCodes : null,
      description: r.description, last_location_note: r.lastLocationNote,
      expected_return: r.expectedReturn,
      vin_data: buildVinData(null, r.make, r.model),
      imported_at: now, imported_by: userId,
      entered_inventory_at: now, entered_by: userId,
      updated_at: now
    };
  }

  // Every protected (real-scan-only / first-entry-only) column is explicitly
  // echoed back from the pre-fetched existing row, never omitted — see the
  // module header comment for why omission isn't trusted here.
  function buildVehicleUpdatePayload(r, plan, userId, now) {
    const existing = plan.existingVehicles.get(r.vin);
    return {
      serial_id: existing.serial_id,
      current_status: r.currentStatus,
      current_status_other: existing.current_status_other,
      current_destination: (plan.sheetType === "maintenance" && r.offLot) ? "VENDOR: " + r.vendor : existing.current_destination,
      current_destination_other: existing.current_destination_other,
      current_conditions: existing.current_conditions,
      // Fill-if-blank, not always-overwrite: unlike current_status (which the
      // sheet genuinely owns), plate/state/SIPP are static facts a human may
      // have already corrected via vehicle-info.js's own editor — a stale
      // sheet re-import shouldn't clobber a manual fix.
      plate: existing.plate || r.plate,
      plate_state: existing.plate_state || r.plateState,
      sipp: existing.sipp || r.sipp,
      unit_number: r.unitNumber, mileage: r.odometer,
      hold_codes: r.holdCodes.length ? r.holdCodes : null,
      description: r.description, last_location_note: r.lastLocationNote,
      expected_return: r.expectedReturn,
      vin_data: buildVinData(existing.vin_data, r.make, r.model),
      needs_new_tag: existing.needs_new_tag,
      last_lat: existing.last_lat, last_lng: existing.last_lng,
      last_seen_at: existing.last_seen_at, last_user_id: existing.last_user_id, last_record_id: existing.last_record_id,
      section_id: existing.section_id, section_name: existing.section_name,
      entered_inventory_at: existing.entered_inventory_at, entered_by: existing.entered_by,
      imported_at: now, imported_by: userId,
      updated_at: now
    };
  }

  function buildJobInsertPayload(r, plan, userId, now) {
    return {
      serial_id: resolveSerialId(r, plan), job_type: r.currentStatus,
      performed_by: r.offLot ? "vendor" : "in_house",
      vendor_id: r.vendor ? (plan.vendorMap.get(r.vendor.toLowerCase()) || null) : null,
      state: r.offLot ? "SENT_OUT" : "OPEN",
      mileage: r.odometer, ecd: r.ecd,
      notes: sanitizeNotes("Imported from Maintenance sheet." + (r.lastLocationNote ? " " + r.lastLocationNote : "")),
      opened_by: userId, opened_at: now, sent_out_at: r.offLot ? now : null
    };
  }

  // Plain single-row UPDATE — unlike the vehicles bulk upsert above, a
  // partial payload here has simple, well-defined PostgREST semantics (only
  // the given columns are set), so omitting opened_by/opened_at/returned_*/
  // close_* is safe and doesn't need the echo-back treatment.
  function buildJobUpdatePayload(r, plan, now) {
    const existing = plan.existingJobs.get(resolveSerialId(r, plan) + "|" + r.currentStatus);
    const payload = {
      mileage: r.odometer,
      vendor_id: r.vendor ? (plan.vendorMap.get(r.vendor.toLowerCase()) || existing.vendor_id) : existing.vendor_id,
      ecd: r.ecd,
      notes: sanitizeNotes("Imported from Maintenance sheet." + (r.lastLocationNote ? " " + r.lastLocationNote : "")),
      updated_at: now
    };
    if (existing.state === "OPEN" && r.offLot) { payload.state = "SENT_OUT"; payload.sent_out_at = now; }
    return payload;
  }

  async function commitPlan(plan) {
    const userId = DT_AUTH.getUser()?.id || null;
    const now = new Date().toISOString();

    if (plan.newVendorNames.length) {
      const { data, error } = await sb.from("service_vendors")
        .insert(plan.newVendorNames.map(name => ({ name, vendor_type: "other", active: true })))
        .select("id,name");
      if (error) throw new Error("Creating vendors failed: " + error.message);
      (data || []).forEach(v => plan.vendorMap.set(v.name.trim().toLowerCase(), v.id));
    }

    for (const chunk of chunkArray(plan.newVehicles, BATCH_SIZE)) {
      const { error } = await sb.from("vehicles").insert(chunk.map(r => buildVehicleInsertPayload(r, plan, userId, now)));
      if (error) throw new Error("Inserting vehicles failed: " + error.message);
    }
    for (const chunk of chunkArray(plan.updatedVehicles, BATCH_SIZE)) {
      const { error } = await sb.from("vehicles")
        .upsert(chunk.map(r => buildVehicleUpdatePayload(r, plan, userId, now)), { onConflict: "serial_id" });
      if (error) throw new Error("Updating vehicles failed: " + error.message);
    }

    if (plan.newJobs.length) {
      const { error } = await sb.from("service_jobs").insert(plan.newJobs.map(r => buildJobInsertPayload(r, plan, userId, now)));
      if (error) throw new Error("Creating service jobs failed: " + error.message);
    }
    for (const r of plan.updatedJobs) {
      const existing = plan.existingJobs.get(resolveSerialId(r, plan) + "|" + r.currentStatus);
      const { error } = await sb.from("service_jobs").update(buildJobUpdatePayload(r, plan, now)).eq("id", existing.id);
      if (error) throw new Error("Updating service job failed: " + error.message);
    }
  }

  // -------- UI --------

  function setMsg(text, kind) {
    const el = $("importMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "import-msg" + (kind ? " " + kind : "");
  }

  function renderSummary(plan) {
    const el = $("importSummary");
    if (!el) return;
    if (!plan) { el.innerHTML = ""; el.classList.add("u-hidden"); return; }
    el.classList.remove("u-hidden");

    const rows = [];
    rows.push(`<div class="import-summary-row"><strong>${plan.good.length}</strong> row${plan.good.length === 1 ? "" : "s"} ready — sheet: ${esc(SHEET_LABELS[plan.sheetType] || plan.sheetType)}</div>`);
    if (plan.good.length) {
      rows.push(`<div class="import-summary-row">${plan.newVehicles.length} new vehicle${plan.newVehicles.length === 1 ? "" : "s"}, ${plan.updatedVehicles.length} updated</div>`);
      if (plan.sheetType === "maintenance") {
        rows.push(`<div class="import-summary-row">${plan.newJobs.length} new service job${plan.newJobs.length === 1 ? "" : "s"}, ${plan.updatedJobs.length} updated</div>`);
        if (plan.newVendorNames.length) {
          rows.push(`<div class="import-summary-row">New vendors to create: ${plan.newVendorNames.map(esc).join(", ")}</div>`);
        }
      }
    }
    if (plan.unrecognizedCodes.length) {
      rows.push(`<div class="import-summary-row import-summary-warn">Unlabeled status codes import as-is — add labels in STATUS_LABELS (app.js) when ready: ${plan.unrecognizedCodes.map(esc).join(", ")}</div>`);
    }
    if (plan.warnings.length) {
      rows.push(`<div class="import-summary-row import-summary-warn">${plan.warnings.length} warning${plan.warnings.length === 1 ? "" : "s"}<ul>${plan.warnings.slice(0, 20).map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>`);
    }
    if (plan.errors.length) {
      rows.push(`<div class="import-summary-row import-summary-err">${plan.errors.length} row${plan.errors.length === 1 ? "" : "s"} skipped<ul>${plan.errors.slice(0, 20).map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>`);
    }
    el.innerHTML = rows.join("");
  }

  async function onPreview() {
    const btn = $("importPreviewBtn");
    let text = ($("importPasteArea")?.value || "").trim();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM if pasted from a file export
    currentPlan = null;
    $("importCommitBtn").disabled = true;
    renderSummary(null);
    if (!text) { setMsg("Paste some rows first.", "err"); return; }

    btn.disabled = true; setMsg("Parsing…", "");
    try {
      const headerLine = text.split(/\r\n|\r|\n/, 1)[0] || "";
      const rows = parseDelimited(text, detectDelimiter(headerLine));
      if (!rows.length) { setMsg("Couldn't find any rows.", "err"); return; }

      const [headerRow, ...dataRows] = rows;
      const fieldMap = mapHeaders(headerRow);
      if (fieldMap.vin == null) { setMsg("Couldn't find a VIN column — check the pasted header row.", "err"); return; }

      const override = $("importSheetType")?.value || "auto";
      const sheetType = override !== "auto" ? override : detectSheetType(fieldMap);
      if (!sheetType) { setMsg("Couldn't tell which sheet this is — pick one from the dropdown.", "err"); return; }

      const { good, errors, warnings } = validateAndBuildRows(dataRows, sheetType, fieldMap);
      if (!good.length) {
        currentPlan = { sheetType, good, errors, warnings, newVehicles: [], updatedVehicles: [], newJobs: [], updatedJobs: [], newVendorNames: [], unrecognizedCodes: [] };
        renderSummary(currentPlan);
        setMsg("No valid rows to import.", "err");
        return;
      }

      setMsg("Checking against existing data…", "");
      const plan = await buildPlan(good, sheetType);
      plan.errors = errors; plan.warnings = warnings;
      currentPlan = plan;
      renderSummary(plan);
      $("importCommitBtn").disabled = false;
      setMsg("Preview ready — review below, then Commit Import.", "ok");
    } catch (err) {
      console.warn("[Import] preview", err);
      setMsg(err.message || "Preview failed.", "err");
    } finally {
      btn.disabled = false;
    }
  }

  async function onCommit() {
    if (!currentPlan || !currentPlan.good.length) return;
    const plan = currentPlan;
    const ok = await DT_UI.confirm({
      title: `Import ${plan.good.length} row${plan.good.length === 1 ? "" : "s"}?`,
      body: `${plan.newVehicles.length} new vehicle(s), ${plan.updatedVehicles.length} updated.` +
        (plan.sheetType === "maintenance" ? ` ${plan.newJobs.length} new service job(s), ${plan.updatedJobs.length} updated.` : ""),
      okLabel: "Import"
    });
    if (!ok) return;

    const btn = $("importCommitBtn");
    btn.disabled = true; setMsg("Importing…", "");
    try {
      await commitPlan(plan);
      DT_TOAST.show(`Imported ${plan.good.length} row${plan.good.length === 1 ? "" : "s"}`, "success");
      setMsg("Import complete. Paste updated data any time to re-run.", "ok");
      $("importPasteArea").value = "";
    } catch (err) {
      console.warn("[Import] commit", err);
      setMsg((err.message || "Import failed partway") + " — fix the issue and paste again; it's safe to re-run.", "err");
      DT_TOAST.show("Import failed — see message above.", "error");
    } finally {
      currentPlan = null;
      renderSummary(null);
      btn.disabled = true;
    }
  }

  const life = DT_LIFECYCLE.create({
    wire() {
      $("importPreviewBtn")?.addEventListener("click", onPreview);
      $("importCommitBtn")?.addEventListener("click", onCommit);
    },
    start() {},
    stop() {
      currentPlan = null;
      renderSummary(null);
      const ta = $("importPasteArea");
      if (ta) ta.value = "";
      setMsg("", "");
    }
  });

  const canSee = () => !!DT_AUTH.isManager?.();
  document.addEventListener("dt-auth-change", () => life.set(canSee()));
  life.set(canSee());

  window.DT_IMPORT = {};
})();
