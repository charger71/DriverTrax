// ============================================================
// Backlot — Reports & CSV export
//   Mounts into #section-reports. Pick a dataset (records /
//   detail_jobs / vehicles), a grouping, and (for the log
//   datasets) a date range; aggregate client-side into a table
//   with counts + % of total, and export to CSV.
//   On-demand (no realtime). Self-contained (BL_* only).
// ============================================================
(function () {
  if (!window.BL_AUTH) return;
  const sb  = BL_AUTH.client;
  const $   = (id) => document.getElementById(id);
  const esc = window.BL_ESC;
  const fmt = window.BL_FORMAT;

  const GROUPS = {
    records:     [["driver", "Driver"], ["status", "Status"], ["section", "Section"], ["day", "Day"]],
    detail_jobs: [["detailer", "Detailer"], ["day", "Day"]],
    vehicles:    [["status", "Status"], ["destination", "Destination"], ["section", "Section"]],
  };
  const DATASET_LABEL = { records: "Cars scanned", detail_jobs: "Detail jobs", vehicles: "Current inventory" };
  const UNIT = { records: "cars", detail_jobs: "jobs", vehicles: "vehicles" };

  let started = false;
  let lastReport = null; // { dataset, groupLabel, rows:[{label,count}], total, unit }
  let pager = null;
  let repCtx = { total: 0 }; // last-run context (for row renderer + Total row)

  const fmtDay = (ts) => new Date(ts).toLocaleDateString("en-CA", { timeZone: fmt.TZ }); // YYYY-MM-DD

  async function resolveNames(ids, fallback) {
    const names = {};
    const list = [...new Set(ids.filter(Boolean))];
    if (list.length) {
      const { data } = await sb.from("profiles").select("id,display_name").in("id", list);
      (data || []).forEach((p) => { names[p.id] = p.display_name || fallback; });
    }
    return names;
  }

  function populateGroups() {
    const ds = $("blRepDataset").value;
    $("blRepGroup").innerHTML = GROUPS[ds].map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    const isVeh = ds === "vehicles";
    $("blRepFromField").style.display = isVeh ? "none" : "";
    $("blRepToField").style.display = isVeh ? "none" : "";
  }

  async function run() {
    const ds = $("blRepDataset").value;
    const group = $("blRepGroup").value;
    const from = $("blRepFrom").value, to = $("blRepTo").value;

    $("blRepBody").innerHTML = `<tr><td><div class="bl-empty">Running…</div></td></tr>`;

    let rows = [], error = null;
    if (ds === "vehicles") {
      const res = await sb.from("vehicles").select("current_status,current_destination,section_name");
      rows = res.data || []; error = res.error;
    } else {
      const tsCol = ds === "records" ? "ts" : "started_at";
      const sel = ds === "records" ? "user_id,ts,status,section_name" : "detailer_id,started_at,completed_at";
      let q = sb.from(ds).select(sel);
      if (from) q = q.gte(tsCol, new Date(from + "T00:00:00").toISOString());
      if (to)   q = q.lte(tsCol, new Date(to + "T23:59:59.999").toISOString());
      const res = await q;
      rows = res.data || []; error = res.error;
    }
    if (error) {
      $("blRepBody").innerHTML = `<tr><td><div class="bl-empty">${esc(error.message)}</div></td></tr>`;
      return;
    }

    // aggregate
    const counts = {};
    rows.forEach((r) => {
      let key;
      if (group === "driver") key = r.user_id;
      else if (group === "detailer") key = r.detailer_id;
      else if (group === "status") key = (ds === "vehicles" ? r.current_status : r.status);
      else if (group === "destination") key = r.current_destination;
      else if (group === "section") key = r.section_name;
      else if (group === "day") key = fmtDay(ds === "records" ? r.ts : r.started_at);
      if (key == null || key === "") key = "(none)";
      counts[key] = (counts[key] || 0) + 1;
    });

    let labels = {};
    if (group === "driver" || group === "detailer") {
      labels = await resolveNames(Object.keys(counts), group === "detailer" ? "Detailer" : "Driver");
    }
    let out = Object.entries(counts).map(([k, c]) => ({ label: labels[k] || k, count: c }));
    if (group === "day") out.sort((a, b) => a.label.localeCompare(b.label));
    else out.sort((a, b) => b.count - a.count);

    const total = out.reduce((s, r) => s + r.count, 0);
    const groupLabel = GROUPS[ds].find((x) => x[0] === group)[1];
    const unit = UNIT[ds];

    renderTable(groupLabel, out, total);
    const rangeTxt = ds === "vehicles" ? "current snapshot" : `${from || "earliest"} → ${to || "now"}`;
    $("blRepSummary").textContent = `${DATASET_LABEL[ds]} · by ${groupLabel} · ${rangeTxt} · ${total} ${unit} across ${out.length} ${out.length === 1 ? "row" : "rows"}`;

    lastReport = { dataset: DATASET_LABEL[ds], groupLabel, rows: out, total, unit };
    $("blRepExport").disabled = out.length === 0;
  }

  function renderTable(groupLabel, rows, total) {
    $("blRepHead").innerHTML = `<tr><th>${esc(groupLabel)}</th><th class="bl-num">Count</th><th class="bl-num">% of total</th></tr>`;
    const body = $("blRepBody");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="3"><div class="bl-empty">No data for these filters.</div></td></tr>`;
      hidePager();
      return;
    }
    repCtx.total = total;
    ensurePager();
    pager.setItems(rows);
  }

  function renderRepRows(rows) {
    const total = repCtx.total;
    const body = $("blRepBody");
    if (!body) return;
    body.innerHTML = rows.map((r) =>
      `<tr><td>${esc(r.label)}</td><td class="bl-num">${r.count}</td><td class="bl-num">${total ? ((r.count / total) * 100).toFixed(1) : 0}%</td></tr>`
    ).join("") + `<tr class="bl-report-total"><td>Total</td><td class="bl-num">${total}</td><td class="bl-num">100%</td></tr>`;
  }

  function ensurePager() { if (!pager) pager = BL_PAGINATE.create({ mount: $("blRepPager"), render: renderRepRows }); }
  function hidePager() { const m = $("blRepPager"); if (m) { m.hidden = true; m.innerHTML = ""; } }

  // ---- CSV export ----
  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function exportCsv() {
    if (!lastReport) return;
    const { dataset, groupLabel, rows, total } = lastReport;
    const lines = [[groupLabel, "Count", "% of total"].map(csvCell).join(",")];
    rows.forEach((r) => lines.push([r.label, r.count, total ? ((r.count / total) * 100).toFixed(1) : 0].map(csvCell).join(",")));
    lines.push(["Total", total, "100"].map(csvCell).join(","));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backlot-${dataset.toLowerCase().replace(/\s+/g, "-")}-by-${groupLabel.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    BL_TOAST.success("CSV downloaded.");
  }

  function start() {
    if (started) return;
    started = true;
    const to = new Date(); const from = new Date(); from.setDate(from.getDate() - 6);
    $("blRepTo").value = to.toISOString().slice(0, 10);
    $("blRepFrom").value = from.toISOString().slice(0, 10);
    populateGroups();
    $("blRepDataset").addEventListener("change", populateGroups);
    $("blRepRun").addEventListener("click", run);
    $("blRepExport").addEventListener("click", exportCsv);
  }

  // Controls are static UI; wire them up as soon as the DOM is here.
  start();

  window.BL_REPORTS = { run };
})();
