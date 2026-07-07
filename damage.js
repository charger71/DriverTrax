// ============================================================
// DriverTrax damage + tire + claim (v2 — per-record, inline)
//
// The whole inspection UI lives inline in the New Entry form's
// Body damage + Tires collapsibles. Damage marks, tire condition/PSI,
// and insurance claim data are held in module-local state until
// saveRecord() reads them via DT_DAMAGE.getEntryState() and bundles
// them into the record row (damage_marks jsonb, tire_details jsonb,
// claim_number text, claim_notes text).
//
// No modal, no Supabase writes here, no realtime, no per-vehicle
// buffer. Anyone can edit until the record is saved.
//
// Public API (window.DT_DAMAGE):
//   getEntryState()  → { damage_marks, tire_details, claim_number, claim_notes }
//   reset()          — clear all local state + UI (called from the
//                      entry-form reset path in app.js)
//   Read-only vocabulary (COLORS, LABELS, PANEL_NAMES, TIRE_*) is
//   exposed for read-only rendering in the detail overlay etc.
// ============================================================
(function () {
  if (!window.DT_AUTH) return;
  const $ = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  const COLORS = { dent:"#EF9F27", scratch:"#D85A30", chip:"#7F77DD", crack:"#E24B4A", missing:"#5F5E5A" };
  const LABELS = { dent:"Dent", scratch:"Scratch", chip:"Chip", crack:"Crack", missing:"Missing" };

  const TIRE_POSITIONS = ["FL", "FR", "RL", "RR"];
  const TIRE_POS_LABEL = { FL:"Front left", FR:"Front right", RL:"Rear left", RR:"Rear right" };
  const TIRE_CONDITIONS = ["OK", "worn", "low", "flat", "replace"];
  const TIRE_CONDITION_LABEL = { OK:"OK", worn:"Worn", low:"Low PSI", flat:"Flat", replace:"Replace" };

  const PANEL_NAMES = {
    FRONT_BUMPERS:"Front bumper", FRONT_GRILL:"Front grille", FRONT_PANEL:"Front fascia",
    FRONT_NUMBER_PLATE:"Front license plate", FRONT_NEAR_SIDE_HEADLAMP:"Driver headlight",
    FRONT_OFF_SIDE_HEADLAMP:"Passenger headlight", FRONT_NEAR_SIDE_FOG_LIGHT:"Driver fog light",
    FRONT_OFF_SIDE_FOG_LIGHT:"Passenger fog light", FRONT_BONNET:"Hood", FRONT_WINDSCREEN:"Windshield",
    REAR_BUMPER:"Rear bumper", REAR_PANEL:"Rear fascia", REAR_NUMBER_PLATE:"Rear license plate",
    NEAR_SIDE_REAR_HEADLAMP:"Driver taillight", OFF_SIDE_REAR_HEADLAMP:"Passenger taillight",
    FRONT_REAR_WINDOW:"Rear windshield", FRONT_ROOF_PANEL:"Roof",
    NEAR_SIDE_DRIVER_DOOR:"Driver front door", NEAR_SIDE_PASSENGER_DOOR:"Driver rear door",
    NEAR_SIDE_DRIVER_WINDOW:"Driver front window", NEAR_SIDE_PASSENGER_WINDOW:"Driver rear window",
    NEAR_SIDE_SIDE_WINDOW:"Driver quarter window", NEAR_SIDE_FRONT_PANEL:"Driver front fender",
    NEAR_SIDE_FENDERS:"Driver rear quarter", NEAR_SIDE_REAR_BUMPER:"Driver rear bumper corner",
    NEAR_SIDE_WING_MIRROR:"Driver side mirror", NEAR_SIDE_DRIVER_HANDLE:"Driver front door handle",
    NEAR_SIDE_PASSENGER_HANDLE:"Driver rear door handle", NEAR_SIDE_FRONT_WHEEL:"Driver front wheel",
    NEAR_SIDE_REAR_WHEEL:"Driver rear wheel", NEAR_SIDE_FRONT_TYPE:"Driver front tire",
    NEAR_SIDE_REAR_TYPE:"Driver rear tire", NEAR_SIDE_FUEL_CAP:"Fuel cap",
    OFF_SIDE_DRIVER_DOOR:"Passenger front door", OFF_SIDE_PASSENGER_DOOR:"Passenger rear door",
    OFF_SIDE_DRIVER_WINDOW:"Passenger front window", OFF_SIDE_PASSENGER_WINDOW:"Passenger rear window",
    OFF_SIDE_SIDE_WINDOW:"Passenger quarter window", OFF_SIDE_FRONT_PANEL:"Passenger front fender",
    OFF_SIDE_FENDERS:"Passenger rear quarter", OFF_SIDE_REAR_BUMPER:"Passenger rear bumper corner",
    OFF_SIDE_WING_MIRROR:"Passenger side mirror", OFF_SIDE_DRIVER_HANDLE:"Passenger front door handle",
    OFF_SIDE_PASSENGER_HANDLE:"Passenger rear door handle", OFF_SIDE_FRONT_WHEEL:"Passenger front wheel",
    OFF_SIDE_REAR_WHEEL:"Passenger rear wheel", OFF_SIDE_FRONT_TYPE:"Passenger front tire",
    OFF_SIDE_REAR_TYPE:"Passenger rear tire", BODY_TRIM:"Body trim"
  };

  const PICKER_GROUPS = {
    "Front":         ["FRONT_BUMPERS","FRONT_GRILL","FRONT_PANEL","FRONT_NUMBER_PLATE","FRONT_NEAR_SIDE_HEADLAMP","FRONT_OFF_SIDE_HEADLAMP","FRONT_NEAR_SIDE_FOG_LIGHT","FRONT_OFF_SIDE_FOG_LIGHT","FRONT_BONNET","FRONT_WINDSCREEN"],
    "Rear":          ["REAR_BUMPER","REAR_PANEL","REAR_NUMBER_PLATE","NEAR_SIDE_REAR_HEADLAMP","OFF_SIDE_REAR_HEADLAMP","FRONT_REAR_WINDOW"],
    "Top":           ["FRONT_ROOF_PANEL","BODY_TRIM"],
    "Driver side":   ["NEAR_SIDE_DRIVER_DOOR","NEAR_SIDE_PASSENGER_DOOR","NEAR_SIDE_DRIVER_WINDOW","NEAR_SIDE_PASSENGER_WINDOW","NEAR_SIDE_SIDE_WINDOW","NEAR_SIDE_FRONT_PANEL","NEAR_SIDE_FENDERS","NEAR_SIDE_REAR_BUMPER","NEAR_SIDE_WING_MIRROR","NEAR_SIDE_DRIVER_HANDLE","NEAR_SIDE_PASSENGER_HANDLE","NEAR_SIDE_FRONT_WHEEL","NEAR_SIDE_REAR_WHEEL","NEAR_SIDE_FRONT_TYPE","NEAR_SIDE_REAR_TYPE","NEAR_SIDE_FUEL_CAP"],
    "Passenger side":["OFF_SIDE_DRIVER_DOOR","OFF_SIDE_PASSENGER_DOOR","OFF_SIDE_DRIVER_WINDOW","OFF_SIDE_PASSENGER_WINDOW","OFF_SIDE_SIDE_WINDOW","OFF_SIDE_FRONT_PANEL","OFF_SIDE_FENDERS","OFF_SIDE_REAR_BUMPER","OFF_SIDE_WING_MIRROR","OFF_SIDE_DRIVER_HANDLE","OFF_SIDE_PASSENGER_HANDLE","OFF_SIDE_FRONT_WHEEL","OFF_SIDE_REAR_WHEEL","OFF_SIDE_FRONT_TYPE","OFF_SIDE_REAR_TYPE"]
  };

  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---------- module state (per-entry, cleared by reset()) ----------
  let activeType = "dent";
  let marks = [];   // [{ panel_id, damage_type, x, y }]
  let tires = {};   // { FL: { condition?, psi? }, ... }
  let claim = { claim_number: "", notes: "" };

  const svgEl = () => $("entryDamageSvg");

  // ---------- SVG mark rendering ----------
  function makeMarkNode(m, idx) {
    const g = document.createElementNS(SVG_NS, "g");
    const halo = document.createElementNS(SVG_NS, "circle");
    halo.setAttribute("cx", m.x); halo.setAttribute("cy", m.y);
    halo.setAttribute("r", 9);
    halo.setAttribute("fill", COLORS[m.damage_type] || "#888");
    halo.setAttribute("opacity", "0.25");
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", m.x); dot.setAttribute("cy", m.y);
    dot.setAttribute("r", 6);
    dot.setAttribute("fill", COLORS[m.damage_type] || "#888");
    dot.setAttribute("stroke", "var(--panel)");
    dot.setAttribute("stroke-width", "1");
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", m.x); text.setAttribute("y", m.y + 2.5);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "7");
    text.setAttribute("font-weight", "600");
    text.setAttribute("fill", "white");
    text.setAttribute("font-family", "ui-monospace, SFMono-Regular, monospace");
    text.textContent = idx + 1;
    g.appendChild(halo); g.appendChild(dot); g.appendChild(text);
    return g;
  }

  function renderMarks() {
    const svg = svgEl();
    if (!svg) return;
    const marksGroup = svg.querySelector(".entry-damage-marks");
    if (marksGroup) {
      while (marksGroup.firstChild) marksGroup.removeChild(marksGroup.firstChild);
    }
    svg.querySelectorAll(".panel-hit.has-damage").forEach(el => el.classList.remove("has-damage"));
    marks.forEach((m, idx) => {
      if (marksGroup) marksGroup.appendChild(makeMarkNode(m, idx));
      const panel = svg.querySelector("#" + m.panel_id);
      if (panel) panel.classList.add("has-damage");
    });
    renderLog();
    updateCounts();
  }

  function renderLog() {
    const list = $("entryDamageList");
    const empty = $("entryDamageEmpty");
    if (!list || !empty) return;
    list.querySelectorAll(".damage-log-row").forEach(n => n.remove());
    empty.style.display = marks.length ? "none" : "block";
    marks.forEach((m, idx) => {
      const row = document.createElement("div");
      row.className = "damage-log-row";
      const color = COLORS[m.damage_type] || "#888";
      const label = LABELS[m.damage_type] || m.damage_type;
      const location = PANEL_NAMES[m.panel_id] || m.panel_id;
      row.innerHTML = `
        <span class="damage-log-num" style="background:${color}">${idx + 1}</span>
        <span class="damage-log-name">
          <span class="damage-log-type">${esc(label)}</span>
          <span class="damage-log-loc"> · ${esc(location)}</span>
        </span>
        <button type="button" class="damage-log-del" data-idx="${idx}" aria-label="Remove">&times;</button>
      `;
      list.appendChild(row);
    });
    list.querySelectorAll(".damage-log-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        if (Number.isFinite(idx)) {
          marks.splice(idx, 1);
          renderMarks();
        }
      });
    });
  }

  function updateCounts() {
    const badge = $("entryDamageCount");
    if (badge) badge.textContent = String(marks.length).padStart(2, "0");
    const summary = $("entryDamageSummaryCount");
    if (summary) summary.textContent = marks.length ? `${marks.length} mark${marks.length === 1 ? "" : "s"}` : "";
  }

  function updateTireSummary() {
    const summary = $("entryTireSummaryCount");
    if (!summary) return;
    const flagged = TIRE_POSITIONS.filter(pos => {
      const t = tires[pos];
      return t && t.condition && t.condition !== "OK";
    });
    summary.textContent = flagged.length ? `${flagged.length} flagged` : "";
  }

  // ---------- tire strip ----------
  function renderTireStrip() {
    const container = $("tireStripInEntry");
    if (!container) return;
    container.innerHTML = TIRE_POSITIONS.map(pos => {
      const t = tires[pos] || {};
      const cond = t.condition || "OK";
      const psi = t.psi != null ? t.psi : "";
      return `<div class="dt-tire-card" data-pos="${pos}">
        <div class="dt-tire-card-head">
          <span class="dt-tire-pos">${pos}</span>
          <span class="dt-tire-cond dt-tire-cond--${cond}" data-cond-chip>${esc(TIRE_CONDITION_LABEL[cond])}</span>
        </div>
        <div class="dt-tire-pos-label">${esc(TIRE_POS_LABEL[pos])}</div>
        <label class="dt-tire-field">
          <span>Condition</span>
          <select class="dt-tire-condition-select">
            ${TIRE_CONDITIONS.map(c => `<option value="${c}"${c === cond ? " selected" : ""}>${esc(TIRE_CONDITION_LABEL[c])}</option>`).join("")}
          </select>
        </label>
        <label class="dt-tire-field">
          <span>PSI</span>
          <input type="number" class="dt-tire-psi-input" min="0" max="200" step="1" value="${esc(psi)}" placeholder="—" inputmode="numeric">
        </label>
      </div>`;
    }).join("");

    container.querySelectorAll(".dt-tire-card").forEach(card => {
      const pos = card.dataset.pos;
      const sel = card.querySelector(".dt-tire-condition-select");
      const psi = card.querySelector(".dt-tire-psi-input");
      const chip = card.querySelector("[data-cond-chip]");
      sel.addEventListener("change", () => {
        const cond = sel.value;
        chip.className = "dt-tire-cond dt-tire-cond--" + cond;
        chip.textContent = TIRE_CONDITION_LABEL[cond];
        tires[pos] = { ...(tires[pos] || {}), condition: cond };
        syncLegacySelectedTires(pos, cond);
        updateTireSummary();
      });
      psi.addEventListener("change", () => {
        const raw = psi.value === "" ? null : Number(psi.value);
        const val = Number.isFinite(raw) ? raw : null;
        tires[pos] = { ...(tires[pos] || {}), psi: val };
      });
    });
    updateTireSummary();
  }

  // Keep legacy `selectedTires` global (a position[] array) in sync so
  // saveRecord() in app.js still fills records.tires when status="TI".
  function syncLegacySelectedTires(pos, cond) {
    if (!Array.isArray(window.selectedTires)) return;
    const arr = window.selectedTires;
    const idx = arr.indexOf(pos);
    if (cond === "OK") { if (idx >= 0) arr.splice(idx, 1); }
    else { if (idx === -1) arr.push(pos); }
    if (typeof window.updateTireLabel === "function") window.updateTireLabel();
  }

  // ---------- init wiring (runs once on DOMContentLoaded) ----------
  function init() {
    // Chip row
    document.querySelectorAll("#entryDamageCollapse .damage-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        activeType = chip.dataset.type;
        document.querySelectorAll("#entryDamageCollapse .damage-chip").forEach(c => c.classList.toggle("active", c === chip));
      });
    });

    // SVG panel click → add a mark
    const svg = svgEl();
    if (svg) {
      Object.keys(PANEL_NAMES).forEach(id => {
        const el = svg.querySelector("#" + id);
        if (!el) return;
        el.classList.add("panel-hit");
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const pt = svg.createSVGPoint();
          pt.x = e.clientX; pt.y = e.clientY;
          const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
          marks.push({ panel_id: id, damage_type: activeType, x: loc.x, y: loc.y });
          renderMarks();
        });
      });
    }

    // Panel picker (fallback for hard-to-tap panels)
    const picker = $("entryDamagePicker");
    const pickerAdd = $("entryDamagePickerAdd");
    if (picker) {
      Object.entries(PICKER_GROUPS).forEach(([section, ids]) => {
        const og = document.createElement("optgroup");
        og.label = section;
        ids.forEach(id => {
          const opt = document.createElement("option");
          opt.value = id;
          opt.textContent = PANEL_NAMES[id];
          og.appendChild(opt);
        });
        picker.appendChild(og);
      });
      picker.addEventListener("change", () => { if (pickerAdd) pickerAdd.disabled = !picker.value; });
    }
    if (pickerAdd) {
      pickerAdd.addEventListener("click", () => {
        const id = picker && picker.value;
        if (!id || !svg) return;
        const el = svg.querySelector("#" + id);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pt = svg.createSVGPoint();
        pt.x = rect.left + rect.width / 2;
        pt.y = rect.top + rect.height / 2;
        const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
        marks.push({ panel_id: id, damage_type: activeType, x: loc.x, y: loc.y });
        renderMarks();
        picker.value = "";
        pickerAdd.disabled = true;
      });
    }

    // Insurance claim inputs (notes reveal once a number is typed)
    const claimNum = $("entryClaimNumber");
    const claimNotes = $("entryClaimNotes");
    const claimNotesWrap = $("entryClaimNotesWrap");
    if (claimNum) {
      claimNum.addEventListener("input", () => {
        claim.claim_number = claimNum.value.trim();
        if (claimNotesWrap) claimNotesWrap.classList.toggle("u-hidden", !claim.claim_number);
        if (!claim.claim_number) {
          if (claimNotes) claimNotes.value = "";
          claim.notes = "";
        }
      });
    }
    if (claimNotes) {
      claimNotes.addEventListener("input", () => { claim.notes = claimNotes.value.trim(); });
    }

    renderTireStrip();
    renderMarks();
  }

  // ---------- reset (called from entry-form reset in app.js) ----------
  function reset() {
    marks = [];
    tires = {};
    claim = { claim_number: "", notes: "" };
    activeType = "dent";
    // Reset chip row visual to the "Dent" default
    document.querySelectorAll("#entryDamageCollapse .damage-chip").forEach(c => {
      c.classList.toggle("active", c.dataset.type === "dent");
    });
    // Clear claim inputs
    const claimNum = $("entryClaimNumber");
    const claimNotes = $("entryClaimNotes");
    const claimNotesWrap = $("entryClaimNotesWrap");
    if (claimNum) claimNum.value = "";
    if (claimNotes) claimNotes.value = "";
    if (claimNotesWrap) claimNotesWrap.classList.add("u-hidden");
    renderTireStrip();
    renderMarks();
  }

  // ---------- public getter (called by saveRecord) ----------
  function getEntryState() {
    return {
      damage_marks: marks.slice(),
      tire_details: { ...tires },
      claim_number: claim.claim_number || null,
      claim_notes: claim.notes || null
    };
  }

  // Prefill the collapsible with an existing record's damage so the
  // Edit overlay can reuse the same UI. (Optional — no-op if the
  // record has none.)
  function loadFromRecord(record) {
    marks = Array.isArray(record?.damage_marks) ? record.damage_marks.slice() : [];
    tires = record?.tire_details && typeof record.tire_details === "object" ? { ...record.tire_details } : {};
    claim = {
      claim_number: record?.claim_number || "",
      notes: record?.claim_notes || ""
    };
    const claimNum = $("entryClaimNumber");
    const claimNotes = $("entryClaimNotes");
    const claimNotesWrap = $("entryClaimNotesWrap");
    if (claimNum) claimNum.value = claim.claim_number;
    if (claimNotes) claimNotes.value = claim.notes;
    if (claimNotesWrap) claimNotesWrap.classList.toggle("u-hidden", !claim.claim_number);
    renderTireStrip();
    renderMarks();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // ---------- read-only viewers (used by VIN history detail overlay and
  // the aggregate panel at the top of the timeline). Both take a
  // record-shaped object: { damage_marks, tire_details, tires, claim_number, claim_notes }.
  function _cloneDamageSilhouette() {
    const source = $("entryDamageSvg");
    if (!source) return null;
    const cloned = source.cloneNode(true);
    cloned.removeAttribute("id");
    cloned.querySelectorAll("[id]").forEach(el => {
      const id = el.id;
      el.removeAttribute("id");
      if (PANEL_NAMES[id]) el.setAttribute("data-panel", id);
    });
    const marksGroup = cloned.querySelector(".entry-damage-marks");
    if (marksGroup) while (marksGroup.firstChild) marksGroup.removeChild(marksGroup.firstChild);
    cloned.classList.add("damage-viewer-svg");
    return cloned;
  }

  function renderDamageViewer(container, record) {
    if (!container) return;
    const rawMarks = Array.isArray(record?.damage_marks) ? record.damage_marks : [];
    const claimNum = record?.claim_number || "";
    const claimNotes = record?.claim_notes || "";
    if (!rawMarks.length && !claimNum) { container.innerHTML = ""; return; }

    const svgHost = document.createElement("div");
    svgHost.className = "damage-svg-wrap damage-svg-wrap--ro";
    const cloned = _cloneDamageSilhouette();
    if (cloned) {
      const marksGroup = cloned.querySelector(".entry-damage-marks");
      rawMarks.forEach((m, idx) => {
        if (marksGroup) marksGroup.appendChild(makeMarkNode(m, idx));
        const panel = cloned.querySelector(`[data-panel="${m.panel_id}"]`);
        if (panel) panel.classList.add("has-damage");
      });
      svgHost.appendChild(cloned);
    }

    const logRows = rawMarks.map((m, idx) => {
      const color = COLORS[m.damage_type] || "#888";
      const label = LABELS[m.damage_type] || m.damage_type;
      const location = PANEL_NAMES[m.panel_id] || m.panel_id;
      return `<div class="damage-log-row damage-log-row--ro">
        <span class="damage-log-num" style="background:${color}">${idx + 1}</span>
        <span class="damage-log-name">
          <span class="damage-log-type">${esc(label)}</span>
          <span class="damage-log-loc"> · ${esc(location)}</span>
        </span>
      </div>`;
    }).join("");

    const logCard = rawMarks.length ? `
      <div class="damage-log-card damage-log-card--ro">
        <div class="damage-log-header">
          <span>Damage log</span>
          <span class="damage-count-badge">${String(rawMarks.length).padStart(2, "0")}</span>
        </div>
        <div class="damage-log-list">${logRows}</div>
      </div>` : "";

    const claimCard = claimNum ? `
      <div class="damage-claim-card damage-claim-card--ro">
        <div class="detail-row"><span class="detail-label">Claim #</span><span class="detail-val">${esc(claimNum)}</span></div>
        ${claimNotes ? `<div class="detail-row"><span class="detail-label">Claim notes</span><span class="detail-val">${esc(claimNotes)}</span></div>` : ""}
      </div>` : "";

    container.innerHTML = "";
    container.appendChild(svgHost);
    container.insertAdjacentHTML("beforeend", logCard + claimCard);
  }

  function renderTireViewer(container, record) {
    if (!container) return;
    const details = record?.tire_details && typeof record.tire_details === "object" ? record.tire_details : null;
    const legacy = Array.isArray(record?.tires) ? record.tires : [];
    const hasAny = (details && Object.keys(details).length) || legacy.length;
    if (!hasAny) { container.innerHTML = ""; return; }

    const cards = TIRE_POSITIONS.map(pos => {
      const t = details?.[pos] || {};
      const cond = t.condition || (legacy.includes(pos) ? "flat" : "OK");
      const psi = t.psi != null && t.psi !== "" ? t.psi : "";
      const condLabel = TIRE_CONDITION_LABEL[cond] || cond;
      return `<div class="dt-tire-card dt-tire-card--ro" data-pos="${pos}">
        <div class="dt-tire-card-head">
          <span class="dt-tire-pos">${pos}</span>
          <span class="dt-tire-cond dt-tire-cond--${cond}">${esc(condLabel)}</span>
        </div>
        <div class="dt-tire-pos-label">${esc(TIRE_POS_LABEL[pos])}</div>
        ${psi !== "" ? `<div class="dt-tire-psi-ro">PSI: <b>${esc(psi)}</b></div>` : ""}
      </div>`;
    }).join("");

    container.innerHTML = `<div class="dt-tire-strip dt-tire-strip--ro">${cards}</div>`;
  }

  window.DT_DAMAGE = {
    getEntryState,
    reset,
    loadFromRecord,
    renderDamageViewer,
    renderTireViewer,
    COLORS, LABELS, PANEL_NAMES,
    TIRE_POSITIONS, TIRE_POS_LABEL, TIRE_CONDITION_LABEL
  };
})();
