// ============================================================
// DriverTrax Cloud Sync (Supabase)
// Diffs every local setRecords() call against the previous state
// and queues changed/deleted records for the cloud. The queue
// persists in localStorage so offline saves flush on reconnect.
// ============================================================

(function () {
  if (!window.DT_AUTH) {
    console.error("[Sync] DT_AUTH not loaded — make sure auth.js runs first");
    return;
  }
  if (typeof getRecords !== "function" || typeof setRecords !== "function") {
    console.error("[Sync] getRecords/setRecords not found — load order issue");
    return;
  }

  const sb = DT_AUTH.client;
  const QUEUE_KEY = "drivertrax_sync_queue";   // { [id]: "upsert" | "delete" }
  const SNAPSHOT_KEY = "drivertrax_sync_snapshot"; // last-known cloud-side JSON per id
  let flushing = false;
  let pendingFlush = null;

  // ----- queue helpers -----
  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "{}"); }
    catch { return {}; }
  }
  function writeQueue(q) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    updateBadge();
  }
  function readSnapshot() {
    try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "{}"); }
    catch { return {}; }
  }
  function writeSnapshot(s) {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(s));
  }

  // ----- mapping local record <-> Supabase row -----
  function toRow(rec, userId) {
    return {
      id: String(rec.id),
      user_id: userId,
      serial_id: rec.serialId || "",
      status: rec.status || "",
      status_other: rec.statusOther || null,
      destination: rec.destination || null,
      destination_other: rec.destinationOther || null,
      no_tag: !!rec.noTag,
      shuttle: !!rec.shuttle,
      transport: !!rec.transport,
      shift_num: Number.isFinite(rec.shiftNum) ? rec.shiftNum : null,
      notes: rec.notes || null,
      lat: Number.isFinite(rec.lat) ? rec.lat : null,
      lng: Number.isFinite(rec.lng) ? rec.lng : null,
      gps_error: !!rec.gpsError,
      tires: rec.tires && rec.tires.length ? rec.tires : null,
      vin_data: rec.vinData || null,
      ts: new Date(rec.timestamp || Date.now()).toISOString()
    };
  }
  function fromRow(row) {
    return {
      id: row.id,
      serialId: row.serial_id,
      status: row.status,
      statusOther: row.status_other || "",
      destination: row.destination || "",
      destinationOther: row.destination_other || "",
      noTag: !!row.no_tag,
      shuttle: !!row.shuttle,
      transport: !!row.transport,
      shiftNum: row.shift_num,
      notes: row.notes || "",
      lat: row.lat,
      lng: row.lng,
      gpsError: !!row.gps_error,
      tires: row.tires || [],
      vinData: row.vin_data || undefined,
      timestamp: row.ts ? new Date(row.ts).getTime() : Date.now()
    };
  }

  // ----- diff & queue on every local write -----
  const origSetRecords = window.setRecords;
  let prevById = indexBy(getRecords());
  window.setRecords = function (records) {
    origSetRecords(records);
    const nextById = indexBy(records);
    const queue = readQueue();
    // Inserts + updates
    for (const id in nextById) {
      const prev = prevById[id];
      if (!prev || JSON.stringify(prev) !== JSON.stringify(nextById[id])) {
        queue[id] = "upsert";
      }
    }
    // Deletes
    for (const id in prevById) {
      if (!nextById[id]) queue[id] = "delete";
    }
    prevById = nextById;
    writeQueue(queue);
    scheduleFlush();
  };

  function indexBy(arr) {
    const m = {};
    for (const r of arr) m[String(r.id)] = r;
    return m;
  }

  // ----- flush queue to Supabase -----
  function scheduleFlush() {
    if (pendingFlush) return;
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      flushQueue();
    }, 600);
  }

  async function flushQueue() {
    if (flushing) return;
    const user = DT_AUTH.getUser();
    if (!user) return;
    if (!navigator.onLine) { updateBadge(); return; }
    const queue = readQueue();
    const ids = Object.keys(queue);
    if (ids.length === 0) { updateBadge("ok"); return; }

    flushing = true;
    updateBadge("syncing");

    const recordsById = indexBy(getRecords());
    const upserts = [];
    const deletes = [];
    for (const id of ids) {
      if (queue[id] === "upsert" && recordsById[id]) upserts.push(toRow(recordsById[id], user.id));
      else if (queue[id] === "delete") deletes.push(id);
    }

    try {
      if (upserts.length) {
        const { error } = await sb.from("records").upsert(upserts, { onConflict: "id" });
        if (error) throw error;
      }
      if (deletes.length) {
        const { error } = await sb.from("records").delete().in("id", deletes);
        if (error) throw error;
      }
      // Success: clear queue, refresh snapshot
      const snap = readSnapshot();
      for (const row of upserts) snap[row.id] = row;
      for (const id of deletes) delete snap[id];
      writeSnapshot(snap);
      writeQueue({});
      updateBadge("ok");
    } catch (err) {
      console.warn("[Sync] flush failed", err);
      updateBadge("err");
    } finally {
      flushing = false;
    }
  }

  // ----- initial pull + merge on sign-in -----
  async function pullAndMerge() {
    const user = DT_AUTH.getUser();
    if (!user) return;
    updateBadge("syncing");
    try {
      const { data: rows, error } = await sb
        .from("records")
        .select("*")
        .eq("user_id", user.id)
        .order("ts", { ascending: false });
      if (error) throw error;

      const cloud = rows || [];
      const cloudById = {};
      for (const row of cloud) cloudById[row.id] = fromRow(row);

      const local = getRecords();
      const localById = indexBy(local);

      // Cloud wins on conflict; keep local-only rows for upload
      const merged = { ...localById, ...cloudById };
      const mergedArr = Object.values(merged).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      // Push local-only rows
      const localOnly = Object.keys(localById).filter(id => !cloudById[id]);
      const queue = readQueue();
      for (const id of localOnly) queue[id] = "upsert";
      writeQueue(queue);

      // Snapshot for future diffs
      const snap = {};
      for (const row of cloud) snap[row.id] = row;
      writeSnapshot(snap);

      // Write merged set without re-queueing everything: skip our wrapper
      origSetRecords(mergedArr);
      invalidateRecordsCacheIfDefined();
      prevById = indexBy(mergedArr);

      // Re-render any visible lists
      tryRender();
      scheduleFlush();
    } catch (err) {
      console.warn("[Sync] pull failed", err);
      updateBadge("err");
    }
  }

  function invalidateRecordsCacheIfDefined() {
    if (typeof invalidateRecordsCache === "function") invalidateRecordsCache();
  }

  function tryRender() {
    try { if (typeof renderTodayEntries === "function") renderTodayEntries(); } catch {}
    try { if (typeof renderRecords === "function") renderRecords(); } catch {}
    try { if (typeof renderDashboard === "function") renderDashboard(); } catch {}
  }

  // ----- sync badge in the menu footer -----
  function updateBadge(state) {
    const el = document.getElementById("menuSyncStatus");
    if (!el) return;
    const queue = readQueue();
    const pending = Object.keys(queue).length;
    if (!DT_AUTH.getUser()) { el.textContent = "Not signed in"; return; }
    if (state === "syncing") { el.textContent = "Syncing…"; return; }
    if (state === "err") { el.textContent = "Sync error — will retry"; return; }
    if (pending > 0 && !navigator.onLine) { el.textContent = `Offline · ${pending} queued`; return; }
    if (pending > 0) { el.textContent = `${pending} queued`; return; }
    el.textContent = "Synced ✓";
  }

  // ----- wire up auth + connectivity events -----
  document.addEventListener("dt-auth-change", (e) => {
    if (e.detail.user) pullAndMerge();
    else updateBadge();
  });
  window.addEventListener("online", () => { scheduleFlush(); });
  window.addEventListener("offline", () => updateBadge());

  // If auth fires before this file loads, kick off immediately
  if (DT_AUTH.getUser()) pullAndMerge();

  // Expose for debugging
  window.DT_SYNC = { flush: flushQueue, pull: pullAndMerge, queue: readQueue };
})();
