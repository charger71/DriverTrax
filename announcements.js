// ============================================================
// DriverTrax Announcements
//   - Banner + read panel for drivers/CXRs
//   - Shared thread renderer (reactions + flat replies) used by
//     both the driver panel and the manager Backlot view
//   - Realtime: subscribes to announcement_replies + reactions
//     once, then re-renders every visible card on any change.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const DISMISSED_KEY = "drivertrax_announcements_dismissed";

  const REACTION_EMOJIS = ["👍", "✅", "👀", "🙋"];

  const $ = (id) => document.getElementById(id);
  const esc = window.DT_ESC;
  const profileCache = new Map(); // user_id -> display_name

  // Twitter-style relative time. Pass prefix:"" for "5 min ago", or omit
  // (defaults to "Posted ") for the alert phrasing "Posted 5 min ago".
  function timeAgo(input, prefix = "Posted ") {
    const d = (input instanceof Date) ? input : new Date(input);
    if (!d || isNaN(d.getTime())) return "";
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 5)  return "Just now";
    if (s < 60) return `${prefix}${s} sec ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${prefix}${m} min${m === 1 ? "" : "s"} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${prefix}${h} hour${h === 1 ? "" : "s"} ago`;
    const dd = Math.floor(h / 24);
    if (dd < 7) return `${prefix}${dd} day${dd === 1 ? "" : "s"} ago`;
    return `${prefix}${d.toLocaleDateString()}`;
  }

  async function fetchProfileNames(ids) {
    const missing = [...new Set(ids)].filter(id => id && !profileCache.has(id));
    if (!missing.length) return;
    const { data } = await sb.from("profiles").select("id,display_name").in("id", missing);
    (data || []).forEach(p => profileCache.set(p.id, p.display_name || "(no name)"));
  }

  // ---------- thread renderer (shared) ----------
  async function renderThread(card, announcementId) {
    if (!card || !announcementId) return;
    const user = DT_AUTH.getUser();
    if (!user) return;

    const [{ data: reactions }, { data: replies }] = await Promise.all([
      sb.from("announcement_reactions").select("emoji,user_id").eq("announcement_id", announcementId),
      sb.from("announcement_replies").select("id,author_id,body,created_at").eq("announcement_id", announcementId).order("created_at", { ascending: true })
    ]);

    await fetchProfileNames((replies || []).map(r => r.author_id));

    // Reactions row + names
    const reactionEl = card.querySelector(".ann-reactions");
    if (reactionEl) {
      const counts = {};
      const usersByEmoji = {};
      const mine = new Set();
      REACTION_EMOJIS.forEach(e => { counts[e] = 0; usersByEmoji[e] = []; });
      (reactions || []).forEach(r => {
        if (counts[r.emoji] === undefined) { counts[r.emoji] = 0; usersByEmoji[r.emoji] = []; }
        counts[r.emoji]++;
        usersByEmoji[r.emoji].push(r.user_id);
        if (r.user_id === user.id) mine.add(r.emoji);
      });

      // Make sure we have display names for everyone who reacted
      const allReactorIds = (reactions || []).map(r => r.user_id);
      await fetchProfileNames(allReactorIds);

      reactionEl.innerHTML = REACTION_EMOJIS.map(e => `
        <button type="button" class="ann-reaction ${mine.has(e) ? "mine" : ""}" data-emoji="${e}">
          <span class="emoji">${e}</span>
          <span class="count">${counts[e]}</span>
        </button>
      `).join("");

      // Names line below the badges — one segment per emoji that has reactors
      const namesLine = REACTION_EMOJIS
        .filter(e => usersByEmoji[e].length > 0)
        .map(e => {
          const names = usersByEmoji[e].map(uid => {
            if (uid === user.id) return "You";
            return profileCache.get(uid) || "Someone";
          }).join(", ");
          return `<span class="ann-reactor-group"><span class="emoji">${e}</span> ${esc(names)}</span>`;
        }).join("");
      const namesEl = card.querySelector(".ann-reactor-names");
      if (namesEl) namesEl.innerHTML = namesLine;

      reactionEl.querySelectorAll(".ann-reaction").forEach(b => {
        b.addEventListener("click", async () => {
          await toggleReaction(announcementId, b.dataset.emoji);
          renderThread(card, announcementId);
        });
      });
    }

    // Reply list
    const listEl = card.querySelector(".ann-reply-list");
    if (listEl) {
      if (!replies || !replies.length) {
        listEl.innerHTML = "";
      } else {
        const canManage = DT_AUTH.isManager();
        listEl.innerHTML = replies.map(r => {
          const name = profileCache.get(r.author_id) || "Driver";
          const own = r.author_id === user.id;
          const delBtn = (own || canManage) ? `<button class="ann-reply-del" data-id="${r.id}">delete</button>` : "";
          return `
            <div class="ann-reply">
              <div class="ann-reply-meta"><b>${esc(name)}</b> · ${esc(timeAgo(r.created_at, ""))} ${delBtn}</div>
              <div class="ann-reply-body">${esc(r.body)}</div>
            </div>
          `;
        }).join("");
        listEl.querySelectorAll(".ann-reply-del").forEach(b => {
          b.addEventListener("click", async () => {
            if (!confirm("Delete this reply?")) return;
            await sb.from("announcement_replies").delete().eq("id", b.dataset.id);
          });
        });
      }
    }

    // Reply form (attach once)
    const formEl = card.querySelector(".ann-reply-form");
    if (formEl && !formEl.dataset.wired) {
      formEl.dataset.wired = "1";
      formEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = formEl.querySelector("input[name=body]");
        const body = (input.value || "").trim();
        if (!body) return;
        input.disabled = true;
        const { error } = await sb.from("announcement_replies").insert({
          announcement_id: announcementId, author_id: user.id, body
        });
        input.disabled = false;
        if (error) { alert(error.message); return; }
        input.value = "";
        // Realtime will re-render; do a synchronous re-render too for snappier UX
        renderThread(card, announcementId);
      });
    }
  }

  async function toggleReaction(announcementId, emoji) {
    const user = DT_AUTH.getUser();
    if (!user) return;
    // Find an existing row; if present, delete it. Else insert.
    const { data: existing } = await sb
      .from("announcement_reactions")
      .select("id")
      .eq("announcement_id", announcementId)
      .eq("user_id", user.id)
      .eq("emoji", emoji)
      .maybeSingle();
    if (existing) {
      await sb.from("announcement_reactions").delete().eq("id", existing.id);
    } else {
      await sb.from("announcement_reactions").insert({ announcement_id: announcementId, user_id: user.id, emoji });
    }
  }

  // Build the markup inside a card. Caller (driver panel or manager view)
  // gives us an empty container; we inject reactions + reply list + reply form.
  function injectThreadMarkup(container) {
    container.insertAdjacentHTML("beforeend", `
      <div class="ann-reactions"></div>
      <div class="ann-reactor-names"></div>
      <div class="ann-thread">
        <div class="ann-reply-list"></div>
        <form class="ann-reply-form">
          <input type="text" name="body" placeholder="Reply…" maxlength="500" autocomplete="off">
          <button type="submit" class="btn btn-primary btn--sm">Send</button>
        </form>
      </div>
    `);
  }

  // ---------- driver banner + panel ----------
  let announcements = [];           // newest first
  let realtimeChan = null;
  let threadChan = null;
  let started = false;
  let timeTickInterval = null;

  function getDismissed() {
    try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]")); }
    catch { return new Set(); }
  }
  function setDismissed(set) { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set])); }

  function topUndismissed() {
    const dismissed = getDismissed();
    return announcements.find(a => !dismissed.has(a.id)) || null;
  }
  function unreadCount() {
    const dismissed = getDismissed();
    return announcements.filter(a => !dismissed.has(a.id)).length;
  }

  function renderBanner() {
    const banner = $("annBanner");
    const top = topUndismissed();
    if (!banner) return;
    if (!top) { banner.classList.add("hidden"); return; }
    const author = profileCache.get(top.author_id) || "Manager";
    $("annBannerBody").innerHTML = `
      <span class="ann-author">${esc(author)}</span>
      <span class="ann-time">${esc(timeAgo(top.created_at))}</span>
      <span class="ann-body-text">${esc(top.body)}</span>`;
    banner.dataset.id = top.id;
    banner.classList.remove("hidden");
  }

  function renderBadge() {
    const n = unreadCount();
    const targets = [$("annUnreadBadge"), $("tabAlertsBadge")];
    targets.forEach(el => {
      if (!el) return;
      if (n > 0) { el.textContent = n; el.classList.remove("hidden"); }
      else { el.classList.add("hidden"); }
    });
    window.DT_PWA?.setBadgeSource?.("alerts", n);
  }

  function renderDriverPanel() {
    const el = $("annDriverList");
    if (!el) return;
    if (!announcements.length) {
      el.innerHTML = `<div class="bl-empty">No alerts yet.</div>`;
      return;
    }
    const dismissed = getDismissed();
    el.innerHTML = announcements.map(a => {
      const author = profileCache.get(a.author_id) || "Manager";
      return `
      <div class="ann-card ${dismissed.has(a.id) ? "" : "unread"}" data-ann-id="${a.id}">
        <div class="meta">
          <span class="ann-author">${esc(author)}</span>
          <span class="ann-time">${esc(timeAgo(a.created_at))}</span>
        </div>
        <div class="body">${esc(a.body)}</div>
      </div>
    `}).join("");
    el.querySelectorAll(".ann-card").forEach(card => {
      injectThreadMarkup(card);
      renderThread(card, card.dataset.annId);
    });
  }

  function renderAll() { renderBanner(); renderBadge(); renderDriverPanel(); }

  async function loadAnnouncementsForDriver() {
    const { data, error } = await sb
      .from("announcements")
      .select("id,body,created_at,expires_at,author_id,status")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) { console.warn("[Announcements] load", error); return; }
    const now = Date.now();
    announcements = (data || []).filter(a => !a.expires_at || new Date(a.expires_at).getTime() > now);
    await fetchProfileNames(announcements.map(a => a.author_id));
    renderAll();
  }

  function start() {
    if (started) return;
    started = true;
    $("annBannerClose")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const banner = $("annBanner");
      const id = banner?.dataset.id;
      if (!id) return;
      const d = getDismissed(); d.add(id); setDismissed(d);
      renderAll();
    });
    // Tapping the banner body opens the Announcements panel
    $("annBanner")?.addEventListener("click", (e) => {
      if (e.target.closest("#annBannerClose")) return;
      if (typeof showTab === "function") showTab("announcements");
    });
    document.addEventListener("dt-tab-shown", (e) => {
      if (e.detail === "announcements") {
        const d = getDismissed();
        announcements.forEach(a => d.add(a.id));
        setDismissed(d);
        renderAll();
      }
    });
    loadAnnouncementsForDriver();
    realtimeChan = sb.channel("driver-announcements")
      .on("postgres_changes", { event: "*", schema: "public", table: "announcements" }, loadAnnouncementsForDriver)
      .subscribe();
    // Keep relative times ("5 min ago") fresh without re-fetching
    if (timeTickInterval) clearInterval(timeTickInterval);
    timeTickInterval = setInterval(renderAll, 60000);
  }

  function stop() {
    started = false;
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
    if (timeTickInterval) { clearInterval(timeTickInterval); timeTickInterval = null; }
    $("annBanner")?.classList.add("hidden");
    $("annUnreadBadge")?.classList.add("hidden");
    $("tabAlertsBadge")?.classList.add("hidden");
    window.DT_PWA?.setBadgeSource?.("alerts", 0);
  }

  function shouldRunDriverUI() {
    const p = DT_AUTH.getProfile();
    if (!p) return false;
    // Driver-style alerts UI is for drivers only. CXR + managers + admins use
    // the manager Alerts panel; detailers don't see alerts at all.
    return p.role === "driver";
  }

  document.addEventListener("dt-auth-change", () => { shouldRunDriverUI() ? start() : stop(); });
  if (shouldRunDriverUI()) start();

  // ---------- shared realtime: refresh every visible card on any reply/reaction change ----------
  function setupThreadRealtime() {
    if (threadChan) return;
    const refreshVisible = () => {
      document.querySelectorAll(".ann-card[data-ann-id]").forEach(card => {
        renderThread(card, card.dataset.annId);
      });
    };
    threadChan = sb.channel("ann-threads")
      .on("postgres_changes", { event: "*", schema: "public", table: "announcement_replies" },   refreshVisible)
      .on("postgres_changes", { event: "*", schema: "public", table: "announcement_reactions" }, refreshVisible)
      .subscribe();
  }
  document.addEventListener("dt-auth-change", () => { if (DT_AUTH.getUser()) setupThreadRealtime(); });
  if (DT_AUTH.getUser()) setupThreadRealtime();

  // ---------- public API ----------
  window.DT_ANN = {
    REACTION_EMOJIS,
    renderThread,
    injectThreadMarkup,
    timeAgo,
    reload: loadAnnouncementsForDriver
  };
  // Convenience shorthand for code outside this module
  window.dtTimeAgo = (input, prefix) => timeAgo(input, prefix === undefined ? "" : prefix);
})();
