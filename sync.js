// ============================================================
// DriverTrax Cloud Sync (Supabase) — IDB-backed queue
// Diffs every local setRecords() call against the previous state
// and queues changed/deleted records for the cloud. The queue
// persists in IndexedDB so it survives tab crashes and is ready
// for solo SW flush (currently the SW still wakes a visible
// client, but the data layer no longer needs a tab to read it).
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
  if (!window.DT_IDB) {
    console.error("[Sync] DT_IDB not loaded — make sure idb.js runs first");
    return;
  }

  const sb = DT_AUTH.client;
  const IDB = DT_IDB;
  const QUEUE_KEY = "sync_queue";       // in `kv` store: { [id]: "upsert" | "delete" }
  const SNAPSHOT_KEY = "sync_snapshot"; // in `kv` store: { [id]: lastCloudRow }
  const LS_QUEUE_KEY = "drivertrax_sync_queue";       // legacy
  const LS_SNAPSHOT_KEY = "drivertrax_sync_snapshot"; // legacy

  // In-memory mirror of the queue so setRecords() can update synchronously.
  // IDB writes are fire-and-forget; we await them only when flushing.
  let queue = {};
  let queueReady = false;
  let flushing = false;
  let pendingFlush = null;
  let prevById = indexBy(getRecords());

  // ----- one-time migration from localStorage to IDB -----
  async function migrateFromLocalStorage() {
    try {
      const rawQ = localStorage.getItem(LS_QUEUE_KEY);
      const rawS = localStorage.getItem(LS_SNAPSHOT_KEY);
      if (rawQ) {
        const parsed = JSON.parse(rawQ);
        const existing = (await IDB.get("kv", QUEUE_KEY)) || {};
        await IDB.set("kv", QUEUE_KEY, { ...parsed, ...existing });
        localStorage.removeItem(LS_QUEUE_KEY);
      }
      if (rawS) {
        const parsed = JSON.parse(rawS);
        if (!(await IDB.get("kv", SNAPSHOT_KEY))) {
          await IDB.set("kv", SNAPSHOT_KEY, parsed);
        }
        localStorage.removeItem(LS_SNAPSHOT_KEY);
      }
    } catch (e) {
      console.warn("[Sync] migration skipped:", e.message);
    }
  }

  async function loadQueue() {
    await migrateFromLocalStorage();
    queue = (await IDB.get("kv", QUEUE_KEY)) || {};
    queueReady = true;
    updateBadge();
    // If anything queued before we finished loading, schedule a flush.
    if (Object.keys(queue).length > 0) scheduleFlush();
  }

  function persistQueue() {
    // Fire-and-forget; reads always go through the in-memory `queue`.
    IDB.set("kv", QUEUE_KEY, queue).catch(() => {});
    updateBadge();
    // Background Sync: ask the SW to wake any client when connectivity
    // returns. The queue lives in IDB now, so a future SW could flush
    // solo with a stored auth token — today it still pings clients.
    if (Object.keys(queue).length > 0 && "serviceWorker" in navigator && "SyncManager" in window) {
      navigator.serviceWorker.ready
        .then(reg => reg.sync?.register?.("drivertrax-flush"))
        .catch(() => {});
    }
  }

  async function readSnapshot() { return (await IDB.get("kv", SNAPSHOT_KEY)) || {}; }
  function writeSnapshot(s) { IDB.set("kv", SNAPSHOT_KEY, s).catch(() => {}); }

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
      conditions: rec.conditions && rec.conditions.length ? rec.conditions : null,
      vin_data: rec.vinData || null,
      photo_url: rec.photo_url || null,
      photo_urls: Array.isArray(rec.photo_urls) && rec.photo_urls.length ? rec.photo_urls : null,
      mileage: Number.isFinite(rec.mileage) ? rec.mileage : null,
      fuel_level: rec.fuel_level || null,
      damage_marks: Array.isArray(rec.damage_marks) ? rec.damage_marks : [],
      tire_details: rec.tire_details && typeof rec.tire_details === "object" ? rec.tire_details : {},
      claim_number: rec.claim_number || null,
      claim_notes: rec.claim_notes || null,
      section_id: rec.sectionId || null,
      section_name: rec.sectionName || null,
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
      conditions: row.conditions || [],
      vinData: row.vin_data || undefined,
      photo_url: row.photo_url || "",
      photo_urls: Array.isArray(row.photo_urls) ? row.photo_urls : (row.photo_urls ? [].concat(row.photo_urls) : []),
      mileage: Number.isFinite(row.mileage) ? row.mileage : null,
      fuel_level: row.fuel_level || "",
      damage_marks: Array.isArray(row.damage_marks) ? row.damage_marks : [],
      tire_details: row.tire_details && typeof row.tire_details === "object" ? row.tire_details : {},
      claim_number: row.claim_number || "",
      claim_notes: row.claim_notes || "",
      sectionId: row.section_id || null,
      sectionName: row.section_name || "",
      timestamp: row.ts ? new Date(row.ts).getTime() : Date.now()
    };
  }

  function indexBy(arr) {
    const m = {};
    for (const r of arr) m[String(r.id)] = r;
    return m;
  }

  // ----- diff & queue on every local write -----
  const origSetRecords = window.setRecords;
  window.setRecords = function (records) {
    origSetRecords(records);
    const nextById = indexBy(records);
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
    persistQueue();
    scheduleFlush();
  };

  // ----- flush queue to Supabase -----
  function scheduleFlush() {
    if (pendingFlush) return;
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      flushQueue();
    }, 600);
  }

  async function flushQueue() {
    if (flushing || !queueReady) return;
    const user = DT_AUTH.getUser();
    if (!user) return;
    // Detailers don't write records directly — the detailer flow inserts
    // them through detail_jobs. Everyone else needs sync.
    const p = DT_AUTH.getProfile();
    if (p && p.role === "detailer") return;
    if (!navigator.onLine) { updateBadge(); return; }
    const ids = Object.keys(queue);
    if (ids.length === 0) { updateBadge("ok"); return; }

    flushing = true;
    updateBadge("syncing");

    const recordsById = indexBy(getRecords());
    let upserts = [];
    const deletes = [];
    // Capture the snapshot of queue entries we're flushing so concurrent
    // edits added to `queue` while we're awaiting Supabase aren't dropped.
    const inflight = {};
    for (const id of ids) {
      inflight[id] = queue[id];
      if (queue[id] === "upsert" && recordsById[id]) upserts.push(toRow(recordsById[id], user.id));
      else if (queue[id] === "delete") deletes.push(id);
    }

    try {
      if (upserts.length) {
        let { error } = await sb.from("records").upsert(upserts, { onConflict: "id" });
        if (error && (error.code === "42501" || /row-level security/i.test(error.message || ""))) {
          // RLS blocked one or more rows. Find which queued ids already
          // exist in the cloud under a different user_id, drop those from
          // the queue, and retry the rest. Stops a single orphaned record
          // (account switch, shared device) from wedging the whole sync.
          const upIds = upserts.map(r => r.id);
          const { data: existing, error: lookupErr } = await sb
            .from("records").select("id,user_id").in("id", upIds);
          if (lookupErr) {
            console.warn("[Sync] RLS recovery lookup failed", lookupErr);
            throw error;
          }
          const orphanIds = new Set((existing || [])
            .filter(r => r.user_id && r.user_id !== user.id)
            .map(r => r.id));
          if (orphanIds.size > 0) {
            console.warn("[Sync] dropping queued ids owned by another user:", [...orphanIds]);
            for (const id of orphanIds) { delete queue[id]; delete inflight[id]; }
            persistQueue();
            upserts = upserts.filter(r => !orphanIds.has(r.id));
            if (typeof window.showToast === "function") {
              window.showToast(
                `Skipped ${orphanIds.size} record${orphanIds.size === 1 ? "" : "s"} owned by another account`,
                "warn"
              );
            }
            if (upserts.length) {
              const retry = await sb.from("records").upsert(upserts, { onConflict: "id" });
              error = retry.error;
            } else {
              error = null;
            }
          }
        }
        if (error) {
          if (error.code === "42501" || /row-level security/i.test(error.message || "")) {
            console.warn("[Sync] RLS blocked upsert.",
              "current user.id =", user.id,
              "rows being sent =", upserts.length,
              "queued ids =", upserts.map(r => r.id));
          }
          throw error;
        }
      }
      if (deletes.length) {
        const { error } = await sb.from("records").delete().in("id", deletes);
        if (error) throw error;
      }
      // Success: drop only the inflight entries (preserve concurrent edits)
      // and refresh the snapshot.
      const snap = await readSnapshot();
      for (const row of upserts) snap[row.id] = row;
      for (const id of deletes) delete snap[id];
      writeSnapshot(snap);
      for (const id in inflight) {
        if (queue[id] === inflight[id]) delete queue[id];
      }
      persistQueue();
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
    const p = DT_AUTH.getProfile();
    if (p && p.role === "detailer") return;
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

      // Cloud wins on conflict; keep local-only rows for upload.
      const merged = { ...localById, ...cloudById };
      const mergedArr = Object.values(merged).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      // Push local-only rows
      const localOnly = Object.keys(localById).filter(id => !cloudById[id]);
      for (const id of localOnly) queue[id] = "upsert";
      persistQueue();

      // Snapshot for future diffs
      const snap = {};
      for (const row of cloud) snap[row.id] = row;
      writeSnapshot(snap);

      // Write merged set without re-queueing everything: skip our wrapper
      origSetRecords(mergedArr);
      if (typeof invalidateRecordsCache === "function") invalidateRecordsCache();
      prevById = indexBy(mergedArr);

      tryRender();
      scheduleFlush();
    } catch (err) {
      console.warn("[Sync] pull failed", err);
      updateBadge("err");
    }
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
    const pending = Object.keys(queue).length;
    if (!DT_AUTH.getUser()) { el.textContent = "Not signed in"; return; }
    if (state === "syncing") { el.textContent = "Syncing…"; return; }
    if (state === "err") { el.textContent = "Sync error — will retry"; return; }
    if (pending > 0 && !navigator.onLine) { el.textContent = `Offline · ${pending} queued`; return; }
    if (pending > 0) { el.textContent = `${pending} queued`; return; }
    el.innerHTML = `Synced <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-check"/></svg>`;
  }

  function shouldRunSync() {
    const p = DT_AUTH.getProfile();
    return p && p.role !== "detailer";
  }

  function clearBadge() {
    const el = document.getElementById("menuSyncStatus");
    if (el) el.textContent = "";
  }

  // ----- wire up auth + connectivity events -----
  document.addEventListener("dt-auth-change", (e) => {
    if (e.detail.user && shouldRunSync()) pullAndMerge();
    else clearBadge();
  });
  window.addEventListener("online",  () => { if (shouldRunSync()) scheduleFlush(); });
  window.addEventListener("offline", () => { if (shouldRunSync()) updateBadge(); });
  navigator.serviceWorker?.addEventListener?.("message", (e) => {
    if (e.data?.type === "dt-sync-flush" && shouldRunSync()) scheduleFlush();
  });

  // Boot: load queue from IDB, then kick off pull if already signed in.
  loadQueue().then(() => {
    if (DT_AUTH.getUser() && shouldRunSync()) pullAndMerge();
  });

  // Expose for debugging
  window.DT_SYNC = {
    flush: flushQueue,
    pull: pullAndMerge,
    queue: () => ({ ...queue }),
    // Escape hatch: when the queue is wedged on rows whose cloud copy is
    // owned by a different user, clear the queue without touching local
    // cache. Reload after running.
    clearQueue() { queue = {}; persistQueue(); updateBadge("ok"); console.info("[Sync] queue cleared"); }
  };
})();
