// ============================================================
// DriverTrax Web Notifications
//   Surfaces new alerts (announcements) and coverage requests
//   (extra_driver_requests) to drivers, detailers, and CXRs while
//   the PWA is running. Prefers the browser Notification API when
//   available; falls back to an in-app toast (DT_TOAST) otherwise
//   — that covers the iOS WKWebView wrapper, denied permission,
//   and any browser without Notification support.
//
//   No server / push subscription — fires from the page when a
//   Supabase Realtime INSERT arrives. Skips the user's own posts
//   and any rows older than session start so reloads don't spam.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;

  const sb = DT_AUTH.client;
  const PERM_ASKED_KEY = "drivertrax_notif_perm_asked";
  const TARGET_ROLES = new Set(["driver", "detailer", "cxr"]);

  // Don't fire for rows that already existed when this session started.
  const sessionStart = Date.now();
  // Boundary for catchUp() — anything inserted after this timestamp is fair
  // game to surface. Advances each time we successfully query. Realtime is
  // unreliable on iOS (WKWebView suspends the socket in background) so we
  // need an HTTP fallback that runs on resume + reconnect.
  let lastSeenAt = new Date(sessionStart).toISOString();
  // Per-row dedupe: realtime and catchUp can both deliver the same row.
  const surfacedAnn = new Set();
  const surfacedEdr = new Set();
  let chan = null;
  let started = false;
  let catchingUp = false;

  function isTargetRole() {
    const p = DT_AUTH.getProfile();
    return !!(p && TARGET_ROLES.has(p.role));
  }

  async function ensurePermission() {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    // Only auto-prompt once per device; after that the user can
    // re-enable via the browser site settings.
    if (localStorage.getItem(PERM_ASKED_KEY)) return false;
    localStorage.setItem(PERM_ASKED_KEY, "1");
    try {
      const res = await Notification.requestPermission();
      return res === "granted";
    } catch {
      return false;
    }
  }

  async function show(title, body, tag, onClickTab) {
    const hasNative = typeof Notification !== "undefined" && Notification.permission === "granted";
    if (!hasNative) {
      // WKWebView wrapper, denied permission, or unsupported browser — surface it in-app
      // via #alertModal (the .users-modal pattern). Last-wins if one is already open.
      openAlertModal(title, body, onClickTab);
      return;
    }
    const opts = {
      body,
      tag,
      icon: "./icon.png",
      badge: "./icon.png",
      data: { tab: onClickTab }
    };
    // Prefer the service worker so the notification persists if
    // the tab is backgrounded; fall back to the page Notification.
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg && reg.showNotification) {
        await reg.showNotification(title, opts);
        return;
      }
    } catch {}
    try {
      const n = new Notification(title, opts);
      n.onclick = () => {
        window.focus();
        if (onClickTab && typeof window.showTab === "function") {
          window.showTab(onClickTab);
        }
        n.close();
      };
    } catch (err) {
      console.warn("[Notifications] show failed", err);
    }
  }

  async function authorName(id) {
    if (!id) return "Manager";
    try {
      const { data } = await sb.from("profiles").select("display_name").eq("id", id).maybeSingle();
      return data?.display_name || "Manager";
    } catch {
      return "Manager";
    }
  }

  async function surfaceAnnouncement(row) {
    if (!row?.id || surfacedAnn.has(row.id)) return;
    surfacedAnn.add(row.id);
    const who = await authorName(row.author_id);
    show(
      `New alert from ${who}`,
      (row.body || "").slice(0, 180),
      `ann-${row.id}`,
      "announcements"
    );
  }

  function surfaceCoverage(row) {
    if (!row?.id || surfacedEdr.has(row.id)) return;
    surfacedEdr.add(row.id);
    const when = row.shift_time
      ? new Date(row.shift_time).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
      : "";
    const shifts = Array.isArray(row.shifts) && row.shifts.length ? ` (${row.shifts.join(", ")})` : "";
    const need = row.needed_count ? `${row.needed_count} driver${row.needed_count === 1 ? "" : "s"} needed` : "Coverage needed";
    show(
      "Coverage request",
      [when && `${when}${shifts}`, need, row.note].filter(Boolean).join(" — "),
      `edr-${row.id}`,
      "announcements"
    );
  }

  async function onAnnouncementInsert(row) {
    const user = DT_AUTH.getUser();
    if (!user || row.author_id === user.id) return;
    if (row.status && row.status !== "open") return;
    const created = new Date(row.created_at || Date.now()).getTime();
    if (created < sessionStart - 5000) return;
    await surfaceAnnouncement(row);
  }

  async function onCoverageInsert(row) {
    const user = DT_AUTH.getUser();
    if (!user || row.manager_id === user.id) return;
    if (row.status && row.status !== "open") return;
    const role = DT_AUTH.getProfile()?.role;
    if (role && row.position && row.position !== role) return;
    const created = new Date(row.created_at || Date.now()).getTime();
    if (created < sessionStart - 5000) return;
    surfaceCoverage(row);
  }

  // Fill any gap that opened while the WebSocket was asleep. Runs on
  // channel SUBSCRIBED (initial + reconnect) and on visibilitychange
  // → visible. Idempotent via surfaced* Sets.
  async function catchUp() {
    if (catchingUp) return;
    if (!isTargetRole()) return;
    const user = DT_AUTH.getUser();
    if (!user) return;
    catchingUp = true;
    const since = lastSeenAt;
    lastSeenAt = new Date().toISOString();
    try {
      const { data } = await sb.from("announcements")
        .select("*")
        .gt("created_at", since)
        .neq("author_id", user.id)
        .eq("status", "open")
        .order("created_at", { ascending: true });
      for (const row of (data || [])) await surfaceAnnouncement(row);
    } catch (err) {
      console.warn("[Notifications] catch-up announcements failed", err);
    }
    try {
      const role = DT_AUTH.getProfile()?.role;
      const { data } = await sb.from("extra_driver_requests")
        .select("*")
        .gt("created_at", since)
        .neq("manager_id", user.id)
        .eq("status", "open")
        .order("created_at", { ascending: true });
      for (const row of (data || [])) {
        if (role && row.position && row.position !== role) continue;
        surfaceCoverage(row);
      }
    } catch (err) {
      console.warn("[Notifications] catch-up coverage failed", err);
    }
    catchingUp = false;
  }

  function urlBase64ToUint8Array(base64) {
    const padding = "=".repeat((4 - base64.length % 4) % 4);
    const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function ensurePushSubscription() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const vapidKey = window.VAPID_PUBLIC_KEY;
    if (!vapidKey) return; // not configured yet
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey)
        });
      }
      const json = sub.toJSON();
      const user = DT_AUTH.getUser();
      const profile = DT_AUTH.getProfile();
      if (!user || !profile) return;
      await sb.from("push_subscriptions").upsert({
        endpoint: json.endpoint,
        user_id: user.id,
        role: profile.role,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        user_agent: navigator.userAgent,
        updated_at: new Date().toISOString()
      }, { onConflict: "endpoint" });
    } catch (err) {
      console.warn("[Notifications] push subscribe failed", err);
    }
  }

  function onVisibility() {
    if (document.visibilityState === "visible") catchUp();
  }

  async function start() {
    if (started) return;
    if (!isTargetRole()) return;
    // Claim the flag before the first await. Two dt-auth-change events
    // arriving while ensurePermission() was pending both cleared the guard
    // above, and the second subscribe() overwrote `chan` — orphaning the
    // first channel, which kept delivering and produced duplicate alerts.
    started = true;
    // Ask for native permission on platforms that support it, but don't
    // gate the Realtime subscription on the result — the #alertModal
    // fallback in show() handles WKWebView / denied-permission cases.
    try {
      await ensurePermission();
    } catch (err) {
      started = false;
      console.warn("[Notifications] permission check failed", err);
      return;
    }
    ensurePushSubscription();
    chan = sb.channel("dt-notifications")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "announcements" },
          (payload) => onAnnouncementInsert(payload.new || {}))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "extra_driver_requests" },
          (payload) => onCoverageInsert(payload.new || {}))
      .subscribe((status) => {
        // Runs on initial connect and every reconnect (e.g. after iOS
        // wakes the WebView) — fill any gap the socket missed.
        if (status === "SUBSCRIBED") catchUp();
      });
    document.addEventListener("visibilitychange", onVisibility);
  }

  function stop() {
    started = false;
    if (chan) { sb.removeChannel(chan); chan = null; }
    document.removeEventListener("visibilitychange", onVisibility);
  }

  navigator.serviceWorker?.addEventListener("message", (e) => {
    if (e.data?.type === "dt-show-tab" && typeof window.showTab === "function") {
      window.showTab(e.data.tab);
    }
  });

  document.addEventListener("dt-auth-change", () => {
    isTargetRole() ? start() : stop();
  });
  if (isTargetRole()) start();

  // -----------------------------------------------------------
  // In-app modal fallback (#alertModal in index.html). Lazy-wired
  // on first use; handlers idempotent so multiple opens don't stack.
  // -----------------------------------------------------------
  let modalRefs = null;
  let currentTab = null;

  function ensureModal() {
    if (modalRefs) return modalRefs;
    const modal = document.getElementById("alertModal");
    const titleEl = document.getElementById("alertModalTitle");
    const bodyEl = document.getElementById("alertModalBody");
    const closeBtn = document.getElementById("alertModalClose");
    const dismissBtn = document.getElementById("alertModalDismiss");
    const viewBtn = document.getElementById("alertModalView");
    if (!modal || !titleEl || !bodyEl || !closeBtn || !dismissBtn || !viewBtn) return null;

    const close = () => {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    };
    closeBtn.addEventListener("click", close);
    dismissBtn.addEventListener("click", close);
    viewBtn.addEventListener("click", () => {
      const tab = currentTab;
      close();
      if (tab && typeof window.showTab === "function") window.showTab(tab);
    });
    // Backdrop click intentionally does NOT dismiss — force an explicit action.

    modalRefs = { modal, titleEl, bodyEl, viewBtn, close };
    return modalRefs;
  }

  function openAlertModal(title, body, onClickTab) {
    const refs = ensureModal();
    if (!refs) return;
    refs.titleEl.textContent = title || "New alert";
    refs.bodyEl.textContent = body || "";
    currentTab = onClickTab || null;
    refs.viewBtn.style.display = currentTab ? "" : "none";
    refs.modal.classList.add("show");
    refs.modal.setAttribute("aria-hidden", "false");
    try { if (typeof haptic === "function") haptic("warn"); } catch {}
  }

  window.DT_NOTIFS = {
    test: () => show("DriverTrax test", "Notifications are working.", "test", "announcements"),
    testModal: () => openAlertModal("New alert from Test", "This is what an in-app alert looks like when native notifications aren't available.", "announcements"),
    catchUp,
    requestPermission: async () => {
      localStorage.removeItem(PERM_ASKED_KEY);
      const ok = await ensurePermission();
      if (ok) start();
      return ok;
    }
  };
})();
