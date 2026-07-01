// ============================================================
// Backlot — VIN helpers (BL_VIN)
//   • isValidVIN(s)     — 17-char VIN check
//   • decode(vin)       — NHTSA vPIC lookup → vin_data (same shape
//                         as the driver app so records stay consistent)
//   • scan(onResult)    — camera barcode scan via @zxing/library
//   Self-contained (BL_* only). NHTSA hosts are allow-listed in CSP.
// ============================================================
(function () {
  const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
  const isValidVIN = (s) => VIN_RE.test(String(s || "").trim());

  async function decode(vin) {
    try {
      const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${encodeURIComponent(vin)}?format=json`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.Results || !data.Results.length) return null;
      const map = {};
      data.Results.forEach((r) => {
        if (r.Value && r.Value !== "Not Applicable" && r.Value !== "0") map[r.Variable] = r.Value;
      });
      if (!map["Make"] && !map["Model"] && !map["Model Year"]) return null;
      const cyl = map["Engine Number of Cylinders"];
      const disp = map["Displacement (L)"];
      const engine = [disp ? `${disp}L` : null, cyl ? `${cyl}-cyl` : null].filter(Boolean).join(" ");
      return {
        year: map["Model Year"] || "",
        make: map["Make"] || "",
        model: map["Model"] || "",
        trim: map["Trim"] || "",
        bodyClass: map["Body Class"] || "",
        fuelType: map["Fuel Type - Primary"] || "",
        engine,
        manufacturer: map["Manufacturer Name"] || "",
        driveType: map["Drive Type"] || "",
        transmission: map["Transmission Style"] || "",
        doors: map["Doors"] || "",
        vehicleType: map["Vehicle Type"] || "",
        plantCity: map["Plant City"] || "",
        plantCountry: map["Plant Country"] || "",
        series: map["Series"] || "",
      };
    } catch (e) { console.warn("[Backlot] VIN decode failed", e); return null; }
  }

  // ---- camera scan (zxing) ----
  function scan(onResult) {
    if (!window.ZXing) { if (window.BL_TOAST) BL_TOAST.error("Scanner library not loaded."); return; }
    const ov = document.createElement("div");
    ov.className = "bl-scan-overlay";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Scan VIN barcode");
    ov.innerHTML = `
      <div class="bl-scan-box">
        <video id="blScanVideo" playsinline muted></video>
        <div class="bl-scan-hint">Point the camera at the VIN barcode</div>
        <button type="button" class="bl-btn bl-btn--secondary bl-btn--block" id="blScanCancel">Cancel</button>
      </div>`;
    document.body.appendChild(ov);

    const reader = new ZXing.BrowserMultiFormatReader();
    let done = false;
    const cleanup = () => { try { reader.reset(); } catch (_) {} ov.remove(); };
    const finish = (code) => { if (done) return; done = true; cleanup(); if (code) onResult(code); };

    ov.querySelector("#blScanCancel").addEventListener("click", () => finish(null));
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(null); });

    reader.decodeFromVideoDevice(null, ov.querySelector("#blScanVideo"), (result) => {
      if (result && !done) finish(result.getText());
    }).catch((e) => { cleanup(); if (window.BL_TOAST) BL_TOAST.error("Camera unavailable: " + (e.message || e)); });
  }

  window.BL_VIN = { isValidVIN, decode, scan };
})();
