// ═══════════════════════════════════════════════════════════════════════
//  DRIVER TRAX — TRAINING ADMIN  (standalone, vanilla JS)
//  Authoring UI for training modules. Not linked from the driver menu.
//  Reads bundled modules from elearning/modules/*.json (read-only).
//  Writes custom modules to localStorage["drivertrax_elearning_custom_modules"]
//  — same key the driver-facing elearning.js reads from, so changes
//  appear in the Training tab immediately.
//  Use "Export JSON" to download a module file and commit it under
//  elearning/modules/ for permanent shipping.
//
//  Gate: SHA-256 hash of admin passphrase stored at
//        localStorage["drivertrax_admin_hash"] (per-device).
//        See the bootstrap snippet in elearning-admin.html.
// ═══════════════════════════════════════════════════════════════════════

(function () {
  const LS_CUSTOM = "drivertrax_elearning_custom_modules";
  const LS_HASH = "drivertrax_admin_hash";
  const LS_UNLOCKED = "drivertrax_admin_unlocked";
  const MODULES_INDEX_URL = "elearning/modules/index.json";

  let quizzes = [];
  let bundledIds = new Set();
  let state = { quizIdx: 0, qIdx: 0 };

  // ---------- utils ----------
  const esc = window.DT_ESC;
  function uid(prefix) {
    return (prefix || "q") + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function isCustom(id) { return !bundledIds.has(id); }
  function getCustom() {
    try { return JSON.parse(localStorage.getItem(LS_CUSTOM) || "[]"); }
    catch (e) { return []; }
  }
  function saveCustom(list) {
    localStorage.setItem(LS_CUSTOM, JSON.stringify(list));
  }
  function persistCustom() {
    saveCustom(quizzes.filter(q => isCustom(q.id)));
  }
  async function sha256(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------- gate ----------
  async function checkGate() {
    const hash = localStorage.getItem(LS_HASH);
    const sessionOk = sessionStorage.getItem(LS_UNLOCKED) === "1";
    if (!hash) {
      // No passphrase set — open. Show a hint in the admin pane.
      showAdmin(true);
      return;
    }
    if (sessionOk) { showAdmin(false); return; }
    showGate();
  }
  function showGate() {
    document.getElementById("gateWrap").style.display = "block";
    document.getElementById("adminWrap").style.display = "none";
    const pw = document.getElementById("gatePw");
    const btn = document.getElementById("gateBtn");
    const err = document.getElementById("gateErr");
    pw.focus();
    const submit = async () => {
      err.textContent = "";
      const h = await sha256(pw.value || "");
      if (h === localStorage.getItem(LS_HASH)) {
        sessionStorage.setItem(LS_UNLOCKED, "1");
        showAdmin(false);
      } else {
        err.textContent = "Incorrect passphrase";
        pw.value = ""; pw.focus();
      }
    };
    btn.addEventListener("click", submit);
    pw.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
  }
  function showAdmin(noPwSet) {
    document.getElementById("gateWrap").style.display = "none";
    document.getElementById("adminWrap").style.display = "block";
    init(noPwSet);
  }

  // ---------- loading ----------
  async function loadBundled() {
    const out = [];
    try {
      const r = await fetch(MODULES_INDEX_URL, { cache: "no-store" });
      if (!r.ok) return out;
      const idx = await r.json();
      const files = Array.isArray(idx.modules) ? idx.modules : [];
      for (const f of files) {
        try {
          const rr = await fetch("elearning/modules/" + f, { cache: "no-store" });
          if (!rr.ok) continue;
          out.push(await rr.json());
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* no manifest */ }
    return out;
  }
  async function loadAll() {
    const bundled = await loadBundled();
    bundledIds = new Set(bundled.map(m => m.id));
    const custom = getCustom();
    const map = new Map();
    bundled.forEach(m => map.set(m.id, m));
    custom.forEach(m => map.set(m.id, m));
    quizzes = Array.from(map.values());
  }

  // ---------- factories ----------
  function makeBlankQuestion(type) {
    const base = { id: uid("q"), type, prompt: "New question", image: null, explanation: "" };
    if (type === "true-false") return { ...base, correctAnswer: "true" };
    if (type === "multi-select") return { ...base, options: [{ id: "a", text: "Option A" }, { id: "b", text: "Option B" }], correctAnswer: [] };
    return { ...base, options: [{ id: "a", text: "Option A" }, { id: "b", text: "Option B" }], correctAnswer: "a" };
  }
  function makeBlankQuiz() {
    return {
      id: uid("module"),
      title: "New Module",
      category: "TRAINING",
      duration: 5,
      passingScore: 80,
      description: "",
      questions: [makeBlankQuestion("multiple-choice")]
    };
  }
  function moveQuestion(quiz, from, to) {
    const n = quiz.questions.length;
    if (from < 0 || from >= n) return;
    to = Math.max(0, Math.min(n - 1, to));
    if (from === to) return;
    const [item] = quiz.questions.splice(from, 1);
    quiz.questions.splice(to, 0, item);
    // keep selection following the moved question
    if (state.qIdx === from) state.qIdx = to;
    else if (state.qIdx > from && state.qIdx <= to) state.qIdx -= 1;
    else if (state.qIdx < from && state.qIdx >= to) state.qIdx += 1;
    persistCustom();
    render();
  }

  function exportQuiz(quiz) {
    const clean = JSON.parse(JSON.stringify(quiz));
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = (quiz.id || "module") + ".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- render ----------
  function body() { return document.getElementById("adminBody"); }

  function render(noPwSet) {
    if (!quizzes.length) {
      // create first quiz automatically
      quizzes.push(makeBlankQuiz());
      persistCustom();
    }
    if (state.quizIdx >= quizzes.length) state.quizIdx = 0;
    const quiz = quizzes[state.quizIdx];
    if (!quiz.questions || !quiz.questions.length) {
      quiz.questions = [makeBlankQuestion("multiple-choice")];
      if (isCustom(quiz.id)) persistCustom();
    }
    if (state.qIdx >= quiz.questions.length) state.qIdx = quiz.questions.length - 1;
    if (state.qIdx < 0) state.qIdx = 0;
    const q = quiz.questions[state.qIdx];
    const editable = isCustom(quiz.id);

    const b = body();
    b.innerHTML = `
      ${noPwSet ? `<div class="record" style="border-color:var(--accent);background:var(--accent-muted);margin-bottom:var(--space-4)">
        <div class="record-notes" style="color:var(--text)">
          <b>No admin passphrase set on this device.</b> Anyone with the URL can author modules.
          Open DevTools console and run the snippet on the unlock screen (refresh after) to require a passphrase.
        </div>
      </div>` : ""}

      <div class="field-label quiz-first-label">MODULE</div>
      <div style="display:flex;gap:var(--space-2);align-items:stretch;flex-wrap:wrap">
        <select id="adQuizSel" style="flex:1;min-width:200px">
          ${quizzes.map((qz, i) => `<option value="${i}"${i === state.quizIdx ? " selected" : ""}>${esc(qz.title || qz.id)}${isCustom(qz.id) ? "" : " · bundled"}</option>`).join("")}
        </select>
        <button class="quiz-type-btn" id="adNewQuiz" style="white-space:nowrap">+ NEW</button>
        <button class="quiz-type-btn" id="adExport" style="white-space:nowrap">⇩ EXPORT JSON</button>
        <button class="quiz-type-btn" id="adImport" style="white-space:nowrap">⇪ IMPORT JSON</button>
        <input type="file" id="adImportFile" accept="application/json,.json" style="display:none">
        ${editable ? `<button class="quiz-type-btn" id="adDeleteQuiz" style="white-space:nowrap;color:var(--danger);border-color:var(--danger)">✕ DELETE</button>` : ""}
      </div>

      ${editable ? `
        <div class="field-label">MODULE DETAILS</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2)">
          <input type="text" id="adTitle" value="${esc(quiz.title || "")}" placeholder="Title">
          <input type="text" id="adCategory" value="${esc(quiz.category || "")}" placeholder="Category (SAFETY/PROCESS)">
          <input type="number" id="adDuration" value="${esc(quiz.duration || 5)}" min="1" placeholder="Duration (min)">
          <input type="number" id="adPass" value="${esc(quiz.passingScore || 80)}" min="0" max="100" placeholder="Passing %">
        </div>
        <textarea id="adDesc" rows="2" placeholder="Description" style="margin-top:var(--space-2)">${esc(quiz.description || "")}</textarea>
      ` : `<div class="record"><div class="record-notes" style="color:var(--text2);font-size:var(--font-sm)">This module is loaded from <code>elearning/modules/</code> and is read-only here. To customise it, click <b>+ NEW</b>, or use <b>Import JSON</b> after editing the file directly.</div></div>`}

      <div class="today-header">
        <div class="today-title">QUESTIONS</div>
        <div class="today-count">${quiz.questions.length}</div>
      </div>

      <div class="quiz-author-list" id="adQList">
        ${quiz.questions.map((qi, i) => `
          <div class="quiz-author-item${state.qIdx === i ? " active" : ""}" data-qpick="${i}"${editable ? ` draggable="true" data-qidx="${i}"` : ""}>
            ${editable ? `<div class="quiz-drag-handle" title="Drag to reorder">⋮⋮</div>` : ""}
            <div class="quiz-author-num">Q${pad2(i + 1)}</div>
            <div class="quiz-author-text">${esc(qi.prompt || "(empty)")}</div>
            <div class="quiz-author-type">${esc((qi.type || "").split("-")[0])}</div>
            ${editable ? `<div class="quiz-author-moves">
              <button class="quiz-move-btn" data-move="up" data-qmidx="${i}" title="Move up"${i === 0 ? " disabled" : ""}>↑</button>
              <button class="quiz-move-btn" data-move="down" data-qmidx="${i}" title="Move down"${i === quiz.questions.length - 1 ? " disabled" : ""}>↓</button>
            </div>` : ""}
          </div>
        `).join("")}
      </div>

      ${editable ? `
        <div class="field-label">+ ADD QUESTION</div>
        <div class="quiz-type-row">
          <button class="quiz-type-btn" data-addq="multiple-choice">+ MULTIPLE CHOICE</button>
          <button class="quiz-type-btn" data-addq="true-false">+ TRUE / FALSE</button>
          <button class="quiz-type-btn" data-addq="multi-select">+ MULTI-SELECT</button>
          <button class="quiz-type-btn" data-addq="image-choice">+ IMAGE-BASED</button>
        </div>

        <div class="today-header">
          <div class="today-title">EDITING Q${pad2(state.qIdx + 1)}</div>
          <span class="record-status status-PM">${esc((q.type || "").replace(/-/g, " "))}</span>
        </div>

        <div class="field-label quiz-first-label">PROMPT</div>
        <textarea id="adQPrompt" rows="3">${esc(q.prompt || "")}</textarea>

        <div class="field-label">IMAGE (OPTIONAL)</div>
        <input type="text" id="adQImage" value="${esc(q.image || "")}" placeholder="https://… or upload below" class="quiz-url-input">
        <div style="display:flex;gap:var(--space-2);margin-top:var(--space-2)">
          <button class="quiz-type-btn" id="adQUpload">⇪ UPLOAD IMAGE</button>
          ${q.image ? `<button class="quiz-type-btn" id="adQClearImg" style="color:var(--danger);border-color:var(--danger)">✕ REMOVE IMAGE</button>` : ""}
          <input type="file" id="adQImgFile" accept="image/*" style="display:none">
        </div>
        ${q.image ? `<img src="${esc(q.image)}" alt="" class="quiz-image quiz-image-preview">` : ""}
        ${q.image ? `
          <div class="field-label">IMAGE CAPTION (OPTIONAL)</div>
          <input type="text" id="adQCaption" value="${esc(q.caption || "")}" placeholder="Short caption shown beneath the image">
        ` : ""}

        <div id="adQAnswerEditor"></div>

        <div class="field-label">EXPLANATION (SHOWN AFTER ANSWERING)</div>
        <textarea id="adQExplain" rows="2" placeholder="Why is this answer correct?">${esc(q.explanation || "")}</textarea>

        <button class="btn btn-danger quiz-delete-btn" id="adDelQ"${quiz.questions.length <= 1 ? " disabled" : ""}>✕ DELETE QUESTION</button>
      ` : ""}
    `;

    // ===== top toolbar handlers =====
    document.getElementById("adQuizSel").addEventListener("change", e => {
      state.quizIdx = Number(e.target.value); state.qIdx = 0; render();
    });
    document.getElementById("adNewQuiz").addEventListener("click", () => {
      const nq = makeBlankQuiz();
      quizzes.push(nq); persistCustom();
      state.quizIdx = quizzes.length - 1; state.qIdx = 0; render();
    });
    document.getElementById("adExport").addEventListener("click", () => exportQuiz(quiz));
    const importBtn = document.getElementById("adImport");
    const importFile = document.getElementById("adImportFile");
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", e => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const m = JSON.parse(reader.result);
          if (!m.id) m.id = uid("module");
          if (!Array.isArray(m.questions)) m.questions = [];
          const existingIdx = quizzes.findIndex(qq => qq.id === m.id);
          if (existingIdx >= 0 && isCustom(m.id)) {
            if (!confirm(`A module with id "${m.id}" already exists. Overwrite?`)) return;
            quizzes[existingIdx] = m;
          } else {
            if (bundledIds.has(m.id)) m.id = m.id + "-imported";
            quizzes.push(m);
          }
          persistCustom();
          state.quizIdx = quizzes.findIndex(qq => qq.id === m.id);
          state.qIdx = 0; render();
        } catch (err) { alert("Invalid JSON: " + err.message); }
      };
      reader.readAsText(f);
      importFile.value = "";
    });
    const delBtn = document.getElementById("adDeleteQuiz");
    if (delBtn) delBtn.addEventListener("click", () => {
      if (!confirm(`Delete module "${quiz.title || quiz.id}"?`)) return;
      quizzes = quizzes.filter(qq => qq.id !== quiz.id);
      persistCustom();
      state.quizIdx = 0; state.qIdx = 0; render();
    });

    // ===== question-list picker =====
    b.querySelectorAll("[data-qpick]").forEach(el => el.addEventListener("click", (e) => {
      // ignore clicks on the move buttons / drag handle so they don't change selection
      if (e.target.closest("[data-move]") || e.target.closest(".quiz-drag-handle")) return;
      state.qIdx = Number(el.dataset.qpick); render();
    }));

    if (!editable) return;

    // ===== question reorder: up/down buttons =====
    b.querySelectorAll("[data-move]").forEach(btn => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.qmidx);
      const dir = btn.dataset.move === "up" ? -1 : 1;
      moveQuestion(quiz, i, i + dir);
    }));

    // ===== question reorder: HTML5 drag-and-drop =====
    const list = document.getElementById("adQList");
    if (list) {
      let dragFrom = null;
      list.querySelectorAll("[data-qidx]").forEach(item => {
        item.addEventListener("dragstart", (e) => {
          dragFrom = Number(item.dataset.qidx);
          item.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", String(dragFrom)); } catch (_) {}
        });
        item.addEventListener("dragend", () => {
          item.classList.remove("dragging");
          list.querySelectorAll(".drop-above,.drop-below").forEach(el => el.classList.remove("drop-above", "drop-below"));
        });
        item.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = item.getBoundingClientRect();
          const above = (e.clientY - rect.top) < rect.height / 2;
          item.classList.toggle("drop-above", above);
          item.classList.toggle("drop-below", !above);
        });
        item.addEventListener("dragleave", () => {
          item.classList.remove("drop-above", "drop-below");
        });
        item.addEventListener("drop", (e) => {
          e.preventDefault();
          const to = Number(item.dataset.qidx);
          const rect = item.getBoundingClientRect();
          const above = (e.clientY - rect.top) < rect.height / 2;
          const insertAt = above ? to : to + 1;
          if (dragFrom == null || dragFrom === to) { dragFrom = null; return; }
          moveQuestion(quiz, dragFrom, insertAt > dragFrom ? insertAt - 1 : insertAt);
          dragFrom = null;
        });
      });
    }

    // ===== module field handlers =====
    document.getElementById("adTitle").addEventListener("input", e => { quiz.title = e.target.value; persistCustom(); });
    document.getElementById("adCategory").addEventListener("input", e => { quiz.category = e.target.value; persistCustom(); });
    document.getElementById("adDuration").addEventListener("input", e => { quiz.duration = Number(e.target.value) || 0; persistCustom(); });
    document.getElementById("adPass").addEventListener("input", e => { quiz.passingScore = Math.max(0, Math.min(100, Number(e.target.value) || 0)); persistCustom(); });
    document.getElementById("adDesc").addEventListener("input", e => { quiz.description = e.target.value; persistCustom(); });

    b.querySelectorAll("[data-addq]").forEach(btn => btn.addEventListener("click", () => {
      quiz.questions.push(makeBlankQuestion(btn.dataset.addq));
      persistCustom();
      state.qIdx = quiz.questions.length - 1;
      render();
    }));

    // ===== question field handlers =====
    document.getElementById("adQPrompt").addEventListener("input", e => { q.prompt = e.target.value; persistCustom(); });
    document.getElementById("adQImage").addEventListener("input", e => { q.image = e.target.value || null; persistCustom(); });
    const upBtn = document.getElementById("adQUpload");
    const upFile = document.getElementById("adQImgFile");
    upBtn.addEventListener("click", () => upFile.click());
    upFile.addEventListener("change", e => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { q.image = reader.result; persistCustom(); render(); };
      reader.readAsDataURL(f);
    });
    const clrImg = document.getElementById("adQClearImg");
    if (clrImg) clrImg.addEventListener("click", () => { q.image = null; q.caption = ""; persistCustom(); render(); });

    const capInp = document.getElementById("adQCaption");
    if (capInp) capInp.addEventListener("input", e => { q.caption = e.target.value; persistCustom(); });

    document.getElementById("adQExplain").addEventListener("input", e => { q.explanation = e.target.value; persistCustom(); });
    document.getElementById("adDelQ").addEventListener("click", () => {
      if (quiz.questions.length <= 1) return;
      quiz.questions.splice(state.qIdx, 1);
      state.qIdx = Math.max(0, Math.min(state.qIdx, quiz.questions.length - 1));
      persistCustom(); render();
    });

    renderAnswerEditor(q);
  }

  function renderAnswerEditor(q) {
    const host = document.getElementById("adQAnswerEditor");
    if (!host) return;

    if (q.type === "multiple-choice" || q.type === "image-choice") {
      host.innerHTML = `
        <div class="field-label">OPTIONS · TAP CIRCLE TO MARK CORRECT</div>
        <div id="adOpts"></div>
        <button class="quiz-type-btn quiz-add-option" id="adAddOpt">+ ADD OPTION</button>
      `;
      renderOptions(q, false);
      document.getElementById("adAddOpt").addEventListener("click", () => {
        const letter = String.fromCharCode(97 + (q.options || []).length);
        q.options = q.options || [];
        q.options.push({ id: letter, text: `Option ${letter.toUpperCase()}` });
        persistCustom(); render();
      });
    } else if (q.type === "multi-select") {
      host.innerHTML = `
        <div class="field-label">OPTIONS · TAP SQUARE TO MARK CORRECT (MULTIPLE)</div>
        <div id="adOpts"></div>
        <button class="quiz-type-btn quiz-add-option" id="adAddOpt">+ ADD OPTION</button>
      `;
      renderOptions(q, true);
      document.getElementById("adAddOpt").addEventListener("click", () => {
        const letter = String.fromCharCode(97 + (q.options || []).length);
        q.options = q.options || [];
        q.options.push({ id: letter, text: `Option ${letter.toUpperCase()}` });
        if (!Array.isArray(q.correctAnswer)) q.correctAnswer = [];
        persistCustom(); render();
      });
    } else if (q.type === "true-false") {
      host.innerHTML = `
        <div class="field-label">CORRECT ANSWER</div>
        <div class="quiz-tf-row quiz-tf-row-compact">
          ${["true", "false"].map(v => `<button class="quiz-tf-btn quiz-tf-btn-compact${q.correctAnswer === v ? " selected" : ""}" data-tfans="${v}">${v}</button>`).join("")}
        </div>
      `;
      host.querySelectorAll("[data-tfans]").forEach(btn => btn.addEventListener("click", () => {
        q.correctAnswer = btn.dataset.tfans; persistCustom(); render();
      }));
    }
  }

  function renderOptions(q, multi) {
    const wrap = document.getElementById("adOpts");
    const isCorr = id => multi ? (q.correctAnswer || []).includes(id) : q.correctAnswer === id;
    wrap.innerHTML = (q.options || []).map((opt, i) => `
      <div class="quiz-option-row">
        <button class="quiz-option-mark${isCorr(opt.id) ? " correct" : ""}${multi ? " square" : ""}" data-mark="${esc(opt.id)}">${isCorr(opt.id) ? "✓" : ""}</button>
        <input type="text" class="quiz-option-input" data-optedit="${i}" value="${esc(opt.text || "")}">
        <button class="quiz-option-del" data-optdel="${i}"${(q.options || []).length <= 2 ? " disabled" : ""}>×</button>
      </div>
    `).join("");
    wrap.querySelectorAll("[data-mark]").forEach(btn => btn.addEventListener("click", () => {
      const id = btn.dataset.mark;
      if (multi) {
        const ca = Array.isArray(q.correctAnswer) ? q.correctAnswer.slice() : [];
        q.correctAnswer = ca.includes(id) ? ca.filter(x => x !== id) : [...ca, id];
      } else {
        q.correctAnswer = id;
      }
      persistCustom(); render();
    }));
    wrap.querySelectorAll("[data-optedit]").forEach(inp => inp.addEventListener("input", e => {
      const i = Number(inp.dataset.optedit);
      q.options[i].text = e.target.value;
      persistCustom();
    }));
    wrap.querySelectorAll("[data-optdel]").forEach(btn => btn.addEventListener("click", () => {
      if ((q.options || []).length <= 2) return;
      const i = Number(btn.dataset.optdel);
      const removedId = q.options[i].id;
      q.options.splice(i, 1);
      if (multi && Array.isArray(q.correctAnswer)) {
        q.correctAnswer = q.correctAnswer.filter(x => x !== removedId);
      } else if (q.correctAnswer === removedId) {
        q.correctAnswer = (q.options[0] || {}).id || "";
      }
      persistCustom(); render();
    }));
  }

  // ---------- bootstrap ----------
  async function init(noPwSet) {
    await loadAll();
    render(noPwSet);
  }

  document.addEventListener("DOMContentLoaded", checkGate);
})();
