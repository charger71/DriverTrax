// ============================================================
// Backlot — record catalogs & sanitizers (BL_* namespace)
//
// Self-contained copy of the driver app's DT_OPTIONS / STATUS_LABELS
// / sanitizers so Backlot's record forms speak the same vocabulary
// without referencing any driver-app file. Keep in sync with
// app.js DT_OPTIONS if the catalog changes (until a shared config
// table replaces both — see the deferred status-config enhancement).
// ============================================================
(function () {
  const OPTIONS = {
    // Selectable by any role on the entry / notes form.
    STATUS_BASE: [
      "CLEAN", "DIRTY", "REWASH", "BODY", "PM", "MK", "MR", "OM",
      "AUDIT FAIL", "WI/DELETE", "GLASS", "TI", "OTHER",
    ],
    // Selectable only by CXR / manager / admin.
    STATUS_PRIVILEGED: ["CHECK_OUT", "HOLD", "DNR"],
    // System-set by the detailer flow — not user-selectable.
    STATUS_DERIVED: ["DETAILING", "DETAILED"],
    DESTINATIONS: ["GARAGE", "QTA", "BACKLOT", "ATLANTIC", "BRANCH", "OTHER"],
    CONDITIONS: [
      { id: "REGULAR",      label: "Regular" },
      { id: "DETAIL",       label: "Detail" },
      { id: "PET_HAIR",     label: "Pet Hair" },
      { id: "SPIFFY",       label: "Spiffy" },
      { id: "AIR",          label: "Air" },
      { id: "WASHER_FLUID", label: "Washer Fluid" },
      { id: "FUEL",         label: "Fuel" },
      { id: "CHARGE",       label: "Charge" },
      { id: "QUICK_FLIP",   label: "Quick Flip" },
      { id: "PRIORITY",     label: "Priority" },
    ],
    FUEL_LEVELS: ["EMPTY", "1/4", "1/2", "3/4", "FULL"],
  };

  const STATUS_LABELS = {
    "REWASH": "REWASH/FLUIDS",
    "BODY": "BODY DAMAGE",
    "PM": "PM (MAINT.)",
    "MK": "MK (MECH.)",
    "MR": "MR (RECALL)",
    "OM": "OM (OVER MILES)",
    "TI": "TI (TIRE)",
    "CHECK_IN": "CHECK IN",
    "CHECK_OUT": "CHECK OUT",
    "HOLD": "HOLD",
    "DNR": "DO NOT RENT (DNR)",
    "DETAILING": "DETAILING",
    "DETAILED": "DETAILED",
  };

  const conditionLabel = (id) => (OPTIONS.CONDITIONS.find((c) => c.id === id)?.label) || id;

  // --- sanitizers (ported verbatim from app.js) ---
  const sanitizeSerial = (str) => String(str || "").replace(/[^A-Z0-9\-]/g, "").slice(0, 30);
  const sanitizeNotes  = (str) => String(str || "").replace(/<[^>]*>/g, "").replace(/[<>]/g, "").slice(0, 500).trim();

  window.BL_OPTIONS = OPTIONS;
  window.BL_STATUS_LABELS = STATUS_LABELS;
  window.BL_STATUS_LABEL = (s) => STATUS_LABELS[s] || s || "";
  window.BL_CONDITION_LABEL = conditionLabel;
  window.BL_SANITIZE = { serial: sanitizeSerial, notes: sanitizeNotes };
})();
