// ============================================================
// Backlot — shell navigation & topbar
//
// Wires the sidebar/tab-bar section switching, the live clock, the
// signed-in avatar, and sign-out. Feature modules (dashboard, roster,
// …) listen for `bl-section-shown` to lazy-refresh when their section
// becomes visible.
// ============================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const SECTION_LABELS = {
    dashboard: "Dashboard", records: "Records", roster: "Roster", users: "Users",
    comms: "Comms", reports: "Reports", vin: "Vehicle history",
    "parking-sections": "Parking sections",
  };
  // Sections shown programmatically (not from the sidebar tab bar). These
  // don't take a highlighted nav item, and the crumb shows their label.
  const PROGRAMMATIC_SECTIONS = new Set(["vin"]);
  const DEFAULT_SECTION = "dashboard";

  let _currentSection = DEFAULT_SECTION;
  let _previousSection = null;

  function showSection(name) {
    if (name === _currentSection) return;
    // Track where we came from so the VIN page's Back button can pop back.
    // Only remember non-programmatic sections so double-Back doesn't ping-pong.
    if (!PROGRAMMATIC_SECTIONS.has(_currentSection)) _previousSection = _currentSection;
    _currentSection = name;

    document.querySelectorAll(".bl-section").forEach((s) => {
      s.classList.toggle("is-active", s.id === "section-" + name);
    });
    document.querySelectorAll(".bl-nav-item").forEach((b) => {
      // Programmatic sections don't map to a nav tab — clear the highlight.
      b.classList.toggle("is-active", !PROGRAMMATIC_SECTIONS.has(name) && b.dataset.section === name);
    });
    const crumb = $("blCrumb");
    if (crumb) crumb.textContent = SECTION_LABELS[name] || name;
    document.dispatchEvent(new CustomEvent("bl-section-shown", { detail: name }));
  }

  // Return to the section that was active before the current programmatic
  // section was pushed. Falls back to dashboard when there's nothing to pop.
  function back() {
    showSection(_previousSection || DEFAULT_SECTION);
  }

  window.BL_NAV = { show: showSection, back };

  function wireNav() {
    const nav = $("blNav");
    if (!nav) return;
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest(".bl-nav-item");
      if (!btn || !nav.contains(btn)) return;
      // Some nav items are <a target="_blank"> links to standalone pages
      // (e.g. parking sections tool). Those have no data-section — let the
      // browser follow the link and don't blank the current section.
      if (!btn.dataset.section) return;
      showSection(btn.dataset.section);
    });
  }

  function startClock() {
    const el = $("blClock");
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toLocaleString("en-US", {
        weekday: "short", hour: "numeric", minute: "2-digit",
        timeZone: (window.BL_FORMAT && BL_FORMAT.TZ) || "America/New_York",
      });
    };
    tick();
    setInterval(tick, 30000);
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "–";
    return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  function applyProfile() {
    const p = window.BL_AUTH && BL_AUTH.getProfile && BL_AUTH.getProfile();
    const av = $("blAvatar");
    if (av && p) { av.textContent = initials(p.display_name); av.title = p.display_name || "Signed in"; }
  }

  document.addEventListener("bl-auth-change", applyProfile);
  $("blSignOut")?.addEventListener("click", () => window.BL_AUTH && BL_AUTH.signOut());

  wireNav();
  startClock();
})();
