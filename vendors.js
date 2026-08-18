// ============================================================
// DriverTrax Service Vendors (manager-only)
//   - Lists every row in service_vendors — outside shops (body, glass,
//     tire, dealer, ...) that mechanics route work to
//   - Add/edit modal: name, type, contact, phone, address, active
//   - Delete removes the row; jobs that already reference it keep the
//     vendor_id (FK has no cascade), only the picker loses the option
//
// Mounts into #panel-vendors; wired from the Vendors menu item.
// Same shape as locations.js — see that file for the pattern this
// mirrors.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb  = DT_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  let vendors = [];
  let realtimeChan = null;

  const TYPE_LABELS = {
    body: "Body shop", glass: "Glass shop", tire: "Tire shop",
    towing: "Towing", locksmith: "Locksmith",
    dealer: "Dealer", general: "General repair", other: "Other"
  };

  async function load() {
    const list = $("vendorList");
    const { data, error } = await sb
      .from("service_vendors")
      .select("id,name,vendor_type,contact_name,phone,address,active")
      .order("name", { ascending: true });
    if (error) {
      if (list) list.innerHTML = `<div class="u-empty">${esc(error.message)}</div>`;
      return;
    }
    vendors = data || [];
    render();
  }

  function render() {
    const list = $("vendorList");
    if (!list) return;
    if (!vendors.length) {
      list.innerHTML = `<div class="u-empty">No vendors yet. Add one to get started.</div>`;
      return;
    }
    list.innerHTML = vendors.map(v => `
      <div class="loc-row" data-id="${esc(v.id)}">
        <div class="loc-row-main">
          <div class="loc-row-name">${esc(v.name)}</div>
          <div class="loc-row-meta">
            <span class="loc-row-badge loc-row-badge--name">${esc(TYPE_LABELS[v.vendor_type] || v.vendor_type)}</span>
            <span class="loc-row-status ${v.active ? "loc-row-status--open" : "loc-row-status--restricted"}">${v.active ? "Active" : "Inactive"}</span>
            ${v.phone ? `<span>${esc(v.phone)}</span>` : ""}
          </div>
        </div>
        <button type="button" class="btn btn-secondary btn--sm vendor-row-edit"
                data-id="${esc(v.id)}" aria-label="Edit ${esc(v.name)}">Edit</button>
        <button type="button" class="btn btn-destructive btn--sm vendor-row-delete"
                data-id="${esc(v.id)}" data-name="${esc(v.name)}"
                aria-label="Delete ${esc(v.name)}">Delete</button>
      </div>
    `).join("");
  }

  function showModal(v) {
    const modal = $("vendorModal");
    if (!modal) return;
    const form = $("vendorForm");
    form.reset();
    $("vendorModalTitle").textContent = v ? "Edit vendor" : "Add vendor";
    if (v) {
      form.elements.id.value = v.id;
      form.elements.name.value = v.name || "";
      form.elements.vendor_type.value = v.vendor_type || "other";
      form.elements.contact_name.value = v.contact_name || "";
      form.elements.phone.value = v.phone || "";
      form.elements.address.value = v.address || "";
      form.elements.active.checked = v.active !== false;
    } else {
      form.elements.id.value = "";
      form.elements.active.checked = true;
    }
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => form.querySelector('input[name="name"]')?.focus(), 50);
  }

  function hideModal() {
    const modal = $("vendorModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    const form = $("vendorForm");
    if (form) form.reset();
    DT_UI.setMessage($("vendorModalMsg"), "");
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = $("vendorForm");
    const msg = $("vendorModalMsg");
    const submit = $("vendorModalSubmit");
    if (!form) return;
    const id = form.elements.id.value || null;
    const payload = {
      name: (form.elements.name.value || "").trim().slice(0, 60),
      vendor_type: form.elements.vendor_type.value || "other",
      contact_name: (form.elements.contact_name.value || "").trim().slice(0, 60) || null,
      phone: (form.elements.phone.value || "").trim().slice(0, 30) || null,
      address: (form.elements.address.value || "").trim().slice(0, 120) || null,
      active: form.elements.active.checked
    };
    if (!payload.name) {
      DT_UI.setMessage(msg, "Enter a name.", "err");
      return;
    }
    submit.disabled = true;
    DT_UI.setMessage(msg, "Saving…", "ok");

    const { error } = id
      ? await sb.from("service_vendors").update(payload).eq("id", id)
      : await sb.from("service_vendors").insert(payload);

    submit.disabled = false;
    if (error) {
      const dup = error.code === "23505" || /duplicate|unique/i.test(error.message || "");
      DT_UI.setMessage(msg, dup ? "That name already exists." : (error.message || "Save failed"), "err");
      return;
    }

    DT_TOAST.show(id ? "Vendor updated" : "Vendor added", "success");
    hideModal();
    await load();
  }

  async function onDelete(id, name) {
    if (!id) return;
    if (!await DT_UI.confirm({
      title: `Delete "${name}"?`,
      body: "This removes it from the vendor picker. Jobs that already reference it keep their history.",
      okLabel: "Delete",
      danger: true
    })) return;
    const { error } = await sb.from("service_vendors").delete().eq("id", id);
    if (error) {
      if (DT_ERR.isMissing(error)) {
        DT_TOAST.missing("vendor");
        await load();
        return;
      }
      DT_TOAST.show(error.message || "Delete failed", "error");
      return;
    }
    DT_TOAST.show("Vendor deleted", "success");
    await load();
  }

  const life = DT_LIFECYCLE.create({
    wire() {
      $("vendorAddBtn")?.addEventListener("click", () => showModal(null));
      $("vendorModalClose")?.addEventListener("click", hideModal);
      $("vendorModalCancel")?.addEventListener("click", hideModal);
      $("vendorModal")?.addEventListener("click", (e) => { if (e.target.id === "vendorModal") hideModal(); });
      $("vendorForm")?.addEventListener("submit", onSubmit);
      $("vendorList")?.addEventListener("click", (e) => {
        const editBtn = e.target.closest(".vendor-row-edit");
        if (editBtn) { showModal(vendors.find(v => v.id === editBtn.dataset.id) || null); return; }
        const delBtn = e.target.closest(".vendor-row-delete");
        if (delBtn) onDelete(delBtn.dataset.id, delBtn.dataset.name);
      });
    },
    start() {
      load();
      realtimeChan = sb.channel("service-vendors-feed")
        .on("postgres_changes", { event: "*", schema: "public", table: "service_vendors" }, load)
        .subscribe();
    },
    stop() {
      if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
    }
  });

  const canSee = () => !!(DT_AUTH.isManager?.() || DT_AUTH.isAdmin?.());
  document.addEventListener("dt-auth-change", () => life.set(canSee()));
  life.set(canSee());

  // Read-only accessor for maintenance.js's vendor picker — mechanics aren't
  // managers, so they never run this module's own life-cycle, but they still
  // need the active vendor list.
  async function listActive() {
    const { data, error } = await sb
      .from("service_vendors")
      .select("id,name,vendor_type")
      .eq("active", true)
      .order("name", { ascending: true });
    if (error) { console.warn("[Vendors] listActive", error); return []; }
    return data || [];
  }

  window.DT_VENDORS = { reload: load, listActive };
})();
