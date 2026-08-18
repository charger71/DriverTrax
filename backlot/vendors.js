// ============================================================
// Backlot — Service Vendors
//   Mounts into #section-vendors. Lists every row in service_vendors
//   — outside shops (body, glass, tire, towing, locksmith, ...) that
//   mechanics route work to in the driver app. Create / edit / delete.
//
//   Lazy-loads on first bl-section-shown for "vendors" — same pattern
//   as parking-sections.js — rather than a role-gated life-cycle. No
//   Backlot-side role restriction beyond "can enter Backlot at all"
//   (manager/cxr/admin); RLS on service_vendors itself still limits
//   writes to manager/admin.
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;

  let vendors = [];
  let started = false;
  let realtimeChan = null;

  const TYPE_LABELS = {
    body: "Body shop", glass: "Glass shop", tire: "Tire shop",
    towing: "Towing", locksmith: "Locksmith",
    dealer: "Dealer", general: "General repair", other: "Other"
  };

  function fullAddress(v) {
    const cityStateZip = [v.city, [v.state, v.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return [v.address, cityStateZip].filter(Boolean).join(", ");
  }

  async function load() {
    const { data, error } = await sb
      .from("service_vendors")
      .select("id,name,vendor_type,contact_name,phone,address,city,state,zip,active")
      .order("name", { ascending: true });
    const el = $("blVendorsList");
    if (error) { if (el) el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }
    vendors = data || [];
    render();
  }

  function render() {
    const el = $("blVendorsList");
    if (!el) return;
    if (!vendors.length) {
      el.innerHTML = `<div class="bl-empty">No vendors yet. Add one to get started.</div>`;
      return;
    }
    el.innerHTML = vendors.map((v) => `
      <div class="bl-users-row${v.active === false ? " is-disabled" : ""}">
        <div class="info">
          <div class="name">${esc(v.name)}
            <span class="bl-role-pill">${esc(TYPE_LABELS[v.vendor_type] || v.vendor_type)}</span>
            ${v.active === false ? `<span class="bl-disabled-pill">Inactive</span>` : ""}
          </div>
          <div class="meta">${[v.contact_name, v.phone, fullAddress(v)].filter(Boolean).map(esc).join(" · ")}</div>
        </div>
        <div class="actions">
          <button class="bl-btn bl-btn--sm bl-btn--secondary" data-act="edit" data-id="${v.id}">Edit</button>
          <button class="bl-btn bl-btn--sm bl-btn--danger" data-act="delete" data-id="${v.id}" data-name="${esc(v.name)}">Delete</button>
        </div>
      </div>
    `).join("");
  }

  function onListClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "edit") openEdit(btn.dataset.id);
    else if (btn.dataset.act === "delete") onDelete(btn.dataset.id, btn.dataset.name);
  }

  const setMsg = (text, kind) => BL_UI.setMessage($("blVendorsModalMsg"), text, kind);
  const showModal = () => $("blVendorsModal").classList.add("is-open");
  function hideModal() { $("blVendorsModal").classList.remove("is-open"); setMsg(""); }

  function openCreate() {
    $("blVendorsModalTitle").textContent = "Add vendor";
    $("blVendorsSubmit").textContent = "Create";
    const f = $("blVendorsForm");
    f.reset();
    f.elements.id.value = "";
    f.elements.active.checked = true;
    showModal();
  }

  function openEdit(id) {
    const v = vendors.find((x) => x.id === id);
    if (!v) { BL_TOAST.missing("vendor"); return; }
    $("blVendorsModalTitle").textContent = "Edit vendor";
    $("blVendorsSubmit").textContent = "Save";
    const f = $("blVendorsForm");
    f.elements.id.value = v.id;
    f.elements.name.value = v.name || "";
    f.elements.vendor_type.value = v.vendor_type || "other";
    f.elements.contact_name.value = v.contact_name || "";
    f.elements.phone.value = v.phone || "";
    f.elements.address.value = v.address || "";
    f.elements.city.value = v.city || "";
    f.elements.state.value = v.state || "";
    f.elements.zip.value = v.zip || "";
    f.elements.active.checked = v.active !== false;
    showModal();
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const id = f.elements.id.value || null;
    const payload = {
      name: (f.elements.name.value || "").trim().slice(0, 60),
      vendor_type: f.elements.vendor_type.value || "other",
      contact_name: (f.elements.contact_name.value || "").trim().slice(0, 60) || null,
      phone: (f.elements.phone.value || "").trim().slice(0, 30) || null,
      address: (f.elements.address.value || "").trim().slice(0, 120) || null,
      city: (f.elements.city.value || "").trim().slice(0, 60) || null,
      state: (f.elements.state.value || "").trim().slice(0, 2).toUpperCase() || null,
      zip: (f.elements.zip.value || "").trim().slice(0, 10) || null,
      active: f.elements.active.checked
    };
    if (!payload.name) { setMsg("Enter a name.", "err"); return; }

    setMsg("Saving…");
    const { error } = id
      ? await sb.from("service_vendors").update(payload).eq("id", id)
      : await sb.from("service_vendors").insert(payload);
    if (error) {
      const dup = error.code === "23505" || /duplicate|unique/i.test(error.message || "");
      setMsg(dup ? "That name already exists." : (error.message || "Save failed"), "err");
      return;
    }
    BL_TOAST.success(id ? "Vendor updated." : "Vendor added.");
    hideModal();
    load();
  }

  async function onDelete(id, name) {
    if (!id) return;
    if (!confirm(`Delete "${name}"? This removes it from the vendor picker. Jobs that already reference it keep their history.`)) return;
    const { error } = await sb.from("service_vendors").delete().eq("id", id);
    if (error) { BL_TOAST.error("Delete failed: " + error.message); return; }
    BL_TOAST.success("Vendor deleted.");
    load();
  }

  function start() {
    if (started) return;
    started = true;
    $("blVendorsCreate")?.addEventListener("click", openCreate);
    $("blVendorsList")?.addEventListener("click", onListClick);
    $("blVendorsModalClose")?.addEventListener("click", hideModal);
    $("blVendorsCancel")?.addEventListener("click", hideModal);
    $("blVendorsModal")?.addEventListener("click", (e) => { if (e.target.id === "blVendorsModal") hideModal(); });
    $("blVendorsForm")?.addEventListener("submit", onSubmit);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("blVendorsModal")?.classList.contains("is-open")) hideModal();
    });
    realtimeChan = sb.channel("backlot-vendors")
      .on("postgres_changes", { event: "*", schema: "public", table: "service_vendors" }, load)
      .subscribe();
  }

  // Lazy-load when the section is first shown — same pattern as
  // parking-sections.js.
  document.addEventListener("bl-section-shown", (e) => {
    if (e.detail !== "vendors") return;
    start();
    load();
  });

  window.BL_VENDORS = { reload: load };
})();
