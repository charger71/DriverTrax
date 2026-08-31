// ============================================================
// Backlot — SIPP / ACRISS class codes
//   Mounts into #section-sipp-codes. Lists every row in sipp_codes —
//   the rental class vocabulary (ECAR, ICAR, SUV, ...) the driver
//   app's plate/class editor reads from. Create / edit label / delete.
//
//   code is the stable key (it has to match vehicles.sipp values
//   already on file), so it's only settable when adding a new code —
//   editing an existing one only lets you change the label.
//
//   Lazy-loads on first bl-section-shown for "sipp-codes" — same
//   pattern as vendors.js / parking-sections.js.
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;

  let codes = [];
  let started = false;
  let editingCode = null; // null = "add" mode; a code string = "edit" mode

  async function load() {
    const { data, error } = await sb
      .from("sipp_codes")
      .select("code,label,is_luxury,is_compact")
      .order("code", { ascending: true });
    const el = $("blSippList");
    if (error) { if (el) el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }
    codes = data || [];
    render();
  }

  function render() {
    const el = $("blSippList");
    if (!el) return;
    if (!codes.length) {
      el.innerHTML = `<div class="bl-empty">No SIPP codes yet. Add one to get started.</div>`;
      return;
    }
    el.innerHTML = codes.map((c) => `
      <div class="bl-users-row">
        <div class="info">
          <div class="name">${esc(c.code)}</div>
          <div class="meta">${esc(c.label)}${c.is_luxury ? ` <span class="bl-luxury-pill">Luxury</span>` : ""}${c.is_compact ? ` <span class="bl-compact-pill">Compact</span>` : ""}</div>
        </div>
        <div class="actions">
          <button class="bl-btn bl-btn--sm bl-btn--secondary" data-act="edit" data-code="${esc(c.code)}">Edit</button>
          <button class="bl-btn bl-btn--sm bl-btn--danger" data-act="delete" data-code="${esc(c.code)}">Delete</button>
        </div>
      </div>
    `).join("");
  }

  function onListClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "edit") openEdit(btn.dataset.code);
    else if (btn.dataset.act === "delete") onDelete(btn.dataset.code);
  }

  const setMsg = (text, kind) => BL_UI.setMessage($("blSippModalMsg"), text, kind);
  const showModal = () => $("blSippModal").classList.add("is-open");
  function hideModal() { $("blSippModal").classList.remove("is-open"); setMsg(""); }

  function openCreate() {
    editingCode = null;
    $("blSippModalTitle").textContent = "Add SIPP code";
    $("blSippSubmit").textContent = "Create";
    const f = $("blSippForm");
    f.reset();
    f.elements.code.disabled = false;
    showModal();
    setTimeout(() => f.elements.code.focus(), 50);
  }

  function openEdit(code) {
    const c = codes.find((x) => x.code === code);
    if (!c) { BL_TOAST.missing("SIPP code"); return; }
    editingCode = code;
    $("blSippModalTitle").textContent = "Edit SIPP code";
    $("blSippSubmit").textContent = "Save";
    const f = $("blSippForm");
    f.elements.code.value = c.code;
    f.elements.code.disabled = true;
    f.elements.label.value = c.label || "";
    f.elements.luxury.checked = !!c.is_luxury;
    f.elements.compact.checked = !!c.is_compact;
    showModal();
    setTimeout(() => f.elements.label.focus(), 50);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const label = (f.elements.label.value || "").trim().slice(0, 60);
    if (!label) { setMsg("Enter a label.", "err"); return; }
    const is_luxury = f.elements.luxury.checked;
    const is_compact = f.elements.compact.checked;

    setMsg("Saving…");
    let error;
    if (editingCode) {
      ({ error } = await sb.from("sipp_codes").update({ label, is_luxury, is_compact }).eq("code", editingCode));
    } else {
      const code = (f.elements.code.value || "").trim().toUpperCase().slice(0, 10);
      if (!code) { setMsg("Enter a code.", "err"); return; }
      ({ error } = await sb.from("sipp_codes").insert({ code, label, is_luxury, is_compact }));
    }
    if (error) {
      const dup = error.code === "23505" || /duplicate|unique/i.test(error.message || "");
      setMsg(dup ? "That code already exists." : (error.message || "Save failed"), "err");
      return;
    }
    BL_TOAST.success(editingCode ? "SIPP code updated." : "SIPP code added.");
    hideModal();
    load();
  }

  async function onDelete(code) {
    if (!code) return;
    if (!confirm(`Delete "${code}"? Vehicles already tagged with this code keep it as free text — only the picker loses the option.`)) return;
    const { error } = await sb.from("sipp_codes").delete().eq("code", code);
    if (error) { BL_TOAST.error("Delete failed: " + error.message); return; }
    BL_TOAST.success("SIPP code deleted.");
    load();
  }

  function start() {
    if (started) return;
    started = true;
    $("blSippList")?.addEventListener("click", onListClick);
    $("blSippAddBtn")?.addEventListener("click", openCreate);
    $("blSippModalClose")?.addEventListener("click", hideModal);
    $("blSippModalCancel")?.addEventListener("click", hideModal);
    $("blSippModal")?.addEventListener("click", (e) => { if (e.target.id === "blSippModal") hideModal(); });
    $("blSippForm")?.addEventListener("submit", onSubmit);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("blSippModal")?.classList.contains("is-open")) hideModal();
    });
  }

  // Lazy-load when the section is first shown.
  document.addEventListener("bl-section-shown", (e) => {
    if (e.detail !== "sipp-codes") return;
    start();
    load();
  });

  window.BL_SIPP_CODES = { reload: load };
})();
