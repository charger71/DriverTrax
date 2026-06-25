// ============================================================
// DriverTrax Users (manager-only)
//   - Lists every profile (name, email, role, home airport)
//   - Edit modal: name, email, role, home_airport, shuttle_subrole,
//     callbacks_opt_in, optional "set new password" + "send reset" button
//   - Create modal: email + initial password (user is confirmed on create)
//
// Email + password operations route through the `admin-users` edge function,
// which uses the service-role key to call auth.admin.* on the server.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const $ = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  let users = [];
  let realtimeChan = null;
  let started = false;
  let mode = "edit"; // "edit" | "create"

  async function adminCall(action, payload) {
    const { data: sess } = await sb.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return { error: "Not signed in" };
    const { data, error } = await sb.functions.invoke("admin-users", {
      body: { action, ...payload },
      headers: { Authorization: `Bearer ${token}` }
    });
    if (error) {
      // FunctionsHttpError carries the response body in error.context
      let msg = error.message || "Request failed";
      try {
        const body = await error.context?.json?.();
        if (body?.error) msg = body.error;
      } catch (_) { /* ignore */ }
      return { error: msg };
    }
    if (data?.error) return { error: data.error };
    return { data };
  }

  async function load() {
    const { data, error } = await sb
      .from("profiles")
      .select("id,display_name,email,phone,role,home_airport,shuttle_subrole,callbacks_opt_in,approved,disabled,created_at")
      .order("display_name", { ascending: true, nullsFirst: false });
    if (error) {
      $("usersList").innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`;
      return;
    }
    users = data || [];
    render();
  }

  function render() {
    const amAdmin = DT_AUTH.isAdmin && DT_AUTH.isAdmin();
    const amCxr   = DT_AUTH.isCxr   && DT_AUTH.isCxr();
    const CXR_EDITABLE = new Set(["driver", "detailer"]);
    const term = ($("usersSearch")?.value || "").trim().toLowerCase();
    const visible = amCxr ? users.filter(u => CXR_EDITABLE.has(u.role || "driver")) : users;
    const list = visible.filter(u => !term
      || (u.display_name || "").toLowerCase().includes(term)
      || (u.email || "").toLowerCase().includes(term));
    const el = $("usersList");
    if (!list.length) {
      el.innerHTML = `<div class="bl-empty">No users match.</div>`;
      return;
    }
    const myId = (DT_AUTH.getUser && DT_AUTH.getUser()?.id) || null;
    el.innerHTML = list.map(u => {
      const targetRole = u.role || "driver";
      let canEdit = false, blockReason = "";
      if (amAdmin) { canEdit = true; }
      else if (amCxr) {
        canEdit = CXR_EDITABLE.has(targetRole);
        if (!canEdit) blockReason = "CXR can only edit drivers and detailers";
      } else {
        canEdit = targetRole !== "admin";
        if (!canEdit) blockReason = "Only an admin can edit another admin";
      }
      const isSelf = myId && u.id === myId;
      const canDisable = canEdit && !isSelf;
      const canDelete  = amAdmin && !isSelf;
      const pending = u.approved === false;
      const disabled = !!u.disabled;
      const contact = u.email || u.phone || "";
      return `
        <div class="users-row row-${esc(targetRole)}${pending ? " is-pending" : ""}${disabled ? " is-disabled" : ""}">
          <div class="info">
            <div class="name">${esc(u.display_name || "(no name)")}${pending ? ` <span class="pending-pill">Pending</span>` : ""}${disabled ? ` <span class="disabled-pill">Disabled</span>` : ""}</div>
            <div class="meta">${esc(contact)}${u.home_airport ? " · " + esc(u.home_airport) : ""}</div>
          </div>
          <span class="role-pill">${esc(targetRole)}</span>
          ${pending && canEdit
            ? `<button class="approve" data-id="${u.id}" title="Approve this account">Approve</button>`
            : ""}
          ${canEdit
            ? `<button class="edit" data-id="${u.id}">Edit</button>`
            : `<button class="edit" disabled title="${esc(blockReason)}">Edit</button>`}
          ${canDisable
            ? `<button class="toggle-disabled" data-id="${u.id}" data-action="${disabled ? "enable" : "disable"}">${disabled ? "Enable" : "Disable"}</button>`
            : ""}
          ${canDelete
            ? `<button class="delete" data-id="${u.id}" title="Delete user permanently">Delete</button>`
            : ""}
        </div>
      `;
    }).join("");
    el.querySelectorAll(".edit:not([disabled])").forEach(b => {
      b.addEventListener("click", () => openEdit(b.dataset.id));
    });
    el.querySelectorAll(".approve").forEach(b => {
      b.addEventListener("click", () => onApprove(b.dataset.id));
    });
    el.querySelectorAll(".toggle-disabled").forEach(b => {
      b.addEventListener("click", () => onToggleDisabled(b.dataset.id, b.dataset.action));
    });
    el.querySelectorAll(".delete").forEach(b => {
      b.addEventListener("click", () => onDelete(b.dataset.id));
    });

    const invite = $("usersInviteBtn");
    if (invite) invite.style.display = "";
  }

  async function onToggleDisabled(id, action) {
    const u = users.find(x => x.id === id);
    if (!u) { DT_TOAST.missing("user"); return; }
    const verb = action === "disable" ? "Disable" : "Enable";
    if (!confirm(`${verb} ${u.display_name || u.email || "this user"}? ${action === "disable" ? "They will not be able to sign in." : "They will be able to sign in again."}`)) return;
    const { error } = await adminCall(action, { user_id: id });
    if (error) { alert(`${verb} failed: ${error}`); return; }
    load();
  }

  async function onDelete(id) {
    const u = users.find(x => x.id === id);
    if (!u) { DT_TOAST.missing("user"); return; }
    const label = u.display_name || u.email || "this user";
    if (!confirm(`Permanently delete ${label}? This cannot be undone.`)) return;
    if (!confirm(`Really delete ${label}? Type-once confirmation.`)) return;
    const { error } = await adminCall("delete", { user_id: id });
    if (error) { alert("Delete failed: " + error); return; }
    load();
  }

  async function onApprove(id) {
    const u = users.find(x => x.id === id);
    if (!u) { DT_TOAST.missing("user"); return; }
    if (!confirm(`Approve ${u.display_name || u.email || "this user"}?`)) return;
    const { error } = await sb.from("profiles").update({ approved: true }).eq("id", id);
    if (error) { alert("Approve failed: " + error.message); return; }
    load();
  }

  // ----- modal helpers -----
  function setMsg(text, kind) {
    DT_UI.setMessage($("usersModalMsg"), text, kind);
  }

  function showModal() { $("usersModal").classList.add("show"); }
  function hideModal() { $("usersModal").classList.remove("show"); setMsg(""); }

  function setFormForRole(role) {
    $("usersShuttleRow").style.display = role === "driver" ? "" : "none";
  }

  function applyCxrRoleLimits() {
    const form = $("usersForm");
    const amCxr = DT_AUTH.isCxr && DT_AUTH.isCxr();
    Array.from(form.elements.role.options).forEach(opt => {
      const allowed = amCxr ? (opt.value === "driver" || opt.value === "detailer") : true;
      opt.hidden = !allowed;
      opt.disabled = !allowed;
    });
  }

  function openEdit(id) {
    const u = users.find(x => x.id === id);
    if (!u) { DT_TOAST.missing("user"); return; }
    mode = "edit";
    $("usersModalTitle").textContent = "Edit User";
    $("usersModalSubmit").textContent = "Save";
    const form = $("usersForm");
    form.elements.id.value = u.id;
    form.elements.display_name.value = u.display_name || "";
    form.elements.email.value = u.email || "";
    form.elements.email.disabled = false;
    form.elements.phone.value = u.phone || "";
    form.elements.role.value = u.role || "driver";
    form.elements.shuttle_subrole.value = u.shuttle_subrole || "";
    form.elements.home_airport.value = u.home_airport || "";
    form.elements.callbacks_opt_in.checked = !!u.callbacks_opt_in;
    form.elements.password.value = "";
    form.elements.password.placeholder = "Leave blank to keep current password";
    form.elements.password.required = false;

    $("usersPasswordRow").style.display = "";
    $("usersResetRow").style.display = "";

    applyCxrRoleLimits();
    setFormForRole(form.elements.role.value);
    showModal();
  }

  function openInvite() {
    mode = "create";
    $("usersModalTitle").textContent = "Create User";
    $("usersModalSubmit").textContent = "Create";
    const form = $("usersForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.email.disabled = false;
    form.elements.role.value = "driver";
    form.elements.password.placeholder = "Initial password (min 8 chars)";
    form.elements.password.required = true;

    $("usersPasswordRow").style.display = "";
    $("usersResetRow").style.display = "none";

    applyCxrRoleLimits();
    setFormForRole("driver");
    showModal();
  }

  async function onResetPassword() {
    const email = $("usersForm").elements.email.value.trim();
    if (!email) { setMsg("No email on this profile.", "err"); return; }
    if (!confirm(`Send a password-reset email to ${email}?`)) return;
    setMsg("Sending reset link…");
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname
    });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Reset link sent.", "ok");
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const id              = form.elements.id.value;
    const display_name    = (form.elements.display_name.value || "").trim() || null;
    const email           = (form.elements.email.value || "").trim() || null;
    const phone           = (form.elements.phone.value || "").trim() || null;
    const role            = form.elements.role.value;
    const shuttle_subrole = role === "driver" ? (form.elements.shuttle_subrole.value || null) : null;
    const home_airport    = form.elements.home_airport.value || null;
    const callbacks_opt_in = !!form.elements.callbacks_opt_in.checked;
    const password        = form.elements.password.value;

    if (mode === "create") {
      if (!email) { setMsg("Email is required.", "err"); return; }
      if (!password || password.length < 8) { setMsg("Password must be at least 8 characters.", "err"); return; }
      setMsg("Creating user…");
      const { data, error } = await adminCall("create", {
        email,
        password,
        profile: { display_name, phone, role, shuttle_subrole, home_airport, callbacks_opt_in }
      });
      if (error) { setMsg(error, "err"); return; }
      setMsg("User created.", "ok");
      load();
      setTimeout(hideModal, 800);
      return;
    }

    // edit
    if (!email) { setMsg("Email is required.", "err"); return; }
    setMsg("Saving…");

    const u = users.find(x => x.id === id);
    const emailChanged = !!u && (u.email || "") !== email;

    if (emailChanged) {
      const { error } = await adminCall("update_email", { user_id: id, email });
      if (error) { setMsg("Email update failed: " + error, "err"); return; }
    }

    if (password) {
      if (password.length < 8) { setMsg("Password must be at least 8 characters.", "err"); return; }
      const { error } = await adminCall("update_password", { user_id: id, password });
      if (error) { setMsg("Password update failed: " + error, "err"); return; }
    }

    const { error: pe } = await sb.from("profiles")
      .update({ display_name, phone, role, shuttle_subrole, home_airport, callbacks_opt_in })
      .eq("id", id);
    if (pe) { setMsg(pe.message, "err"); return; }

    setMsg("Saved.", "ok");
    load();
    setTimeout(hideModal, 500);
  }

  function start() {
    if (started) return;
    started = true;

    $("usersInviteBtn")?.addEventListener("click", openInvite);
    $("usersModalClose")?.addEventListener("click", hideModal);
    $("usersModalCancel")?.addEventListener("click", hideModal);
    $("usersModal")?.addEventListener("click", (e) => { if (e.target.id === "usersModal") hideModal(); });
    $("usersSearch")?.addEventListener("input", render);
    $("usersForm")?.addEventListener("submit", onSubmit);
    $("usersForm")?.elements.role.addEventListener("change", (e) => setFormForRole(e.target.value));
    $("usersResetBtn")?.addEventListener("click", onResetPassword);

    load();
    realtimeChan = sb.channel("users-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, load)
      .subscribe();
  }

  function stop() {
    started = false;
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  const canSeeUsers = () => DT_AUTH.isManager() || (DT_AUTH.isCxr && DT_AUTH.isCxr());
  document.addEventListener("dt-auth-change", () => {
    if (canSeeUsers()) start(); else stop();
  });
  if (canSeeUsers()) start();

  window.DT_USERS = { reload: load };
})();
