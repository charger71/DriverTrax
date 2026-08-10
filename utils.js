// ============================================================
// DriverTrax shared utilities
//   - DT_ESC: HTML escape (same map every module had its own copy of)
//   - DT_FORMAT: time/date formatters (single source for "America/New_York")
//   - DT_TOAST: thin wrapper over showToast() so non-app modules can use it
//   - DT_UI: misc UI helpers (modal status message)
//   - DT_MEDIA: vehicle-photo upload/resize/sign + GPS capture + latest
//               mileage/fuel lookup. Reads window.DT_AUTH.client lazily so
//               this file can load before auth.js.
// Load this BEFORE auth.js / app.js / feature modules.
// ============================================================
(function () {
  const ESC_MAP = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ESC_MAP[c]);

  const TZ = "America/New_York";
  const toDate = (v) => (v instanceof Date) ? v : new Date(v);
  const valid  = (d) => d && !isNaN(d.getTime());

  const time = (v) => {
    const d = toDate(v);
    if (!valid(d)) return "";
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  };
  // date/dateTime pin the same TZ as time(). Without it a phone set outside
  // Eastern rendered the ET clock time next to its own local date, so a 10pm
  // entry showed yesterday's date beside tonight's time.
  const date = (v) => {
    const d = toDate(v);
    if (!valid(d)) return "";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
  };
  const dateTime = (v) => {
    const d = toDate(v);
    if (!valid(d)) return "";
    return d.toLocaleString(undefined, { timeZone: TZ });
  };
  // Prefer the rich timeAgo from announcements.js when loaded; fall back to dateTime.
  const timeAgo = (v, prefix) => {
    if (typeof window.dtTimeAgo === "function") return window.dtTimeAgo(v, prefix);
    return dateTime(v);
  };
  // Records show "5 min ago" when announcements.js is loaded, EST clock time otherwise.
  const timeAgoOrClock = (v) => {
    if (typeof window.dtTimeAgo === "function") return window.dtTimeAgo(v);
    return time(v);
  };

  window.DT_ESC = esc;
  window.DT_FORMAT = { time, date, dateTime, timeAgo, timeAgoOrClock, TZ };

  // Toast: delegate to showToast() defined in app.js once it's loaded.
  // Safe to call before app.js initializes — calls are dropped silently.
  window.DT_TOAST = {
    show(msg, type) {
      if (typeof window.showToast === "function") window.showToast(msg, type);
    },
    // Standardized "this record is gone" alert. Use when a Supabase
    // fetch-by-id comes back empty or returns PGRST116, instead of
    // surfacing the raw error to the user.
    missing(label) {
      const what = label || "record";
      this.show(`This ${what} no longer exists — it may have been deleted.`, "error");
    }
  };

  // Detect Supabase "row not found" responses so callers can branch to
  // DT_TOAST.missing() instead of showing the raw error. Covers both
  // .single() (PGRST116) and .maybeSingle()/list shapes (data is null
  // or empty array with no error).
  window.DT_ERR = {
    isMissing(error, data) {
      if (error && (error.code === "PGRST116" || error.status === 406)) return true;
      if (!error && (data == null || (Array.isArray(data) && data.length === 0))) return true;
      return false;
    }
  };

  // Set a modal status message (matches the .users-modal-msg className pattern
  // already used in users/auth modals).
  window.DT_UI = {
    setMessage(el, text, kind) {
      if (!el) return;
      el.textContent = text || "";
      el.className = "users-modal-msg" + (kind ? " " + kind : "");
    }
  };

  // Feature-module lifecycle. Modules start and stop as roles change, and
  // dt-auth-change fires more often than it looks — a failed profile fetch
  // (normal on lot wifi) reads as "no profile", stopping every module, and
  // the next success starts them again. The old single `started` flag was
  // reset by stop(), so each cycle re-ran start() and registered a second
  // copy of every DOM and document listener.
  //
  // Splitting the two states fixes that: `wire` runs exactly once ever, for
  // listener registration; `start`/`stop` may run any number of times, for
  // subscriptions and data loads.
  //
  //   const life = DT_LIFECYCLE.create({
  //     wire()  { $("btn").addEventListener("click", onClick); },
  //     start() { load(); chan = sb.channel(...).subscribe(); },
  //     stop()  { if (chan) { sb.removeChannel(chan); chan = null; } }
  //   });
  //   document.addEventListener("dt-auth-change", () => life.set(shouldRun()));
  //   life.set(shouldRun());
  window.DT_LIFECYCLE = {
    create({ wire, start, stop }) {
      let wired = false;
      let running = false;
      return {
        set(on) { on ? this.start() : this.stop(); },
        start() {
          if (!wired) { wired = true; if (wire) wire(); }
          if (running) return;
          running = true;
          if (start) start();
        },
        stop() {
          if (!running) return;
          running = false;
          if (stop) stop();
        },
        get running() { return running; }
      };
    }
  };

  // Vehicle-photo + GPS helpers. The Supabase client lives on DT_AUTH, which
  // loads after utils.js, so every function resolves it lazily.
  const sbOrThrow = () => {
    const sb = window.DT_AUTH?.client;
    if (!sb) throw new Error("DT_AUTH not loaded yet");
    return sb;
  };

  async function signPhotoPaths(paths) {
    const unique = [...new Set((paths || []).filter(Boolean))];
    if (!unique.length) return {};
    const sb = sbOrThrow();
    const { data } = await sb.storage.from("vehicle-photos").createSignedUrls(unique, 600);
    const out = {};
    (data || []).forEach(u => { out[u.path] = u.signedUrl; });
    return out;
  }

  async function uploadPhoto(blob, vin) {
    const sb = sbOrThrow();
    const user = DT_AUTH.getUser();
    if (!user) throw new Error("Not signed in");
    const type = blob.type || "image/jpeg";
    const ext = type === "image/png" ? "png"
              : type === "image/webp" ? "webp"
              : type === "image/heic" || type === "image/heif" ? "heic"
              : "jpg";
    const path = `${user.id}/${vin}-${Date.now()}.${ext}`;
    const { error } = await sb.storage
      .from("vehicle-photos")
      .upload(path, blob, { contentType: type, upsert: false });
    if (error) throw error;
    return path;
  }

  async function drawToJpeg(source, w, h, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(source, 0, 0, w, h);
    return new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
  }

  // Mobile-safe resize: createImageBitmap throws on iOS HEIC photos and on
  // some Android browsers, so fall back to an <img> element, and finally to
  // returning the original file untouched so the upload still goes through.
  async function resizeImageBlob(file, maxW, maxH, quality) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const ratio = Math.min(maxW / bmp.width, maxH / bmp.height, 1);
      return await drawToJpeg(bmp, Math.round(bmp.width * ratio), Math.round(bmp.height * ratio), quality);
    } catch (_) { /* fall through */ }

    try {
      const url = URL.createObjectURL(file);
      try {
        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error("image decode failed"));
          i.src = url;
        });
        const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
        return await drawToJpeg(img, Math.round(img.naturalWidth * ratio), Math.round(img.naturalHeight * ratio), quality);
      } finally { URL.revokeObjectURL(url); }
    } catch (_) { /* fall through */ }

    return file;
  }

  function captureGps() {
    return new Promise(resolve => {
      if (!("geolocation" in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        () => resolve(null),
        { timeout: 8000, enableHighAccuracy: true, maximumAge: 30000 }
      );
    });
  }

  async function getLatestMileageAndFuel(vin) {
    const sb = sbOrThrow();
    const { data, error } = await sb.from("records")
      .select("mileage,fuel_level,ts")
      .eq("serial_id", vin)
      .order("ts", { ascending: false })
      .limit(50);
    if (error) console.warn("[DT_MEDIA] latestMileageFuel", error);
    const rows = data || [];
    const mileage = rows.find(r => Number.isFinite(r.mileage))?.mileage ?? null;
    const fuel    = rows.find(r => r.fuel_level)?.fuel_level ?? null;
    return { mileage, fuel };
  }

  window.DT_MEDIA = {
    signPhotoPaths,
    uploadPhoto,
    resizeImageBlob,
    captureGps,
    getLatestMileageAndFuel
  };
})();
