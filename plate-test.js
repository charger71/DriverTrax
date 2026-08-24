// ============================================================
// PLATE OCR SPIKE — standalone test harness (plate-test.html)
//
// Not part of the app: index.html does not load this, sw.js does not
// precache it. Its only job is to answer one question with real numbers
// before any of this gets designed into DriverTrax —
//
//   can a phone browser read lot plates well enough to be worth it?
//
// So every accepted read is logged with what produced it (preprocess mode,
// page-seg mode, confidence, ms) and gets judged correct/wrong by the person
// holding the phone. "Copy JSON" hands that dataset back for a go/no-go call.
//
// Deliberately self-contained — no DT_AUTH, no Supabase, nothing written to
// the fleet. Results live in localStorage on the tester's device.
// ============================================================
(function () {
  const $ = (id) => document.getElementById(id);
  // utils.js always defines DT_ESC, but a fallback that does not escape would
  // be a trap sitting behind a function named esc().
  const esc = window.DT_ESC || ((s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const STORE_KEY = "dt_plate_test_v1";

  // Plates are 4-8 characters in practice (vanity plates run long, some
  // states run short). Anything outside that is a misread of the state name,
  // the slogan, or the frame, so it never reaches the list.
  const MIN_LEN = 4;
  const MAX_LEN = 8;
  const VOTE_WINDOW_MS = 2500;   // how long a candidate stays eligible to be confirmed
  const REACCEPT_MS = 6000;      // same plate can't re-fire inside this window
  const OCR_WIDTH = 800;         // crop is scaled to this before recognition

  // Lines the OCR pulls off the plate that are never the plate number.
  // Not exhaustive by design — it only has to beat the obvious cases so the
  // tester isn't judging "PENNSYLVANIA" as a failed plate read.
  const STOP_WORDS = new Set([
    "NEW","YORK","JERSEY","HAMPSHIRE","MEXICO","PENNSYLVANIA","VIRGINIA","WEST",
    "NORTH","SOUTH","CAROLINA","DAKOTA","RHODE","ISLAND","CONNECTICUT","VERMONT",
    "MAINE","MASSACHUSETTS","MARYLAND","DELAWARE","OHIO","INDIANA","ILLINOIS",
    "MICHIGAN","FLORIDA","GEORGIA","TEXAS","CALIFORNIA","NEVADA","ARIZONA",
    "GARDEN","STATE","EMPIRE","SUNSHINE","LIBERTY","GRACE","FIRST","FLIGHT",
    "ENTERPRISE","RENTAL","TEMP","TEMPORARY","TAG","JAN","FEB","MAR","APR",
    "JUN","JUL","AUG","SEP","OCT","NOV","DEC"
  ]);

  // --- state ---
  let worker = null;
  let workerState = "idle";      // idle | loading | ready | failed
  let stream = null;
  let running = false;
  let torchOn = false;
  let loopToken = 0;             // bumped on stop, so an in-flight recognize retires
  let reads = [];
  let votes = [];                // [{ plate, conf, at }] inside VOTE_WINDOW_MS
  let lastAccept = { plate: "", at: 0 };
  let fixingId = null;           // row currently showing its correction input
  let clearArmed = false;
  let cropCanvas = null, cropCtx = null;
  let thumbCanvas = null, thumbCtx = null;
  let beepCtx = null;

  // ---------- storage ----------

  function loadReads() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  // Thumbnails are the bulk of the payload, so a quota failure drops the
  // oldest ones rather than losing the reads themselves — the judgements are
  // the data that matters, the picture is just there to judge against.
  function saveReads() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(reads));
    } catch (e) {
      let trimmed = 0;
      for (let i = reads.length - 1; i >= 0 && trimmed < reads.length; i--) {
        if (reads[i].thumb) { reads[i].thumb = ""; trimmed++; }
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(reads));
          setStatus("Storage full — dropped " + trimmed + " thumbnail(s)", "warn");
          return;
        } catch (e2) { /* keep trimming */ }
      }
      setStatus("Could not save results (storage full)", "error");
    }
  }

  // ---------- small helpers ----------

  function setStatus(text, kind) {
    const el = $("ptStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "pt-status" + (kind ? " pt-status--" + kind : "");
  }

  function setLive(text, kind) {
    const el = $("ptLive");
    if (!el) return;
    el.textContent = text;
    el.className = "pt-live" + (kind ? " pt-live--" + kind : "");
  }

  function haptic(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  // One AudioContext for the session: iOS Safari caps live contexts at a
  // handful and silently stops playing audio once you pass it.
  function beep() {
    try {
      if (!beepCtx) beepCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (beepCtx.state === "suspended") { try { beepCtx.resume(); } catch (e) {} }
      const osc = beepCtx.createOscillator();
      const gain = beepCtx.createGain();
      osc.connect(gain); gain.connect(beepCtx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(1480, beepCtx.currentTime);
      gain.gain.setValueAtTime(0.3, beepCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, beepCtx.currentTime + 0.12);
      osc.start(beepCtx.currentTime);
      osc.stop(beepCtx.currentTime + 0.12);
      osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
    } catch (e) {}
  }

  function flash() {
    const el = $("ptFlash");
    if (!el) return;
    el.classList.remove("on");
    void el.offsetWidth;
    el.classList.add("on");
  }

  const opt = (id, fallback) => ($(id) && $(id).value) || fallback;

  // ---------- camera ----------

  async function startCamera() {
    // Plates get read from several feet away, not the 4-6 inches a lot tag is
    // held at, so ask for more pixels than the barcode scanner does.
    const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const tries = [
      { ...base, facingMode: { exact: "environment" }, advanced: [{ focusMode: "continuous" }] },
      { ...base, facingMode: { ideal: "environment" } },
      { facingMode: { ideal: "environment" } }
    ];
    let lastErr = null;
    for (const video of tries) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: false, video });
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("no camera");
  }

  function attachStream(s) {
    const video = $("ptVideo");
    video.srcObject = s;
    video.setAttribute("playsinline", "true");
    video.muted = true;
    const sizeStage = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      // Match the stage to the frame's aspect so the ROI box drawn in CSS
      // percentages lands on exactly the pixels we crop. Anything else
      // (object-fit: cover) means the box lies about what is being read.
      $("ptStage").style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
    };
    video.addEventListener("loadedmetadata", sizeStage, { once: true });
    sizeStage();
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
    return video;
  }

  function stopCamera() {
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      stream = null;
    }
    const video = $("ptVideo");
    if (video) video.srcObject = null;
    torchOn = false;
    const tb = $("ptTorchBtn");
    if (tb) tb.classList.remove("on");
  }

  async function toggleTorch() {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      torchOn = !torchOn;
      $("ptTorchBtn").classList.toggle("on", torchOn);
    } catch (e) {
      setStatus("Flashlight not available on this camera", "warn");
    }
  }

  // ---------- frame capture + preprocessing ----------

  // The ROI is defined in fractions of the frame and mirrored by .pt-roi in
  // CSS: 86% wide, 2:1 (a US plate is 12x6). Keep the two in sync.
  const ROI = { wPct: 0.86, aspect: 2 };

  function grabCrop() {
    const video = $("ptVideo");
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;

    const sw = Math.round(vw * ROI.wPct);
    const sh = Math.min(Math.round(sw / ROI.aspect), vh);
    const sx = Math.round((vw - sw) / 2);
    const sy = Math.round((vh - sh) / 2);

    const dw = OCR_WIDTH;
    const dh = Math.round(sh * (dw / sw));
    if (!cropCanvas) { cropCanvas = document.createElement("canvas"); cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true }); }
    if (cropCanvas.width !== dw || cropCanvas.height !== dh) { cropCanvas.width = dw; cropCanvas.height = dh; }
    cropCtx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    preprocess(cropCtx, dw, dh, opt("ptPrep", "gray"));
    return cropCanvas;
  }

  function percentile(hist, total, p) {
    let seen = 0;
    const target = total * p;
    for (let i = 0; i < 256; i++) {
      seen += hist[i];
      if (seen >= target) return i;
    }
    return 255;
  }

  // Otsu: pick the grey level that best separates dark ink from light plate.
  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = t; }
    }
    return best;
  }

  // Tesseract wants dark text on a light background with the contrast already
  // pulled apart; a raw phone frame of a plate in shade gives it neither.
  function preprocess(ctx, w, h, mode) {
    if (mode === "none") return;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      hist[g]++;
    }
    const total = (d.length / 4) | 0;

    if (mode === "gray") {
      // Percentile stretch, not min/max: one specular highlight or one dark
      // bolt hole would otherwise consume the whole range and stretch nothing.
      const lo = percentile(hist, total, 0.02);
      const hi = percentile(hist, total, 0.98);
      const span = Math.max(1, hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        let v = ((d[i] - lo) * 255) / span;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    } else {
      const t = otsu(hist, total);
      const invert = mode === "binary-invert";
      for (let i = 0; i < d.length; i += 4) {
        const on = d[i] > t;
        const v = (invert ? !on : on) ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function makeThumb(canvas) {
    const w = 240;
    const h = Math.max(1, Math.round(canvas.height * (w / canvas.width)));
    if (!thumbCanvas) { thumbCanvas = document.createElement("canvas"); thumbCtx = thumbCanvas.getContext("2d"); }
    thumbCanvas.width = w; thumbCanvas.height = h;
    thumbCtx.drawImage(canvas, 0, 0, w, h);
    try { return thumbCanvas.toDataURL("image/jpeg", 0.6); } catch (e) { return ""; }
  }

  // ---------- OCR ----------

  async function ensureWorker() {
    if (workerState === "ready") return worker;
    if (workerState === "loading") return null;
    if (typeof window.Tesseract === "undefined") {
      workerState = "failed";
      setStatus("Tesseract failed to load — needs a connection on first run", "error");
      return null;
    }
    workerState = "loading";
    setStatus("Loading OCR engine (~4 MB, first run only)…");
    try {
      // oem 1 = LSTM only. Pulls the smaller integer model and skips the
      // legacy engine entirely, which is the bulk of the download.
      worker = await window.Tesseract.createWorker("eng", 1, {
        logger: (m) => {
          if (m.status === "downloading tesseract core" || m.status === "loading language traineddata") {
            setStatus(m.status + " " + Math.round((m.progress || 0) * 100) + "%");
          }
        }
      });
      await applyParams();
      workerState = "ready";
      setStatus("OCR ready");
      return worker;
    } catch (e) {
      workerState = "failed";
      setStatus("OCR engine failed: " + (e && e.message ? e.message : e), "error");
      return null;
    }
  }

  async function applyParams() {
    if (!worker) return;
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: opt("ptPsm", "7"),
      // Plates are not words. The dictionaries actively hurt: they bend
      // "8HG2" toward something spellable.
      load_system_dawg: "0",
      load_freq_dawg: "0",
      user_defined_dpi: "300"
    });
  }

  // ---------- candidate selection ----------

  function normalize(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // OCR over a plate returns the number plus whatever else is on the plate —
  // state name, slogan, sticker. Score the lines and keep the one that looks
  // like a plate rather than trusting line order.
  function pickPlate(text) {
    const lines = String(text || "").split(/\r?\n/);
    let best = null, bestScore = -1;
    for (const line of lines) {
      const raw = line.trim().toUpperCase();
      if (!raw) continue;
      const plate = normalize(raw);
      if (plate.length < MIN_LEN || plate.length > MAX_LEN) continue;
      if (STOP_WORDS.has(plate)) continue;
      const hasDigit = /[0-9]/.test(plate);
      const hasAlpha = /[A-Z]/.test(plate);
      let score = 0;
      if (hasDigit) score += 3;            // almost every plate carries a digit
      if (hasDigit && hasAlpha) score += 2; // and most mix the two
      if (plate.length >= 6) score += 1;
      if (!hasDigit && plate.length > 3) score -= 2; // probably the state name
      if (score > bestScore) { bestScore = score; best = plate; }
    }
    return bestScore >= 1 ? best : null;
  }

  function voteFor(plate, conf) {
    const now = performance.now();
    votes = votes.filter((v) => now - v.at < VOTE_WINDOW_MS);
    votes.push({ plate, conf, at: now });
    return votes.filter((v) => v.plate === plate).length;
  }

  // ---------- the scan loop ----------

  // Self-scheduling rather than a `while` loop: each pass awaits a recognize
  // that can outlive a stop(), so the token check has to happen on re-entry.
  async function runLoop() {
    const token = loopToken;
    const w = await ensureWorker();
    if (!w || token !== loopToken) return;
    setStatus("Scanning");

    const step = async () => {
      if (!running || token !== loopToken) return;
      const canvas = grabCrop();
      if (!canvas) { setTimeout(step, 120); return; }   // camera hasn't produced a frame yet
      const started = performance.now();
      let res = null;
      try {
        res = await w.recognize(canvas);
      } catch (e) {
        if (token !== loopToken) return;
        setStatus("Recognize failed: " + (e && e.message ? e.message : e), "error");
        setTimeout(step, 400);
        return;
      }
      if (!running || token !== loopToken) return;
      handleResult(res, canvas, Math.round(performance.now() - started), "live");
      setTimeout(step, 0);
    };
    step();
  }

  function handleResult(res, canvas, ms, source) {
    const data = (res && res.data) || {};
    const conf = Math.round(data.confidence || 0);
    const plate = pickPlate(data.text);
    const minConf = parseInt(opt("ptMinConf", "55"), 10);

    if (!plate) {
      setLive("no plate-shaped text · " + ms + " ms", "dim");
      return;
    }
    if (conf < minConf && source === "live") {
      setLive(plate + " · " + conf + "% (below " + minConf + "%) · " + ms + " ms", "dim");
      return;
    }

    // A single shot is the tester deliberately forcing a read, so it skips
    // the vote — that is the point of the button.
    const needed = source === "shot" ? 1 : parseInt(opt("ptVotes", "2"), 10);
    const count = source === "shot" ? needed : voteFor(plate, conf);
    if (count < needed) {
      setLive(plate + " · " + conf + "% · " + count + "/" + needed + " · " + ms + " ms");
      return;
    }

    const now = performance.now();
    if (plate === lastAccept.plate && now - lastAccept.at < REACCEPT_MS) {
      setLive(plate + " · already logged", "dim");
      return;
    }
    lastAccept = { plate, at: now };
    votes = [];
    accept(plate, conf, canvas, ms, source);
  }

  function accept(plate, conf, canvas, ms, source) {
    reads.unshift({
      id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7),
      plate,
      conf,
      ms,
      source,
      prep: opt("ptPrep", "gray"),
      psm: opt("ptPsm", "7"),
      ts: Date.now(),
      thumb: makeThumb(canvas),
      verdict: "",     // "" | "ok" | "bad"
      truth: ""
    });
    saveReads();
    render();
    setLive(plate + " · " + conf + "% · logged", "ok");
    flash();
    beep();
    haptic(40);
  }

  async function singleShot() {
    const w = await ensureWorker();
    if (!w) return;
    const canvas = grabCrop();
    if (!canvas) { setStatus("No camera frame yet", "warn"); return; }
    const btn = $("ptShotBtn");
    btn.disabled = true;
    const started = performance.now();
    try {
      const res = await w.recognize(canvas);
      handleResult(res, canvas, Math.round(performance.now() - started), "shot");
    } catch (e) {
      setStatus("Recognize failed: " + (e && e.message ? e.message : e), "error");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- start / stop ----------

  async function start() {
    if (running) return;
    try {
      stream = await startCamera();
    } catch (e) {
      setStatus("Camera unavailable: " + (e && e.name ? e.name : e), "error");
      return;
    }
    attachStream(stream);
    running = true;
    loopToken++;
    $("ptStartBtn").textContent = "Stop";
    $("ptStartBtn").classList.remove("btn-primary");
    $("ptStartBtn").classList.add("btn-destructive");
    $("ptShotBtn").disabled = false;
    $("ptTorchBtn").disabled = false;
    runLoop();
  }

  function stop() {
    running = false;
    loopToken++;      // retires any recognize still in flight
    votes = [];
    stopCamera();
    $("ptStartBtn").textContent = "Start scanning";
    $("ptStartBtn").classList.add("btn-primary");
    $("ptStartBtn").classList.remove("btn-destructive");
    $("ptShotBtn").disabled = true;
    $("ptTorchBtn").disabled = true;
    setStatus(workerState === "ready" ? "Stopped" : "Idle");
    setLive("—", "dim");
  }

  // ---------- results list ----------

  function stats() {
    const ok = reads.filter((r) => r.verdict === "ok").length;
    const bad = reads.filter((r) => r.verdict === "bad").length;
    const judged = ok + bad;
    const times = reads.map((r) => r.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : 0;
    return { ok, bad, judged, median, total: reads.length };
  }

  function renderStats() {
    const el = $("ptStats");
    if (!el) return;
    const s = stats();
    const acc = s.judged ? Math.round((s.ok / s.judged) * 100) + "%" : "—";
    el.innerHTML =
      statCell(s.total, "reads") +
      statCell(s.ok, "correct") +
      statCell(s.bad, "wrong") +
      statCell(s.total - s.judged, "unjudged") +
      statCell(acc, "accuracy") +
      statCell(s.median ? s.median + " ms" : "—", "median");
  }

  function statCell(num, label) {
    return '<div class="pt-stat"><div class="pt-stat-num">' + esc(num) +
           '</div><div class="pt-stat-label">' + esc(label) + "</div></div>";
  }

  function renderList() {
    const el = $("ptList");
    if (!el) return;
    if (!reads.length) {
      el.innerHTML = '<li class="pt-empty">No reads yet. Start scanning and fill the box with a plate.</li>';
      return;
    }
    el.innerHTML = reads.map(rowHtml).join("");
  }

  function rowHtml(r) {
    const time = window.DT_FORMAT ? DT_FORMAT.time(r.ts) : "";
    const meta = [
      r.conf + "%",
      r.ms + " ms",
      r.prep + " / PSM " + r.psm,
      r.source === "shot" ? "shot" : "live",
      time
    ].filter(Boolean).join(" · ");

    const verdict =
      r.verdict === "ok"  ? '<span class="pt-tag pt-tag--ok">correct</span>' :
      r.verdict === "bad" ? '<span class="pt-tag pt-tag--bad">read ' + esc(r.truth || "?") + "</span>" :
      "";

    const fixing = fixingId === r.id;
    return '<li class="pt-row" data-id="' + esc(r.id) + '">' +
      (r.thumb ? '<img class="pt-thumb" src="' + esc(r.thumb) + '" alt="What the OCR saw">' : '<div class="pt-thumb pt-thumb--none"></div>') +
      '<div class="pt-row-main">' +
        '<div class="pt-plate">' + esc(r.plate) + "</div>" +
        '<div class="pt-meta">' + esc(meta) + "</div>" +
        verdict +
        (fixing
          ? '<div class="pt-fix"><input class="pt-fix-input" type="text" inputmode="text" autocapitalize="characters" ' +
            'value="' + esc(r.truth || r.plate) + '" aria-label="Actual plate">' +
            '<button class="btn btn--sm btn-primary" data-act="save">Save</button></div>'
          : "") +
      "</div>" +
      '<div class="pt-row-actions">' +
        '<button class="btn btn-icon btn--sm" data-act="ok" aria-label="Mark correct">&#10003;</button>' +
        '<button class="btn btn-icon btn--sm" data-act="fix" aria-label="Enter actual plate">&#9998;</button>' +
        '<button class="btn btn-icon btn--sm" data-act="del" aria-label="Delete read">&#10005;</button>' +
      "</div>" +
    "</li>";
  }

  function render() {
    renderStats();
    renderList();
  }

  function onListClick(e) {
    const btn = e.target.closest && e.target.closest("button[data-act]");
    if (!btn) return;
    const li = btn.closest(".pt-row");
    if (!li) return;
    const id = li.getAttribute("data-id");
    const r = reads.find((x) => x.id === id);
    if (!r) return;
    const act = btn.getAttribute("data-act");

    if (act === "ok") {
      r.verdict = "ok"; r.truth = r.plate; fixingId = null;
    } else if (act === "fix") {
      fixingId = fixingId === id ? null : id;
    } else if (act === "del") {
      reads = reads.filter((x) => x.id !== id);
      if (fixingId === id) fixingId = null;
    } else if (act === "save") {
      const input = li.querySelector(".pt-fix-input");
      const truth = normalize(input && input.value);
      if (!truth) return;
      r.truth = truth;
      // Typing the same string the OCR produced is a correct read, not a
      // correction — otherwise a tester who "fixes" a good read scores it wrong.
      r.verdict = truth === r.plate ? "ok" : "bad";
      fixingId = null;
    }
    saveReads();
    render();
  }

  function copyJson() {
    const payload = {
      exported: new Date().toISOString(),
      ua: navigator.userAgent,
      stats: stats(),
      // Thumbnails are for judging on the phone, not for the report.
      reads: reads.map((r) => ({
        plate: r.plate, truth: r.truth, verdict: r.verdict, conf: r.conf,
        ms: r.ms, prep: r.prep, psm: r.psm, source: r.source, ts: r.ts
      }))
    };
    const text = JSON.stringify(payload, null, 2);
    const done = () => setStatus("Results copied to clipboard", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => setStatus("Copy failed", "error"));
    } else {
      setStatus("Clipboard unavailable in this browser", "warn");
    }
  }

  // Two-tap confirm instead of confirm(): native dialogs are suppressed in
  // some WKWebView configurations, where a suppressed confirm() silently
  // returns false and the button appears dead.
  function onClear() {
    const btn = $("ptClearBtn");
    if (!clearArmed) {
      clearArmed = true;
      btn.textContent = "Tap again to clear";
      btn.classList.add("btn-destructive");
      setTimeout(() => {
        if (!clearArmed) return;
        clearArmed = false;
        btn.textContent = "Clear all";
        btn.classList.remove("btn-destructive");
      }, 4000);
      return;
    }
    clearArmed = false;
    btn.textContent = "Clear all";
    btn.classList.remove("btn-destructive");
    reads = [];
    fixingId = null;
    saveReads();
    render();
  }

  // ---------- wiring ----------

  function init() {
    reads = loadReads();
    render();
    setLive("—", "dim");
    setStatus("Idle");

    $("ptStartBtn").addEventListener("click", () => (running ? stop() : start()));
    $("ptShotBtn").addEventListener("click", singleShot);
    $("ptTorchBtn").addEventListener("click", toggleTorch);
    $("ptCopyBtn").addEventListener("click", copyJson);
    $("ptClearBtn").addEventListener("click", onClear);
    $("ptList").addEventListener("click", onListClick);
    // PSM is a Tesseract parameter, so it has to be pushed into the worker;
    // preprocess mode and the thresholds are read per frame.
    $("ptPsm").addEventListener("change", () => { applyParams().catch(() => {}); });

    // Leaving the page with the camera running would keep the torch lit and
    // the lens hot behind whatever the user switched to.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && running) stop();
    });
    window.addEventListener("pagehide", () => { if (running) stop(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
