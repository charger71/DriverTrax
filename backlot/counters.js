// ============================================================
// Backlot — shift-close counters calendar
//   Mounts into #section-counters. Reads counter_snapshots (one
//   row per driver-app Share) and renders a month grid with per-
//   section chips per day. Tap a day → per-snapshot detail modal.
//
// Data model (counter_snapshots):
//   section    text  garage | bcounter | keyup
//   categories jsonb [{name, count}, ...] in order at share time
//   total      int
//   notes      text | null
//   local_date date  EST calendar date used for grouping
//   created_at timestamptz
//   created_by uuid
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;

  const SECTIONS = ["garage", "bcounter", "keyup"];
  const SECTION_LABEL = { garage: "Garage", bcounter: "Backlot", keyup: "Key Up" };
  const SECTION_SHORT = { garage: "G", bcounter: "B", keyup: "K" };
  const TZ = fmt.TZ;

  // View state.
  let cursor = firstOfMonth(new Date());  // first-of-month in EST
  let filter = "all";                     // "all" | section
  let cache = new Map();                  // "YYYY-MM" -> rows[]
  let profiles = new Map();               // uuid -> display_name
  let started = false;
  let realtime = null;
  let lastLoadError = null;

  // ---- date helpers (all EST-anchored) ------------------------
  // Turn "any Date" into the first day of its EST month.
  function firstOfMonth(d) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit"
    }).formatToParts(d);
    const y = +parts.find(p => p.type === "year").value;
    const m = +parts.find(p => p.type === "month").value;
    return new Date(Date.UTC(y, m - 1, 1));
  }
  function addMonths(d, delta) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + delta;
    return new Date(Date.UTC(y, m, 1));
  }
  function ymd(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
  function todayLocalYmd() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === "year").value;
    const m = parts.find(p => p.type === "month").value;
    const dd = parts.find(p => p.type === "day").value;
    return `${y}-${m}-${dd}`;
  }
  function monthLabel(d) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", month: "long", year: "numeric"
    }).format(d);
  }
  // Build the 6-week (42 cell) grid for the visible month, using EST calendar.
  function buildCells(monthStart) {
    const y = monthStart.getUTCFullYear();
    const m = monthStart.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const firstDay = new Date(Date.UTC(y, m, 1));
    const startWeekday = firstDay.getUTCDay(); // 0=Sun
    const cells = [];
    for (let i = 0; i < startWeekday; i++) {
      const d = new Date(Date.UTC(y, m, 1 - (startWeekday - i)));
      cells.push({ date: d, ymd: ymd(d), outside: true });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(Date.UTC(y, m, day));
      cells.push({ date: d, ymd: ymd(d), outside: false });
    }
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1].date;
      const next = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() + 1));
      cells.push({ date: next, ymd: ymd(next), outside: true });
    }
    // Extend to 6 weeks so grid height doesn't jump between months.
    while (cells.length < 42) {
      const last = cells[cells.length - 1].date;
      const next = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() + 1));
      cells.push({ date: next, ymd: ymd(next), outside: true });
    }
    return cells;
  }

  // Map a Supabase/PostgREST error to a specific, action-oriented message.
  // Falls back to the raw text so the toast is never a blank generic.
  function diagnoseLoadError(error) {
    const code = error && (error.code || "");
    const msg  = String(error && (error.message || error.hint || "")).toLowerCase();
    if (code === "42P01" || msg.includes("does not exist") || msg.includes("counter_snapshots")) {
      return "Table counter_snapshots not found — apply counter-snapshots-schema.sql in Supabase.";
    }
    if (error && (error.status === 401 || error.status === 403)) {
      return "Not signed in as a manager — check your session.";
    }
    if (msg.includes("failed to fetch") || msg.includes("networkerror")) {
      return "Couldn't reach Supabase — check your connection.";
    }
    return "Couldn't load counters: " + (error.message || "unknown error");
  }

  // ---- data --------------------------------------------------
  async function loadMonth(monthStart, { force = false } = {}) {
    const key = monthLabel(monthStart);
    if (cache.has(key) && !force) return cache.get(key);
    // Cover the full displayed grid, which can spill into the prior/next month.
    const cells = buildCells(monthStart);
    const from = cells[0].ymd;
    const to   = cells[cells.length - 1].ymd;
    const { data, error } = await sb.from("counter_snapshots")
      .select("id, section, categories, total, notes, local_date, created_at, created_by")
      .gte("local_date", from)
      .lte("local_date", to)
      .order("created_at", { ascending: false });
    if (error) {
      // Full detail to the console so ops can copy the exact PostgREST reply.
      console.warn("[counters] load failed", {
        code: error.code, status: error.status, message: error.message,
        details: error.details, hint: error.hint
      });
      BL_TOAST.error(diagnoseLoadError(error));
      cache.set(key, []);
      lastLoadError = error;
      return [];
    }
    lastLoadError = null;
    cache.set(key, data || []);
    // Warm the profile cache so the modal can show "shared by" names.
    const userIds = [...new Set((data || []).map(r => r.created_by).filter(Boolean))];
    await warmProfiles(userIds);
    return data || [];
  }

  async function warmProfiles(ids) {
    const missing = ids.filter(id => !profiles.has(id));
    if (missing.length === 0) return;
    const { data, error } = await sb.from("profiles")
      .select("id, display_name")
      .in("id", missing);
    if (error) { console.warn("[counters] profiles", error); return; }
    (data || []).forEach(p => profiles.set(p.id, p.display_name || ""));
  }

  // Group rows by local_date and, within a day, by section.
  function indexByDay(rows) {
    const byDay = new Map();
    rows.forEach(r => {
      if (filter !== "all" && r.section !== filter) return;
      let bucket = byDay.get(r.local_date);
      if (!bucket) { bucket = {}; byDay.set(r.local_date, bucket); }
      // For chip counts we sum totals per section on the day.
      const s = r.section;
      if (!bucket[s]) bucket[s] = { total: 0, count: 0, latest: null };
      bucket[s].total += r.total || 0;
      bucket[s].count += 1;
      if (!bucket[s].latest || r.created_at > bucket[s].latest) bucket[s].latest = r.created_at;
    });
    return byDay;
  }

  // ---- render -------------------------------------------------
  function renderMonth(rows) {
    $("blCounterMonth").textContent = monthLabel(cursor);
    const cells = buildCells(cursor);
    const byDay = indexByDay(rows);
    const todayY = todayLocalYmd();

    const grid = $("blCounterGrid");
    const html = cells.map(cell => {
      const dayNum = cell.date.getUTCDate();
      const isToday = cell.ymd === todayY;
      const bucket = byDay.get(cell.ymd);
      const hasData = bucket && Object.keys(bucket).length > 0;
      const cls = [
        "bl-counter-day",
        cell.outside ? "is-outside" : "",
        isToday ? "is-today" : "",
        !cell.outside && !hasData ? "is-empty" : ""
      ].filter(Boolean).join(" ");
      const chips = hasData ? SECTIONS.filter(s => bucket[s]).map(s =>
        `<span class="bl-counter-chip bl-counter-chip--${s}">${SECTION_SHORT[s]}:${bucket[s].total}</span>`
      ).join("") : "";
      const clickable = !cell.outside;
      return `
        <${clickable ? "button" : "div"}
          class="${cls}"
          ${clickable ? `type="button" data-day="${cell.ymd}" aria-label="Snapshots for ${cell.ymd}"` : ""}>
          <span class="bl-counter-daynum">${dayNum}</span>
          <div class="bl-counter-chips">${chips}</div>
        </${clickable ? "button" : "div"}>`;
    }).join("");
    grid.innerHTML = html;

    const total = rows.filter(r => filter === "all" || r.section === filter).length;
    const sub = $("blCounterSub");
    if (lastLoadError) {
      sub.textContent = diagnoseLoadError(lastLoadError);
    } else if (total) {
      sub.textContent = `${total} snapshot${total === 1 ? "" : "s"} this month`;
    } else {
      sub.textContent = "No snapshots yet this month — driver-app shares appear here.";
    }
  }

  async function refresh({ force = false } = {}) {
    const rows = await loadMonth(cursor, { force });
    renderMonth(rows);
  }

  // ---- day detail modal --------------------------------------
  function openDay(ymdKey) {
    const rows = (cache.get(monthLabel(cursor)) || [])
      .filter(r => r.local_date === ymdKey)
      .filter(r => filter === "all" || r.section === filter)
      .sort((a, b) => {
        // group by section, newest first within a section
        if (a.section !== b.section) return SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section);
        return b.created_at.localeCompare(a.created_at);
      });
    const title = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric"
    }).format(new Date(ymdKey + "T00:00:00Z"));
    $("blCounterModalTitle").textContent = title;
    const body = $("blCounterModalBody");
    if (rows.length === 0) {
      body.innerHTML = `<div class="bl-empty">No snapshots on this day for the current filter.</div>`;
    } else {
      const canDelete = BL_AUTH.isManager?.() || BL_AUTH.isAdmin?.();
      body.innerHTML = rows.map(r => renderSnapshot(r, canDelete)).join("");
    }
    const modal = $("blCounterModal");
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }

  function renderSnapshot(r, canDelete) {
    const who = profiles.get(r.created_by) || "Unknown";
    const time = fmt.time(r.created_at);
    const cats = Array.isArray(r.categories) ? r.categories : [];
    const catsHtml = cats.map(c =>
      `<div class="bl-counter-snap-cat"><span>${esc(c.name)}</span><b>${Number(c.count) || 0}</b></div>`
    ).join("");
    const notes = r.notes && r.notes.trim()
      ? `<div class="bl-counter-snap-notes">${esc(r.notes)}</div>` : "";
    const delBtn = canDelete
      ? `<div class="bl-counter-snap-actions">
           <button type="button" class="bl-btn bl-btn--sm bl-btn--destructive"
                   data-del-snap="${esc(r.id)}">
             <svg class="bl-icon bl-icon--sm" aria-hidden="true"><use href="#icon-trash"/></svg>Delete
           </button>
         </div>` : "";
    return `
      <div class="bl-counter-snap" data-snap-id="${esc(r.id)}">
        <div class="bl-counter-snap-head">
          <b>${esc(SECTION_LABEL[r.section] || r.section)}</b>
          <span class="who">${esc(time)} · ${esc(who)}</span>
          <span class="total">${Number(r.total) || 0}</span>
        </div>
        <div class="bl-counter-snap-cats">${catsHtml}</div>
        ${notes}
        ${delBtn}
      </div>`;
  }

  function closeModal() {
    const modal = $("blCounterModal");
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
  }

  async function deleteSnapshot(id) {
    if (!confirm("Delete this snapshot? This cannot be undone.")) return;
    const { error } = await sb.from("counter_snapshots").delete().eq("id", id);
    if (error) {
      console.warn("[counters] delete", error);
      BL_TOAST.error("Delete failed — you may not have permission.");
      return;
    }
    BL_TOAST.success("Snapshot deleted");
    // Drop from cache and re-render.
    cache.forEach((rows, key) => cache.set(key, rows.filter(r => r.id !== id)));
    const rows = cache.get(monthLabel(cursor)) || [];
    renderMonth(rows);
    // Refresh modal contents if it's still open on the same day.
    const modal = $("blCounterModal");
    if (modal.classList.contains("is-open")) {
      const dayTitle = $("blCounterModalTitle").textContent;
      const cell = document.querySelector(`.bl-counter-day[data-day]`);
      // Simpler: close the modal — user can reopen the day if they want.
      closeModal();
    }
  }

  // ---- realtime -----------------------------------------------
  function subscribeRealtime() {
    if (realtime) return;
    realtime = sb.channel("counter_snapshots-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "counter_snapshots" }, () => {
        // Cheapest correct behavior: invalidate the visible month and refetch.
        cache.delete(monthLabel(cursor));
        refresh({ force: true });
      })
      .subscribe();
  }
  function unsubscribeRealtime() {
    if (!realtime) return;
    try { sb.removeChannel(realtime); } catch (_) {}
    realtime = null;
  }

  // ---- events -------------------------------------------------
  function wire() {
    $("blCounterPrev").addEventListener("click", () => { cursor = addMonths(cursor, -1); refresh(); });
    $("blCounterNext").addEventListener("click", () => { cursor = addMonths(cursor, 1); refresh(); });
    $("blCounterToday").addEventListener("click", () => { cursor = firstOfMonth(new Date()); refresh(); });
    $("blCounterRefresh").addEventListener("click", () => refresh({ force: true }));

    const seg = document.querySelector("#section-counters .bl-counter-filters");
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest(".bl-seg-btn");
      if (!btn) return;
      filter = btn.dataset.section;
      seg.querySelectorAll(".bl-seg-btn").forEach(b => b.classList.toggle("is-active", b === btn));
      const rows = cache.get(monthLabel(cursor)) || [];
      renderMonth(rows);
    });

    $("blCounterGrid").addEventListener("click", (e) => {
      const day = e.target.closest("[data-day]");
      if (day) openDay(day.getAttribute("data-day"));
    });

    $("blCounterModalClose").addEventListener("click", closeModal);
    $("blCounterModal").addEventListener("click", (e) => {
      if (e.target === $("blCounterModal")) closeModal();
      const del = e.target.closest("[data-del-snap]");
      if (del) deleteSnapshot(del.getAttribute("data-del-snap"));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("blCounterModal").classList.contains("is-open")) closeModal();
    });
  }

  async function start() {
    if (started) return;
    started = true;
    wire();
    await refresh();
    subscribeRealtime();
  }

  document.addEventListener("bl-section-shown", (e) => {
    if (e.detail === "counters") start();
  });
  // Idle-tear-down if the user navigates away for a while — cheap, but keeps
  // the realtime channel free when the section is inactive.
  document.addEventListener("bl-section-shown", (e) => {
    if (e.detail !== "counters") unsubscribeRealtime();
  });
})();
