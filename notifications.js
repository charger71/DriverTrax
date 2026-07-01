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
  let chan = null;
  let started = false;

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
      // WKWebView wrapper, denied permission, or unsupported browser — surface it in-app.
      if (window.DT_TOAST) {
        const msg = body ? `${title} — ${body}` : title;
        DT_TOAST.show(msg.slice(0, 200), "success");
      }
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

  async function onAnnouncementInsert(row) {
    const user = DT_AUTH.getUser();
    if (!user || row.author_id === user.id) return;
    if (row.status && row.status !== "open") return;
    const created = new Date(row.created_at || Date.now()).getTime();
    if (created < sessionStart - 5000) return;
    const who = await authorName(row.author_id);
    show(
      `New alert from ${who}`,
      (row.body || "").slice(0, 180),
      `ann-${row.id}`,
      "announcements"
    );
  }

  async function onCoverageInsert(row) {
    const user = DT_AUTH.getUser();
    if (!user || row.manager_id === user.id) return;
    if (row.status && row.status !== "open") return;
    const role = DT_AUTH.getProfile()?.role;
    if (role && row.position && row.position !== role) return;
    const created = new Date(row.created_at || Date.now()).getTime();
    if (created < sessionStart - 5000) return;
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

  async function start() {
    if (started) return;
    if (!isTargetRole()) return;
    // Ask for native permission on platforms that support it, but don't
    // gate the Realtime subscription on the result — show() falls back
    // to an in-app toast when native notifications aren't available.
    await ensurePermission();
    started = true;
    ensurePushSubscription();
    chan = sb.channel("dt-notifications")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "announcements" },
          (payload) => onAnnouncementInsert(payload.new || {}))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "extra_driver_requests" },
          (payload) => onCoverageInsert(payload.new || {}))
      .subscribe();
  }

  function stop() {
    started = false;
    if (chan) { sb.removeChannel(chan); chan = null; }
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

  window.DT_NOTIFS = {
    test: () => show("DriverTrax test", "Notifications are working.", "test", "announcements"),
    requestPermission: async () => {
      localStorage.removeItem(PERM_ASKED_KEY);
      const ok = await ensurePermission();
      if (ok) start();
      return ok;
    }
  };
})();
