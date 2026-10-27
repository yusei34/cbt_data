// Network Specialist Afternoon (PM1 / PM2) CBT Simulator
(function () {
  "use strict";

  // Global Registry for Dynamic Script Loading (works over file:// and http://)
  const examDataCache = {};
  const pendingLoadCallbacks = {};

  window.__CBT_REGISTER_EXAM = function (yearKey, data) {
    examDataCache[yearKey] = data;
    if (pendingLoadCallbacks[yearKey]) {
      const cbs = pendingLoadCallbacks[yearKey];
      delete pendingLoadCallbacks[yearKey];
      cbs.forEach((cb) => cb(data));
    }
  };

  function loadExamData(yearKey) {
    return new Promise((resolve, reject) => {
      if (examDataCache[yearKey]) {
        resolve(examDataCache[yearKey]);
        return;
      }
      pendingLoadCallbacks[yearKey] = pendingLoadCallbacks[yearKey] || [];
      pendingLoadCallbacks[yearKey].push(resolve);

      const script = document.createElement("script");
      script.src = `js/${yearKey}.js`;
      script.onload = () => {
        if (!examDataCache[yearKey]) {
          // Fallback to fetch if needed
          fetch(`${yearKey}.json`)
            .then((r) => r.json())
            .then((d) => window.__CBT_REGISTER_EXAM(yearKey, d))
            .catch(reject);
        }
      };
      script.onerror = () => {
        fetch(`${yearKey}.json`)
          .then((r) => r.json())
          .then((d) => window.__CBT_REGISTER_EXAM(yearKey, d))
          .catch(reject);
      };
      document.head.appendChild(script);
    });
  }

  // Storage Keys & State Management
  const STORAGE_KEYS = {
    HISTORY: "nw_cbt_history_v1",
    BOOKMARKS: "nw_cbt_bookmarks_v1",
    HIGHLIGHTS: "nw_cbt_highlights_v1",
    DRAFTS: "nw_cbt_drafts_v1"
  };

  function loadStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveStore(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn("Storage save error:", e);
    }
  }

  let appHistory = loadStore(STORAGE_KEYS.HISTORY, []);
  let appBookmarks = loadStore(STORAGE_KEYS.BOOKMARKS, {});
  let appHighlights = loadStore(STORAGE_KEYS.HIGHLIGHTS, {});
  let appDrafts = loadStore(STORAGE_KEYS.DRAFTS, {});

  // Active Session State
  let currentState = {
    mode: "practice", // "exam" | "practice"
    yearKey: null,
    examData: null,
    sessionKey: "pm1", // "pm1" | "pm2"
    activeQNo: 1,
    selectedExamQNos: [], // e.g., [1, 2] for PM1, [1] for PM2
    answers: {}, // { "q1_設問1(1)": value or {blankKey: val} }
    grades: {}, // { "q1_設問1(1)": "correct" | "partial" | "wrong" }
    revealed: {}, // { "q1_設問1(1)": true/false }
    flags: {}, // { "q1_設問1(1)": true/false }
    isGradedAll: false,
    timerSeconds: 0,
    elapsedSeconds: 0,
    timerRunning: false,
    timerInterval: null,
    markerColor: "yellow",
    figZoom: 1.0
  };

  // Normalization helper for automatic grading of short answers / fill-in-blanks
  function normalizeForCompare(str) {
    if (str === null || str === undefined) return "";
    let s = String(str).trim();
    // Convert full-width alphanumeric & symbols to half-width
    s = s.replace(/[！-～]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
    s = s
      .replace(/　/g, " ")
      .replace(/[、，]/g, ",")
      .replace(/[。．]/g, "")
      .replace(/[“”「」『』]/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
    return s.trim();
  }

  function checkAutoMatch(userVal, modelVal) {
    const u = normalizeForCompare(userVal);
    if (!u) return false;

    let mRaw = String(modelVal || "").trim();
    // Remove notes like （ウと順不同） or （※順不同） or (16字)
    mRaw = mRaw.replace(/[（\(][^）\)]*?(?:順不同|\d+字)[^）\)]*?[）\)]/g, "").trim();

    // Extract alternatives from （又は ...） or 又は / または
    const candidates = new Set();
    candidates.add(normalizeForCompare(mRaw));

    const parenAlt = mRaw.match(/^(.+?)[（\(](?:又は|または)\s*(.+?)[）\)]$/);
    if (parenAlt) {
      candidates.add(normalizeForCompare(parenAlt[1]));
      candidates.add(normalizeForCompare(parenAlt[2]));
    }
    mRaw.split(/\s*(?:又は|または|／|または，)\s*/).forEach((part) => {
      const cleaned = part.replace(/[（\(].*?[）\)]/g, "").trim();
      if (cleaned) candidates.add(normalizeForCompare(cleaned));
    });

    if (candidates.has(u)) return true;
    // Also check without spaces
    const uNoSpace = u.replace(/\s+/g, "");
    for (const c of candidates) {
      if (c && c.replace(/\s+/g, "") === uNoSpace) return true;
    }
    return false;
  }

  function evaluateSubQuestion(sq, qNo) {
    const key = `q${qNo}_${sq.sub_no}`;
    const userAns = currentState.answers[key];

    if (sq.is_void) {
      return "correct";
    }

    if (sq.type === "fill_in_blank" && sq.answer && typeof sq.answer === "object" && !Array.isArray(sq.answer)) {
      const blankKeys = Object.keys(sq.answer);
      if (!userAns || typeof userAns !== "object") return "wrong";
      let matchCount = 0;
      blankKeys.forEach((bk) => {
        if (checkAutoMatch(userAns[bk], sq.answer[bk])) {
          matchCount++;
        }
      });
      if (matchCount === blankKeys.length) return "correct";
      if (matchCount > 0) return "partial";
      return "wrong";
    }

    if (sq.type === "short_answer" && typeof sq.answer === "string") {
      if (checkAutoMatch(userAns, sq.answer)) return "correct";
      return userAns && String(userAns).trim() ? "wrong" : "wrong";
    }

    if (sq.type === "short_answer" && sq.answer && typeof sq.answer === "object" && !Array.isArray(sq.answer)) {
      const blankKeys = Object.keys(sq.answer);
      if (!userAns || typeof userAns !== "object") return "wrong";
      let matchCount = 0;
      blankKeys.forEach((bk) => {
        if (checkAutoMatch(userAns[bk], sq.answer[bk])) matchCount++;
      });
      if (matchCount === blankKeys.length) return "correct";
      if (matchCount > 0) return "partial";
      return "wrong";
    }

    // Descriptive question: if already self-graded, keep it; otherwise suggest based on exact match or keyword match
    if (currentState.grades[key]) {
      return currentState.grades[key];
    }
    const uStr = typeof userAns === "string" ? userAns.trim() : "";
    if (!uStr) return "wrong";
    if (typeof sq.answer === "string" && checkAutoMatch(uStr, sq.answer)) {
      return "correct";
    }
    return "partial"; // Default suggestion for non-empty descriptive answer awaiting self-check
  }

  // Render Dashboard
  function renderDashboard() {
    const indexData = window.__CBT_INDEX_DATA;
    if (!indexData) return;

    // 1. Stats Summary
    const totalExams = indexData.available_exams.length;
    const totalSessionsDone = appHistory.length;
    const bookmarkKeys = Object.keys(appBookmarks).filter((k) => appBookmarks[k]);
    const avgScore =
      totalSessionsDone > 0
        ? Math.round(appHistory.reduce((acc, h) => acc + (h.scorePercent || 0), 0) / totalSessionsDone)
        : 0;

    document.getElementById("bookmarkCountBadge").textContent = bookmarkKeys.length;
    document.getElementById("historyCountBadge").textContent = totalSessionsDone;

    document.getElementById("dashboardStats").innerHTML = `
      <div class="stat-card">
        <div class="stat-label">収録過去問（H24〜R06）</div>
        <div class="stat-value">${totalExams} 年度分</div>
        <div class="stat-sub">午後Ⅰ（36問）・午後Ⅱ（24問）計60問 / 682設問</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">演習・試験 実施回数</div>
        <div class="stat-value">${totalSessionsDone} 回</div>
        <div class="stat-sub">直近の学習履歴を自動保存中</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">平均得点率（自己採点含む）</div>
        <div class="stat-value" style="color:var(--primary);">${avgScore}%</div>
        <div class="stat-sub">○正解(100%) / △部分点(50%) で算出</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">復習ブックマーク登録数</div>
        <div class="stat-value" style="color:var(--warning);">★ ${bookmarkKeys.length} 問</div>
        <div class="stat-sub">ブックマークタブからワンクリック復習</div>
      </div>
    `;

    // 2. Year Cards
    const grid = document.getElementById("examYearGrid");
    grid.innerHTML = indexData.available_exams
      .map((ex) => {
        const yrKey = ex.file.replace(".json", "");
        const pm1 = ex.sessions_summary.pm1;
        const pm2 = ex.sessions_summary.pm2;

        const pm1Items = pm1.titles
          .map((t, idx) => {
            const qNo = idx + 1;
            const bmKey = `${yrKey}_pm1_q${qNo}`;
            const isBm = !!appBookmarks[bmKey];
            return `
              <div class="q-item-mini">
                <div class="q-item-title">
                  <span>${isBm ? "★ " : ""}問${qNo}: ${escapeHtml(t)}</span>
                </div>
                <div class="q-item-actions">
                  <button class="btn btn-secondary btn-sm" onclick="window.__startCBT('${yrKey}', 'pm1', 'practice', ${qNo})">演習</button>
                </div>
              </div>
            `;
          })
          .join("");

        const pm2Items = pm2.titles
          .map((t, idx) => {
            const qNo = idx + 1;
            const bmKey = `${yrKey}_pm2_q${qNo}`;
            const isBm = !!appBookmarks[bmKey];
            return `
              <div class="q-item-mini">
                <div class="q-item-title">
                  <span>${isBm ? "★ " : ""}問${qNo}: ${escapeHtml(t)}</span>
                </div>
                <div class="q-item-actions">
                  <button class="btn btn-secondary btn-sm" onclick="window.__startCBT('${yrKey}', 'pm2', 'practice', ${qNo})">演習</button>
                </div>
              </div>
            `;
          })
          .join("");

        return `
          <div class="year-card">
            <div class="year-card-header">
              <div class="year-title">${escapeHtml(ex.year)} ${escapeHtml(ex.season)}</div>
              <span class="year-badge">${yrKey}</span>
            </div>

            <div class="session-block">
              <div class="session-block-header">
                <div>
                  <span class="session-name">午後Ⅰ</span>
                  <span class="session-meta">（90分・3問中2問選択 / 計${pm1.sub_questions_count}設問・${pm1.figures_count}図表）</span>
                </div>
                <button class="btn btn-primary btn-sm" onclick="window.__startCBT('${yrKey}', 'pm1', 'exam', 1)">本番試験開始</button>
              </div>
              <div class="q-list-mini">${pm1Items}</div>
            </div>

            <div class="session-block">
              <div class="session-block-header">
                <div>
                  <span class="session-name">午後Ⅱ</span>
                  <span class="session-meta">（120分・2問中1問選択 / 計${pm2.sub_questions_count}設問・${pm2.figures_count}図表）</span>
                </div>
                <button class="btn btn-primary btn-sm" onclick="window.__startCBT('${yrKey}', 'pm2', 'exam', 1)">本番試験開始</button>
              </div>
              <div class="q-list-mini">${pm2Items}</div>
            </div>
          </div>
        `;
      })
      .join("");

    renderBookmarksTab();
    renderHistoryTab();
  }

  function renderBookmarksTab() {
    const container = document.getElementById("bookmarksContainer");
    const keys = Object.keys(appBookmarks).filter((k) => appBookmarks[k]);
    if (keys.length === 0) {
      container.innerHTML = `<div class="stat-card" style="text-align:center;padding:36px;color:var(--text-secondary);">まだ復習ブックマーク（★）された問題はありません。演習画面の「★ 復習登録」ボタンから登録できます。</div>`;
      return;
    }

    const rows = keys
      .map((k) => {
        const info = appBookmarks[k];
        return `
          <tr>
            <td><strong>${escapeHtml(info.yearLabel || info.yearKey)}</strong></td>
            <td>${info.sessionKey === "pm1" ? "午後Ⅰ" : "午後Ⅱ"} 問${info.qNo}</td>
            <td><strong>${escapeHtml(info.title || "")}</strong></td>
            <td>${escapeHtml(info.savedAt || "")}</td>
            <td>
              <button class="btn btn-primary btn-sm" onclick="window.__startCBT('${info.yearKey}', '${info.sessionKey}', 'practice', ${info.qNo})">演習を開く</button>
              <button class="btn btn-secondary btn-sm" onclick="window.__removeBookmark('${k}')">解除</button>
            </td>
          </tr>
        `;
      })
      .join("");

    container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>年度</th>
            <th>区分・問</th>
            <th>テーマ</th>
            <th>登録日時</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderHistoryTab() {
    const container = document.getElementById("historyContainer");
    if (appHistory.length === 0) {
      container.innerHTML = `<div class="stat-card" style="text-align:center;padding:36px;color:var(--text-secondary);">まだ解答履歴はありません。問題を解いて「採点・解説を表示」を押すと自動的に記録されます。</div>`;
      return;
    }

    const rows = appHistory
      .slice()
      .reverse()
      .map((h, idx) => {
        const realIdx = appHistory.length - 1 - idx;
        const mins = Math.floor((h.elapsedSeconds || 0) / 60);
        const secs = (h.elapsedSeconds || 0) % 60;
        return `
          <tr>
            <td>${escapeHtml(h.dateStr)}</td>
            <td><span class="year-badge">${h.mode === "exam" ? "本番試験" : "演習モード"}</span></td>
            <td><strong>${escapeHtml(h.yearLabel)} ${h.sessionKey === "pm1" ? "午後Ⅰ" : "午後Ⅱ"}</strong> (${escapeHtml(h.questionsLabel)})</td>
            <td><strong style="color:var(--primary);font-size:15px;">${h.scorePercent}%</strong> (○${h.correctCount} / △${h.partialCount} / ×${h.wrongCount})</td>
            <td>${mins}分${secs}秒</td>
            <td>
              <button class="btn btn-secondary btn-sm" onclick="window.__restoreHistorySession(${realIdx})">結果を再表示</button>
            </td>
          </tr>
        `;
      })
      .join("");

    container.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
        <button class="btn btn-secondary btn-sm" onclick="window.__clearAllHistory()">履歴をクリア</button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>実施日時</th>
            <th>モード</th>
            <th>対象問題</th>
            <th>スコア（内訳）</th>
            <th>所要時間</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // Start CBT Session
  window.__startCBT = async function (yearKey, sessionKey, mode, initialQNo) {
    try {
      const data = await loadExamData(yearKey);
      const sessObj = data.sessions[sessionKey];
      if (!sessObj) return;

      const draftKey = `${yearKey}_${sessionKey}`;
      const savedDraft = appDrafts[draftKey] || {};

      currentState.mode = mode;
      currentState.yearKey = yearKey;
      currentState.examData = data;
      currentState.sessionKey = sessionKey;
      currentState.activeQNo = initialQNo || 1;
      currentState.selectedExamQNos =
        mode === "exam"
          ? sessionKey === "pm1"
            ? [1, 2]
            : [1]
          : [initialQNo || 1];
      currentState.answers = savedDraft.answers ? JSON.parse(JSON.stringify(savedDraft.answers)) : {};
      currentState.grades = savedDraft.grades ? JSON.parse(JSON.stringify(savedDraft.grades)) : {};
      currentState.flags = savedDraft.flags ? JSON.parse(JSON.stringify(savedDraft.flags)) : {};
      currentState.revealed = {};
      currentState.isGradedAll = false;

      // Setup Timer
      if (currentState.timerInterval) clearInterval(currentState.timerInterval);
      currentState.timerSeconds = (sessObj.time_limit_minutes || 90) * 60;
      currentState.elapsedSeconds = 0;
      currentState.timerRunning = true;
      startTimerLoop();

      // Switch View
      document.getElementById("viewDashboard").classList.remove("active");
      document.getElementById("viewSimulator").classList.add("active");

      renderSimulatorHeaderAndTabs();
      renderActiveQuestion();

      if (mode === "exam") {
        openQuestionSelectModal();
      }
    } catch (err) {
      alert("データの読み込みに失敗しました: " + err.message);
    }
  };

  window.__restoreHistorySession = async function (histIdx) {
    const h = appHistory[histIdx];
    if (!h) return;
    const data = await loadExamData(h.yearKey);
    currentState.mode = h.mode;
    currentState.yearKey = h.yearKey;
    currentState.examData = data;
    currentState.sessionKey = h.sessionKey;
    currentState.activeQNo = h.selectedExamQNos[0] || 1;
    currentState.selectedExamQNos = h.selectedExamQNos || [1];
    currentState.answers = h.answers || {};
    currentState.grades = h.grades || {};
    currentState.flags = {};
    currentState.revealed = {};
    currentState.isGradedAll = true;
    if (currentState.timerInterval) clearInterval(currentState.timerInterval);
    currentState.timerRunning = false;

    document.getElementById("viewDashboard").classList.remove("active");
    document.getElementById("viewSimulator").classList.add("active");

    renderSimulatorHeaderAndTabs();
    renderActiveQuestion();
    renderScoreSummaryBanner();
  };

  function saveCurrentDraft() {
    if (!currentState.yearKey || !currentState.sessionKey) return;
    const draftKey = `${currentState.yearKey}_${currentState.sessionKey}`;
    appDrafts[draftKey] = {
      answers: currentState.answers,
      grades: currentState.grades,
      flags: currentState.flags,
      updatedAt: new Date().toISOString()
    };
    saveStore(STORAGE_KEYS.DRAFTS, appDrafts);
  }

  function startTimerLoop() {
    updateTimerDisplay();
    currentState.timerInterval = setInterval(() => {
      if (!currentState.timerRunning) return;
      currentState.elapsedSeconds++;
      if (currentState.mode === "exam") {
        if (currentState.timerSeconds > 0) {
          currentState.timerSeconds--;
        }
      }
      updateTimerDisplay();
    }, 1000);
  }

  function updateTimerDisplay() {
    const box = document.getElementById("timerBox");
    const txt = document.getElementById("timerText");
    const secs = currentState.mode === "exam" ? currentState.timerSeconds : currentState.elapsedSeconds;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    const label = currentState.mode === "exam" ? "残り " : "経過 ";
    txt.textContent = `${label}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

    box.classList.remove("warning", "danger");
    if (currentState.mode === "exam") {
      if (secs <= 300) box.classList.add("danger");
      else if (secs <= 600) box.classList.add("warning");
    }
  }

  function renderSimulatorHeaderAndTabs() {
    const data = currentState.examData;
    const sessObj = data.sessions[currentState.sessionKey];
    const modeLabel = currentState.mode === "exam" ? "本番試験モード" : "演習モード";

    document.getElementById("headerSessionInfo").innerHTML = `
      <span class="year-badge" style="background:rgba(255,255,255,0.16);color:#fff;">${modeLabel}</span>
      <span style="font-weight:700;font-size:14px;">${escapeHtml(data.year)} ${escapeHtml(data.season)} ${escapeHtml(sessObj.name)}</span>
    `;

    // Question Switch Tabs
    const tabsWrap = document.getElementById("questionSwitchTabs");
    tabsWrap.innerHTML = sessObj.questions
      .map((q) => {
        const isActive = q.question_no === currentState.activeQNo;
        const isSelectedForExam = currentState.selectedExamQNos.includes(q.question_no);
        const selBadge =
          currentState.mode === "exam"
            ? isSelectedForExam
              ? `<span style="font-size:10px;background:#16a34a;color:#fff;padding:1px 5px;border-radius:4px;">選択中</span>`
              : `<span style="font-size:10px;background:#94a3b8;color:#fff;padding:1px 5px;border-radius:4px;">未選択</span>`
            : "";
        return `
          <button class="q-tab ${isActive ? "active" : ""} ${isSelectedForExam ? "selected-exam-q" : ""}" onclick="window.__switchQuestion(${q.question_no})">
            <span>問${q.question_no}: ${escapeHtml(q.title)}</span>
            ${selBadge}
          </button>
        `;
      })
      .join("");

    const btnSel = document.getElementById("btnSelectExamQuestions");
    btnSel.style.display = currentState.mode === "exam" ? "inline-flex" : "none";

    updateBookmarkButtonState();
  }

  window.__switchQuestion = function (qNo) {
    currentState.activeQNo = qNo;
    if (currentState.mode === "practice" && !currentState.selectedExamQNos.includes(qNo)) {
      currentState.selectedExamQNos = [qNo];
    }
    renderSimulatorHeaderAndTabs();
    renderActiveQuestion();
  };

  function updateBookmarkButtonState() {
    const bmKey = `${currentState.yearKey}_${currentState.sessionKey}_q${currentState.activeQNo}`;
    const btn = document.getElementById("btnBookmarkQuestion");
    if (appBookmarks[bmKey]) {
      btn.textContent = "★ 復習登録済";
      btn.className = "btn btn-warning btn-sm";
    } else {
      btn.textContent = "☆ 復習登録";
      btn.className = "btn btn-secondary btn-sm";
    }
  }

  // Render Left & Right Panes for Active Question
  function renderActiveQuestion() {
    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo) || sessObj.questions[0];
    if (!qObj) return;

    // 1. Left Pane Header & Quick Figure Bar
    document.getElementById("problemMetaLabel").textContent = `${currentState.examData.year} ${currentState.examData.season} ${sessObj.name}（${sessObj.selection_rule}）`;
    document.getElementById("problemTitleMain").textContent = `問${qObj.question_no}　${qObj.title}`;

    const figBar = document.getElementById("figureQuickBar");
    if (qObj.figures && qObj.figures.length > 0) {
      figBar.style.display = "flex";
      figBar.innerHTML =
        `<span style="font-size:12px;font-weight:700;color:var(--text-secondary);align-self:center;margin-right:4px;">📌 図表を別枠で開く:</span>` +
        qObj.figures
          .map(
            (fg) =>
              `<button class="figure-chip" onclick="window.__openFloatingFigure('${escapeAttr(fg.path)}', '${escapeAttr(fg.caption)}')">${escapeHtml(fg.id)}</button>`
          )
          .join("");
    } else {
      figBar.style.display = "none";
    }

    // 2. Render Problem Body Content (or restore saved highlight HTML)
    const hlKey = `${currentState.yearKey}_${currentState.sessionKey}_q${qObj.question_no}`;
    const bodyEl = document.getElementById("problemBodyContent");
    if (appHighlights[hlKey]) {
      bodyEl.innerHTML = appHighlights[hlKey];
    } else {
      bodyEl.innerHTML = formatBodyMarkdownToHtml(qObj.body_markdown, qObj.figures || []);
    }

    // 3. Render Right Pane Sub-questions
    renderRightPaneSubQuestions(qObj);
    if (currentState.isGradedAll) {
      renderScoreSummaryBanner();
    } else {
      document.getElementById("scoreSummaryBanner").style.display = "none";
    }
  }

  function formatBodyMarkdownToHtml(md, figures) {
    if (!md) return "";
    const lines = md.split("\n");
    let html = "";
    let inTable = false;
    let tableRows = [];

    function flushTable() {
      if (!inTable || tableRows.length === 0) return;
      html += `<table class="md-table">`;
      tableRows.forEach((r, rIdx) => {
        // Skip separator row |---|---|
        if (/^[\|\s\-:]+$/.test(r)) return;
        const cells = r
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
        const tag = rIdx === 0 ? "th" : "td";
        html += `<tr>${cells.map((c) => `<${tag}>${formatInlineTokens(c)}</${tag}>`).join("")}</tr>`;
      });
      html += `</table>`;
      inTable = false;
      tableRows = [];
    }

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        inTable = true;
        tableRows.push(trimmed);
        continue;
      } else if (inTable) {
        flushTable();
      }

      if (!trimmed) {
        continue;
      }

      // Heading ### 〔...〕
      if (trimmed.startsWith("### ")) {
        html += `<h3>${escapeHtml(trimmed.slice(4))}</h3>`;
        continue;
      }

      // Image ![caption](path)
      const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imgMatch) {
        const cap = imgMatch[1];
        const path = imgMatch[2];
        html += `
          <div class="problem-figure-card">
            <div class="problem-figure-toolbar">
              <span>${escapeHtml(cap)}</span>
              <button class="btn btn-secondary btn-sm" onclick="window.__openFloatingFigure('${escapeAttr(path)}', '${escapeAttr(cap)}')">📌 別枠にピン留め・拡大</button>
            </div>
            <div class="problem-figure-img-wrap">
              <img src="${escapeAttr(path)}" alt="${escapeAttr(cap)}" onclick="window.__openFloatingFigure('${escapeAttr(path)}', '${escapeAttr(cap)}')" title="クリックで別枠ピン留め・拡大表示" />
            </div>
          </div>
        `;
        continue;
      }

      html += `<p>${formatInlineTokens(trimmed)}</p>`;
    }
    if (inTable) flushTable();
    return html;
  }

  function formatInlineTokens(str) {
    // Allow <u>...</u> from source markdown while escaping other HTML
    const parts = str.split(/(<u>.*?<\/u>)/g);
    return parts
      .map((part) => {
        if (part.startsWith("<u>") && part.endsWith("</u>")) {
          const inner = escapeHtml(part.slice(3, -4));
          return `<span class="underline-ref">${inner}</span>`;
        }
        let s = escapeHtml(part);
        // Blank badges **【 ア 】** or 【 ア 】
        s = s.replace(/\*\*【\s*([^】]+?)\s*】\*\*/g, `<span class="blank-badge">【 $1 】</span>`);
        s = s.replace(/【\s*([ア-ンa-j])\s*】/g, `<span class="blank-badge">【 $1 】</span>`);
        // Bold **...**
        s = s.replace(/\*\*([^*]+)\*\*/g, `<strong>$1</strong>`);
        // Inline code `...`
        s = s.replace(/`([^`]+)`/g, `<code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-family:monospace;">$1</code>`);
        // Circled numbers ①〜⑫
        s = s.replace(/([①-⑫])/g, `<strong style="color:var(--primary);font-size:15.5px;">$1</strong>`);
        return s;
      })
      .join("");
  }

  function renderRightPaneSubQuestions(qObj) {
    const qNo = qObj.question_no;
    const sqs = qObj.sub_questions || [];

    // 1. Render Sticky Navigation Bar
    const navBar = document.getElementById("subqNavBar");
    navBar.innerHTML = sqs
      .map((sq, idx) => {
        const key = `q${qNo}_${sq.sub_no}`;
        const hasAns = isSubQuestionAnswered(sq, qNo);
        const isFlagged = !!currentState.flags[key];
        const isRev = currentState.isGradedAll || !!currentState.revealed[key];
        const grade = isRev ? currentState.grades[key] || evaluateSubQuestion(sq, qNo) : null;

        let cls = "subq-pill";
        if (isRev && grade) cls += ` grade-${grade}`;
        else if (hasAns) cls += " answered";
        if (isFlagged) cls += " flagged";

        const markIcon =
          grade === "correct" ? " ○" : grade === "partial" ? " △" : grade === "wrong" ? " ×" : "";
        return `<button class="${cls}" onclick="window.__scrollToSubQ(${idx})">${escapeHtml(sq.sub_no)}${markIcon}${isFlagged ? " 🚩" : ""}</button>`;
      })
      .join("");

    // 2. Render Sub-Question Cards
    const container = document.getElementById("subQuestionsContainer");
    container.innerHTML = sqs
      .map((sq, idx) => {
        const key = `q${qNo}_${sq.sub_no}`;
        const isFlagged = !!currentState.flags[key];
        const isRev = currentState.isGradedAll || !!currentState.revealed[key];
        const grade = isRev ? currentState.grades[key] || evaluateSubQuestion(sq, qNo) : null;
        if (isRev && !currentState.grades[key]) {
          currentState.grades[key] = grade;
        }

        const typeLabel =
          sq.type === "fill_in_blank"
            ? "空欄補充（自動判定）"
            : sq.type === "descriptive"
            ? `記述式（${sq.max_length ? sq.max_length + "字以内" : "自己採点"}）`
            : "短答式（自動/自己採点）";

        const inputHtml = renderSubQuestionInputs(sq, qNo, key);
        const revealHtml = isRev ? renderSubQuestionReveal(sq, qNo, key, grade) : "";

        const practiceCheckBtn =
          currentState.mode === "practice"
            ? `<button class="btn btn-secondary btn-sm" onclick="window.__toggleRevealSubQ('${escapeAttr(key)}', ${qNo}, ${idx})">${
                isRev ? "解説を隠す" : "解答・解説を確認"
              }</button>`
            : "";

        return `
          <div class="subq-card" id="subqCard_${idx}">
            <div class="subq-card-header">
              <div class="subq-title-group">
                <span class="subq-no-badge">${escapeHtml(sq.sub_no)}</span>
                <span class="subq-sec-badge">${escapeHtml(sq.section || "全体")}</span>
                <span class="subq-type-badge">${typeLabel}</span>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <button class="btn btn-secondary btn-sm" onclick="window.__toggleFlagSubQ('${escapeAttr(key)}')" title="あとで見直すフラグ">${
                  isFlagged ? "🚩 見直し中" : "🏳 見直し"
                }</button>
                ${practiceCheckBtn}
              </div>
            </div>

            <div class="subq-qtext">${escapeHtml(sq.question_text)}</div>

            ${inputHtml}
            ${revealHtml}
          </div>
        `;
      })
      .join("");
  }

  function isSubQuestionAnswered(sq, qNo) {
    const key = `q${qNo}_${sq.sub_no}`;
    const val = currentState.answers[key];
    if (!val) return false;
    if (typeof val === "string") return val.trim().length > 0;
    if (typeof val === "object") {
      return Object.values(val).some((v) => v && String(v).trim().length > 0);
    }
    return false;
  }

  function renderSubQuestionInputs(sq, qNo, key) {
    const savedVal = currentState.answers[key];

    // Case 1: Multi-blank dictionary answer
    if (sq.answer && typeof sq.answer === "object" && !Array.isArray(sq.answer)) {
      const objVal = savedVal && typeof savedVal === "object" ? savedVal : {};
      const itemsHtml = Object.keys(sq.answer)
        .map((bk) => {
          const v = objVal[bk] || "";
          return `
            <div class="blank-input-item">
              <span class="blank-key-label">${escapeHtml(bk)}</span>
              <input type="text" class="cbt-input" value="${escapeAttr(v)}" placeholder="${escapeAttr(bk)} の解答を入力..." oninput="window.__onBlankInput('${escapeAttr(key)}', '${escapeAttr(bk)}', this.value)" />
            </div>
          `;
        })
        .join("");
      return `<div class="blank-inputs-grid">${itemsHtml}</div>`;
    }

    // Case 2: Descriptive answer with character counter & keyword checker
    if (sq.type === "descriptive" || sq.max_length) {
      const strVal = typeof savedVal === "string" ? savedVal : "";
      const len = strVal.replace(/\s+/g, "").length;
      const maxLen = sq.max_length || 50;
      const isOver = sq.max_length && len > sq.max_length;
      const reqKws = sq.required_keywords || [];

      const kwBadges = reqKws
        .map((kw) => {
          const ok = strVal.includes(kw);
          return `<span class="kw-check-chip ${ok ? "kw-ok" : ""}" id="kw_${escapeAttr(key)}_${escapeAttr(kw)}">${
            ok ? "✓" : "・"
          } 必須語句「${escapeHtml(kw)}」</span>`;
        })
        .join(" ");

      return `
        <div>
          <textarea class="cbt-textarea" placeholder="${
            sq.max_length ? sq.max_length + "字以内で解答を入力してください..." : "記述解答を入力してください..."
          }" oninput="window.__onDescInput('${escapeAttr(key)}', this.value, ${maxLen})">${escapeHtml(strVal)}</textarea>
          <div class="char-counter-bar">
            <div>${kwBadges}</div>
            <div class="char-count-num ${isOver ? "over-limit" : ""}" id="charCount_${escapeAttr(key)}">
              文字数（空白除く）: ${len}${sq.max_length ? ` / ${sq.max_length}字以内` : "字"}
            </div>
          </div>
        </div>
      `;
    }

    // Case 3: Single short answer
    const strVal = typeof savedVal === "string" ? savedVal : "";
    return `
      <div>
        <input type="text" class="cbt-input" value="${escapeAttr(strVal)}" placeholder="解答を入力してください..." oninput="window.__onSingleInput('${escapeAttr(key)}', this.value)" />
      </div>
    `;
  }

  function formatModelAnswerForDisplay(ans) {
    if (ans === null || ans === undefined) return "";
    if (typeof ans === "string") return ans;
    if (Array.isArray(ans)) return ans.map((x, i) => `・${x}`).join("\n");
    if (typeof ans === "object") {
      return Object.entries(ans)
        .map(([k, v]) => `【 ${k} 】 ${v}`)
        .join("　/　");
    }
    return String(ans);
  }

  function renderSubQuestionReveal(sq, qNo, key, grade) {
    const modelStr = formatModelAnswerForDisplay(sq.answer);
    return `
      <div class="answer-reveal-box">
        <div class="model-answer-block">
          <div class="model-answer-label">模範解答例</div>
          <div class="model-answer-text">${escapeHtml(modelStr)}</div>
        </div>

        <div class="self-grade-bar">
          <span style="font-size:12.5px;font-weight:700;color:var(--text-secondary);">採点結果（クリックで自己採点を変更可能）:</span>
          <div class="grade-btn-group">
            <button class="grade-btn ${grade === "correct" ? "active-correct" : ""}" onclick="window.__setGrade('${escapeAttr(key)}', 'correct')">○ 正解 (100%)</button>
            <button class="grade-btn ${grade === "partial" ? "active-partial" : ""}" onclick="window.__setGrade('${escapeAttr(key)}', 'partial')">△ 部分点 (50%)</button>
            <button class="grade-btn ${grade === "wrong" ? "active-wrong" : ""}" onclick="window.__setGrade('${escapeAttr(key)}', 'wrong')">× 不正解 (0%)</button>
          </div>
        </div>

        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:4px;">解説</div>
          <div class="explanation-text">${escapeHtml(sq.explanation || "解説データは問題全体の解説を参照してください。")}</div>
        </div>
      </div>
    `;
  }

  // Input Handlers
  window.__onBlankInput = function (key, blankKey, val) {
    if (!currentState.answers[key] || typeof currentState.answers[key] !== "object") {
      currentState.answers[key] = {};
    }
    currentState.answers[key][blankKey] = val;
    saveCurrentDraft();
    refreshNavPillsOnly();
  };

  window.__onSingleInput = function (key, val) {
    currentState.answers[key] = val;
    saveCurrentDraft();
    refreshNavPillsOnly();
  };

  window.__onDescInput = function (key, val, maxLen) {
    currentState.answers[key] = val;
    saveCurrentDraft();
    const len = val.replace(/\s+/g, "").length;
    const countEl = document.getElementById(`charCount_${key}`);
    if (countEl) {
      countEl.textContent = `文字数（空白除く）: ${len}${maxLen ? ` / ${maxLen}字以内` : "字"}`;
      if (maxLen && len > maxLen) countEl.classList.add("over-limit");
      else countEl.classList.remove("over-limit");
    }
    refreshNavPillsOnly();
  };

  function refreshNavPillsOnly() {
    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo);
    if (!qObj) return;
    const qNo = qObj.question_no;
    const pills = document.getElementById("subqNavBar").children;
    qObj.sub_questions.forEach((sq, idx) => {
      if (!pills[idx]) return;
      const key = `q${qNo}_${sq.sub_no}`;
      const hasAns = isSubQuestionAnswered(sq, qNo);
      const isRev = currentState.isGradedAll || !!currentState.revealed[key];
      if (!isRev) {
        pills[idx].classList.toggle("answered", hasAns);
      }
    });
  }

  window.__scrollToSubQ = function (idx) {
    const el = document.getElementById(`subqCard_${idx}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  window.__toggleFlagSubQ = function (key) {
    currentState.flags[key] = !currentState.flags[key];
    saveCurrentDraft();
    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo);
    if (qObj) renderRightPaneSubQuestions(qObj);
  };

  window.__toggleRevealSubQ = function (key, qNo, idx) {
    currentState.revealed[key] = !currentState.revealed[key];
    if (currentState.revealed[key] && !currentState.grades[key]) {
      const sessObj = currentState.examData.sessions[currentState.sessionKey];
      const qObj = sessObj.questions.find((q) => q.question_no === qNo);
      const sq = qObj && qObj.sub_questions[idx];
      if (sq) {
        currentState.grades[key] = evaluateSubQuestion(sq, qNo);
      }
    }
    saveCurrentDraft();
    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo);
    if (qObj) renderRightPaneSubQuestions(qObj);
  };

  window.__setGrade = function (key, gradeVal) {
    currentState.grades[key] = gradeVal;
    saveCurrentDraft();
    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo);
    if (qObj) renderRightPaneSubQuestions(qObj);
    if (currentState.isGradedAll) {
      renderScoreSummaryBanner();
    }
  };

  // Finish & Grade All Selected Questions
  function finishAndGradeSession() {
    currentState.timerRunning = false;
    currentState.isGradedAll = true;

    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const targetQNos =
      currentState.mode === "exam" ? currentState.selectedExamQNos : [currentState.activeQNo];

    let correctCount = 0;
    let partialCount = 0;
    let wrongCount = 0;
    let totalCount = 0;

    sessObj.questions.forEach((q) => {
      if (!targetQNos.includes(q.question_no)) return;
      q.sub_questions.forEach((sq) => {
        const key = `q${q.question_no}_${sq.sub_no}`;
        const g = evaluateSubQuestion(sq, q.question_no);
        currentState.grades[key] = g;
        currentState.revealed[key] = true;
        totalCount++;
        if (g === "correct") correctCount++;
        else if (g === "partial") partialCount++;
        else wrongCount++;
      });
    });

    const scorePercent =
      totalCount > 0 ? Math.round(((correctCount * 1.0 + partialCount * 0.5) / totalCount) * 100) : 0;

    // Save to History
    const now = new Date();
    const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(
      now.getDate()
    ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    appHistory.push({
      dateStr,
      mode: currentState.mode,
      yearKey: currentState.yearKey,
      yearLabel: `${currentState.examData.year} ${currentState.examData.season}`,
      sessionKey: currentState.sessionKey,
      selectedExamQNos: targetQNos.slice(),
      questionsLabel: targetQNos.map((n) => `問${n}`).join("・"),
      scorePercent,
      correctCount,
      partialCount,
      wrongCount,
      elapsedSeconds: currentState.elapsedSeconds,
      answers: JSON.parse(JSON.stringify(currentState.answers)),
      grades: JSON.parse(JSON.stringify(currentState.grades))
    });
    saveStore(STORAGE_KEYS.HISTORY, appHistory);
    saveCurrentDraft();

    const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo);
    if (qObj) renderRightPaneSubQuestions(qObj);
    renderScoreSummaryBanner();
  }

  function renderScoreSummaryBanner() {
    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const targetQNos =
      currentState.mode === "exam" ? currentState.selectedExamQNos : [currentState.activeQNo];

    let correctCount = 0;
    let partialCount = 0;
    let wrongCount = 0;
    let totalCount = 0;

    sessObj.questions.forEach((q) => {
      if (!targetQNos.includes(q.question_no)) return;
      q.sub_questions.forEach((sq) => {
        const key = `q${q.question_no}_${sq.sub_no}`;
        const g = currentState.grades[key] || evaluateSubQuestion(sq, q.question_no);
        totalCount++;
        if (g === "correct") correctCount++;
        else if (g === "partial") partialCount++;
        else wrongCount++;
      });
    });

    const scorePercent =
      totalCount > 0 ? Math.round(((correctCount * 1.0 + partialCount * 0.5) / totalCount) * 100) : 0;
    const passBadge =
      scorePercent >= 60
        ? `<span style="background:var(--success);color:#fff;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;">合格圏内 (60%以上)</span>`
        : `<span style="background:var(--warning);color:#fff;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;">要復習 (60%未満)</span>`;

    const banner = document.getElementById("scoreSummaryBanner");
    banner.style.display = "block";
    banner.innerHTML = `
      <div class="stat-card" style="border:2px solid var(--primary);background:var(--primary-light);">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
          <div>
            <div style="font-size:12px;font-weight:700;color:var(--primary);">採点集計結果（対象: ${targetQNos
              .map((n) => "問" + n)
              .join("・")}）</div>
            <div style="font-size:24px;font-weight:800;color:var(--text-main);margin-top:2px;">
              総合スコア: ${scorePercent}% <span style="font-size:14px;font-weight:600;color:var(--text-secondary);">（○正解: ${correctCount} / △部分点: ${partialCount} / ×不正解: ${wrongCount} / 計${totalCount}設問）</span>
            </div>
          </div>
          ${passBadge}
        </div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:6px;">
          ※記述式設問は各設問カードの「○正解 / △部分点 / ×不正解」ボタンをクリックするとリアルタイムに再集計されます。
        </div>
      </div>
    `;
  }

  // Highlighter Logic in Left Pane
  function setupHighlighter() {
    const swatches = document.querySelectorAll(".marker-swatch");
    swatches.forEach((btn) => {
      btn.addEventListener("click", () => {
        swatches.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentState.markerColor = btn.getAttribute("data-color");
      });
    });

    const bodyEl = document.getElementById("problemBodyContent");
    bodyEl.addEventListener("mouseup", () => {
      if (!currentState.markerColor || currentState.markerColor === "none") return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!bodyEl.contains(range.commonAncestorContainer)) return;

      const text = sel.toString().trim();
      if (!text) return;

      try {
        const mark = document.createElement("mark");
        mark.className = `cbt-mark-${currentState.markerColor}`;
        mark.title = "クリックでこのマーカーを消去";
        range.surroundContents(mark);
        sel.removeAllRanges();
        saveCurrentHighlights();
      } catch (e) {
        // Fallback for selections spanning multiple nodes
        const frag = range.extractContents();
        const mark = document.createElement("mark");
        mark.className = `cbt-mark-${currentState.markerColor}`;
        mark.title = "クリックでこのマーカーを消去";
        mark.appendChild(frag);
        range.insertNode(mark);
        sel.removeAllRanges();
        saveCurrentHighlights();
      }
    });

    // Click existing <mark> to remove it
    bodyEl.addEventListener("click", (e) => {
      const m = e.target.closest("mark[class^='cbt-mark-']");
      if (m) {
        const parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        saveCurrentHighlights();
      }
    });

    document.getElementById("btnClearMarks").addEventListener("click", () => {
      if (!currentState.examData) return;
      const sessObj = currentState.examData.sessions[currentState.sessionKey];
      const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo);
      if (!qObj) return;
      const hlKey = `${currentState.yearKey}_${currentState.sessionKey}_q${qObj.question_no}`;
      delete appHighlights[hlKey];
      saveStore(STORAGE_KEYS.HIGHLIGHTS, appHighlights);
      bodyEl.innerHTML = formatBodyMarkdownToHtml(qObj.body_markdown, qObj.figures || []);
    });
  }

  function saveCurrentHighlights() {
    if (!currentState.examData) return;
    const hlKey = `${currentState.yearKey}_${currentState.sessionKey}_q${currentState.activeQNo}`;
    appHighlights[hlKey] = document.getElementById("problemBodyContent").innerHTML;
    saveStore(STORAGE_KEYS.HIGHLIGHTS, appHighlights);
  }

  // Floating Pinned Figure Window
  window.__openFloatingFigure = function (path, caption) {
    const modal = document.getElementById("floatingFigModal");
    const img = document.getElementById("floatingFigImg");
    const title = document.getElementById("floatingFigTitle");
    currentState.figZoom = 1.0;
    img.style.transform = `scale(1)`;
    img.src = path;
    title.textContent = caption || "図表ビューア";
    modal.classList.add("active");
  };

  function setupFloatingFigureViewer() {
    const modal = document.getElementById("floatingFigModal");
    const header = document.getElementById("floatingFigHeader");
    const img = document.getElementById("floatingFigImg");

    document.getElementById("btnCloseFloatingFig").addEventListener("click", () => {
      modal.classList.remove("active");
    });
    document.getElementById("btnZoomInFig").addEventListener("click", () => {
      currentState.figZoom = Math.min(2.5, currentState.figZoom + 0.25);
      img.style.transform = `scale(${currentState.figZoom})`;
    });
    document.getElementById("btnZoomOutFig").addEventListener("click", () => {
      currentState.figZoom = Math.max(0.5, currentState.figZoom - 0.25);
      img.style.transform = `scale(${currentState.figZoom})`;
    });
    document.getElementById("btnZoomResetFig").addEventListener("click", () => {
      currentState.figZoom = 1.0;
      img.style.transform = `scale(1)`;
    });

    // Make Floating Window Draggable
    let isDragging = false;
    let startX = 0,
      startY = 0,
      origLeft = 0,
      origTop = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      isDragging = true;
      const rect = modal.getBoundingClientRect();
      modal.style.right = "auto";
      modal.style.bottom = "auto";
      modal.style.left = rect.left + "px";
      modal.style.top = rect.top + "px";
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      modal.style.left = Math.max(0, origLeft + dx) + "px";
      modal.style.top = Math.max(40, origTop + dy) + "px";
    });

    window.addEventListener("mouseup", () => {
      isDragging = false;
    });
  }

  // Split Pane Resizer
  function setupPaneResizer() {
    const resizer = document.getElementById("paneResizer");
    const leftPane = document.getElementById("leftPane");
    const container = document.getElementById("splitContainer");
    let dragging = false;

    resizer.addEventListener("mousedown", (e) => {
      dragging = true;
      resizer.classList.add("dragging");
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = container.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      if (pct >= 25 && pct <= 75) {
        leftPane.style.width = `${pct}%`;
      }
    });

    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        resizer.classList.remove("dragging");
      }
    });
  }

  // Modals: Overview / Question Selection / Data Backup
  function openModal(title, bodyHtml, primaryLabel, onPrimary) {
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalBody").innerHTML = bodyHtml;
    const btnPrimary = document.getElementById("btnModalPrimary");
    if (primaryLabel && onPrimary) {
      btnPrimary.style.display = "inline-flex";
      btnPrimary.textContent = primaryLabel;
      btnPrimary.onclick = onPrimary;
    } else {
      btnPrimary.style.display = "none";
    }
    document.getElementById("appModal").classList.add("active");
  }

  function closeModal() {
    document.getElementById("appModal").classList.remove("active");
  }

  function openQuestionSelectModal() {
    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const reqCount = sessObj.select_count || (currentState.sessionKey === "pm1" ? 2 : 1);
    const checkboxesHtml = sessObj.questions
      .map((q) => {
        const checked = currentState.selectedExamQNos.includes(q.question_no) ? "checked" : "";
        return `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:10px;cursor:pointer;">
            <input type="checkbox" name="examQSelect" value="${q.question_no}" ${checked} style="margin-top:4px;transform:scale(1.2);" />
            <div>
              <div style="font-weight:800;font-size:15px;">問${q.question_no}: ${escapeHtml(q.title)}</div>
              <div style="font-size:12.5px;color:var(--text-secondary);margin-top:4px;">設問数: ${q.sub_questions.length}問 / 図表数: ${
          (q.figures || []).length
        }点</div>
            </div>
          </label>
        `;
      })
      .join("");

    openModal(
      `${sessObj.name} 解答する問題の選択（${sessObj.selection_rule}）`,
      `<p style="font-size:13.5px;color:var(--text-secondary);margin-bottom:14px;">本番試験モードで採点対象とする問題を <strong>${reqCount}問</strong> 選択してください（試験中も上部の「選択問題を設定」から変更可能です）。</p>${checkboxesHtml}`,
      "選択を確定して開始",
      () => {
        const checked = Array.from(document.querySelectorAll("input[name='examQSelect']:checked")).map((el) =>
          Number(el.value)
        );
        if (checked.length !== reqCount) {
          alert(`${sessObj.name}では ${reqCount}問 選択してください（現在 ${checked.length}問 選択中）。`);
          return;
        }
        currentState.selectedExamQNos = checked;
        if (!checked.includes(currentState.activeQNo)) {
          currentState.activeQNo = checked[0];
        }
        closeModal();
        renderSimulatorHeaderAndTabs();
        renderActiveQuestion();
      }
    );
  }

  function openOverviewModal() {
    if (!currentState.examData) return;
    const sessObj = currentState.examData.sessions[currentState.sessionKey];
    const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo);
    if (!qObj) return;

    const html = `
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div>
          <h4 style="font-size:14px;color:var(--primary);margin-bottom:6px;">≪出題趣旨≫</h4>
          <div class="explanation-text">${escapeHtml(qObj.intent || "記載なし")}</div>
        </div>
        <div>
          <h4 style="font-size:14px;color:var(--primary);margin-bottom:6px;">≪採点講評≫</h4>
          <div class="explanation-text">${escapeHtml(qObj.review_comment || "記載なし")}</div>
        </div>
        <div>
          <h4 style="font-size:14px;color:var(--primary);margin-bottom:6px;">≪全体解説≫</h4>
          <div class="explanation-text">${escapeHtml(qObj.overview_explanation || "記載なし")}</div>
        </div>
      </div>
    `;
    openModal(`問${qObj.question_no}「${qObj.title}」出題趣旨・採点講評・全体解説`, html);
  }

  function openBackupModal() {
    const exportObj = {
      exportedAt: new Date().toISOString(),
      history: appHistory,
      bookmarks: appBookmarks,
      highlights: appHighlights,
      drafts: appDrafts
    };
    const jsonStr = JSON.stringify(exportObj, null, 2);

    const html = `
      <div style="display:flex;flex-direction:column;gap:14px;">
        <p style="font-size:13px;color:var(--text-secondary);">学習履歴・復習ブックマーク・蛍光ペンマーカー・入力中の下書きデータをJSONファイルとして保存・復元できます。</p>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary" onclick="window.__downloadBackupJson()">JSONファイルをダウンロード</button>
          <label class="btn btn-secondary" style="cursor:pointer;">
            JSONファイルから復元
            <input type="file" accept=".json" style="display:none;" onchange="window.__importBackupJson(this)" />
          </label>
        </div>
        <textarea class="cbt-textarea" style="height:180px;font-family:monospace;font-size:12px;" readonly>${escapeHtml(
          jsonStr
        )}</textarea>
      </div>
    `;
    openModal("学習データのバックアップ保存 / 復元", html);
  }

  window.__downloadBackupJson = function () {
    const exportObj = {
      exportedAt: new Date().toISOString(),
      history: appHistory,
      bookmarks: appBookmarks,
      highlights: appHighlights,
      drafts: appDrafts
    };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nw_cbt_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  window.__importBackupJson = function (inputEl) {
    const file = inputEl.files && inputEl.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (parsed.history) saveStore(STORAGE_KEYS.HISTORY, (appHistory = parsed.history));
        if (parsed.bookmarks) saveStore(STORAGE_KEYS.BOOKMARKS, (appBookmarks = parsed.bookmarks));
        if (parsed.highlights) saveStore(STORAGE_KEYS.HIGHLIGHTS, (appHighlights = parsed.highlights));
        if (parsed.drafts) saveStore(STORAGE_KEYS.DRAFTS, (appDrafts = parsed.drafts));
        closeModal();
        renderDashboard();
        alert("学習データを復元しました！");
      } catch (e) {
        alert("JSONファイルの形式が正しくありません: " + e.message);
      }
    };
    reader.readAsText(file);
  };

  window.__removeBookmark = function (bmKey) {
    delete appBookmarks[bmKey];
    saveStore(STORAGE_KEYS.BOOKMARKS, appBookmarks);
    renderDashboard();
  };

  window.__clearAllHistory = function () {
    if (!confirm("すべての解答履歴を消去しますか？")) return;
    appHistory = [];
    saveStore(STORAGE_KEYS.HISTORY, appHistory);
    renderDashboard();
  };

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  // Initialize Event Listeners
  function initApp() {
    // Dashboard Tabs
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const target = btn.getAttribute("data-tab");
        ["tabExams", "tabBookmarks", "tabHistory"].forEach((id) => {
          document.getElementById(id).style.display = id === target ? "block" : "none";
        });
      });
    });

    const goHome = () => {
      if (currentState.timerInterval) clearInterval(currentState.timerInterval);
      document.getElementById("viewSimulator").classList.remove("active");
      document.getElementById("viewDashboard").classList.add("active");
      document.getElementById("headerSessionInfo").innerHTML = "";
      renderDashboard();
    };

    document.getElementById("btnHomeLogo").addEventListener("click", goHome);
    document.getElementById("btnNavDashboard").addEventListener("click", goHome);
    document.getElementById("btnBackToHome").addEventListener("click", goHome);

    document.getElementById("btnToggleTimer").addEventListener("click", (e) => {
      currentState.timerRunning = !currentState.timerRunning;
      e.target.textContent = currentState.timerRunning ? "一時停止" : "再開";
    });

    document.getElementById("btnBookmarkQuestion").addEventListener("click", () => {
      if (!currentState.examData) return;
      const sessObj = currentState.examData.sessions[currentState.sessionKey];
      const qObj = sessObj.questions.find((q) => q.question_no === currentState.activeQNo);
      if (!qObj) return;
      const bmKey = `${currentState.yearKey}_${currentState.sessionKey}_q${currentState.activeQNo}`;
      if (appBookmarks[bmKey]) {
        delete appBookmarks[bmKey];
      } else {
        const now = new Date();
        appBookmarks[bmKey] = {
          yearKey: currentState.yearKey,
          yearLabel: `${currentState.examData.year} ${currentState.examData.season}`,
          sessionKey: currentState.sessionKey,
          qNo: currentState.activeQNo,
          title: qObj.title,
          savedAt: `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(
            now.getDate()
          ).padStart(2, "0")}`
        };
      }
      saveStore(STORAGE_KEYS.BOOKMARKS, appBookmarks);
      updateBookmarkButtonState();
    });

    document.getElementById("btnFinishAndGrade").addEventListener("click", finishAndGradeSession);
    document.getElementById("btnSelectExamQuestions").addEventListener("click", openQuestionSelectModal);
    document.getElementById("btnShowOverviewModal").addEventListener("click", openOverviewModal);
    document.getElementById("btnExportData").addEventListener("click", openBackupModal);
    document.getElementById("btnCloseModal").addEventListener("click", closeModal);
    document.getElementById("appModal").addEventListener("click", (e) => {
      if (e.target.id === "appModal") closeModal();
    });

    setupHighlighter();
    setupFloatingFigureViewer();
    setupPaneResizer();
    renderDashboard();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
