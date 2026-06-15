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
  let started = false;

  async function load() {
    const user = DT_AUTH.getUser();
    if (!user) return;

    const { data: requests, error } = await sb
      .from("extra_driver_requests")
      .select("id,shift_time,shifts,needed_count,note,status,created_at, extra_driver_responses(response,driver_id,shifts,created_at)")
      .eq("status", "open")
      .order("shift_time", { ascending: true });
    if (error) { console.warn("[Requests] load", error); return; }

    const section = $("edrDriverSection");
    const list = $("edrDriverList");
    if (!section || !list) return;

    if (!requests || !requests.length) {
      section.style.display = "none";
      list.innerHTML = "";
      return;
    }
    section.style.display = "";

    list.innerHTML = requests.map(r => {
      const responses = r.extra_driver_responses || [];
      const yesCount  = responses.filter(x => x.response === "yes").length;
      const noCount   = responses.filter(x => x.response === "no").length;
      const myRes     = responses.find(x => x.driver_id === user.id) || null;
      const myShifts  = new Set((myRes && myRes.shifts) || []);

      const when = new Date(r.shift_time).toLocaleDateString([], {
        weekday: "short", month: "short", day: "numeric"
      });
      const progress = `${yesCount}/${r.needed_count} accepted · ${noCount} declined`;
      const requestedShifts = (r.shifts || []).map(s => `<span class="edr-shift-tag">${esc(s)}</span>`).join("");
      const checkboxes = (r.shifts || []).map(s => `
        <label class="shift-chip">
          <input type="checkbox" name="shifts" value="${esc(s)}" ${myShifts.has(s) ? "checked" : ""}>
          <span>${esc(s)}</span>
        </label>`).join("");

      const yesLabel = myRes?.response === "yes" ? "✓ Confirmed" : "I can come in";
      const noLabel  = myRes?.response === "no"  ? "✓ Not available" : "Not available";

      return `
        <div class="edr-card ${myRes ? "responded" : ""}" data-id="${r.id}">
          <div class="when">${esc(when)}</div>
          <div class="meta">${r.needed_count} driver${r.needed_count === 1 ? "" : "s"} needed</div>
          <div class="edr-shift-tags">${requestedShifts}</div>
          ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
          <div class="progress">${esc(progress)}</div>

          <div class="shift-picker u-mt-3">
            <span class="shift-picker-label">Which shifts can you cover?</span>
            ${checkboxes}
          </div>

          <div class="edr-actions">
            <button class="edr-yes ${myRes?.response === "yes" ? "mine" : ""}" data-response="yes">${yesLabel}</button>
            <button class="edr-no  ${myRes?.response === "no"  ? "mine" : ""}" data-response="no" >${noLabel}</button>
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
            alert("Pick at least one shift you can cover.");
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
    if (error) { alert(error.message); return; }
  }

  function start() {
    if (started) return;
    started = true;
    load();
    realtimeChan = sb.channel("edr-driver")
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_requests" },  load)
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_driver_responses" }, load)
      .subscribe();
  }

  function stop() {
    started = false;
    if (realtimeChan) { sb.removeChannel(realtimeChan); realtimeChan = null; }
    const section = $("edrDriverSection");
    if (section) section.style.display = "none";
  }

  // Drivers + CXRs see coverage requests; managers see the manager-side list instead.
  function shouldRun() {
    const p = DT_AUTH.getProfile();
    if (!p) return false;
    // Coverage Requests responder is for drivers only — CXR + managers see
    // the manager Alerts panel which already lists open requests.
    return p.role === "driver";
  }

  document.addEventListener("dt-auth-change", () => { shouldRun() ? start() : stop(); });
  if (shouldRun()) start();

  window.DT_REQUESTS = { reload: load };
})();
