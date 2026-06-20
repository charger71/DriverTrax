// ============================================================
// DriverTrax IndexedDB helper (window.DT_IDB)
// Two stores:
//   kv      - generic key/value (sync queue, snapshot, misc)
//   backups - rotating backup snapshots, keyed by timestamp (number)
// All methods return Promises. Silently no-op if IDB is unavailable
// (private mode, locked storage) so callers never crash.
// ============================================================

(function () {
  const DB_NAME = "drivertrax";
  const DB_VERSION = 1;
  const STORES = ["kv", "backups"];

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("IDB unavailable")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IDB blocked"));
    }).catch(err => { _dbPromise = null; throw err; });
    return _dbPromise;
  }

  function tx(store, mode) {
    return openDB().then(db => db.transaction(store, mode).objectStore(store));
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(store, key) {
    try { return await wrap((await tx(store, "readonly")).get(key)); }
    catch { return undefined; }
  }
  async function set(store, key, val) {
    try { await wrap((await tx(store, "readwrite")).put(val, key)); return true; }
    catch { return false; }
  }
  async function del(store, key) {
    try { await wrap((await tx(store, "readwrite")).delete(key)); return true; }
    catch { return false; }
  }
  async function keys(store) {
    try { return await wrap((await tx(store, "readonly")).getAllKeys()); }
    catch { return []; }
  }
  async function values(store) {
    try { return await wrap((await tx(store, "readonly")).getAll()); }
    catch { return []; }
  }
  async function clear(store) {
    try { await wrap((await tx(store, "readwrite")).clear()); return true; }
    catch { return false; }
  }

  window.DT_IDB = { get, set, del, keys, values, clear };
})();
