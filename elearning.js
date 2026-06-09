// ═══════════════════════════════════════════════════════════════════════
//  DRIVER TRAX — TRAINING / E-LEARNING MODULE  (driver-facing, vanilla JS)
//  Mounts into #elearningRoot inside the existing #panel-training panel.
//  Sub-tabs: TRAIN · MY HISTORY  (authoring lives in elearning-admin.html)
//  Quizzes load from elearning/modules/*.json (manifest: index.json) plus
//  any admin-authored quizzes saved to localStorage by the admin page.
//  Attempt history persists to localStorage.
// ═══════════════════════════════════════════════════════════════════════

(function () {
  const LS_CUSTOM = "drivertrax_elearning_custom_modules";
  const LS_RESULTS = "drivertrax_elearning_results";
  const MODULES_INDEX_URL = "elearning/modules/index.json";

  // ---------- state ----------
  let quizzes = [];           // merged list (custom override bundled by id)
  let bundledIds = new Set(); // ids that come from disk (read-only)
  let view = { tab: "train", stage: "catalog", quizId: null, qIdx: 0, answers: {}, startTs: 0, elapsed: 0, timerId: null };
  let buildState = { quizIdx: 0, qIdx: 0 };
  let initialized = false;
  let mounted = false;

  // ---------- utils ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function uid(prefix) {
    return (prefix || "q") + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function getResults() {
    try { return JSON.parse(localStorage.getItem(LS_RESULTS) || "[]"); }
    catch (e) { return []; }
  }
  function saveResult(r) {
    const arr = getResults();
    arr.push(r);
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    localStorage.setItem(LS_RESULTS, JSON.stringify(arr));
  }
  function getCustom() {
    try { return JSON.parse(localStorage.getItem(LS_CUSTOM) || "[]"); }
    catch (e) { return []; }
  }
  function saveCustom(list) {
    localStorage.setItem(LS_CUSTOM, JSON.stringify(list));
  }
  function isCustom(id) { return !bundledIds.has(id); }

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
          const m = await rr.json();
          out.push(m);
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
    custom.forEach(m => map.set(m.id, m)); // custom overrides
    quizzes = Array.from(map.values());
  }

  // ---------- grading ----------
  function isCorrect(q, a) {
    if (q.type === "multi-select") {
      const ca = Array.isArray(q.correctAnswer) ? q.correctAnswer : [];
      return Array.isArray(a) && a.length === ca.length && a.every(x => ca.includes(x));
    }
    return a === q.correctAnswer;
  }

  // ---------- root mount ----------
  function root() {
    return document.getElementById("elearningRoot");
  }

  function render() {
    const r = root();
    if (!r) return;
    r.innerHTML = `
      <div class="tabs training-subtabs">
        <div class="tab${view.tab === "train" ? " active" : ""}" data-tab="train">TRAIN</div>
        <div class="tab${view.tab === "reports" ? " active" : ""}" data-tab="reports">MY HISTORY</div>
      </div>
      <div class="training-body" id="elBody"></div>
    `;
    r.querySelectorAll(".tab[data-tab]").forEach(t => {
      t.addEventListener("click", () => {
        view.tab = t.dataset.tab;
        if (view.tab !== "train") stopTimer();
        if (view.tab === "train") { view.stage = "catalog"; view.quizId = null; }
        render();
      });
    });
    if (view.tab === "train") renderTrain();
    else renderReports();
  }

  function body() { return document.getElementById("elBody"); }

  // ═══════════════════════════════════════════════════════════════════
  //  TRAIN  ·  Catalog / Runner / Results
  // ═══════════════════════════════════════════════════════════════════
  function renderTrain() {
    if (view.stage === "catalog" || !view.quizId) return renderCatalog();
    const quiz = quizzes.find(q => q.id === view.quizId);
    if (!quiz) { view.stage = "catalog"; return renderCatalog(); }
    if (view.stage === "taking") return renderRunner(quiz);
    if (view.stage === "done") return renderResults(quiz);
  }

  function renderCatalog() {
    const b = body();
    b.innerHTML = `
      <div class="today-header training-catalog-head">
        <div class="today-title">ASSIGNED MODULES</div>
        <div class="today-count">${quizzes.length}</div>
      </div>
      ${quizzes.length ? "" : `<div class="record"><div class="record-notes">No modules assigned.</div></div>`}
      ${quizzes.map(q => `
        <div class="record" data-start="${esc(q.id)}">
          <div class="record-header">
            <div class="record-serial">${esc(q.title || q.id)}</div>
            <div class="record-badges">
              <span class="record-status ${q.category === "SAFETY" ? "status-DIRTY" : "status-CLEAN"}">${esc(q.category || "TRAINING")}</span>
            </div>
          </div>
          <div class="record-meta">
            <b>${(q.questions || []).length}</b> QUESTIONS &nbsp;·&nbsp; ~<b>${esc(q.duration || 0)}</b> MIN &nbsp;·&nbsp; PASS <b>${esc(q.passingScore || 80)}%</b>
          </div>
          <div class="record-notes">${esc(q.description || "")}</div>
          <button class="btn btn-primary quiz-card-cta">▸ START MODULE</button>
        </div>
      `).join("")}
    `;
    b.querySelectorAll("[data-start]").forEach(el => {
      el.addEventListener("click", () => {
        view.quizId = el.dataset.start;
        view.stage = "taking";
        view.qIdx = 0;
        view.answers = {};
        view.startTs = Date.now();
        view.elapsed = 0;
        startTimer();
        render();
      });
    });
  }

  function startTimer() {
    stopTimer();
    view.timerId = setInterval(() => {
      view.elapsed = Date.now() - view.startTs;
      const t = document.getElementById("elQuizTimer");
      if (t) {
        const mins = Math.floor(view.elapsed / 60000);
        const secs = Math.floor((view.elapsed % 60000) / 1000);
        t.textContent = `${pad2(mins)}:${pad2(secs)}`;
      }
    }, 1000);
  }
  function stopTimer() {
    if (view.timerId) { clearInterval(view.timerId); view.timerId = null; }
  }

  function renderRunner(quiz) {
    const idx = view.qIdx;
    const q = quiz.questions[idx];
    const isLast = idx === quiz.questions.length - 1;
    const current = view.answers[q.id];
    const hasAnswer = current !== undefined && !(Array.isArray(current) && current.length === 0) && current !== "";
    const mins = Math.floor(view.elapsed / 60000);
    const secs = Math.floor((view.elapsed % 60000) / 1000);
    const pct = ((idx + 1) / quiz.questions.length) * 100;

    const b = body();
    b.innerHTML = `
      <div class="today-header training-catalog-head">
        <div class="today-title">Q${pad2(idx + 1)} / ${pad2(quiz.questions.length)}</div>
        <div class="quiz-timer" id="elQuizTimer">${pad2(mins)}:${pad2(secs)}</div>
      </div>
      <div class="quiz-progress-track"><div class="quiz-progress-fill" style="width:${pct}%"></div></div>
      <div class="field-label quiz-type-label">◆ ${esc((q.type || "").replace(/-/g, " ").toUpperCase())}</div>
      <div class="quiz-prompt">${esc(q.prompt || "")}</div>
      ${q.image ? `<figure class="quiz-image-figure"><img src="${esc(q.image)}" alt="${esc(q.caption || "")}" class="quiz-image">${q.caption ? `<figcaption class="quiz-image-caption">${esc(q.caption)}</figcaption>` : ""}</figure>` : ""}
      <div id="elAnswerArea"></div>
      <div class="quiz-nav-row">
        <button class="btn btn-secondary quiz-nav-btn" id="elBackBtn">${idx === 0 ? "✕ EXIT" : "◂ BACK"}</button>
        <button class="btn btn-primary quiz-nav-btn" id="elNextBtn"${hasAnswer ? "" : " disabled"}>${isLast ? "SUBMIT ▸" : "NEXT ▸"}</button>
      </div>
    `;

    renderAnswerArea(q);

    document.getElementById("elBackBtn").addEventListener("click", () => {
      if (idx === 0) {
        stopTimer();
        view.stage = "catalog"; view.quizId = null;
        render();
      } else {
        view.qIdx--;
        render();
      }
    });
    document.getElementById("elNextBtn").addEventListener("click", () => {
      if (!hasAnswer) return;
      if (isLast) {
        stopTimer();
        view.stage = "done";
        render();
      } else {
        view.qIdx++;
        render();
      }
    });
  }

  function renderAnswerArea(q) {
    const area = document.getElementById("elAnswerArea");
    const current = view.answers[q.id];

    if (q.type === "multiple-choice" || q.type === "image-choice") {
      area.innerHTML = `<div class="quiz-choices">${(q.options || []).map((opt, i) => `
        <button class="quiz-choice${current === opt.id ? " selected" : ""}" data-opt="${esc(opt.id)}">
          <span class="quiz-choice-marker">${String.fromCharCode(65 + i)}</span>
          <span class="quiz-choice-text">${esc(opt.text || "")}</span>
        </button>
      `).join("")}</div>`;
      area.querySelectorAll("[data-opt]").forEach(btn => {
        btn.addEventListener("click", () => {
          view.answers[q.id] = btn.dataset.opt;
          renderRunner(quizzes.find(qq => qq.id === view.quizId));
        });
      });
    } else if (q.type === "true-false") {
      area.innerHTML = `<div class="quiz-tf-row">
        ${["true", "false"].map(v => `<button class="quiz-tf-btn${current === v ? " selected" : ""}" data-tf="${v}">${v}</button>`).join("")}
      </div>`;
      area.querySelectorAll("[data-tf]").forEach(btn => {
        btn.addEventListener("click", () => {
          view.answers[q.id] = btn.dataset.tf;
          renderRunner(quizzes.find(qq => qq.id === view.quizId));
        });
      });
    } else if (q.type === "multi-select") {
      const sel = Array.isArray(current) ? current : [];
      area.innerHTML = `
        <div class="field-label quiz-multi-hint">⚐ SELECT ALL THAT APPLY</div>
        <div class="quiz-choices">${(q.options || []).map((opt, i) => {
          const on = sel.includes(opt.id);
          return `<button class="quiz-choice${on ? " selected" : ""}" data-ms="${esc(opt.id)}">
            <span class="quiz-choice-marker quiz-choice-marker-square">${on ? "✓" : String.fromCharCode(65 + i)}</span>
            <span class="quiz-choice-text">${esc(opt.text || "")}</span>
          </button>`;
        }).join("")}</div>
      `;
      area.querySelectorAll("[data-ms]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.ms;
          const next = sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id];
          view.answers[q.id] = next;
          renderRunner(quizzes.find(qq => qq.id === view.quizId));
        });
      });
    }
  }

  function renderResults(quiz) {
    const answers = view.answers;
    const elapsed = view.elapsed;
    const correctCount = quiz.questions.filter(q => isCorrect(q, answers[q.id])).length;
    const score = Math.round((correctCount / quiz.questions.length) * 100);
    const passed = score >= (quiz.passingScore || 80);
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);

    // persist a result entry once per finish
    if (!view._saved) {
      view._saved = true;
      saveResult({
        quizId: quiz.id,
        quizTitle: quiz.title,
        score,
        passed,
        elapsedMs: elapsed,
        questions: quiz.questions.map(q => ({ id: q.id, type: q.type, correct: isCorrect(q, answers[q.id]) })),
        at: new Date().toISOString()
      });
    }

    const b = body();
    b.innerHTML = `
      <div class="quiz-result-hero ${passed ? "pass" : "fail"}">
        <div class="quiz-result-status">${passed ? "✓ MODULE PASSED" : "✕ NOT PASSED"}</div>
        <div class="quiz-result-score">${score}<span class="quiz-result-pct">%</span></div>
        <div class="quiz-result-sub">${correctCount} OF ${quiz.questions.length} CORRECT · ${mins}M ${pad2(secs)}S</div>
      </div>
      ${!passed ? `
        <div class="record quiz-retake-notice">
          <div class="field-label quiz-retake-label">RETAKE REQUIRED</div>
          <div class="quiz-retake-text">A score of ${quiz.passingScore || 80}% is required to pass. Review explanations below before retaking.</div>
        </div>` : ""}
      <div class="today-header"><div class="today-title">QUESTION REVIEW</div></div>
      ${quiz.questions.map((q, i) => {
        const ok = isCorrect(q, answers[q.id]);
        return `<div class="record">
          <div class="record-header">
            <div class="quiz-review-body">
              <div class="record-meta quiz-review-qnum">Q${pad2(i + 1)}</div>
              <div class="quiz-review-q">${esc(q.prompt || "")}</div>
            </div>
            <span class="quiz-review-mark ${ok ? "correct" : "wrong"}">${ok ? "✓" : "✕"}</span>
          </div>
          <div class="record-notes">${esc(q.explanation || "")}</div>
        </div>`;
      }).join("")}
      <button class="btn btn-primary" id="elDoneBtn">${passed ? "◂ BACK TO MODULES" : "↻ RETAKE MODULE"}</button>
    `;
    document.getElementById("elDoneBtn").addEventListener("click", () => {
      view._saved = false;
      if (passed) {
        view.stage = "catalog"; view.quizId = null;
      } else {
        // retake
        view.stage = "taking"; view.qIdx = 0; view.answers = {};
        view.startTs = Date.now(); view.elapsed = 0;
        startTimer();
      }
      render();
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  REPORTS  ·  derived from saved results in localStorage
  // ═══════════════════════════════════════════════════════════════════
  function renderReports() {
    const all = getResults();
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = all.filter(r => new Date(r.at).getTime() >= since);

    const totalRunners = recent.length;
    const passCount = recent.filter(r => r.passed).length;
    const completionRate = totalRunners ? Math.round((passCount / totalRunners) * 100) : 0;
    const averageScore = totalRunners ? Math.round(recent.reduce((s, r) => s + r.score, 0) / totalRunners) : 0;
    const averageTime = totalRunners ? (recent.reduce((s, r) => s + r.elapsedMs, 0) / totalRunners / 60000) : 0;

    // by quiz
    const byQuiz = {};
    recent.forEach(r => {
      const k = r.quizTitle || r.quizId;
      if (!byQuiz[k]) byQuiz[k] = { completed: 0, total: 0 };
      byQuiz[k].total += 1;
      if (r.passed) byQuiz[k].completed += 1;
    });

    // question performance
    const qStats = {};
    recent.forEach(r => {
      (r.questions || []).forEach(q => {
        if (!qStats[q.id]) qStats[q.id] = { c: 0, t: 0 };
        qStats[q.id].t += 1;
        if (q.correct) qStats[q.id].c += 1;
      });
    });
    const qPerf = Object.keys(qStats).map(id => ({
      id: id.toUpperCase().slice(0, 6),
      correct: Math.round((qStats[id].c / qStats[id].t) * 100)
    })).slice(0, 8);

    // recent attempts (last 5)
    const recentList = all.slice(-5).reverse();

    const b = body();
    b.innerHTML = `
      <div class="dash-section">
        <div class="dash-title">LAST 30 DAYS</div>
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-num">${totalRunners}</div><div class="stat-label">ATTEMPTS</div></div>
          <div class="stat-card"><div class="stat-num">${completionRate}%</div><div class="stat-label">PASSED</div></div>
          <div class="stat-card"><div class="stat-num">${averageScore}%</div><div class="stat-label">AVG SCORE</div></div>
          <div class="stat-card"><div class="stat-num">${averageTime.toFixed(1)}m</div><div class="stat-label">AVG TIME</div></div>
        </div>
      </div>

      <div class="dash-section">
        <div class="dash-title">COMPLETION BY MODULE</div>
        <div class="bar-chart">
          ${Object.keys(byQuiz).length === 0 ? `<div class="record-notes">No attempts yet.</div>` :
            Object.entries(byQuiz).map(([k, v]) => {
              const pct = Math.round((v.completed / v.total) * 100);
              return `<div class="bar-row">
                <div class="bar-key">${esc(k.slice(0, 14))}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                <div class="bar-val">${v.completed}/${v.total}</div>
              </div>`;
            }).join("")}
        </div>
      </div>

      <div class="dash-section">
        <div class="dash-title">QUESTION DIFFICULTY (% CORRECT)</div>
        <div class="bar-chart">
          ${qPerf.length === 0 ? `<div class="record-notes">No question data yet.</div>` :
            qPerf.map(qp => `
              <div class="bar-row">
                <div class="bar-key">${esc(qp.id)}</div>
                <div class="bar-track"><div class="bar-fill${qp.correct < 70 ? " quiz-bar-warn" : ""}" style="width:${qp.correct}%"></div></div>
                <div class="bar-val">${qp.correct}%</div>
              </div>
            `).join("")}
        </div>
      </div>

      <div class="dash-section">
        <div class="dash-title">RECENT SUBMISSIONS</div>
        ${recentList.length === 0 ? `<div class="record"><div class="record-notes">No attempts saved yet. Take a module from the TRAIN tab.</div></div>` :
          recentList.map(r => {
            const mins = Math.floor(r.elapsedMs / 60000);
            const secs = Math.floor((r.elapsedMs % 60000) / 1000);
            const initials = (r.quizTitle || r.quizId || "??").split(/[\s-_]+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
            return `<div class="record quiz-recent-row">
              <div class="record-header quiz-recent-header">
                <div class="quiz-recent-left">
                  <div class="quiz-avatar">${esc(initials)}</div>
                  <div>
                    <div class="record-serial quiz-recent-name">${esc(r.quizTitle || r.quizId)}</div>
                    <div class="record-meta quiz-recent-time">${pad2(mins)}:${pad2(secs)} · ${new Date(r.at).toLocaleDateString()}</div>
                  </div>
                </div>
                <div class="record-badges">
                  <span class="quiz-recent-score">${r.score}%</span>
                  <span class="record-status ${r.passed ? "status-CLEAN" : "status-DIRTY"}">${r.passed ? "PASS" : "FAIL"}</span>
                </div>
              </div>
            </div>`;
          }).join("")}
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Entry point — hook into app's showTab
  // ═══════════════════════════════════════════════════════════════════
  async function init() {
    const r = root();
    if (!r) return;
    if (!initialized) {
      r.innerHTML = `<div class="record"><div class="record-notes">Loading modules…</div></div>`;
      await loadAll();
      initialized = true;
    }
    mounted = true;
    render();
  }

  function teardown() {
    mounted = false;
    stopTimer();
  }

  const origShowTab = window.showTab;
  window.showTab = function (name) {
    if (typeof origShowTab === "function") origShowTab(name);
    if (name === "training") init();
    else teardown();
  };

  document.addEventListener("DOMContentLoaded", () => {
    const panel = document.getElementById("panel-training");
    if (panel && panel.classList.contains("active")) init();
  });
})();
