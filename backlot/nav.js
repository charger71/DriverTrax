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
    comms: "Comms", reports: "Reports",
  };

  function showSection(name) {
    document.querySelectorAll(".bl-section").forEach((s) => {
      s.classList.toggle("is-active", s.id === "section-" + name);
    });
    document.querySelectorAll(".bl-nav-item").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.section === name);
    });
    const crumb = $("blCrumb");
    if (crumb) crumb.textContent = SECTION_LABELS[name] || name;
    document.dispatchEvent(new CustomEvent("bl-section-shown", { detail: name }));
  }
  window.BL_NAV = { show: showSection };

  function wireNav() {
    const nav = $("blNav");
    if (!nav) return;
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest(".bl-nav-item");
      if (!btn || !nav.contains(btn)) return;
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
