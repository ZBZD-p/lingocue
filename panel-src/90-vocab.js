    function installVocab(ctx) {
    // ---- vocab ----

    // Matches app.py's MASTERED_STREAK -- a word this many consecutive
    // "known" gradings in a row drops out of the quiz pool (but stays in
    // the vocab book). Duplicated rather than fetched because it only ever
    // needs to agree with the backend's own constant, never be configurable
    // per-request.
    const MASTERED_STREAK = 6;

    // ms -> "明天" / "3 天后" / null if already due. Shared by the quiz's
    // idle screen (nothing due right now, but something will be) and the
    // vocab list's per-card countdown.
    function fmtDueIn(ts) {
      const ms = ts * 1000 - Date.now();
      if (ms <= 0) return null;
      const days = Math.round(ms / 86400000);
      return days <= 0 ? "今天晚些时候" : days === 1 ? "明天" : `${days} 天后`;
    }

    let quizQueue = [];
    let quizIndex = 0;
    let quizKnown = 0;
    let quizUnknown = 0;
    let quizMissed = [];

    function shuffled(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    // Exam-syllabus tags a saved word can carry (see dictionary.py/
    // build_dict.py) -- only words saved after that feature shipped have
    // any of these; older entries just have no tags array to match against,
    // which the scope filter below treats as "excluded once a scope is
    // actually chosen", same as a word genuinely off every list.
    const QUIZ_TAG_OPTIONS = [
      { value: "zk", label: "中考" },
      { value: "gk", label: "高考" },
      { value: "cet4", label: "四级" },
      { value: "cet6", label: "六级" },
      { value: "ky", label: "考研" },
      { value: "toefl", label: "托福" },
      { value: "ielts", label: "雅思" },
      { value: "gre", label: "GRE" },
    ];
    // "0" = 不限 (whatever's due, all at once) -- the original behavior,
    // still the default for anyone who never touches this setting.
    const QUIZ_BATCH_OPTIONS = ["10", "20", "30", "0"];
    const QUIZ_SCOPE_KEY = "english-tutor-quiz-scope";
    const QUIZ_BATCH_KEY = "english-tutor-quiz-batch";

    function loadQuizScope() {
      try {
        const saved = JSON.parse(localStorage.getItem(QUIZ_SCOPE_KEY));
        return Array.isArray(saved) ? saved : [];
      } catch (e) {
        return [];
      }
    }
    function saveQuizScope(tags) { localStorage.setItem(QUIZ_SCOPE_KEY, JSON.stringify(tags)); }
    function loadQuizBatch() { return localStorage.getItem(QUIZ_BATCH_KEY) || "0"; }
    function saveQuizBatch(v) { localStorage.setItem(QUIZ_BATCH_KEY, v); }

    // Has a captured meaning (nothing to self-test against otherwise),
    // hasn't hit MASTERED_STREAK (see renderVocabList's badge, which is
    // the way back in), and matches the current scope filter -- everything
    // except whether it's actually due today, which quizPool below adds.
    // Split out from quizPool so renderQuizStart can tell "nothing due"
    // apart from "nothing matches this scope at all" using the same
    // filtering logic instead of two separate implementations of it.
    function scopedEligible() {
      const scope = loadQuizScope();
      // Checking every single box reads as "don't filter" to anyone
      // clicking it, not "only words carrying at least one exam tag" --
      // the latter would silently exclude every untagged word (most of a
      // real vocab book, including anything saved before tags existed at
      // all, or a word genuinely off all 8 lists), which is the opposite
      // of what "select everything" means to someone using the checkboxes.
      const noFilter = scope.length === 0 || scope.length === QUIZ_TAG_OPTIONS.length;
      return ctx.state.vocabEntries.filter((e) => {
        if (!e.answer || (e.streak || 0) >= MASTERED_STREAK) return false;
        if (noFilter) return true;
        return (e.tags || []).some((t) => scope.includes(t));
      });
    }

    function quizPool() {
      const now = Date.now() / 1000;
      return scopedEligible().filter((e) => (e.next_review_at || 0) <= now);
    }

    async function gradeEntry(entry, result) {
      const res = await fetch(`${API}/api/vocab/${entry.id}/grade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result }),
      });
      const data = await res.json();
      // Mirrors the persisted values onto the in-memory record so the vocab
      // list (mastered badge / due countdown) and the next quiz's pool are
      // correct without re-fetching the whole list.
      if (data && data.ok) {
        entry.streak = data.streak;
        entry.next_review_at = data.next_review_at;
        if (result === "known") {
          ctx.fns.refreshVocabHighlight();
          invalidateDifficultyBadge();
          updateDifficultyBadge();
        }
      }
      return data;
    }

    function startQuiz(pool) {
      const batch = parseInt(loadQuizBatch(), 10) || 0;
      quizQueue = shuffled(pool);
      if (batch > 0) quizQueue = quizQueue.slice(0, batch);
      quizIndex = 0;
      quizKnown = 0;
      quizUnknown = 0;
      quizMissed = [];
      renderQuizCard();
    }

    // Own tab's idle state -- what "抽查" shows before a round is started,
    // and what "退出抽查" returns to. Doesn't re-fetch: vocabEntries is
    // already current enough (loaded when this tab was entered, kept in
    // sync locally by gradeEntry as gradings come in during the round).
    function renderQuizStart() {
      const pool = quizPool();
      const scoped = scopedEligible();
      let emptyReason;
      if (ctx.state.vocabEntries.length === 0) {
        emptyReason = "还没有生词。去生词本页存一些吧。";
      } else {
        // Has an answer and isn't mastered yet, ignoring the scope filter --
        // distinct from "scoped is empty", which could just mean the chosen
        // tags don't match anything even though the book has plenty left.
        const unscopedEligible = ctx.state.vocabEntries.filter((e) => e.answer && (e.streak || 0) < MASTERED_STREAK);
        if (unscopedEligible.length === 0) {
          emptyReason = "没有可抽查的词——生词都已掌握，或者还没查过意思。";
        } else if (scoped.length === 0) {
          emptyReason = "你选的范围里没有符合的生词，换个范围或者取消筛选试试。";
        } else {
          const soonest = Math.min(...scoped.map((e) => e.next_review_at || 0));
          emptyReason = `今天的复习都做完了，下一个词 ${fmtDueIn(soonest) || "很快"} 到期。`;
        }
      }

      // Plain toggle buttons, not native checkboxes/<select> -- this panel
      // doesn't use native form controls anywhere else (the settings page's
      // own dropdowns are hand-rolled too, see populateSelect, precisely
      // because a native popup renders outside the shadow root with none of
      // this stylesheet applied to it). Pills match the same accent-select
      // language already used for .tab-btn.active/.dropdown-item.selected.
      const scope = loadQuizScope();
      const batch = loadQuizBatch();
      const scopeHtml = QUIZ_TAG_OPTIONS.map((opt) => `
        <button class="quiz-scope-pill${scope.includes(opt.value) ? " selected" : ""}" data-tag="${opt.value}">${opt.label}</button>
      `).join("");
      const batchHtml = QUIZ_BATCH_OPTIONS.map((v) => `
        <button class="quiz-batch-pill${v === batch ? " selected" : ""}" data-batch="${v}">${v === "0" ? "不限" : v}</button>
      `).join("");

      const statusLine = ctx.state.vocabTestStatus
        ? (ctx.state.vocabTestStatus.is_default
            ? "还没测过，视频难度目前按默认水平估计"
            : `约 ${ctx.state.vocabTestStatus.vocab_size} 词 · ${ctx.state.vocabTestStatus.level_label}`)
        : "加载中…";

      vocabQuiz.innerHTML = `
        <div class="vocab-test-promo">
          <div class="vocab-test-promo-text">
            <div class="vocab-test-promo-title">你的词汇量</div>
            <div class="vocab-test-promo-sub">${ctx.fns.escapeHtml(statusLine)}</div>
          </div>
          <button class="vocab-test-start-btn">${ctx.state.vocabTestStatus && !ctx.state.vocabTestStatus.is_default ? "重新测一下" : "测一下"}</button>
        </div>
        <div class="quiz-scope">
          <div class="quiz-scope-row">${scopeHtml}</div>
          <div class="quiz-batch-row">
            <span class="quiz-batch-label">一次抽查</span>
            <div class="quiz-batch-pills">${batchHtml}</div>
          </div>
        </div>
        ${pool.length > 0 ? `
          <div class="quiz-start">
            <div class="quiz-start-count">${pool.length} 个词可以抽查</div>
            <button class="quiz-start-btn">${icon("repeat")} 开始抽查</button>
          </div>
        ` : `
          <div class="quiz-start">
            <div class="quiz-start-empty">${ctx.fns.escapeHtml(emptyReason)}</div>
          </div>
        `}
      `;

      // Any pill flipping re-renders the whole thing (simplest way to keep
      // the "X 个词可以抽查" count live as the filter changes) --
      // loadQuizScope() reflected into each pill's `.selected` class above
      // is what makes that rebuild preserve the selection instead of
      // losing it.
      vocabQuiz.querySelectorAll(".quiz-scope-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          const current = loadQuizScope();
          const tag = pill.dataset.tag;
          const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
          saveQuizScope(next);
          renderQuizStart();
        });
      });
      // No re-render here: batch size only affects how many due words get
      // pulled into a round once started, not what's currently eligible/due.
      vocabQuiz.querySelectorAll(".quiz-batch-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          saveQuizBatch(pill.dataset.batch);
          vocabQuiz.querySelectorAll(".quiz-batch-pill").forEach((p) => p.classList.toggle("selected", p === pill));
        });
      });

      const startBtn = vocabQuiz.querySelector(".quiz-start-btn");
      if (startBtn) startBtn.addEventListener("click", () => startQuiz(pool));
      vocabQuiz.querySelector(".vocab-test-start-btn").addEventListener("click", ctx.fns.startVocabTest);
    }

    async function loadQuizStart() {
      vocabQuiz.innerHTML = `<div class="quiz-start"><div class="quiz-start-count">加载中…</div></div>`;
      try {
        [ctx.state.vocabEntries, ctx.state.vocabTestStatus] = await Promise.all([
          fetch(`${API}/api/vocab`).then((r) => r.json()),
          fetch(`${API}/api/vocab-test/status`).then((r) => r.json()),
        ]);
      } catch (e) {
        vocabQuiz.innerHTML = `<div class="quiz-start"><div class="quiz-start-empty">加载生词本失败：${ctx.fns.escapeHtml(e.message)}</div></div>`;
        return;
      }
      renderQuizStart();
    }

    // The "退出抽查" click handler.
    function exitQuiz() {
      renderQuizStart();
    }

    function renderQuizCard() {
      if (quizIndex >= quizQueue.length) { renderQuizSummary(); return; }
      const entry = quizQueue[quizIndex];
      // Before the answer's revealed, not after -- hearing the word while
      // trying to recall its meaning is the point, same reasoning as why
      // the word itself is shown first. Reuses the same pronunciation path
      // as the vocab list's speak button (Youdao audio, falling back to the
      // browser's own TTS).
      ctx.fns.speakWord(entry.question);
      vocabQuiz.innerHTML = `
        <div class="quiz-topbar">
          <div class="quiz-progress">${quizIndex + 1} / ${quizQueue.length}</div>
          <button class="quiz-exit-btn" title="退出抽查" aria-label="退出抽查">${icon("close")}</button>
        </div>
        <div class="quiz-card">
          <div class="quiz-word">${ctx.fns.escapeHtml(entry.question)}</div>
          <button class="quiz-reveal-btn">显示答案</button>
        </div>
      `;
      vocabQuiz.querySelector(".quiz-exit-btn").addEventListener("click", exitQuiz);
      vocabQuiz.querySelector(".quiz-reveal-btn").addEventListener("click", () => renderQuizCardRevealed(entry));
    }

    function renderQuizCardRevealed(entry) {
      // Same word again on reveal -- this click is a direct user gesture
      // (unlike the auto-play on card arrival above), so there's no
      // autoplay-restriction risk here even if the first one got blocked.
      ctx.fns.speakWord(entry.question);
      const quizCard = vocabQuiz.querySelector(".quiz-card");
      quizCard.innerHTML = `
        <div class="quiz-word">${ctx.fns.escapeHtml(entry.question)}</div>
        ${entry.subtitle_text ? `<div class="quiz-subtitle">"${ctx.fns.escapeHtml(entry.subtitle_text)}"</div>` : ""}
        <div class="quiz-answer">${ctx.fns.renderMarkdown(entry.answer)}</div>
        <div class="quiz-grade-row">
          <button class="quiz-grade-btn quiz-grade-unknown">${icon("close")} 不认识</button>
          <button class="quiz-grade-btn quiz-grade-known">${icon("check")} 认识</button>
        </div>
      `;
      quizCard.querySelector(".quiz-grade-unknown").addEventListener("click", () => submitGrade(entry, false));
      quizCard.querySelector(".quiz-grade-known").addEventListener("click", () => submitGrade(entry, true));
    }

    async function submitGrade(entry, known) {
      vocabQuiz.querySelectorAll(".quiz-grade-btn").forEach((b) => { b.disabled = true; });
      try {
        await gradeEntry(entry, known ? "known" : "unknown");
      } catch (e) {
        // Best-effort: session counters below still advance so one network
        // hiccup doesn't stall the whole quiz -- this grading just won't
        // have persisted, same tradeoff as pushDeepSeekConfig elsewhere.
      }
      if (known) quizKnown++; else { quizUnknown++; quizMissed.push(entry); }
      quizIndex++;
      renderQuizCard();
    }

    function renderQuizSummary() {
      vocabQuiz.innerHTML = `
        <div class="quiz-topbar">
          <div class="quiz-progress">完成</div>
          <button class="quiz-exit-btn" title="退出抽查" aria-label="退出抽查">${icon("close")}</button>
        </div>
        <div class="quiz-summary">
          <div class="quiz-summary-line quiz-summary-known">${icon("check")} 认识 ${quizKnown} 个</div>
          <div class="quiz-summary-line quiz-summary-unknown">${icon("close")} 不认识 ${quizUnknown} 个</div>
          <div class="quiz-summary-actions">
            ${quizMissed.length > 0
              ? `<button class="quiz-retry-missed-btn">只复习刚才不认识的（${quizMissed.length}）</button>` : ""}
            <button class="quiz-exit-summary-btn">退出抽查</button>
          </div>
        </div>
      `;
      vocabQuiz.querySelector(".quiz-exit-btn").addEventListener("click", exitQuiz);
      vocabQuiz.querySelector(".quiz-exit-summary-btn").addEventListener("click", exitQuiz);
      const retryBtn = vocabQuiz.querySelector(".quiz-retry-missed-btn");
      if (retryBtn) retryBtn.addEventListener("click", () => startQuiz(quizMissed));
    }

    ctx.fns.loadQuizStart = loadQuizStart;
    ctx.fns.gradeEntry = gradeEntry;
    ctx.fns.renderQuizStart = renderQuizStart;
    }
    installVocab(ctx);
