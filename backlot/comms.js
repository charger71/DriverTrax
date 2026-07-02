// ============================================================
// Backlot — Communications
//   Mounts into #section-comms.
//     • Announcements: broadcast composer + manage (close /
//       cancel / delete). Team sees them in DriverTrax.
//     • Extra-driver requests: post a shift request + manage
//       (mark filled / cancel / delete) with accepted responders.
//   Realtime + 30s poll. Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;

  let realtimeChan = null, pollTimer = null, started = false;
  // Client-side filter state; a re-render just re-filters the cached list.
  const annState = { search: "", status: "" };
  const edrState = { search: "", status: "" };
  let annCache = [], annNames = {};
  let edrCache = [], edrNames = {};

  async function resolveNames(ids, fallback) {
    const names = {};
    const list = [...new Set(ids.filter(Boolean))];
    if (list.length) {
      const { data } = await sb.from("profiles").select("id,display_name").in("id", list);
      (data || []).forEach((p) => { names[p.id] = p.display_name || fallback; });
    }
    return names;
  }

  // ---------------- announcements ----------------
  async function loadAnnouncements() {
    const el = $("blAnnList");
    if (!el) return;
    const { data, error } = await sb.from("announcements")
      .select("*, announcement_replies(id,author_id,body,created_at)")
      .order("created_at", { ascending: false }).limit(80);
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }

    annCache = data || [];
    const replyAuthorIds = annCache.flatMap((a) => (a.announcement_replies || []).map((r) => r.author_id));
    annNames = await resolveNames([...annCache.map((a) => a.author_id), ...replyAuthorIds], "Team member");
    renderAnnouncements();
  }

  function renderAnnouncements() {
    const el = $("blAnnList");
    if (!el) return;
    const term = annState.search.trim().toLowerCase();
    const status = annState.status;
    const filtered = annCache.filter((a) => {
      const s = a.status || "open";
      if (status && s !== status) return false;
      if (!term) return true;
      const bodyHit = (a.body || "").toLowerCase().includes(term);
      const authorHit = (annNames[a.author_id] || "").toLowerCase().includes(term);
      return bodyHit || authorHit;
    });

    if (!filtered.length) {
      el.innerHTML = `<div class="bl-empty">${annCache.length ? "No announcements match these filters." : "No announcements yet."}</div>`;
      return;
    }

    el.innerHTML = filtered.map((a) => {
      const status = a.status || "open";
      const isArchived = status !== "open";
      const actions = isArchived
        ? `<button class="bl-btn bl-btn--sm bl-btn--danger" data-ann-del="${a.id}">Delete</button>`
        : `<button class="bl-btn bl-btn--sm" data-ann-close="${a.id}">Close</button>
           <button class="bl-btn bl-btn--sm" data-ann-cancel="${a.id}">Cancel</button>
           <button class="bl-btn bl-btn--sm bl-btn--danger" data-ann-del="${a.id}">Delete</button>`;
      const replies = (a.announcement_replies || []).slice().sort((x, y) => (x.created_at || "").localeCompare(y.created_at || ""));
      const repliesHtml = replies.length
        ? `<details class="bl-disclosure"><summary>Replies (${replies.length})</summary>
            <div class="bl-replies">${replies.map((r) => `
              <div class="bl-reply">
                <span class="bl-reply-author">${esc(annNames[r.author_id] || "Team member")}</span>
                <span class="bl-reply-body">${esc(r.body || "")}</span>
                <span class="bl-reply-time">${esc(fmt.timeAgo(r.created_at))}</span>
              </div>`).join("")}</div>
           </details>`
        : `<div class="meta">No replies yet.</div>`;
      return `<div class="bl-comms-item">
        <div class="body">${esc(a.body || "")}</div>
        <div class="row">
          <span class="meta">Posted ${esc(fmt.timeAgo(a.created_at))} by ${esc(annNames[a.author_id] || "Manager")}</span>
          <span class="bl-status status-${esc(status)}">${esc(status)}</span>
        </div>
        ${repliesHtml}
        <div class="bl-comms-actions">${actions}</div>
      </div>`;
    }).join("");
  }

  function onAnnClick(e) {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.annClose)  return setAnnStatus(t.dataset.annClose, "closed");
    if (t.dataset.annCancel) return setAnnStatus(t.dataset.annCancel, "cancelled");
    if (t.dataset.annDel)    return delAnn(t.dataset.annDel);
  }
  async function setAnnStatus(id, status) {
    if (!confirm(`${status === "closed" ? "Close" : "Cancel"} this announcement?`)) return;
    const { error } = await sb.from("announcements").update({ status }).eq("id", id);
    if (error) { BL_TOAST.error(error.message); return; }
    loadAnnouncements();
  }
  async function delAnn(id) {
    if (!confirm("Delete this announcement? Replies and reactions go too.")) return;
    const { error } = await sb.from("announcements").delete().eq("id", id);
    if (error) { BL_TOAST.error(error.message); return; }
    loadAnnouncements();
  }
  async function onAnnSubmit(e) {
    e.preventDefault();
    const body = (new FormData(e.target).get("body") || "").trim();
    if (!body) return;
    const user = BL_AUTH.getUser();
    const { error } = await sb.from("announcements").insert({ author_id: user.id, body });
    if (error) { BL_TOAST.error(error.message); return; }
    e.target.reset();
    BL_TOAST.success("Broadcast sent.");
    loadAnnouncements();
  }

  // ---------------- extra-driver requests ----------------
  const POSITION_LABEL = { driver: "Driver", detailer: "Detailer", cxr: "CXR" };

  async function loadEdr() {
    const el = $("blEdrList");
    if (!el) return;
    const { data, error } = await sb.from("extra_driver_requests")
      .select("*, extra_driver_responses(response,driver_id,shifts,created_at)")
      .order("created_at", { ascending: false }).limit(40);
    if (error) { el.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }

    edrCache = data || [];
    const driverIds = edrCache.flatMap((r) => (r.extra_driver_responses || []).map((x) => x.driver_id));
    edrNames = await resolveNames(driverIds, "Driver");
    renderEdr();
  }

  function renderEdr() {
    const el = $("blEdrList");
    if (!el) return;
    const term = edrState.search.trim().toLowerCase();
    const status = edrState.status;
    const filtered = edrCache.filter((r) => {
      if (status && r.status !== status) return false;
      if (!term) return true;
      const noteHit = (r.note || "").toLowerCase().includes(term);
      const driverHit = (r.extra_driver_responses || []).some((x) => (edrNames[x.driver_id] || "").toLowerCase().includes(term));
      return noteHit || driverHit;
    });
    if (!filtered.length) {
      el.innerHTML = `<div class="bl-empty">${edrCache.length ? "No requests match these filters." : "No requests yet."}</div>`;
      return;
    }
    el.innerHTML = filtered.map((r) => {
      const isArchived = r.status !== "open";
      const responses = r.extra_driver_responses || [];
      const accepted = responses.filter((x) => x.response === "yes")
        .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
      const declined = responses.filter((x) => x.response === "no").length;
      const when = new Date(r.shift_time).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: fmt.TZ });
      const tags = (r.shifts || []).map((s) => `<span class="bl-shift-tag">${esc(s)}</span>`).join("");
      const pos = POSITION_LABEL[r.position] || "Driver";
      const acceptedHtml = accepted.length
        ? `<div class="bl-accepted">${accepted.map((a) => esc(edrNames[a.driver_id] || "Driver")).join(" · ")}</div>` : "";
      const actions = isArchived
        ? `<button class="bl-btn bl-btn--sm bl-btn--danger" data-edr-del="${r.id}">Delete</button>`
        : `<button class="bl-btn bl-btn--sm" data-edr-fill="${r.id}">Mark filled</button>
           <button class="bl-btn bl-btn--sm" data-edr-cancel="${r.id}">Cancel</button>
           <button class="bl-btn bl-btn--sm bl-btn--danger" data-edr-del="${r.id}">Delete</button>`;
      return `<div class="bl-comms-item">
        <div class="row">
          <b>${esc(when)}</b>
          <span class="bl-status status-${esc(r.status)}">${esc(r.status)}</span>
        </div>
        <div class="bl-shift-tags">${tags}</div>
        <div class="meta">${r.needed_count} ${esc(pos)}${r.needed_count === 1 ? "" : "s"} needed${r.note ? " · " + esc(r.note) : ""}</div>
        <div class="meta">${accepted.length} accepted · ${declined} declined</div>
        ${acceptedHtml}
        <div class="bl-comms-actions">${actions}</div>
      </div>`;
    }).join("");
  }

  function onEdrClick(e) {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.edrFill)   return setEdrStatus(t.dataset.edrFill, "filled");
    if (t.dataset.edrCancel) return setEdrStatus(t.dataset.edrCancel, "cancelled");
    if (t.dataset.edrDel)    return delEdr(t.dataset.edrDel);
  }
  async function setEdrStatus(id, status) {
    if (!confirm(`${status === "filled" ? "Mark filled" : "Cancel"} this request?`)) return;
    const { error } = await sb.from("extra_driver_requests").update({ status }).eq("id", id);
    if (error) { BL_TOAST.error(error.message); return; }
    loadEdr();
  }
  async function delEdr(id) {
    if (!confirm("Delete this request? This removes the record of who responded.")) return;
    const { error } = await sb.from("extra_driver_requests").delete().eq("id", id);
    if (error) { BL_TOAST.error(error.message); return; }
    loadEdr();
  }
  async function onEdrSubmit(e) {
    e.preventDefault();
    if (BL_AUTH.isCxr()) { BL_TOAST.warn("CXR users can't post shift requests."); return; }
    const fd = new FormData(e.target);
    const shifts = fd.getAll("shifts");
    if (!shifts.length) { BL_TOAST.warn("Pick at least one shift (AM / MID / PM)."); return; }
    const dateStr = fd.get("shift_date");
    if (!dateStr) { BL_TOAST.warn("Pick a shift date."); return; }
    const shiftDate = new Date(dateStr + "T00:00:00");
    const user = BL_AUTH.getUser();
    const { error } = await sb.from("extra_driver_requests").insert({
      manager_id: user.id,
      shift_time: shiftDate.toISOString(),
      needed_count: parseInt(fd.get("needed_count"), 10) || 1,
      shifts,
      position: fd.get("position") || "driver",
      note: (fd.get("note") || "").trim() || null,
    });
    if (error) { BL_TOAST.error(error.message); return; }
    e.target.reset();
    BL_TOAST.success("Request posted.");
    loadEdr();
  }

  function applyCxrLimits() {
    // CXR can broadcast but not request extra drivers.
    const form = $("blEdrForm");
    if (form && BL_AUTH.isCxr()) {
      form.querySelectorAll("input,select,button,textarea").forEach((c) => { c.disabled = true; });
      if (!form.dataset.note) {
        form.dataset.note = "1";
        form.insertAdjacentHTML("beforebegin", `<div class="bl-empty">Only managers can post extra-driver requests.</div>`);
      }
    }
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  const debounceCache = {};
  function debouncedRender(kind) {
    if (debounceCache[kind]) return debounceCache[kind];
    const state = kind === "ann" ? annState : edrState;
    const inputId = kind === "ann" ? "blAnnSearch" : "blEdrSearch";
    const rerender = kind === "ann" ? renderAnnouncements : renderEdr;
    debounceCache[kind] = debounce(() => { state.search = $(inputId)?.value || ""; rerender(); }, 200);
    return debounceCache[kind];
  }
  function onChipClick(e, state, containerId, rerender) {
    const btn = e.target.closest(".bl-chip-btn");
    if (!btn) return;
    state.status = btn.dataset.status || "";
    const container = $(containerId);
    container?.querySelectorAll(".bl-chip-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    rerender();
  }

  function refreshAll() { loadAnnouncements(); loadEdr(); }

  function start() {
    if (started) return;
    started = true;
    $("blAnnList")?.addEventListener("click", onAnnClick);
    $("blEdrList")?.addEventListener("click", onEdrClick);
    $("blAnnForm")?.addEventListener("submit", onAnnSubmit);
    $("blEdrForm")?.addEventListener("submit", onEdrSubmit);
    // Client-side filter controls — cheap re-render, no re-fetch.
    $("blAnnSearch")?.addEventListener("input", debouncedRender("ann"));
    $("blEdrSearch")?.addEventListener("input", debouncedRender("edr"));
    $("blAnnStatusChips")?.addEventListener("click", (e) => onChipClick(e, annState, "blAnnStatusChips", renderAnnouncements));
    $("blEdrStatusChips")?.addEventListener("click", (e) => onChipClick(e, edrState, "blEdrStatusChips", renderEdr));
    applyCxrLimits();
    refreshAll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshAll, 30000);
    realtimeChan = sb.channel("backlot-comms")
      .on("postgres_changes", { event: "*", schema: "public", table: "announcements" }, loadAnnouncements)
      .on("postgres_changes", { event: "*", schema: "public", table: "announcement_replies" }, loadAnnouncements)
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_requests" }, loadEdr)
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_responses" }, loadEdr)
      .subscribe();
  }

  function stop() {
    started = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
  }

  document.addEventListener("bl-auth-change", () => { if (BL_AUTH.canEnter()) start(); else stop(); });
  if (BL_AUTH.canEnter()) start();
  document.addEventListener("bl-section-shown", (e) => { if (e.detail === "comms" && started) refreshAll(); });

  window.BL_COMMS = { refresh: refreshAll };
})();
