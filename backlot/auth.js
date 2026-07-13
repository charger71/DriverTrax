// ============================================================
// Backlot — Auth & role gate (BL_AUTH)
//
// Self-contained sign-in for the Backlot manager console. Talks to
// the SAME Supabase project as the driver app, reusing the shared
// `profiles` rows and roles, but ships its own gate so a driver-app
// change can never break it.
//
// Access: manager / admin / cxr may enter. Everyone else (driver,
// detailer, signed-out) is held at the gate. Admin-only powers are
// enforced per-action inside the feature modules.
//
// Exposes window.BL_AUTH: client, getUser, getProfile, role checks,
// signOut, onReady. Fires `bl-auth-change` on the document.
// ============================================================
(function () {
  if (!window.supabase || !window.BL_SUPABASE_URL || !window.BL_SUPABASE_ANON_KEY) {
    console.error("[Backlot] supabase-js or config not loaded");
    return;
  }

  const sb = window.supabase.createClient(
    window.BL_SUPABASE_URL,
    window.BL_SUPABASE_ANON_KEY,
    { auth: { persistSession: true, autoRefreshToken: true, storageKey: "backlot-auth" } }
  );

  const state = { user: null, profile: null, ready: false, listeners: [] };

  const roleOf = () => (state.profile && state.profile.role) || null;
  const isManager  = () => { const r = roleOf(); return r === "manager" || r === "admin"; };
  const isAdmin    = () => roleOf() === "admin";
  const isCxr      = () => roleOf() === "cxr";
  // Who is allowed into the console at all.
  const canEnter   = () => isManager() || isCxr();

  window.BL_AUTH = {
    client: sb,
    getUser: () => state.user,
    getProfile: () => state.profile,
    isManager, isAdmin, isCxr, canEnter,
    signOut: async () => { await sb.auth.signOut(); location.reload(); },
    onReady: (fn) => { if (state.ready) fn(); else state.listeners.push(fn); },
  };

  // ---- gate overlay markup -------------------------------------------
  function ensureGate() {
    if (document.getElementById("bl-gate")) return;
    const el = document.createElement("div");
    el.id = "bl-gate";
    el.className = "bl-gate";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Backlot sign in");
    el.innerHTML = `
      <div class="bl-gate-card">
        <div class="bl-gate-brand">
          <svg class="bl-gate-logo" aria-hidden="true"><use href="#icon-wheel"/></svg>
          <span class="bl-gate-wordmark">Backlot</span>
          <span>Manager console</span>
        </div>

        <form class="bl-gate-form" id="bl-form-signin">
          <label class="bl-field">
            <span class="bl-field-label">Email</span>
            <input type="email" name="email" autocomplete="email" required>
          </label>
          <label class="bl-field">
            <span class="bl-field-label">Password</span>
            <input type="password" name="password" autocomplete="current-password" required minlength="6">
          </label>
          <button type="submit" class="bl-btn bl-btn--primary bl-btn--block">Sign in</button>
          <button type="button" class="bl-btn bl-btn--link" id="bl-link-forgot">Forgot password?</button>
        </form>

        <form class="bl-gate-form is-hidden" id="bl-form-forgot">
          <p class="bl-gate-sub">Enter your email — we'll send a reset link.</p>
          <label class="bl-field">
            <span class="bl-field-label">Email</span>
            <input type="email" name="email" autocomplete="email" required>
          </label>
          <button type="submit" class="bl-btn bl-btn--primary bl-btn--block">Send reset link</button>
          <button type="button" class="bl-btn bl-btn--link" id="bl-link-back">Back to sign in</button>
        </form>

        <form class="bl-gate-form is-hidden" id="bl-form-reset">
          <p class="bl-gate-sub">Choose a new password.</p>
          <label class="bl-field">
            <span class="bl-field-label">New password</span>
            <input type="password" name="password" autocomplete="new-password" required minlength="6">
          </label>
          <button type="submit" class="bl-btn bl-btn--primary bl-btn--block">Update password</button>
        </form>

        <div class="bl-gate-denied is-hidden" id="bl-denied">
          <svg class="bl-gate-denied-icon" aria-hidden="true"><use href="#icon-ban"/></svg>
          <h2>Not authorized</h2>
          <p id="bl-denied-msg">Backlot is for managers. Your account doesn't have access.</p>
          <button type="button" class="bl-btn bl-btn--secondary bl-btn--block" id="bl-denied-signout">Sign out</button>
        </div>

        <div class="bl-gate-msg" id="bl-gate-msg" role="status" aria-live="polite"></div>
      </div>
    `;
    document.body.appendChild(el);

    el.querySelector("#bl-form-signin").addEventListener("submit", onSignIn);
    el.querySelector("#bl-form-forgot").addEventListener("submit", onForgot);
    el.querySelector("#bl-form-reset").addEventListener("submit", onResetPassword);
    el.querySelector("#bl-link-forgot").addEventListener("click", () => showForm("forgot"));
    el.querySelector("#bl-link-back").addEventListener("click", () => showForm("signin"));
    el.querySelector("#bl-denied-signout").addEventListener("click", async () => {
      await sb.auth.signOut();
      location.reload();
    });
  }

  function showForm(which) {
    ensureGate();
    ["signin", "forgot", "reset"].forEach((name) => {
      document.getElementById("bl-form-" + name)?.classList.toggle("is-hidden", name !== which);
    });
    document.getElementById("bl-denied")?.classList.add("is-hidden");
    setMsg("");
  }

  function showDenied(msg) {
    ensureGate();
    ["signin", "forgot", "reset"].forEach((name) => {
      document.getElementById("bl-form-" + name)?.classList.add("is-hidden");
    });
    const d = document.getElementById("bl-denied");
    if (d) d.classList.remove("is-hidden");
    if (msg) { const m = document.getElementById("bl-denied-msg"); if (m) m.textContent = msg; }
    setMsg("");
  }

  function setMsg(text, kind) {
    const el = document.getElementById("bl-gate-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "bl-gate-msg" + (kind ? " bl-gate-msg--" + kind : "");
  }

  function openGate() {
    ensureGate();
    document.getElementById("bl-gate").classList.add("is-open");
    document.body.classList.add("bl-gate-open");
    document.body.classList.remove("bl-authed");
  }
  function closeGate() {
    document.getElementById("bl-gate")?.classList.remove("is-open");
    document.body.classList.remove("bl-gate-open");
    document.body.classList.add("bl-authed");
  }

  async function onSignIn(e) {
    e.preventDefault();
    setMsg("Signing in…");
    const fd = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({
      email: (fd.get("email") || "").trim(),
      password: fd.get("password"),
    });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Welcome back.", "ok");
  }

  async function onForgot(e) {
    e.preventDefault();
    setMsg("Sending reset link…");
    const email = (new FormData(e.target).get("email") || "").trim();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Check your email for the reset link.", "ok");
  }

  async function onResetPassword(e) {
    e.preventDefault();
    setMsg("Updating password…");
    const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get("password") });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Password updated.", "ok");
    setTimeout(() => showForm("signin"), 800);
  }

  async function loadProfile(userId) {
    const { data, error } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) { console.warn("[Backlot] profile load failed", error); return null; }
    return data;
  }

  function applyBodyRole() {
    const r = roleOf();
    document.body.classList.toggle("bl-is-manager", r === "manager" || r === "admin");
    document.body.classList.toggle("bl-is-admin", r === "admin");
    document.body.classList.toggle("bl-is-cxr", r === "cxr");
  }

  function markReady() {
    if (state.ready) return;
    state.ready = true;
    state.listeners.splice(0).forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  async function applySession(session) {
    if (session && session.user) {
      state.user = session.user;
      state.profile = await loadProfile(session.user.id);

      // Approval gate — unapproved accounts can't be managers anyway, but be explicit.
      const approved = !state.profile || state.profile.approved !== false;
      if (!approved) {
        showDenied("Your account is still pending manager approval.");
        openGate();
      } else if (!canEnter()) {
        showDenied("Backlot is for managers. Your account doesn't have access.");
        openGate();
      } else {
        applyBodyRole();
        closeGate();
      }
    } else {
      state.user = null;
      state.profile = null;
      applyBodyRole();
      showForm("signin");
      openGate();
    }
    markReady();
    document.dispatchEvent(new CustomEvent("bl-auth-change", { detail: { user: state.user, profile: state.profile } }));
  }

  // Initial session check + ongoing auth changes
  sb.auth.getSession().then(({ data }) => applySession(data.session));
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { showForm("reset"); openGate(); return; }
    applySession(session);
  });
})();
