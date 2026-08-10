// ============================================================
// DriverTrax Extra-Driver Requests (driver side)
// Surfaces open coverage requests from managers in the driver
// Announcements panel. One tap to accept or decline. Updates
// live so the manager sees the response immediately.
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;

  const $ = (id) => document.getElementById(id);
  const esc = window.DT_ESC;

  let realtimeChan = null;

  async function load() {
    const user = DT_AUTH.getUser();
    if (!user) return;

    const role = DT_AUTH.getProfile()?.role || "driver";
    const { data: requests, error } = await sb
      .from("extra_driver_requests")
      .select("id,shift_time,shifts,needed_count,note,status,position,created_at, extra_driver_responses(response,driver_id,shifts,created_at)")
      .eq("status", "open")
      .eq("position", role)
      .order("shift_time", { ascending: true });
    if (error) { console.warn("[Requests] load", error); return; }

    const section = $("edrDriverSection");
    const list = $("edrDriverList");
    if (!section || !list) return;

    if (!requests || !requests.length) {
      section.style.display = "none";
      list.innerHTML = "";
      window.DT_PWA?.setBadgeSource?.("coverage", 0);
      return;
    }
    section.style.display = "";

    const unresponded = requests.filter(r =>
      !(r.extra_driver_responses || []).some(x => x.driver_id === user.id)
    ).length;
    window.DT_PWA?.setBadgeSource?.("coverage", unresponded);

    list.innerHTML = requests.map(r => {
      const responses = r.extra_driver_responses || [];
      const yesCount  = responses.filter(x => x.response === "yes").length;
      const noCount   = responses.filter(x => x.response === "no").length;
      const myRes     = responses.find(x => x.driver_id === user.id) || null;
      const myShifts  = new Set((myRes && myRes.shifts) || []);

      const when = new Date(r.shift_time).toLocaleDateString([], {
        weekday: "short", month: "short", day: "numeric"
      });
      const positionLabel = { driver: "driver", detailer: "detailer", cxr: "CXR" }[r.position] || "person";
      const progress = `${yesCount}/${r.needed_count} accepted · ${noCount} declined`;
      const requestedShifts = (r.shifts || []).map(s => `<span class="edr-shift-tag">${esc(s)}</span>`).join("");
      const checkboxes = (r.shifts || []).map(s => `
        <label class="shift-chip">
          <input type="checkbox" name="shifts" value="${esc(s)}" ${myShifts.has(s) ? "checked" : ""}>
          <span>${esc(s)}</span>
        </label>`).join("");

      const checkIcon = `<svg class="icon" aria-hidden="true"><use href="#icon-check"/></svg>`;
      const yesLabel = myRes?.response === "yes" ? `${checkIcon} Confirmed` : "I can come in";
      const noLabel  = myRes?.response === "no"  ? `${checkIcon} Not available` : "Not available";

      return `
        <div class="edr-card ${myRes ? "responded" : ""}" data-id="${r.id}">
          <div class="when">${esc(when)}</div>
          <div class="meta">${r.needed_count} ${esc(positionLabel)}${r.needed_count === 1 || positionLabel === "CXR" ? "" : "s"} needed</div>
          <div class="edr-shift-tags">${requestedShifts}</div>
          ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
          <div class="progress">${esc(progress)}</div>

          <div class="shift-picker">
            <span class="shift-picker-label">Which shifts can you cover?</span>
            ${checkboxes}
          </div>

          <div class="edr-actions">
            <button class="btn btn-primary btn--sm edr-yes ${myRes?.response === "yes" ? "mine" : ""}" data-response="yes">${yesLabel}</button>
            <button class="btn btn-ghost   btn--sm edr-no  ${myRes?.response === "no"  ? "mine" : ""}" data-response="no" >${noLabel}</button>
          </div>
        </div>
      `;
    }).join("");

    list.querySelectorAll(".edr-card").forEach(card => {
      const reqId = card.dataset.id;
      card.querySelectorAll(".edr-actions button").forEach(b => {
        b.addEventListener("click", async () => {
          const wantedResponse = b.dataset.response;
          const checkedShifts = [...card.querySelectorAll('input[name="shifts"]:checked')].map(i => i.value);
          if (wantedResponse === "yes" && checkedShifts.length === 0) {
            DT_TOAST.show("Pick at least one shift you can cover", "warn");
            return;
          }
          await respond(reqId, wantedResponse, wantedResponse === "yes" ? checkedShifts : []);
          load();
        });
      });
    });
  }

  async function respond(requestId, response, shifts) {
    const user = DT_AUTH.getUser();
    if (!user) return;
    const { error } = await sb
      .from("extra_driver_responses")
      .upsert({ request_id: requestId, driver_id: user.id, response, shifts: shifts || [] },
              { onConflict: "request_id,driver_id" });
    if (error) { DT_TOAST.show(error.message || "Couldn't record your response", "error"); return; }
  }

  const life = DT_LIFECYCLE.create({
    start() {
      load();
      realtimeChan = sb.channel("edr-driver")
        .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_requests" },  load)
        .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_responses" }, load)
        .subscribe();
    },
    stop() {
      if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
      const section = $("edrDriverSection");
      if (section) section.style.display = "none";
      window.DT_PWA?.setBadgeSource?.("coverage", 0);
    }
  });

  // Coverage requests are visible to all front-line roles (driver, detailer, CXR).
  // Managers see the manager-side list in the Alerts panel instead.
  function shouldRun() {
    const p = DT_AUTH.getProfile();
    if (!p) return false;
    return p.role === "driver" || p.role === "detailer" || p.role === "cxr";
  }

  document.addEventListener("dt-auth-change", () => life.set(shouldRun()));
  life.set(shouldRun());

  window.DT_REQUESTS = { reload: load };
})();
