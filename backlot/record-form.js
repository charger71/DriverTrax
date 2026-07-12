// ============================================================
// Backlot — Record create/edit form (BL_RECORD_FORM)
//   Shared modal for creating and editing records. Writes directly
//   to Supabase (requires the privileged records RLS policy from
//   records-write-access-schema.sql). Handles status/destination
//   "other" fields, tires (TI), conditions, flags, notes, photos
//   (vehicle-photos bucket), and hooks for VIN decode + scan.
//   Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const S   = window.BL_SANITIZE || { serial: (x) => x, notes: (x) => x };

  const PHOTO_BUCKET = "vehicle-photos";
  let inited = false, mode = "create";
  let existingPhotos = []; // storage paths kept from the record
  let pendingPhotos = [];  // { blob, url } not yet uploaded
  let currentVinData = null; // decoded VIN info for the open record

  const setMsg = (t, k) => BL_UI.setMessage($("blRecFormMsg"), t, k);
  const showModal = () => $("blRecFormModal").classList.add("is-open");
  function hideModal() { $("blRecFormModal").classList.remove("is-open"); setMsg(""); revokePending(); }

  function init() {
    if (inited) return;
    inited = true;
    const o = window.BL_OPTIONS || {};
    const label = window.BL_STATUS_LABEL || ((s) => s);

    // status: base + privileged (all selectable — Backlot users are cxr/manager/admin)
    const statuses = [...(o.STATUS_BASE || []), ...(o.STATUS_PRIVILEGED || [])];
    $("blRecFormStatus").innerHTML = `<option value="">Select status…</option>` +
      statuses.map((s) => `<option value="${esc(s)}">${esc(label(s))}</option>`).join("");
    $("blRecFormDest").innerHTML = `<option value="">Select destination…</option>` +
      (o.DESTINATIONS || []).map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    $("blRecFormFuel").innerHTML = `<option value="">—</option>` +
      (o.FUEL_LEVELS || []).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
    $("blRecFormConditions").innerHTML = (o.CONDITIONS || []).map((c) =>
      `<label><input type="checkbox" value="${esc(c.id)}"> ${esc(c.label)}</label>`).join("");

    $("blRecFormStatus").addEventListener("change", applyStatusGating);
    $("blRecFormDest").addEventListener("change", applyDestGating);
    $("blRecFormClose").addEventListener("click", hideModal);
    $("blRecFormCancel").addEventListener("click", hideModal);
    $("blRecFormModal").addEventListener("click", (e) => { if (e.target.id === "blRecFormModal") hideModal(); });
    $("blRecForm").addEventListener("submit", onSubmit);
    $("blRecFormPhotoBtn").addEventListener("click", () => $("blRecFormPhotoInput").click());
    $("blRecFormPhotoInput").addEventListener("change", onPhotoPick);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("blRecFormModal").classList.contains("is-open")) hideModal(); });

    // VIN decode on blur (lights up once vin.js is loaded)
    $("blRecFormSerial").addEventListener("blur", maybeDecodeVin);
    // Scan button — only useful once BL_VIN.scan exists
    const scanBtn = $("blRecFormScan");
    if (scanBtn) {
      if (window.BL_VIN && BL_VIN.scan) scanBtn.addEventListener("click", onScan);
      else scanBtn.classList.add("is-hidden");
    }
  }

  function applyStatusGating() {
    const v = $("blRecFormStatus").value;
    $("blRecFormStatusOtherRow").classList.toggle("is-hidden", v !== "OTHER");
    $("blRecFormTiresRow").classList.toggle("is-hidden", v !== "TI");
  }
  function applyDestGating() {
    $("blRecFormDestOtherRow").classList.toggle("is-hidden", $("blRecFormDest").value !== "OTHER");
  }

  function setChecks(containerId, values) {
    const set = new Set(values || []);
    document.querySelectorAll(`#${containerId} input[type=checkbox]`).forEach((cb) => { cb.checked = set.has(cb.value); });
  }
  const getChecks = (containerId) =>
    [...document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)].map((cb) => cb.value);

  function open(m, record) {
    init();
    mode = m;
    const f = $("blRecForm");
    f.reset();
    revokePending(); pendingPhotos = []; existingPhotos = [];
    setMsg("");
    currentVinData = null;
    $("blRecFormVinInfo").classList.add("is-hidden");
    $("blRecFormVinInfo").innerHTML = "";
    // Section row is hidden by default; edit-mode reveals it if the record
    // has a section stamp. Reset here so create-mode always starts hidden.
    $("blRecFormSectionRow")?.classList.add("is-hidden");

    if (m === "edit" && record) {
      $("blRecFormTitle").textContent = "Edit record";
      $("blRecFormSubmit").textContent = "Save";
      f.elements.id.value = record.id;
      f.elements.serial_id.value = record.serial_id || "";
      f.elements.status.value = record.status || "";
      f.elements.status_other.value = record.status_other || "";
      f.elements.destination.value = record.destination || "";
      f.elements.destination_other.value = record.destination_other || "";
      // Read-only section (GPS-tagged). Hide the row when nothing to show.
      const sectionRow = $("blRecFormSectionRow");
      const sectionInput = f.elements.section_name;
      if (sectionRow && sectionInput) {
        if (record.section_name) {
          sectionInput.value = record.section_name;
          sectionRow.classList.remove("is-hidden");
        } else {
          sectionInput.value = "";
          sectionRow.classList.add("is-hidden");
        }
      }
      f.elements.fuel_level.value = record.fuel_level || "";
      f.elements.mileage.value = (record.mileage != null ? record.mileage : "");
      f.elements.notes.value = record.notes || "";
      f.elements.no_tag.checked = !!record.no_tag;
      f.elements.shuttle.checked = !!record.shuttle;
      f.elements.transport.checked = !!record.transport;
      setChecks("blRecFormConditions", record.conditions);
      setChecks("blRecFormTires", record.tires);
      existingPhotos = Array.isArray(record.photo_urls) ? [...record.photo_urls]
        : (record.photo_url ? [record.photo_url] : []);
      if (record.vin_data) showVinInfo(record.vin_data);
      f.dataset.userId = record.user_id || "";
      f.dataset.ts = record.ts || "";
    } else {
      $("blRecFormTitle").textContent = "New record";
      $("blRecFormSubmit").textContent = "Create";
      f.elements.id.value = "";
      delete f.dataset.userId; delete f.dataset.ts;
    }
    applyStatusGating(); applyDestGating();
    renderPhotoStrip();
    showModal();
    setTimeout(() => f.elements.serial_id.focus(), 50);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const serial = S.serial((f.elements.serial_id.value || "").trim().toUpperCase());
    if (!serial) { setMsg("VIN / Serial is required.", "err"); return; }
    const status = f.elements.status.value;
    if (!status) { setMsg("Please choose a status.", "err"); return; }

    const submitBtn = $("blRecFormSubmit");
    submitBtn.disabled = true;
    setMsg(pendingPhotos.length ? "Uploading photos…" : "Saving…");

    const recId = f.elements.id.value || (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

    // Upload any new photos to vehicle-photos, keep the storage paths.
    let photoPaths = [...existingPhotos];
    try {
      for (const p of pendingPhotos) {
        const path = `${recId}/${crypto?.randomUUID?.() || Date.now()}.jpg`;
        const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, p.blob, { contentType: "image/jpeg", upsert: false });
        if (error) throw error;
        photoPaths.push(path);
      }
    } catch (err) {
      setMsg("Photo upload failed: " + (err.message || err), "err");
      submitBtn.disabled = false;
      return;
    }

    const mileageRaw = (f.elements.mileage.value || "").trim();
    const mileage = mileageRaw ? parseInt(mileageRaw, 10) : null;
    const destination = f.elements.destination.value || null;
    const payload = {
      serial_id: serial,
      status,
      status_other: status === "OTHER" ? (S.notes(f.elements.status_other.value || "").slice(0, 40) || null) : null,
      destination,
      destination_other: destination === "OTHER" ? (S.notes(f.elements.destination_other.value || "").slice(0, 40) || null) : null,
      conditions: getChecks("blRecFormConditions"),
      tires: status === "TI" ? getChecks("blRecFormTires") : [],
      fuel_level: f.elements.fuel_level.value || null,
      mileage: Number.isFinite(mileage) && mileage >= 0 ? mileage : null,
      no_tag: f.elements.no_tag.checked,
      shuttle: f.elements.shuttle.checked,
      transport: f.elements.transport.checked,
      notes: S.notes(f.elements.notes.value || "") || null,
      photo_urls: photoPaths.length ? photoPaths : null,
      vin_data: currentVinData || null,
    };

    let error;
    if (mode === "edit") {
      // Preserve original owner + timestamp.
      ({ error } = await sb.from("records").update(payload).eq("id", recId));
    } else {
      payload.id = recId;
      payload.user_id = BL_AUTH.getUser()?.id || null;
      payload.ts = new Date().toISOString();
      ({ error } = await sb.from("records").insert(payload));
    }
    submitBtn.disabled = false;
    if (error) { setMsg((mode === "edit" ? "Save" : "Create") + " failed: " + error.message, "err"); return; }
    setMsg(mode === "edit" ? "Saved." : "Created.", "ok");
    BL_TOAST.success(mode === "edit" ? "Record saved." : "Record created.");
    if (window.BL_RECORDS) BL_RECORDS.reload();
    setTimeout(hideModal, 500);
  }

  // ---------- photos ----------
  function onPhotoPick(e) {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    files.forEach(async (file) => {
      try {
        const blob = await resizeImage(file);
        pendingPhotos.push({ blob, url: URL.createObjectURL(blob) });
        renderPhotoStrip();
      } catch (_) { /* skip bad image */ }
    });
  }
  function resizeImage(file, max = 1600, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > max || height > max) {
          const s = Math.min(max / width, max / height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error("resize failed")), "image/jpeg", quality);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  async function renderPhotoStrip() {
    const strip = $("blRecFormPhotos");
    if (!strip) return;
    let html = "";
    // existing (signed URLs)
    if (existingPhotos.length) {
      try {
        const { data } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(existingPhotos, 600);
        (data || []).forEach((d, i) => {
          if (d.signedUrl) html += photoThumb(d.signedUrl, "existing", i);
        });
      } catch (_) { /* best effort */ }
    }
    pendingPhotos.forEach((p, i) => { html += photoThumb(p.url, "pending", i); });
    strip.innerHTML = html;
    strip.querySelectorAll("[data-rm]").forEach((btn) => btn.addEventListener("click", () => {
      const [kind, idx] = btn.dataset.rm.split(":");
      if (kind === "existing") existingPhotos.splice(+idx, 1);
      else { URL.revokeObjectURL(pendingPhotos[+idx]?.url); pendingPhotos.splice(+idx, 1); }
      renderPhotoStrip();
    }));
  }
  const photoThumb = (src, kind, i) =>
    `<div class="bl-photo-wrap"><img class="bl-photo-thumb" src="${esc(src)}" alt="Record photo"><button type="button" class="rm" data-rm="${kind}:${i}" aria-label="Remove photo"><svg class="bl-icon" aria-hidden="true"><use href="#icon-x"/></svg></button></div>`;
  function revokePending() { pendingPhotos.forEach((p) => URL.revokeObjectURL(p.url)); }

  // ---------- VIN decode / scan hooks (vin.js) ----------
  function showVinInfo(vd) {
    currentVinData = vd;
    const el = $("blRecFormVinInfo");
    const line = [vd.year, vd.make, vd.model].filter(Boolean).join(" ");
    if (!line) { el.classList.add("is-hidden"); return; }
    el.innerHTML = `<span class="yr">${esc(line)}</span>${vd.trim ? " · " + esc(vd.trim) : ""}`;
    el.classList.remove("is-hidden");
  }
  async function maybeDecodeVin() {
    if (!window.BL_VIN || !BL_VIN.decode) return;
    const vin = ($("blRecFormSerial").value || "").trim().toUpperCase();
    if (!BL_VIN.isValidVIN || !BL_VIN.isValidVIN(vin)) return;
    const el = $("blRecFormVinInfo");
    el.classList.remove("is-hidden"); el.textContent = "Looking up VIN…";
    const vd = await BL_VIN.decode(vin);
    if (vd) showVinInfo(vd); else { el.classList.add("is-hidden"); currentVinData = null; }
  }
  async function onScan() {
    if (!window.BL_VIN || !BL_VIN.scan) return;
    BL_VIN.scan((code) => {
      if (code) { $("blRecFormSerial").value = String(code).toUpperCase(); maybeDecodeVin(); }
    });
  }

  window.BL_RECORD_FORM = { open };
})();
