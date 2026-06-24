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

  // ----- PIN helpers ---------------------------------------------------
  // The PIN is a per-device quick-unlock for an already-signed-in session.
  // The hash stays in localStorage (never in cloud) so a compromised cloud
  // row can't replay locks. Salted with the user id so the same PIN by two
  // users hashes differently.
  const UNLOCKED_FLAG_KEY = "drivertrax_pin_unlocked";
  const pinHashKey = (uid) => `drivertrax_pin_${uid}`;

  async function hashPin(pin, userId) {
    const data = new TextEncoder().encode(userId + ":" + pin);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function getStoredPinHash(uid) { return uid && localStorage.getItem(pinHashKey(uid)); }
  function setStoredPinHash(uid, h) { localStorage.setItem(pinHashKey(uid), h); }
  function clearStoredPinHash(uid) { localStorage.removeItem(pinHashKey(uid)); }
  function isUnlockedThisSession() { return sessionStorage.getItem(UNLOCKED_FLAG_KEY) === "1"; }
  function markUnlocked() { sessionStorage.setItem(UNLOCKED_FLAG_KEY, "1"); }
  function clearUnlocked() { sessionStorage.removeItem(UNLOCKED_FLAG_KEY); }

  window.DT_AUTH = {
    client: sb,
    getUser: () => state.user,
    getProfile: () => state.profile,
    isManager: () => state.profile && (state.profile.role === "manager" || state.profile.role === "admin"),
    isAdmin:   () => state.profile && state.profile.role === "admin",
    isCxr:     () => state.profile && state.profile.role === "cxr",
    isDetailer:() => state.profile && state.profile.role === "detailer",
    signOut: async () => {
      await sb.auth.signOut();
      location.reload();
    },
    onReady: (fn) => {
      if (state.ready) fn();
      else state.listeners.push(fn);
    },
    // Allow other modules to push a freshly-loaded profile back into the cache
    _setProfile: (p) => {
      state.profile = p;
      const role = p && p.role;
      document.body.classList.toggle("is-manager",  role === "manager" || role === "admin");
      document.body.classList.toggle("is-admin",    role === "admin");
      document.body.classList.toggle("is-cxr",      role === "cxr");
      document.body.classList.toggle("is-detailer", role === "detailer");
      document.dispatchEvent(new CustomEvent("dt-auth-change", { detail: { user: state.user, profile: state.profile } }));
    },
    // PIN management for the Profile page
    hasPin: () => !!(state.user && getStoredPinHash(state.user.id)),
    setPin: async (pin) => {
      if (!state.user) throw new Error("not signed in");
      if (!/^\d{6}$/.test(pin)) throw new Error("PIN must be 6 digits");
      const h = await hashPin(pin, state.user.id);
      setStoredPinHash(state.user.id, h);
      markUnlocked();
    },
    removePin: () => {
      if (state.user) clearStoredPinHash(state.user.id);
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
          <label><span class="is-required">Email</span><input type="email" name="email" autocomplete="email" required></label>
          <label><span class="is-required">Password</span><input type="password" name="password" autocomplete="current-password" required minlength="6"></label>
          <button type="submit" class="dt-auth-submit">Sign in</button>
          <button type="button" class="dt-auth-link" id="dt-link-forgot">Forgot password?</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-forgot">
          <div class="dt-auth-sub">Enter your email — we'll send a reset link.</div>
          <label><span class="is-required">Email</span><input type="email" name="email" autocomplete="email" required></label>
          <button type="submit" class="dt-auth-submit">Send reset link</button>
          <button type="button" class="dt-auth-link" id="dt-link-back-signin">Back to sign in</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-reset">
          <div class="dt-auth-sub">Pick a new password.</div>
          <label><span class="is-required">New password</span><input type="password" name="password" autocomplete="new-password" required minlength="6"></label>
          <button type="submit" class="dt-auth-submit">Update password</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-pin-unlock">
          <div class="dt-auth-sub">Welcome back<span id="dt-pin-name"></span>. Enter your 6-digit PIN.</div>
          <input type="tel" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" required autocomplete="off" autofocus class="dt-pin-input" placeholder="••••••">
          <button type="submit" class="dt-auth-submit">Unlock</button>
          <button type="button" class="dt-auth-link" id="dt-link-pin-signout">Use a different account</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-pin-setup">
          <div class="dt-auth-sub">Set a 6-digit PIN for quick unlock. You can change it later in Profile.</div>
          <label><span class="is-required">New PIN</span><input type="tel" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" required autocomplete="off" class="dt-pin-input" placeholder="••••••"></label>
          <label><span class="is-required">Confirm PIN</span><input type="tel" name="pin2" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" required autocomplete="off" class="dt-pin-input" placeholder="••••••"></label>
          <button type="submit" class="dt-auth-submit">Save PIN</button>
          <button type="button" class="dt-auth-link" id="dt-link-pin-skip">Skip for now</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-signup">
          <div class="dt-auth-sub">New accounts start as drivers. A manager will set your role after they approve you.</div>
          <label><span class="is-required">Display name</span><input type="text" name="display_name" required maxlength="40"></label>
          <label><span class="is-required">Email</span><input type="email" name="email" autocomplete="email" required></label>
          <label><span class="is-required">Password</span><input type="password" name="password" autocomplete="new-password" required minlength="6"></label>
          <button type="submit" class="dt-auth-submit">Create account</button>
        </form>

        <form class="dt-auth-form hidden" id="dt-form-pending" onsubmit="return false">
          <div class="dt-auth-sub">Your account is waiting on manager approval. You'll get access as soon as someone confirms it.</div>
          <button type="button" class="dt-auth-submit" id="dt-pending-signout">Sign out</button>
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

    document.getElementById("dt-pending-signout").addEventListener("click", async () => {
      await sb.auth.signOut();
      clearUnlocked();
      location.reload();
    });

    document.getElementById("dt-form-signin").addEventListener("submit", onSignIn);
    document.getElementById("dt-form-signup").addEventListener("submit", onSignUp);
    document.getElementById("dt-form-forgot").addEventListener("submit", onForgot);
    document.getElementById("dt-form-reset").addEventListener("submit", onResetPassword);
    document.getElementById("dt-form-pin-unlock").addEventListener("submit", onPinUnlock);
    document.getElementById("dt-form-pin-setup").addEventListener("submit", onPinSetup);
    document.getElementById("dt-link-forgot").addEventListener("click", () => showForm("forgot"));
    document.getElementById("dt-link-back-signin").addEventListener("click", () => showForm("signin"));
    document.getElementById("dt-link-pin-signout").addEventListener("click", async () => {
      await sb.auth.signOut();
      clearUnlocked();
      location.reload();
    });
    document.getElementById("dt-link-pin-skip").addEventListener("click", () => {
      markUnlocked();
      hideModal();
    });
  }

  function showForm(which) {
    const forms = ["signin", "signup", "forgot", "reset", "pin-unlock", "pin-setup", "pending"];
    forms.forEach(name => {
      const f = document.getElementById("dt-form-" + name);
      if (f) f.classList.toggle("hidden", name !== which);
    });
    document.querySelectorAll(".dt-tab").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === which);
    });
    // Hide signin/signup tabs on every screen except those two
    const tabs = document.querySelector(".dt-auth-tabs");
    if (tabs) tabs.style.display = (which === "signin" || which === "signup") ? "flex" : "none";
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

    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) { setMsg(error.message, "err"); return; }
    if (!data.user) { setMsg("Check your email to confirm your account. A manager will approve it next.", "ok"); return; }

    // Profile row was auto-created by the on_auth_user_created trigger
    // with role='driver' and approved=false. Set the display name only.
    const { error: pErr } = await sb
      .from("profiles")
      .update({ display_name })
      .eq("id", data.user.id);
    if (pErr) { setMsg("Account created, but profile update failed: " + pErr.message, "err"); return; }
    setMsg("Account created — waiting on manager approval.", "ok");
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

  async function onPinUnlock(e) {
    e.preventDefault();
    if (!state.user) { setMsg("Sign in first.", "err"); return; }
    const pin = new FormData(e.target).get("pin");
    const expected = getStoredPinHash(state.user.id);
    const got = await hashPin(pin, state.user.id);
    if (got !== expected) { setMsg("Wrong PIN.", "err"); return; }
    markUnlocked();
    hideModal();
    // Notify other modules now that we're past the unlock gate
    document.dispatchEvent(new CustomEvent("dt-auth-change", { detail: { user: state.user, profile: state.profile } }));
  }

  async function onPinSetup(e) {
    e.preventDefault();
    if (!state.user) { setMsg("Sign in first.", "err"); return; }
    const fd = new FormData(e.target);
    const pin = fd.get("pin"), pin2 = fd.get("pin2");
    if (pin !== pin2) { setMsg("PINs don't match.", "err"); return; }
    if (!/^\d{6}$/.test(pin)) { setMsg("PIN must be 6 digits.", "err"); return; }
    const h = await hashPin(pin, state.user.id);
    setStoredPinHash(state.user.id, h);
    markUnlocked();
    setMsg("PIN saved.", "ok");
    document.dispatchEvent(new CustomEvent("dt-pin-change"));
    setTimeout(hideModal, 500);
    e.target.reset();
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
      // Gate signed-in but unapproved accounts behind the "pending" screen.
      // approved=true is the live state; older rows without the column are
      // treated as approved so we don't lock everyone out before the
      // migration runs.
      const approved = !state.profile || state.profile.approved !== false;
      if (!approved) {
        ensureModal();
        showForm("pending");
        document.getElementById("dt-auth-modal").classList.add("show");
        if (!state.ready) {
          state.ready = true;
          state.listeners.splice(0).forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
        }
        return;
      }
      const hasPin = !!getStoredPinHash(session.user.id);
      if (hasPin && !isUnlockedThisSession()) {
        // Show the lock screen — keep the session, just gate the UI
        ensureModal();
        const nameEl = document.getElementById("dt-pin-name");
        if (nameEl) nameEl.textContent = state.profile?.display_name ? `, ${state.profile.display_name}` : "";
        showForm("pin-unlock");
        document.getElementById("dt-auth-modal").classList.add("show");
      } else {
        // No PIN, or already unlocked this session — let them in
        markUnlocked();
        hideModal();
      }
    } else {
      state.user = null;
      state.profile = null;
      clearUnlocked();
      showModal();
    }
    const role = state.profile && state.profile.role;
    const isManager  = role === "manager" || role === "admin";
    const isAdmin    = role === "admin";
    const isCxr      = role === "cxr";
    const isDetailer = role === "detailer";
    const isMgrLike  = isManager || isCxr;
    const wasMgrLike  = document.body.classList.contains("is-manager") || document.body.classList.contains("is-cxr");
    const wasDetailer = document.body.classList.contains("is-detailer");
    document.body.classList.toggle("is-manager",  isManager);
    document.body.classList.toggle("is-admin",    isAdmin);
    document.body.classList.toggle("is-cxr",      isCxr);
    document.body.classList.toggle("is-detailer", isDetailer);
    // Switch to a role-appropriate tab on role transition or fresh sign-in.
    if (state.user && typeof showTab === "function") {
      if (isDetailer && !wasDetailer) showTab("detail-scan");
      else if (isMgrLike !== wasMgrLike) showTab(isMgrLike ? "backlot-stats" : "entry");
    }
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
