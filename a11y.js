/*
 * a11y.js — keyboard & ARIA retrofit for click-handler divs and overlays.
 *
 * The app uses many <div onclick=...> elements (tabs, tire-btn,
 * stat-card, map-legend-row, etc.). Divs are unreachable by keyboard and have
 * no announced role, so this module:
 *   1. Marks every clickable non-button/-link element with role="button" and
 *      tabindex="0" (skips elements that already have a focusable role).
 *   2. Installs a delegated keydown handler so Enter / Space activate them.
 *   3. Adds Escape-to-close for the four full-screen overlays (detail, record
 *      detail, note detail, vin keypad, scanner, slide menu).
 *   4. Re-scans on DOM mutation so dynamically rendered cards (records, map
 *      legend rows, dashboard tiles) are covered without each renderer
 *      having to remember.
 */
(function () {
  "use strict";

  const FOCUSABLE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL"]);

  function makeKeyboardAccessible(el) {
    if (!el || el.dataset.a11yKb === "1") return;
    if (FOCUSABLE_TAGS.has(el.tagName)) return;
    if (el.getAttribute("role") === "button") {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
      el.dataset.a11yKb = "1";
      return;
    }
    el.setAttribute("role", "button");
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    el.dataset.a11yKb = "1";
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    // Inline onclick attribute
    scope.querySelectorAll("[onclick]").forEach(makeKeyboardAccessible);
    // Class-based clickables that wire handlers via JS (records, legend rows, etc.)
    scope.querySelectorAll(
      ".record, .map-legend-row, .stat-card.clickable, .quiz-author-item, " +
      ".quiz-recent-row, .day-table tr.has-entries, .training-list-item.clickable"
    ).forEach(makeKeyboardAccessible);
  }

  // Enter / Space activation for role=button elements that aren't real buttons.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const t = e.target;
    if (!t || FOCUSABLE_TAGS.has(t.tagName)) return;
    if (t.getAttribute("role") !== "button") return;
    e.preventDefault();
    t.click();
  });

  // Escape closes the topmost open overlay.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    // Order matters: check nested/most-recent first.
    if (document.getElementById("vinKeypadOverlay")?.classList.contains("open")) {
      window.closeVinKeypad?.(); return;
    }
    if (document.querySelector(".scanner-overlay.open")) {
      window.closeScanner?.(); return;
    }
    if (document.getElementById("recordDetailOverlay")?.classList.contains("open")) {
      window.closeRecordDetailOverlay?.(); return;
    }
    if (document.querySelector(".detail-overlay.open")) {
      window.closeDetail?.(); return;
    }
    if (document.querySelector(".slide-menu.open")) {
      window.closeMenu?.(); return;
    }
    // In-app alert modal (notifications.js fallback for WKWebView / denied perms).
    if (document.getElementById("alertModal")?.classList.contains("show")) {
      document.getElementById("alertModalDismiss")?.click();
      return;
    }
    // Drop-off "Where is this?" prompt (drop-offs.js).
    if (document.getElementById("dropOffLocationModal")?.classList.contains("show")) {
      document.getElementById("dropOffLocationSkip")?.click();
      return;
    }
    // Drop-off GPS/dropdown conflict prompt (drop-offs.js). Escape = cancel.
    if (document.getElementById("dropOffConflictModal")?.classList.contains("show")) {
      document.getElementById("dropOffConflictCancel")?.click();
      return;
    }
    // Counter category editor (app.js: openCategoryEditor). Escape = cancel.
    if (document.getElementById("counterCatModal")?.classList.contains("show")) {
      document.getElementById("counterCatCancel")?.click();
      return;
    }
  });

  // Tag the four overlay roots so AT announces them as dialogs.
  function tagDialog(sel, label) {
    document.querySelectorAll(sel).forEach((el) => {
      if (!el.getAttribute("role")) el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      if (label && !el.getAttribute("aria-label")) el.setAttribute("aria-label", label);
    });
  }

  function init() {
    scan(document);
    tagDialog("#vinKeypadOverlay", "VIN keypad");
    tagDialog(".scanner-overlay", "Barcode scanner");
    tagDialog("#recordDetailOverlay", "Record detail");
    tagDialog(".detail-overlay", "Detail");
    tagDialog(".slide-menu", "Menu");
    tagDialog("#alertModal", "Alert");

    // Re-scan when new clickable divs are rendered (record cards, legend rows,
    // quiz authoring lists, dashboard tiles, etc.).
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          scan(n);
        });
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
