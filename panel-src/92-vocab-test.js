    function installVocabTest(ctx) {
    let vocabTestInOverlay = false;
    let vocabTestStage = 1;
    let vocabTestItems = [];
    let vocabTestIndex = 0;
    let vocabTestAnswers = [];
    let vocabTestTotal = null;

    // ---- vocabulary-size test -------------------------------------------
    //
    // Two-stage adaptive test (see vocab_test.py): stage 1 samples 5 widely-
    // spaced frequency ranks to get a rough estimate, stage 2 re-samples 5
    // ranks around that estimate to refine it. Reuses
    // .quiz-card/.quiz-topbar from the review quiz above -- it's the same
    // "one word, one decision" shape, just without an answer to reveal.

    function exitVocabTest() {
      previewOverlay.hidden = true;
      previewOverlay.innerHTML = "";
      vocabTestInOverlay = false;
      ctx.fns.renderQuizStart();
    }

    const vocabTestHost = () => vocabTestInOverlay ? previewOverlay : vocabQuiz;

    async function startVocabTest() {
      vocabTestInOverlay = true;
      previewOverlay.hidden = false;
      const host = vocabTestHost();
      host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-count">准备题目中…</div></div></div>`;
      vocabTestAnswers = [];
      vocabTestStage = 1;
      try {
        const data = await (await fetch(`${API}/api/vocab-test/stage1`, { method: "POST" })).json();
        vocabTestItems = data.items;
        vocabTestTotal = vocabTestItems.length;
      } catch (e) {
        host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-empty">题目加载失败：${ctx.fns.escapeHtml(e.message)}</div></div></div>`;
        return;
      }
      vocabTestIndex = 0;
      renderVocabTestCard();
    }

    function renderVocabTestCard() {
      if (vocabTestIndex >= vocabTestItems.length) {
        if (vocabTestStage === 1) { advanceVocabTestToStage2(); return; }
        finishVocabTest();
        return;
      }
      const item = vocabTestItems[vocabTestIndex];
      const doneSoFar = vocabTestAnswers.length;
      const meaning = Array.isArray(item.meaning_options) && item.meaning_options.length === 6;
      const host = vocabTestHost();
      host.innerHTML = `
        <div class="vocab-test-modal">
        <div class="quiz-topbar">
          <div class="quiz-progress">第 ${doneSoFar + 1} 题${vocabTestTotal ? `（共 ${vocabTestTotal} 题）` : ""}</div>
          <button class="quiz-exit-btn" title="退出测试" aria-label="退出测试">${icon("close")}</button>
        </div>
        <div class="quiz-card">
          <div class="vocab-test-kicker">${meaning ? "选择最接近的中文释义" : "凭第一反应回答，不确定就选“模糊”"}</div>
          <div class="quiz-word">${ctx.fns.escapeHtml(item.lemma)}</div>
          ${meaning
            ? `<div class="vocab-meaning-options">${item.meaning_options.map((option, i) =>
                `<button class="vocab-meaning-option" data-option="${i}">${ctx.fns.escapeHtml(option)}</button>`).join("")}
                <button class="vocab-meaning-unknown">${icon("close")} 不认识，不做猜测</button></div>`
            : `<div class="quiz-grade-row">
                <button class="quiz-grade-btn quiz-grade-unknown">${icon("close")} 不认识</button>
                <button class="quiz-grade-btn quiz-grade-unsure">模糊</button>
                <button class="quiz-grade-btn quiz-grade-known">${icon("check")} 认识</button>
              </div>`}
        </div>
        </div>
      `;
      host.querySelector(".quiz-exit-btn").addEventListener("click", exitVocabTest);
      const meaningOptions = host.querySelectorAll(".vocab-meaning-option");
      if (meaningOptions.length) meaningOptions.forEach((button) => button.addEventListener("click", () => {
        const selected = Number(button.dataset.option);
        submitVocabTestAnswer(item, selected === item.correct_option ? 2 : 0);
      }));
      const meaningUnknown = host.querySelector(".vocab-meaning-unknown");
      if (meaningUnknown) meaningUnknown.addEventListener("click", () => submitVocabTestAnswer(item, 0));
      const unknown = host.querySelector(".quiz-grade-unknown");
      const unsure = host.querySelector(".quiz-grade-unsure");
      const known = host.querySelector(".quiz-grade-known");
      if (unknown) unknown.addEventListener("click", () => submitVocabTestAnswer(item, 0));
      if (unsure) unsure.addEventListener("click", () => submitVocabTestAnswer(item, 1));
      if (known) known.addEventListener("click", () => submitVocabTestAnswer(item, 2));
    }

    function submitVocabTestAnswer(item, rating) {
      vocabTestAnswers.push({ lemma: item.lemma, rank: item.rank, rating,
        known: rating === 2, is_fake: !!item.is_fake });
      vocabTestIndex++;
      renderVocabTestCard();
    }

    async function advanceVocabTestToStage2() {
      const host = vocabTestHost();
      host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-count">准备第二阶段…</div></div></div>`;
      try {
        const data = await (await fetch(`${API}/api/vocab-test/stage2`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: vocabTestAnswers }),
        })).json();
        vocabTestItems = data.items;
        vocabTestTotal = vocabTestAnswers.length + vocabTestItems.length;
      } catch (e) {
        host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-empty">题目加载失败：${ctx.fns.escapeHtml(e.message)}</div></div></div>`;
        return;
      }
      vocabTestStage = 2;
      vocabTestIndex = 0;
      renderVocabTestCard();
    }

    async function finishVocabTest() {
      const host = vocabTestHost();
      host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-count">算分中…</div></div></div>`;
      let result;
      try {
        result = await (await fetch(`${API}/api/vocab-test/finish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: vocabTestAnswers }),
        })).json();
      } catch (e) {
        host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-empty">提交失败：${ctx.fns.escapeHtml(e.message)}</div></div></div>`;
        return;
      }
      ctx.state.vocabTestStatus = { vocab_size: result.vocab_size, level_label: result.level_label, is_default: false };
      host.innerHTML = `
        <div class="vocab-test-modal">
        <div class="quiz-topbar">
          <div class="quiz-progress">完成</div>
          <button class="quiz-exit-btn" title="退出测试" aria-label="退出测试">${icon("close")}</button>
        </div>
        <div class="vocab-test-result">
          <div class="vocab-test-result-size">约 ${result.vocab_size} 词</div>
          <div class="vocab-test-result-range">合理范围 ${result.vocab_size_low} - ${result.vocab_size_high} 词</div>
          <div class="vocab-test-result-label">${ctx.fns.escapeHtml(result.level_label)}</div>
          ${result.retake_suggested
            ? `<div class="vocab-test-retake-warning">这次答题里有 ${result.fake_known} 个"认识"给了不存在的词，结果可能不准，建议重新测一次。</div>`
            : ""}
          <div class="quiz-summary-actions">
            ${result.retake_suggested ? `<button class="quiz-retry-missed-btn">重新测一次</button>` : ""}
            <button class="quiz-exit-summary-btn">完成</button>
          </div>
        </div>
        </div>
      `;
      host.querySelector(".quiz-exit-btn").addEventListener("click", exitVocabTest);
      host.querySelector(".quiz-exit-summary-btn").addEventListener("click", exitVocabTest);
      const retryBtn = host.querySelector(".quiz-retry-missed-btn");
      if (retryBtn) retryBtn.addEventListener("click", startVocabTest);
    }

    ctx.fns.startVocabTest = startVocabTest;
    ctx.fns.exitVocabTest = exitVocabTest;
    }
    installVocabTest(ctx);
