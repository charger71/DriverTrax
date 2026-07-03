// ============================================================
// DriverTrax Vehicle Damage & Tire Inspection
//
//   - Per-vehicle damage marks (dent/scratch/chip/crack/missing) placed
//     on a 4-view schematic and persisted in `vehicle_damage` keyed by
//     serial_id. All authenticated users can add; manager/admin edits
//     or deletes.
//   - Per-vehicle tire status strip (position × condition × PSI) upserted
//     into `vehicle_tires`, one row per (serial_id, position).
//   - Modal surface (#damageModal) is triggered by:
//       - the "Inspect damage" button in the record detail sheet,
//       - status="BODY" in the entry form (auto-opens the modal),
//   - status="TI" in the entry form mounts the tire strip inline
//     inside #tireStripInEntry instead of opening the modal.
//   - Realtime: subscribes to changes on the currently-open serial_id
//     while the modal is open.
//   - The legacy `selectedTires` global at app.js:1497 is kept in sync
//     with the strip so saveRecord() at app.js:749 still populates
//     records.tires for status="TI" entries.
// ============================================================
(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const $ = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  const COLORS = { dent:"#EF9F27", scratch:"#D85A30", chip:"#7F77DD", crack:"#E24B4A", missing:"#5F5E5A" };
  const LABELS = { dent:"Dent", scratch:"Scratch", chip:"Chip", crack:"Crack", missing:"Missing" };

  // Tire positions match legacy `selectedTires` codes so app.js:749
  // saveRecord's `tires` array stays a stable string[].
  const TIRE_POSITIONS = ["FL", "FR", "RL", "RR"];
  const TIRE_POS_LABEL = { FL:"Front left", FR:"Front right", RL:"Rear left", RR:"Rear right" };
  const TIRE_CONDITIONS = ["OK", "worn", "low", "flat", "replace"];
  const TIRE_CONDITION_LABEL = { OK:"OK", worn:"Worn", low:"Low PSI", flat:"Flat", replace:"Replace" };

  // Panel ids exist as SVG element ids inside #damageSvg (see index.html).
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

  // ---------- module state ----------
  let currentSerial = null;
  let currentType = "dent";
  let marks = [];
  let realtimeChan = null;
  let pickerInitialized = false;
  let panelClickInitialized = false;
  let modalActionsInitialized = false;

  // Global set of serial_ids that have ANY damage on file. Populated once
  // per auth session and kept fresh via a realtime channel; record cards
  // read this via DT_DAMAGE.hasDamage(serialId) to render the DAMAGE badge.
  const damageSet = new Set();
  let damageSetChan = null;
  // Insurance claim cache: serial_id → { claim_number, notes } for the
  // currently-open vehicle. Loaded on modal open.
  let currentClaim = { claim_number: "", notes: "" };

  // ---------- helpers ----------
  function screenToSvg(svg, clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function canEditOthers() {
    return !!(DT_AUTH.isManager?.() || DT_AUTH.isAdmin?.());
  }

  // ---------- marker rendering ----------
  function makeMarkNode(mark, index) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "damage-mark");
    g.dataset.markId = mark.id;
    const halo = document.createElementNS(SVG_NS, "circle");
    halo.setAttribute("cx", mark.x); halo.setAttribute("cy", mark.y);
    halo.setAttribute("r", 9);
    halo.setAttribute("fill", COLORS[mark.damage_type] || "#888");
    halo.setAttribute("opacity", "0.25");
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", mark.x); dot.setAttribute("cy", mark.y);
    dot.setAttribute("r", 6);
    dot.setAttribute("fill", COLORS[mark.damage_type] || "#888");
    dot.setAttribute("stroke", "var(--panel)");
    dot.setAttribute("stroke-width", "1");
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", mark.x); text.setAttribute("y", mark.y + 2.5);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "7");
    text.setAttribute("font-weight", "600");
    text.setAttribute("fill", "white");
    text.setAttribute("font-family", "ui-monospace, SFMono-Regular, monospace");
    text.textContent = index + 1;
    g.appendChild(halo); g.appendChild(dot); g.appendChild(text);
    return g;
  }

  function renderAllMarks() {
    const svg = $("damageSvg");
    const marksGroup = $("damageMarksGroup");
    if (!svg || !marksGroup) return;
    while (marksGroup.firstChild) marksGroup.removeChild(marksGroup.firstChild);
    svg.querySelectorAll(".panel-hit.has-damage").forEach(el => el.classList.remove("has-damage"));
    marks.forEach((m, idx) => {
      marksGroup.appendChild(makeMarkNode(m, idx));
      const panel = document.getElementById(m.panel_id);
      if (panel) panel.classList.add("has-damage");
    });
    renderLog();
  }

  function renderLog() {
    const list = $("damageList");
    const empty = $("damageEmptyMsg");
    const badge = $("damageCountBadge");
    if (!list || !empty || !badge) return;
    badge.textContent = String(marks.length).padStart(2, "0");
    list.querySelectorAll(".damage-log-row").forEach(n => n.remove());
    empty.style.display = marks.length ? "none" : "block";
    const canDelete = canEditOthers();
    marks.forEach((m, idx) => {
      const row = document.createElement("div");
      row.className = "damage-log-row";
      const color = COLORS[m.damage_type] || "#888";
      const label = LABELS[m.damage_type] || m.damage_type;
      const location = PANEL_NAMES[m.panel_id] || m.panel_id;
      const when = window.dtTimeAgo ? window.dtTimeAgo(m.created_at, "") : "";
      row.innerHTML = `
        <span class="damage-log-num" style="background:${color}">${idx + 1}</span>
        <span class="damage-log-name">
          <span class="damage-log-type">${esc(label)}</span>
          <span class="damage-log-loc"> · ${esc(location)}</span>
          ${when ? `<span class="damage-log-when"> · ${esc(when)}</span>` : ""}
        </span>
        ${canDelete ? `<button type="button" class="damage-log-del" data-id="${esc(m.id)}" aria-label="Remove">&times;</button>` : ""}
      `;
      list.appendChild(row);
    });
    list.querySelectorAll(".damage-log-del").forEach(btn => {
      btn.addEventListener("click", () => deleteMark(btn.dataset.id));
    });
  }

  // ---------- Supabase ops ----------
  async function loadMarks(serialId) {
    const { data, error } = await sb.from("vehicle_damage")
      .select("id,serial_id,panel_id,damage_type,notes,x,y,created_by,created_at")
      .eq("serial_id", serialId)
      .order("created_at", { ascending: true });
    if (error) { console.warn("[Damage] loadMarks", error); return []; }
    return data || [];
  }

  async function addMark(panelId, x, y) {
    const user = DT_AUTH.getUser();
    if (!user || !currentSerial) return;
    const payload = {
      serial_id: currentSerial,
      panel_id: panelId,
      damage_type: currentType,
      x, y,
      created_by: user.id
    };
    // Optimistic
    const tempId = "tmp-" + Math.random().toString(36).slice(2);
    marks.push({ ...payload, id: tempId, created_at: new Date().toISOString() });
    renderAllMarks();

    const { data, error } = await sb.from("vehicle_damage").insert(payload).select().single();
    if (error) {
      marks = marks.filter(m => m.id !== tempId);
      renderAllMarks();
      DT_TOAST.show("Could not save damage: " + error.message, "error");
      return;
    }
    const i = marks.findIndex(m => m.id === tempId);
    if (i >= 0) marks[i] = data;
    renderAllMarks();
  }

  async function deleteMark(id) {
    if (!canEditOthers()) {
      DT_TOAST.show("Only managers can delete damage marks.", "warn");
      return;
    }
    if (!id || id.startsWith("tmp-")) return;
    const { error } = await sb.from("vehicle_damage").delete().eq("id", id);
    if (error) {
      if (DT_ERR.isMissing(error)) DT_TOAST.missing("damage mark");
      else DT_TOAST.show("Could not delete: " + error.message, "error");
      return;
    }
    marks = marks.filter(m => m.id !== id);
    renderAllMarks();
  }

  // ---------- realtime ----------
  function subscribeRealtime(serialId) {
    unsubscribeRealtime();
    realtimeChan = sb.channel("vd-" + serialId)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "vehicle_damage", filter: "serial_id=eq." + serialId },
        async () => { marks = await loadMarks(serialId); renderAllMarks(); }
      )
      .on("postgres_changes",
        { event: "*", schema: "public", table: "vehicle_tires", filter: "serial_id=eq." + serialId },
        async () => {
          const modalStrip = $("damageModalTireStrip");
          if (modalStrip) await mountTireStrip(modalStrip, serialId);
        }
      )
      .on("postgres_changes",
        { event: "*", schema: "public", table: "vehicle_claims", filter: "serial_id=eq." + serialId },
        async () => { if (currentSerial === serialId) await mountClaim(serialId); }
      )
      .subscribe();
  }

  function unsubscribeRealtime() {
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  // ---------- modal open/close ----------
  async function open(serialId) {
    if (!serialId) { DT_TOAST.show("No vehicle selected.", "error"); return; }
    const modal = $("damageModal");
    if (!modal) { console.warn("[Damage] #damageModal not in DOM"); return; }

    currentSerial = serialId;
    const titleEl = $("damageModalTitle");
    if (titleEl) titleEl.textContent = "Inspection · " + serialId;

    initChips();
    initPicker();
    initPanelClicks();
    initModalActions();

    marks = await loadMarks(serialId);
    renderAllMarks();
    await mountTireStrip($("damageModalTireStrip"), serialId);
    await mountClaim(serialId);

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    subscribeRealtime(serialId);
  }

  function close() {
    const modal = $("damageModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    unsubscribeRealtime();
    currentSerial = null;
    marks = [];
    const marksGroup = $("damageMarksGroup");
    if (marksGroup) while (marksGroup.firstChild) marksGroup.removeChild(marksGroup.firstChild);
    document.querySelectorAll("#damageSvg .panel-hit").forEach(el => el.classList.remove("has-damage"));
  }

  // ---------- init sub-parts ----------
  function initChips() {
    const chips = document.querySelectorAll(".damage-chip");
    // Restore active chip to reflect currentType
    chips.forEach(chip => chip.classList.toggle("active", chip.dataset.type === currentType));
    chips.forEach(chip => {
      if (chip._wired) return;
      chip._wired = true;
      chip.addEventListener("click", () => {
        currentType = chip.dataset.type;
        chips.forEach(c => c.classList.toggle("active", c === chip));
      });
    });
  }

  function initPicker() {
    const picker = $("damagePickerSelect");
    const addBtn = $("damagePickerAdd");
    if (!picker || !addBtn) return;
    if (pickerInitialized) return;
    pickerInitialized = true;
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
    picker.addEventListener("change", () => { addBtn.disabled = !picker.value; });
    addBtn.addEventListener("click", () => {
      const id = picker.value;
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      const svg = $("damageSvg");
      if (!svg) return;
      const rect = el.getBoundingClientRect();
      const loc = screenToSvg(svg, rect.left + rect.width / 2, rect.top + rect.height / 2);
      addMark(id, loc.x, loc.y);
      picker.value = "";
      addBtn.disabled = true;
    });
  }

  function initPanelClicks() {
    if (panelClickInitialized) return;
    const svg = $("damageSvg");
    if (!svg) return;
    panelClickInitialized = true;
    Object.keys(PANEL_NAMES).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add("panel-hit");
      el.dataset.panel = id;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!currentSerial) return;
        const loc = screenToSvg(svg, e.clientX, e.clientY);
        addMark(id, loc.x, loc.y);
      });
    });
  }

  function initModalActions() {
    if (modalActionsInitialized) return;
    modalActionsInitialized = true;
    const closeBtn = $("damageModalClose");
    const doneBtn = $("damageModalDone");
    const resetBtn = $("damageModalReset");
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (doneBtn)  doneBtn.addEventListener("click", close);
    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        if (!canEditOthers()) {
          DT_TOAST.show("Only managers can reset all damage marks.", "warn");
          return;
        }
        if (!confirm("Clear ALL damage marks on file for this vehicle? This cannot be undone.")) return;
        const { error } = await sb.from("vehicle_damage").delete().eq("serial_id", currentSerial);
        if (error) { DT_TOAST.show("Reset failed: " + error.message, "error"); return; }
        marks = [];
        renderAllMarks();
      });
    }
    // Tap-outside-card closes
    const modal = $("damageModal");
    if (modal) {
      modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    }
  }

  // ---------- tire strip ----------
  async function loadTires(serialId) {
    const { data, error } = await sb.from("vehicle_tires")
      .select("serial_id,position,condition,psi,notes,updated_by,updated_at")
      .eq("serial_id", serialId);
    if (error) { console.warn("[Damage] loadTires", error); return {}; }
    const out = {};
    (data || []).forEach(t => { out[t.position] = t; });
    return out;
  }

  async function upsertTire(serialId, position, patch) {
    const user = DT_AUTH.getUser();
    if (!user || !serialId) return;
    const payload = {
      serial_id: serialId,
      position,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
      ...patch
    };
    const { error } = await sb.from("vehicle_tires")
      .upsert(payload, { onConflict: "serial_id,position" });
    if (error) DT_TOAST.show("Tire update failed: " + error.message, "error");
  }

  async function mountTireStrip(container, serialId) {
    if (!container || !serialId) return;
    const tires = await loadTires(serialId);
    container.innerHTML = TIRE_POSITIONS.map(pos => {
      const t = tires[pos] || {};
      const cond = t.condition || "OK";
      const psi = t.psi != null ? t.psi : "";
      return `
        <div class="dt-tire-card" data-pos="${pos}">
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
        </div>
      `;
    }).join("");

    container.querySelectorAll(".dt-tire-card").forEach(card => {
      const pos = card.dataset.pos;
      const sel = card.querySelector(".dt-tire-condition-select");
      const psi = card.querySelector(".dt-tire-psi-input");
      const chip = card.querySelector("[data-cond-chip]");
      sel.addEventListener("change", async () => {
        const cond = sel.value;
        chip.className = "dt-tire-cond dt-tire-cond--" + cond;
        chip.textContent = TIRE_CONDITION_LABEL[cond];
        await upsertTire(serialId, pos, { condition: cond });
        syncSelectedTiresFromLocal(pos, cond);
      });
      psi.addEventListener("change", async () => {
        const raw = psi.value === "" ? null : Number(psi.value);
        const val = Number.isFinite(raw) ? raw : null;
        await upsertTire(serialId, pos, { psi: val });
      });
    });
  }

  // Mirror a single tire's condition into the legacy selectedTires global.
  // "OK" removes it from the array; anything else adds it.
  function syncSelectedTiresFromLocal(pos, cond) {
    if (!Array.isArray(window.selectedTires)) return;
    const arr = window.selectedTires;
    const idx = arr.indexOf(pos);
    if (cond === "OK") { if (idx >= 0) arr.splice(idx, 1); }
    else { if (idx === -1) arr.push(pos); }
    if (typeof window.updateTireLabel === "function") window.updateTireLabel();
  }

  // Populate selectedTires from the DB truth. Called when the entry form
  // opens the tire strip so a fresh page load reflects prior tire flags.
  async function syncSelectedTiresFromDB(serialId) {
    if (!Array.isArray(window.selectedTires)) return;
    const tires = await loadTires(serialId);
    const flagged = TIRE_POSITIONS.filter(pos => tires[pos] && tires[pos].condition && tires[pos].condition !== "OK");
    window.selectedTires.length = 0;
    flagged.forEach(p => window.selectedTires.push(p));
    if (typeof window.updateTireLabel === "function") window.updateTireLabel();
  }

  // ---------- global damage set (for record-card badges) ----------
  async function loadDamageSet() {
    const { data, error } = await sb.from("vehicle_damage").select("serial_id");
    if (error) { console.warn("[Damage] loadDamageSet", error); return; }
    damageSet.clear();
    (data || []).forEach(r => { if (r.serial_id) damageSet.add(r.serial_id); });
    document.dispatchEvent(new CustomEvent("dt-damage-set-changed"));
  }

  function subscribeDamageSet() {
    if (damageSetChan) return;
    damageSetChan = sb.channel("vd-set")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "vehicle_damage" },
        loadDamageSet
      )
      .subscribe();
  }

  function unsubscribeDamageSet() {
    if (damageSetChan) { sb.removeChannel(damageSetChan); damageSetChan = null; }
    damageSet.clear();
  }

  function hasDamage(serialId) {
    return !!serialId && damageSet.has(serialId);
  }

  // ---------- insurance claim ----------
  async function loadClaim(serialId) {
    const { data, error } = await sb.from("vehicle_claims")
      .select("serial_id,claim_number,notes,updated_by,updated_at")
      .eq("serial_id", serialId)
      .maybeSingle();
    if (error && error.code !== "PGRST116") console.warn("[Damage] loadClaim", error);
    return data || null;
  }

  async function upsertClaim(serialId, patch) {
    const user = DT_AUTH.getUser();
    if (!user || !serialId) return;
    const payload = {
      serial_id: serialId,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
      ...patch
    };
    const { error } = await sb.from("vehicle_claims")
      .upsert(payload, { onConflict: "serial_id" });
    if (error) DT_TOAST.show("Claim save failed: " + error.message, "error");
  }

  async function mountClaim(serialId) {
    const numberEl = $("damageClaimNumber");
    const notesEl = $("damageClaimNotes");
    const notesWrap = $("damageClaimNotesWrap");
    if (!numberEl || !notesEl || !notesWrap) return;

    const row = await loadClaim(serialId);
    currentClaim = {
      claim_number: (row && row.claim_number) || "",
      notes: (row && row.notes) || ""
    };
    numberEl.value = currentClaim.claim_number;
    notesEl.value = currentClaim.notes;
    updateClaimNotesVisibility();

    if (!numberEl._wired) {
      numberEl._wired = true;
      // Reveal notes as soon as the CXR types a claim number; hide + clear
      // notes when they empty it out.
      numberEl.addEventListener("input", updateClaimNotesVisibility);
      numberEl.addEventListener("change", async () => {
        const val = numberEl.value.trim();
        currentClaim.claim_number = val;
        await upsertClaim(currentSerial, {
          claim_number: val || null,
          notes: val ? currentClaim.notes : null
        });
        if (!val) {
          notesEl.value = "";
          currentClaim.notes = "";
        }
      });
    }
    if (!notesEl._wired) {
      notesEl._wired = true;
      notesEl.addEventListener("change", async () => {
        const val = notesEl.value.trim();
        currentClaim.notes = val;
        // Only save notes when there IS a claim number — otherwise they'd
        // orphan a row we've cleared.
        if ((currentClaim.claim_number || "").trim()) {
          await upsertClaim(currentSerial, { notes: val || null });
        }
      });
    }
  }

  function updateClaimNotesVisibility() {
    const numberEl = $("damageClaimNumber");
    const notesWrap = $("damageClaimNotesWrap");
    if (!numberEl || !notesWrap) return;
    const has = numberEl.value.trim().length > 0;
    notesWrap.classList.toggle("u-hidden", !has);
  }

  // ---------- entry-form integrations ----------
  async function showTireStripInEntry(serialId) {
    const container = $("tireStripInEntry");
    if (!container) return;
    if (!serialId) {
      container.innerHTML = `<div class="dt-tire-strip-empty">Scan or type a Serial ID to load tire status.</div>`;
      if (Array.isArray(window.selectedTires)) window.selectedTires.length = 0;
      if (typeof window.updateTireLabel === "function") window.updateTireLabel();
      return;
    }
    currentSerial = serialId; // enables upsertTire from the inline strip
    await mountTireStrip(container, serialId);
    await syncSelectedTiresFromDB(serialId);
  }

  function hideTireStripInEntry() {
    const container = $("tireStripInEntry");
    if (container) container.innerHTML = "";
  }

  // ---------- lifecycle: keep the damage-set warm while signed in ----------
  function start() {
    if (!DT_AUTH.getUser()) return;
    loadDamageSet();
    subscribeDamageSet();
  }
  function stop() {
    unsubscribeDamageSet();
    unsubscribeRealtime();
  }
  document.addEventListener("dt-auth-change", () => {
    if (DT_AUTH.getUser()) start(); else stop();
  });
  if (DT_AUTH.getUser()) start();

  // ---------- public API ----------
  window.DT_DAMAGE = {
    open,
    close,
    showTireStripInEntry,
    hideTireStripInEntry,
    loadMarks,
    loadTires,
    loadClaim,
    hasDamage,
    // Read-only vocabulary exposed so other surfaces (VIN history page)
    // can render marks/tires without duplicating the mapping.
    COLORS,
    LABELS,
    PANEL_NAMES,
    TIRE_POSITIONS,
    TIRE_POS_LABEL,
    TIRE_CONDITION_LABEL
  };
})();
