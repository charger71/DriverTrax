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
  // Twitter-style relative time. Lives here rather than in announcements.js:
  // that had the shared utility delegating to a feature module via a
  // window.dtTimeAgo global, so relative times silently degraded to full
  // timestamps whenever that module hadn't loaded.
  //
  // Default prefix is "" ("5 min ago"). Announcements passes "Posted " for
  // its own phrasing.
  const timeAgo = (v, prefix = "") => {
    const d = toDate(v);
    if (!valid(d)) return "";
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 5)  return "Just now";
    if (s < 60) return `${prefix}${s} sec ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${prefix}${m} min${m === 1 ? "" : "s"} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${prefix}${h} hour${h === 1 ? "" : "s"} ago`;
    const dd = Math.floor(h / 24);
    if (dd < 7) return `${prefix}${dd} day${dd === 1 ? "" : "s"} ago`;
    return `${prefix}${d.toLocaleDateString(undefined, { timeZone: TZ })}`;
  };
  const timeAgoOrClock = (v) => timeAgo(v);

  window.DT_ESC = esc;
  window.DT_FORMAT = { time, date, dateTime, timeAgo, timeAgoOrClock, TZ };
  // Long-standing shorthand used across app.js and backlot.js. Now a plain
  // alias rather than the thing DT_FORMAT depended on.
  window.dtTimeAgo = timeAgo;

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
  // Resolve a CSS custom property to its current value. Canvas, Leaflet
  // divIcons and inline SVG fills can't use var(), so anything drawn that way
  // has to read the token instead of hardcoding a hex — otherwise it keeps
  // the dark-theme color on a light page. Cached per theme, since a render
  // pass can ask for the same token once per marker.
  let _cssVarCache = {};
  let _cssVarTheme = null;
  window.DT_UI = {
    setMessage(el, text, kind) {
      if (!el) return;
      el.textContent = text || "";
      el.className = "users-modal-msg" + (kind ? " " + kind : "");
    },
    // Promise<boolean> confirmation on the .users-modal pattern. Native
    // confirm() blocks the main thread, can't be styled, looks wrong in a
    // standalone PWA, and is suppressed in some WKWebView configurations —
    // which matters here, because a suppressed confirm() returns false and
    // the action silently does nothing.
    //
    //   if (!await DT_UI.confirm({ title: "Delete user?",
    //                              body: "This cannot be undone.",
    //                              okLabel: "Delete", danger: true })) return;
    confirm({ title = "Are you sure?", body = "", okLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
      const modal  = document.getElementById("dtConfirmModal");
      const titleEl = document.getElementById("dtConfirmTitle");
      const bodyEl  = document.getElementById("dtConfirmBody");
      const okBtn   = document.getElementById("dtConfirmOk");
      const cancelBtn = document.getElementById("dtConfirmCancel");
      const closeBtn  = document.getElementById("dtConfirmClose");
      // No markup (a page that doesn't include the dialog) — refuse rather
      // than silently proceeding with a destructive action.
      if (!modal || !titleEl || !bodyEl || !okBtn || !cancelBtn || !closeBtn) {
        console.warn("[DT_UI] #dtConfirmModal missing; treating confirm as declined");
        return Promise.resolve(false);
      }

      titleEl.textContent = title;
      bodyEl.textContent = body;
      okBtn.textContent = okLabel;
      cancelBtn.textContent = cancelLabel;
      okBtn.className = "btn " + (danger ? "btn-destructive" : "btn-primary");

      return new Promise((resolve) => {
        const finish = (result) => {
          modal.classList.remove("show");
          modal.setAttribute("aria-hidden", "true");
          okBtn.removeEventListener("click", onOk);
          cancelBtn.removeEventListener("click", onCancel);
          closeBtn.removeEventListener("click", onCancel);
          modal.removeEventListener("click", onBackdrop);
          document.removeEventListener("keydown", onKey);
          resolve(result);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        const onBackdrop = (e) => { if (e.target === modal) finish(false); };
        const onKey = (e) => { if (e.key === "Escape") finish(false); };

        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        closeBtn.addEventListener("click", onCancel);
        modal.addEventListener("click", onBackdrop);
        document.addEventListener("keydown", onKey);

        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");
        okBtn.focus();
      });
    },
    cssVar(name, fallback = "#888888") {
      const theme = document.documentElement.getAttribute("data-theme") || "";
      if (theme !== _cssVarTheme) { _cssVarCache = {}; _cssVarTheme = theme; }
      if (name in _cssVarCache) return _cssVarCache[name];
      let value = "";
      try {
        value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      } catch (_) { /* no computed style (tests, detached doc) */ }
      return (_cssVarCache[name] = value || fallback);
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
    let mileage = rows.find(r => Number.isFinite(r.mileage))?.mileage ?? null;
    const fuel  = rows.find(r => r.fuel_level)?.fuel_level ?? null;
    // No driver-submitted mileage yet — fall back to the odometer reading
    // inventory-import.js seeded onto the vehicles row. Imported cars sit
    // under just their VIN's last 8 characters until a real scan is saved
    // (see vehicle-vin-suffix-reconcile-schema.sql), so try the full VIN
    // first, then that short suffix. There's no vehicles-level fallback for
    // fuel — the sheets this app imports from don't carry a fuel reading.
    if (mileage === null) {
      const key = String(vin || "").toUpperCase();
      let { data: v } = await sb.from("vehicles").select("mileage").eq("serial_id", key).maybeSingle();
      if (!v && key.length === 17) {
        ({ data: v } = await sb.from("vehicles").select("mileage").eq("serial_id", key.slice(-8)).maybeSingle());
      }
      if (Number.isFinite(v?.mileage)) mileage = v.mileage;
    }
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
