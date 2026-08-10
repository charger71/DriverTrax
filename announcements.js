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

  // The implementation lives in utils.js (DT_FORMAT.timeAgo). This wrapper
  // just supplies the alert phrasing — "Posted 5 min ago" — which is the
  // default everywhere in this module and for DT_ANN.timeAgo consumers.
  const timeAgo = (input, prefix = "Posted ") => DT_FORMAT.timeAgo(input, prefix);

  async function fetchProfileNames(ids) {
    const missing = [...new Set(ids)].filter(id => id && !profileCache.has(id));
    if (!missing.length) return;
    const { data } = await sb.from("profiles").select("id,display_name").in("id", missing);
    (data || []).forEach(p => profileCache.set(p.id, p.display_name || "(no name)"));
  }

  // ---------- thread renderer (shared) ----------
  // Fetching is separated from painting so a panel full of cards costs two
  // queries instead of two per card. renderDriverPanel used to call
  // renderThread() once per card — with 50 announcements that was 100
  // round-trips, and the minute-tick re-render fired the whole set again.
  async function fetchThreads(ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    const out = {};
    if (!wanted.length) return out;
    wanted.forEach(id => { out[id] = { reactions: [], replies: [] }; });

    const [{ data: reactions }, { data: replies }] = await Promise.all([
      sb.from("announcement_reactions").select("announcement_id,emoji,user_id").in("announcement_id", wanted),
      sb.from("announcement_replies").select("id,announcement_id,author_id,body,created_at")
        .in("announcement_id", wanted).order("created_at", { ascending: true })
    ]);
    (reactions || []).forEach(r => { if (out[r.announcement_id]) out[r.announcement_id].reactions.push(r); });
    (replies   || []).forEach(r => { if (out[r.announcement_id]) out[r.announcement_id].replies.push(r); });

    // One name lookup for every author and reactor across the whole batch.
    await fetchProfileNames([
      ...(replies   || []).map(r => r.author_id),
      ...(reactions || []).map(r => r.user_id)
    ]);
    return out;
  }

  // Paint one card from data already fetched. No queries.
  function paintThread(card, announcementId, thread) {
    if (!card || !announcementId || !thread) return;
    const user = DT_AUTH.getUser();
    if (!user) return;
    const reactions = thread.reactions || [];
    const replies = thread.replies || [];

    // Reactions row + names
    const reactionEl = card.querySelector(".ann-reactions");
    if (reactionEl) {
      const counts = {};
      const usersByEmoji = {};
      const mine = new Set();
      REACTION_EMOJIS.forEach(e => { counts[e] = 0; usersByEmoji[e] = []; });
      reactions.forEach(r => {
        if (counts[r.emoji] === undefined) { counts[r.emoji] = 0; usersByEmoji[r.emoji] = []; }
        counts[r.emoji]++;
        usersByEmoji[r.emoji].push(r.user_id);
        if (r.user_id === user.id) mine.add(r.emoji);
      });

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
      if (!replies.length) {
        listEl.innerHTML = "";
      } else {
        const canManage = DT_AUTH.isManager();
        listEl.innerHTML = replies.map(r => {
          const name = profileCache.get(r.author_id) || "Driver";
          const own = r.author_id === user.id;
          const delBtn = (own || canManage) ? `<button class="ann-reply-del" data-id="${r.id}">delete</button>` : "";
          return `
            <div class="ann-reply">
              <div class="ann-reply-meta"><b>${esc(name)}</b> · <span class="ann-time" data-ts="${esc(r.created_at)}">${esc(timeAgo(r.created_at, ""))}</span> ${delBtn}</div>
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
        if (error) { DT_TOAST.show(error.message || "Couldn't post that reply", "error"); return; }
        input.value = "";
        // Realtime will re-render; do a synchronous re-render too for snappier UX
        renderThread(card, announcementId);
      });
    }
  }

  // Single-card fetch + paint. Kept for callers outside this module
  // (DT_ANN.renderThread — the manager Backlot view renders one card at a
  // time) and for the post-action refreshes below.
  async function renderThread(card, announcementId) {
    if (!card || !announcementId) return;
    const threads = await fetchThreads([announcementId]);
    paintThread(card, announcementId, threads[announcementId]);
  }

  // Batched fetch + paint for a whole panel of cards.
  async function renderThreadsFor(cards) {
    const list = [...cards].filter(c => c.dataset.annId);
    if (!list.length) return;
    const threads = await fetchThreads(list.map(c => c.dataset.annId));
    list.forEach(c => paintThread(c, c.dataset.annId, threads[c.dataset.annId]));
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
      <span class="ann-time" data-ts="${esc(top.created_at)}">${esc(timeAgo(top.created_at))}</span>
      <span class="ann-body-text">${esc(top.body)}</span>`;
    banner.dataset.id = top.id;
    banner.classList.remove("hidden");
  }

  function renderBadge() {
    const n = unreadCount();
    const targets = [$("annUnreadBadge"), $("tabAlertsBadge"), $("tabAlertsDetBadge")];
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
      el.innerHTML = `<div class="u-empty">No alerts yet.</div>`;
      return;
    }
    const dismissed = getDismissed();
    el.innerHTML = announcements.map(a => {
      const author = profileCache.get(a.author_id) || "Manager";
      return `
      <div class="ann-card ${dismissed.has(a.id) ? "" : "unread"}" data-ann-id="${a.id}">
        <div class="meta">
          <span class="ann-author">${esc(author)}</span>
          <span class="ann-time" data-ts="${esc(a.created_at)}">${esc(timeAgo(a.created_at))}</span>
        </div>
        <div class="body">${esc(a.body)}</div>
      </div>
    `}).join("");
    const cards = el.querySelectorAll(".ann-card");
    cards.forEach(injectThreadMarkup);
    renderThreadsFor(cards);
  }

  // Relative times only. The minute tick used to call renderAll(), which
  // re-rendered every card and refetched every thread once a minute on every
  // signed-in device, panel visible or not — all to turn "4 min ago" into
  // "5 min ago". Rewriting the text nodes costs nothing and hits no network.
  function renderTimes() {
    document.querySelectorAll(".ann-time[data-ts]").forEach(el => {
      const ts = el.dataset.ts;
      if (!ts) return;
      // Replies render bare ("5 min ago"); banner and cards use the
      // "Posted 5 min ago" phrasing.
      const bare = !!el.closest(".ann-reply-meta");
      el.textContent = timeAgo(ts, bare ? "" : undefined);
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

  const life = DT_LIFECYCLE.create({
    // Registered once ever — see DT_LIFECYCLE in utils.js. These used to live
    // in start(), which stop() made re-runnable, so every profile-fetch blip
    // added another dt-refresh and dt-tab-shown handler. After N blips one
    // pull-to-refresh fired N parallel loads.
    wire() {
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
        if (e.detail !== "announcements" || !life.running) return;
        const d = getDismissed();
        announcements.forEach(a => d.add(a.id));
        setDismissed(d);
        renderAll();
      });
      // Refetch on pull-to-refresh (pull-refresh.js dispatches this).
      document.addEventListener("dt-refresh", () => {
        if (life.running) loadAnnouncementsForDriver();
      });
    },
    start() {
      loadAnnouncementsForDriver();
      realtimeChan = sb.channel("driver-announcements")
        .on("postgres_changes", { event: "*", schema: "public", table: "announcements" }, loadAnnouncementsForDriver)
        .subscribe();
      setupThreadRealtime();
      // Keep relative times fresh. Text only — no re-render, no refetch.
      if (timeTickInterval) clearInterval(timeTickInterval);
      timeTickInterval = setInterval(renderTimes, 60000);
    },
    stop() {
      if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
      teardownThreadRealtime();
      if (timeTickInterval) { clearInterval(timeTickInterval); timeTickInterval = null; }
      $("annBanner")?.classList.add("hidden");
      $("annUnreadBadge")?.classList.add("hidden");
      $("tabAlertsBadge")?.classList.add("hidden");
      $("tabAlertsDetBadge")?.classList.add("hidden");
      window.DT_PWA?.setBadgeSource?.("alerts", 0);
    }
  });

  function shouldRunDriverUI() {
    // Alerts go to everyone who's signed in, regardless of role.
    return !!DT_AUTH.getProfile();
  }

  document.addEventListener("dt-auth-change", () => life.set(shouldRunDriverUI()));
  life.set(shouldRunDriverUI());

  // ---------- shared realtime: refresh the affected card on reply/reaction change ----------
  function setupThreadRealtime() {
    if (threadChan) return;
    // Repaint only the announcement the payload names. This used to re-render
    // every card on screen for any reply or reaction anywhere, re-running the
    // per-card fetch across the whole panel.
    const refreshOne = (payload) => {
      const id = payload?.new?.announcement_id ?? payload?.old?.announcement_id;
      if (!id) return;
      document.querySelectorAll(`.ann-card[data-ann-id="${CSS.escape(String(id))}"]`)
        .forEach(card => renderThread(card, String(id)));
    };
    threadChan = sb.channel("ann-threads")
      .on("postgres_changes", { event: "*", schema: "public", table: "announcement_replies" },   refreshOne)
      .on("postgres_changes", { event: "*", schema: "public", table: "announcement_reactions" }, refreshOne)
      .subscribe();
  }

  function teardownThreadRealtime() {
    // stop() used to leave this subscribed after sign-out, still querying
    // with the old session.
    if (threadChan) { sb.removeChannel(threadChan); threadChan = null; }
  }

  // ---------- public API ----------
  window.DT_ANN = {
    REACTION_EMOJIS,
    renderThread,
    // Batched equivalent for a whole list of cards: two queries total rather
    // than two per card. Prefer it wherever more than one card is rendered
    // at once (the Backlot view still loops over renderThread).
    renderThreads: renderThreadsFor,
    injectThreadMarkup,
    timeAgo,
    renderTimes,
    reload: loadAnnouncementsForDriver
  };
})();
