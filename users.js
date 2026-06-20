// ============================================================
// DriverTrax Users (manager-only)
//   - Lists every profile (name, email, role, home airport)
//   - Edit modal: name, role, home_airport, shuttle_subrole, callbacks_opt_in
//   - Invite: enters email + initial info, sends a magic-link via OTP.
//     When the new user clicks the link, the on_auth_user_created trigger
//     creates their profile row; manager then sees them in the list and
//     can adjust anything that wasn't carried over.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const $ = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  let users = [];
  let realtimeChan = null;
  let started = false;
  let mode = "edit"; // "edit" | "invite"

  async function load() {
    const { data, error } = await sb
      .from("profiles")
      .select("id,display_name,email,phone,role,home_airport,shuttle_subrole,callbacks_opt_in,approved,created_at")
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
    // CXR only sees drivers + detailers — never managers, admins, or other CXRs.
    const visible = amCxr ? users.filter(u => CXR_EDITABLE.has(u.role || "driver")) : users;
    const list = visible.filter(u => !term
      || (u.display_name || "").toLowerCase().includes(term)
      || (u.email || "").toLowerCase().includes(term));
    const el = $("usersList");
    if (!list.length) {
      el.innerHTML = `<div class="bl-empty">No users match.</div>`;
      return;
    }
    el.innerHTML = list.map(u => {
      const targetRole = u.role || "driver";
      // CXR can edit drivers + detailers. Non-admin managers can touch anyone except admins. Admins can touch anyone.
      let canEdit = false, blockReason = "";
      if (amAdmin) { canEdit = true; }
      else if (amCxr) {
        canEdit = CXR_EDITABLE.has(targetRole);
        if (!canEdit) blockReason = "CXR can only edit drivers and detailers";
      } else {
        canEdit = targetRole !== "admin";
        if (!canEdit) blockReason = "Only an admin can edit another admin";
      }
      const pending = u.approved === false;
      const contact = u.email || u.phone || "";
      return `
        <div class="users-row row-${esc(targetRole)}${pending ? " is-pending" : ""}">
          <div class="info">
            <div class="name">${esc(u.display_name || "(no name)")}${pending ? ` <span class="pending-pill">Pending</span>` : ""}</div>
            <div class="meta">${esc(contact)}${u.home_airport ? " · " + esc(u.home_airport) : ""}</div>
          </div>
          <span class="role-pill">${esc(targetRole)}</span>
          ${pending && canEdit
            ? `<button class="approve" data-id="${u.id}" title="Approve this account">Approve</button>`
            : ""}
          ${canEdit
            ? `<button class="edit" data-id="${u.id}">Edit</button>`
            : `<button class="edit" disabled title="${esc(blockReason)}">Edit</button>`}
        </div>
      `;
    }).join("");
    el.querySelectorAll(".edit:not([disabled])").forEach(b => {
      b.addEventListener("click", () => openEdit(b.dataset.id));
    });
    el.querySelectorAll(".approve").forEach(b => {
      b.addEventListener("click", () => onApprove(b.dataset.id));
    });

    // CXR can invite too, but only for driver/detailer roles (enforced in openInvite).
    const invite = $("usersInviteBtn");
    if (invite) invite.style.display = "";
  }

  async function onApprove(id) {
    const u = users.find(x => x.id === id);
    if (!u) { DT_TOAST.missing("user"); return; }
    if (!confirm(`Approve ${u.display_name || u.email || u.phone || "this user"}?`)) return;
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
    // Shuttle sub-role only makes sense for drivers
    $("usersShuttleRow").style.display = role === "driver" ? "" : "none";
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
    form.elements.email.disabled = true;
    form.elements.email.parentElement.classList.add("locked");
    form.elements.phone.value = u.phone || "";
    form.elements.role.value = u.role || "driver";
    form.elements.shuttle_subrole.value = u.shuttle_subrole || "";
    form.elements.home_airport.value = u.home_airport || "";
    form.elements.callbacks_opt_in.checked = !!u.callbacks_opt_in;

    // Channel picker is invite-only
    $("usersInviteChannel").style.display = "none";

    applyCxrRoleLimits();

    // Show Reset Password row for the editor (any manager-tier role can use it)
    ensureResetPasswordRow();

    setFormForRole(form.elements.role.value);
    showModal();
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

  function ensureResetPasswordRow() {
    if ($("usersResetRow")) return;
    const actions = document.querySelector(".users-modal-actions");
    if (!actions) return;
    const row = document.createElement("div");
    row.id = "usersResetRow";
    row.className = "users-reset-row";
    row.innerHTML = `<button type="button" class="users-reset-btn" id="usersResetBtn">Send password reset email</button>`;
    actions.parentElement.insertBefore(row, actions);
    $("usersResetBtn").addEventListener("click", onResetPassword);
  }

  async function onResetPassword() {
    const email = $("usersForm").elements.email.value;
    if (!email) { setMsg("No email on this profile.", "err"); return; }
    if (!confirm(`Send a password-reset email to ${email}?`)) return;
    setMsg("Sending reset link…");
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname
    });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Reset link sent.", "ok");
  }

  function openInvite() {
    mode = "invite";
    $("usersModalTitle").textContent = "Invite User";
    $("usersModalSubmit").textContent = "Send invite";
    const form = $("usersForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.email.disabled = false;
    form.elements.email.parentElement.classList.remove("locked");
    form.elements.role.value = "driver";
    $("usersInviteChannel").style.display = "";
    form.elements.invite_channel.value = "email";
    applyCxrRoleLimits();
    setFormForRole("driver");
    showModal();
  }

  function normalizePhone(raw) {
    if (!raw) return null;
    const digits = raw.replace(/[^\d+]/g, "");
    if (!digits) return null;
    if (digits.startsWith("+")) return digits;
    // Default to US country code if 10 digits
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    return "+" + digits;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const id = form.elements.id.value;
    const display_name    = (form.elements.display_name.value || "").trim() || null;
    const email           = (form.elements.email.value || "").trim() || null;
    const phone           = normalizePhone(form.elements.phone.value);
    const role            = form.elements.role.value;
    const shuttle_subrole = role === "driver" ? (form.elements.shuttle_subrole.value || null) : null;
    const home_airport    = form.elements.home_airport.value || null;
    const callbacks_opt_in = !!form.elements.callbacks_opt_in.checked;

    if (mode === "edit") {
      setMsg("Saving…");
      const { error } = await sb.from("profiles")
        .update({ display_name, phone, role, shuttle_subrole, home_airport, callbacks_opt_in })
        .eq("id", id);
      if (error) { setMsg(error.message, "err"); return; }
      setMsg("Saved.", "ok");
      load();
      setTimeout(hideModal, 500);
    } else {
      const channel = form.elements.invite_channel.value;
      if (channel === "phone" && !phone) { setMsg("Phone number is required for an SMS invite.", "err"); return; }
      if (channel === "email" && !email) { setMsg("Email is required for an email invite.", "err"); return; }
      setMsg("Sending invite…");

      // Magic-link via OTP creates the auth.users row immediately, which fires
      // the on_auth_user_created trigger and gives us a profile row to update.
      const otpArgs = channel === "phone"
        ? { phone, options: { shouldCreateUser: true, data: { display_name, role, home_airport, shuttle_subrole, phone } } }
        : { email, options: { shouldCreateUser: true, data: { display_name, role, home_airport, shuttle_subrole }, emailRedirectTo: location.origin + location.pathname } };
      const { error } = await sb.auth.signInWithOtp(otpArgs);
      if (error) { setMsg(error.message, "err"); return; }

      // Pre-approve the invitee (manager already vetted them) and stamp the
      // role/phone we collected. The trigger created the profile row keyed
      // by email/phone — fetch it and update.
      const lookup = channel === "phone"
        ? sb.from("profiles").select("id").eq("phone", phone).maybeSingle()
        : sb.from("profiles").select("id").eq("email", email).maybeSingle();
      const { data: prof } = await lookup;
      if (prof && prof.id) {
        await sb.from("profiles")
          .update({ display_name, role, shuttle_subrole, home_airport, phone, approved: true })
          .eq("id", prof.id);
      }

      setMsg(channel === "phone"
        ? "Text message sent. They'll appear here after they sign in."
        : "Magic-link email sent. They'll appear here after they sign in.", "ok");
      load();
      setTimeout(hideModal, 1500);
    }
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

    load();
    realtimeChan = sb.channel("users-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, load)
      .subscribe();
  }

  function stop() {
    started = false;
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  // CXR also needs the users list (limited to drivers/detailers — render() enforces).
  const canSeeUsers = () => DT_AUTH.isManager() || (DT_AUTH.isCxr && DT_AUTH.isCxr());
  document.addEventListener("dt-auth-change", () => {
    if (canSeeUsers()) start(); else stop();
  });
  if (canSeeUsers()) start();

  window.DT_USERS = { reload: load };
})();
