// ============================================================
// Backlot — User Management
//   Mounts into #section-users. Lists profiles; create / edit /
//   approve / enable-disable / delete. Email + password ops route
//   through the shared `admin-users` edge function (service-role on
//   the server) — never the service key client-side.
//
//   Authorization is enforced server-side by the edge function;
//   the row gating here is UX only. Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;

  let users = [];
  let realtimeChan = null, started = false;
  let mode = "edit"; // "edit" | "create"

  const CXR_EDITABLE = new Set(["driver", "detailer"]);

  async function adminCall(action, payload) {
    const { data: sess } = await sb.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return { error: "Not signed in" };
    const { data, error } = await sb.functions.invoke("admin-users", {
      body: { action, ...payload },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) {
      let msg = error.message || "Request failed";
      try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch (_) { /* ignore */ }
      return { error: msg };
    }
    if (data?.error) return { error: data.error };
    return { data };
  }

  async function load() {
    const { data, error } = await sb.from("profiles")
      .select("id,display_name,email,phone,role,home_airport,approved,disabled,created_at")
      .order("display_name", { ascending: true, nullsFirst: false });
    if (error) { $("blUsersList").innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }
    users = data || [];
    render();
  }

  function render() {
    const amAdmin = BL_AUTH.isAdmin();
    const amCxr   = BL_AUTH.isCxr();
    const myId    = BL_AUTH.getUser()?.id || null;
    const term    = ($("blUsersSearch")?.value || "").trim().toLowerCase();

    const visible = amCxr ? users.filter((u) => CXR_EDITABLE.has(u.role || "driver")) : users;
    const list = visible.filter((u) => !term
      || (u.display_name || "").toLowerCase().includes(term)
      || (u.email || "").toLowerCase().includes(term));

    const el = $("blUsersList");
    if (!el) return;
    if (!list.length) { el.innerHTML = `<div class="bl-empty">No users match.</div>`; return; }

    el.innerHTML = list.map((u) => {
      const role = u.role || "driver";
      let canEdit = false, block = "";
      if (amAdmin) canEdit = true;
      else if (amCxr) { canEdit = CXR_EDITABLE.has(role); if (!canEdit) block = "CXR can only edit drivers and detailers"; }
      else { canEdit = role !== "admin"; if (!canEdit) block = "Only an admin can edit another admin"; }

      const isSelf = myId && u.id === myId;
      const canDisable = canEdit && !isSelf;
      const canDelete  = amAdmin && !isSelf;
      const pending = u.approved === false;
      const disabled = !!u.disabled;
      const contact = u.email || u.phone || "";

      return `
        <div class="bl-users-row${disabled ? " is-disabled" : ""}">
          <div class="info">
            <div class="name">${esc(u.display_name || "(no name)")}
              ${pending ? `<span class="bl-pending-pill">Pending</span>` : ""}
              ${disabled ? `<span class="bl-disabled-pill">Disabled</span>` : ""}
            </div>
            <div class="meta">${esc(contact)}${u.home_airport ? " · " + esc(u.home_airport) : ""}</div>
          </div>
          <span class="bl-role-pill role-${esc(role)}">${esc(role)}</span>
          <div class="actions">
            ${pending && canEdit ? `<button class="bl-btn bl-btn--sm bl-btn--primary" data-act="approve" data-id="${u.id}">Approve</button>` : ""}
            <button class="bl-btn bl-btn--sm bl-btn--secondary" data-act="edit" data-id="${u.id}"${canEdit ? "" : ` disabled title="${esc(block)}"`}>Edit</button>
            ${canDisable ? `<button class="bl-btn bl-btn--sm" data-act="${disabled ? "enable" : "disable"}" data-id="${u.id}">${disabled ? "Enable" : "Disable"}</button>` : ""}
            ${canDelete ? `<button class="bl-btn bl-btn--sm bl-btn--danger" data-act="delete" data-id="${u.id}">Delete</button>` : ""}
          </div>
        </div>`;
    }).join("");
  }

  function onListClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    switch (btn.dataset.act) {
      case "approve": return onApprove(id);
      case "edit":    return openEdit(id);
      case "disable": return onToggleDisabled(id, "disable");
      case "enable":  return onToggleDisabled(id, "enable");
      case "delete":  return onDelete(id);
    }
  }

  async function onApprove(id) {
    const u = users.find((x) => x.id === id);
    if (!u) { BL_TOAST.missing("user"); return; }
    if (!confirm(`Approve ${u.display_name || u.email || "this user"}?`)) return;
    const { error } = await sb.from("profiles").update({ approved: true }).eq("id", id);
    if (error) { BL_TOAST.error("Approve failed: " + error.message); return; }
    BL_TOAST.success("User approved."); load();
  }

  async function onToggleDisabled(id, action) {
    const u = users.find((x) => x.id === id);
    if (!u) { BL_TOAST.missing("user"); return; }
    const verb = action === "disable" ? "Disable" : "Enable";
    if (!confirm(`${verb} ${u.display_name || u.email || "this user"}? ${action === "disable" ? "They won't be able to sign in." : "They'll be able to sign in again."}`)) return;
    const { error } = await adminCall(action, { user_id: id });
    if (error) { BL_TOAST.error(`${verb} failed: ${error}`); return; }
    BL_TOAST.success(`${verb}d.`); load();
  }

  async function onDelete(id) {
    const u = users.find((x) => x.id === id);
    if (!u) { BL_TOAST.missing("user"); return; }
    const label = u.display_name || u.email || "this user";
    if (!confirm(`Permanently delete ${label}? This cannot be undone.`)) return;
    const { error } = await adminCall("delete", { user_id: id });
    if (error) { BL_TOAST.error("Delete failed: " + error); return; }
    BL_TOAST.success("User deleted."); load();
  }

  // ----- modal -----
  const setMsg = (text, kind) => BL_UI.setMessage($("blUsersModalMsg"), text, kind);
  const showModal = () => $("blUsersModal").classList.add("is-open");
  function hideModal() { $("blUsersModal").classList.remove("is-open"); setMsg(""); }

  function applyCxrRoleLimits() {
    const amCxr = BL_AUTH.isCxr();
    Array.from($("blUsersForm").elements.role.options).forEach((opt) => {
      const ok = amCxr ? CXR_EDITABLE.has(opt.value) : true;
      opt.hidden = !ok; opt.disabled = !ok;
    });
  }

  function openEdit(id) {
    const u = users.find((x) => x.id === id);
    if (!u) { BL_TOAST.missing("user"); return; }
    mode = "edit";
    $("blUsersModalTitle").textContent = "Edit user";
    $("blUsersSubmit").textContent = "Save";
    const f = $("blUsersForm");
    f.elements.id.value = u.id;
    f.elements.display_name.value = u.display_name || "";
    f.elements.email.value = u.email || "";
    f.elements.phone.value = u.phone || "";
    f.elements.role.value = u.role || "driver";
    f.elements.home_airport.value = u.home_airport || "";
    f.elements.password.value = "";
    f.elements.password.placeholder = "Leave blank to keep current";
    f.elements.password.required = false;
    $("blUsersPasswordLabel").textContent = "New password";
    $("blUsersResetRow").style.display = "";
    applyCxrRoleLimits();
    showModal();
  }

  function openCreate() {
    mode = "create";
    $("blUsersModalTitle").textContent = "Create user";
    $("blUsersSubmit").textContent = "Create";
    const f = $("blUsersForm");
    f.reset();
    f.elements.id.value = "";
    f.elements.role.value = "driver";
    f.elements.password.placeholder = "Initial password (min 8)";
    f.elements.password.required = true;
    $("blUsersPasswordLabel").textContent = "Password";
    $("blUsersResetRow").style.display = "none";
    applyCxrRoleLimits();
    showModal();
  }

  async function onResetPassword() {
    const email = ($("blUsersForm").elements.email.value || "").trim();
    if (!email) { setMsg("No email on this profile.", "err"); return; }
    if (!confirm(`Send a password-reset email to ${email}?`)) return;
    setMsg("Sending reset link…");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Reset link sent.", "ok");
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const id           = f.elements.id.value;
    const display_name = (f.elements.display_name.value || "").trim() || null;
    const email        = (f.elements.email.value || "").trim() || null;
    const phone        = (f.elements.phone.value || "").trim() || null;
    const role         = f.elements.role.value;
    const home_airport = (f.elements.home_airport.value || "").trim().toUpperCase() || null;
    const password     = f.elements.password.value;

    if (!email) { setMsg("Email is required.", "err"); return; }

    if (mode === "create") {
      if (!password || password.length < 8) { setMsg("Password must be at least 8 characters.", "err"); return; }
      setMsg("Creating user…");
      const { error } = await adminCall("create", { email, password, profile: { display_name, phone, role, home_airport } });
      if (error) { setMsg(error, "err"); return; }
      setMsg("User created.", "ok"); BL_TOAST.success("User created."); load();
      setTimeout(hideModal, 700);
      return;
    }

    // edit
    setMsg("Saving…");
    const u = users.find((x) => x.id === id);
    if (u && (u.email || "") !== email) {
      const { error } = await adminCall("update_email", { user_id: id, email });
      if (error) { setMsg("Email update failed: " + error, "err"); return; }
    }
    if (password) {
      if (password.length < 8) { setMsg("Password must be at least 8 characters.", "err"); return; }
      const { error } = await adminCall("update_password", { user_id: id, password });
      if (error) { setMsg("Password update failed: " + error, "err"); return; }
    }
    const { error: pe } = await sb.from("profiles").update({ display_name, phone, role, home_airport }).eq("id", id);
    if (pe) { setMsg(pe.message, "err"); return; }
    setMsg("Saved.", "ok"); BL_TOAST.success("Saved."); load();
    setTimeout(hideModal, 500);
  }

  function start() {
    if (started) return;
    started = true;
    $("blUsersList")?.addEventListener("click", onListClick);
    $("blUsersSearch")?.addEventListener("input", render);
    $("blUsersCreate")?.addEventListener("click", openCreate);
    $("blUsersModalClose")?.addEventListener("click", hideModal);
    $("blUsersCancel")?.addEventListener("click", hideModal);
    $("blUsersModal")?.addEventListener("click", (e) => { if (e.target.id === "blUsersModal") hideModal(); });
    $("blUsersReset")?.addEventListener("click", onResetPassword);
    $("blUsersForm")?.addEventListener("submit", onSubmit);
    load();
    realtimeChan = sb.channel("backlot-users")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, load)
      .subscribe();
  }

  function stop() {
    started = false;
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  document.addEventListener("bl-auth-change", () => { if (BL_AUTH.canEnter()) start(); else stop(); });
  if (BL_AUTH.canEnter()) start();
  // Close modal on Escape.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("blUsersModal")?.classList.contains("is-open")) hideModal(); });

  window.BL_USERS = { reload: load };
})();
