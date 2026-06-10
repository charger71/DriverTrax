// ============================================================
// DriverTrax Auth (Supabase)
// Gates the app behind sign-in. Exposes window.DT_AUTH for the
// rest of the app to read the current user/profile and sign out.
// ============================================================

(function () {
  if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
    console.error("[Auth] supabase-js or config not loaded");
    return;
  }

  const sb = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY,
    { auth: { persistSession: true, autoRefreshToken: true } }
  );

  const state = {
    user: null,
    profile: null,
    ready: false,
    listeners: []
  };

  window.DT_AUTH = {
    client: sb,
    getUser: () => state.user,
    getProfile: () => state.profile,
    isManager: () => state.profile && state.profile.role === "manager",
    signOut: async () => {
      await sb.auth.signOut();
      location.reload();
    },
    onReady: (fn) => {
      if (state.ready) fn();
      else state.listeners.push(fn);
    }
  };

  // ----- modal markup -----
  function ensureModal() {
    if (document.getElementById("dt-auth-modal")) return;
    const el = document.createElement("div");
    el.id = "dt-auth-modal";
    el.innerHTML = `
      <div class="dt-auth-card">
        <div class="dt-auth-brand">DRIVERTRAX</div>
        <div class="dt-auth-tabs">
          <button type="button" class="dt-tab active" data-tab="signin">Sign in</button>
          <button type="button" class="dt-tab" data-tab="signup">Sign up</button>
        </div>

        <form class="dt-auth-form" id="dt-form-signin">
          <label>Email<input type="email" name="email" autocomplete="email" required></label>
          <label>Password<input type="password" name="password" autocomplete="current-password" required minlength="6"></label>
          <button type="submit" class="dt-auth-submit">Sign in</button>
          <button type="button" class="dt-auth-link" id="dt-link-forgot">Forgot password?</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-forgot">
          <div class="dt-auth-sub">Enter your email — we'll send a reset link.</div>
          <label>Email<input type="email" name="email" autocomplete="email" required></label>
          <button type="submit" class="dt-auth-submit">Send reset link</button>
          <button type="button" class="dt-auth-link" id="dt-link-back-signin">Back to sign in</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-reset">
          <div class="dt-auth-sub">Pick a new password.</div>
          <label>New password<input type="password" name="password" autocomplete="new-password" required minlength="6"></label>
          <button type="submit" class="dt-auth-submit">Update password</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-signup">
          <label>Display name<input type="text" name="display_name" required maxlength="40"></label>
          <label>Email<input type="email" name="email" autocomplete="email" required></label>
          <label>Password<input type="password" name="password" autocomplete="new-password" required minlength="6"></label>
          <label>Role
            <select name="role" required>
              <option value="driver">Driver</option>
              <option value="cxr">CXR</option>
              <option value="manager">Manager</option>
            </select>
          </label>
          <label class="dt-shuttle-row" id="dt-shuttle-row">Shuttle sub-role (optional)
            <select name="shuttle_subrole">
              <option value="">—</option>
              <option value="driver">Shuttle Driver</option>
              <option value="passenger">Passenger</option>
            </select>
          </label>
          <label>Home airport (optional)<input type="text" name="home_airport" maxlength="6" placeholder="SDF"></label>
          <button type="submit" class="dt-auth-submit">Create account</button>
        </form>

        <div class="dt-auth-msg" id="dt-auth-msg"></div>
      </div>
    `;
    document.body.appendChild(el);

    // Tab switching
    el.querySelectorAll(".dt-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        el.querySelectorAll(".dt-tab").forEach(b => b.classList.toggle("active", b === btn));
        const tab = btn.dataset.tab;
        document.getElementById("dt-form-signin").classList.toggle("hidden", tab !== "signin");
        document.getElementById("dt-form-signup").classList.toggle("hidden", tab !== "signup");
        setMsg("");
      });
    });

    // Hide shuttle sub-role unless role = driver
    const signupForm = document.getElementById("dt-form-signup");
    const roleSel = signupForm.querySelector('select[name="role"]');
    const shuttleRow = document.getElementById("dt-shuttle-row");
    const syncShuttle = () => { shuttleRow.style.display = roleSel.value === "driver" ? "" : "none"; };
    roleSel.addEventListener("change", syncShuttle);
    syncShuttle();

    document.getElementById("dt-form-signin").addEventListener("submit", onSignIn);
    document.getElementById("dt-form-signup").addEventListener("submit", onSignUp);
    document.getElementById("dt-form-forgot").addEventListener("submit", onForgot);
    document.getElementById("dt-form-reset").addEventListener("submit", onResetPassword);
    document.getElementById("dt-link-forgot").addEventListener("click", () => showForm("forgot"));
    document.getElementById("dt-link-back-signin").addEventListener("click", () => showForm("signin"));
  }

  function showForm(which) {
    const forms = ["signin", "signup", "forgot", "reset"];
    forms.forEach(name => {
      const f = document.getElementById("dt-form-" + name);
      if (f) f.classList.toggle("hidden", name !== which);
    });
    document.querySelectorAll(".dt-tab").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === which);
    });
    // Hide tabs entirely on forgot/reset screens
    const tabs = document.querySelector(".dt-auth-tabs");
    if (tabs) tabs.style.display = (which === "forgot" || which === "reset") ? "none" : "flex";
    setMsg("");
  }

  function setMsg(text, kind) {
    const el = document.getElementById("dt-auth-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "dt-auth-msg" + (kind ? " " + kind : "");
  }

  function showModal() {
    ensureModal();
    document.getElementById("dt-auth-modal").classList.add("show");
  }

  function hideModal() {
    const el = document.getElementById("dt-auth-modal");
    if (el) el.classList.remove("show");
  }

  async function onSignIn(e) {
    e.preventDefault();
    setMsg("Signing in…");
    const fd = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({
      email: fd.get("email").trim(),
      password: fd.get("password")
    });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Welcome back.", "ok");
  }

  async function onSignUp(e) {
    e.preventDefault();
    setMsg("Creating account…");
    const fd = new FormData(e.target);
    const email = fd.get("email").trim();
    const password = fd.get("password");
    const display_name = fd.get("display_name").trim();
    const role = fd.get("role");
    const shuttle_subrole = role === "driver" ? (fd.get("shuttle_subrole") || null) : null;
    const home_airport = (fd.get("home_airport") || "").trim().toUpperCase() || null;

    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) { setMsg(error.message, "err"); return; }
    if (!data.user) { setMsg("Check your email to confirm your account.", "ok"); return; }

    // Profile row was auto-created by the on_auth_user_created trigger.
    // Fill in the details now.
    const { error: pErr } = await sb
      .from("profiles")
      .update({ display_name, role, shuttle_subrole, home_airport })
      .eq("id", data.user.id);
    if (pErr) { setMsg("Account created, but profile update failed: " + pErr.message, "err"); return; }
    setMsg("Account created.", "ok");
  }

  async function onForgot(e) {
    e.preventDefault();
    setMsg("Sending reset link…");
    const fd = new FormData(e.target);
    const email = fd.get("email").trim();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname
    });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Check your email for the reset link.", "ok");
  }

  async function onResetPassword(e) {
    e.preventDefault();
    setMsg("Updating password…");
    const fd = new FormData(e.target);
    const { error } = await sb.auth.updateUser({ password: fd.get("password") });
    if (error) { setMsg(error.message, "err"); return; }
    setMsg("Password updated. You're signed in.", "ok");
    setTimeout(() => { hideModal(); showForm("signin"); }, 800);
  }

  async function loadProfile(userId) {
    const { data, error } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) { console.warn("[Auth] profile load failed", error); return null; }
    return data;
  }

  async function applySession(session) {
    if (session && session.user) {
      state.user = session.user;
      state.profile = await loadProfile(session.user.id);
      hideModal();
    } else {
      state.user = null;
      state.profile = null;
      showModal();
    }
    document.body.classList.toggle("is-manager", !!(state.profile && state.profile.role === "manager"));
    if (!state.ready) {
      state.ready = true;
      state.listeners.splice(0).forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
    }
    document.dispatchEvent(new CustomEvent("dt-auth-change", { detail: { user: state.user, profile: state.profile } }));
  }

  // Initial session check
  sb.auth.getSession().then(({ data }) => applySession(data.session));

  // Listen for sign-in / sign-out / token refresh / password recovery
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      ensureModal();
      showForm("reset");
      document.getElementById("dt-auth-modal").classList.add("show");
      return;
    }
    applySession(session);
  });
})();
