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

    async function saveVocabEntry(payload) {
      const res = await fetch(`${API}/api/vocab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`保存失败（HTTP ${res.status}）`);
      const data = await res.json();
      ctx.fns.refreshVocabHighlight();
      invalidateDifficultyBadge();
      updateDifficultyBadge();
      return data;
    }

    async function loadVocabList() {
      vocabEmpty.hidden = false;
      vocabEmpty.textContent = "正在加载…";
      try {
        ctx.state.vocabEntries = await (await fetch(`${API}/api/vocab`)).json();
        renderVocabList(ctx.state.vocabEntries);
      } catch (e) {
        vocabEmpty.hidden = false;
        vocabEmpty.textContent = `加载生词本失败：${e.message}`;
      }
    }

    function buildSubtitleLine(entry) {
      const sub = document.createElement("div");
      sub.className = "vocab-subtitle";
      sub.textContent = `"${entry.subtitle_text}"`;
      return sub;
    }

    /** Jump-to-video button for a card that has one (YouTube only -- see
     *  youtubeJumpTarget; older entries and anything saved on Jellyfin just
     *  don't have video_url, so this returns null and callers skip it).
     *  Plain `href`, no target="_blank": this panel is injected right into
     *  the YouTube tab itself, so the useful thing is jumping the same tab
     *  to that moment, not opening a second one next to it. */
    function buildJumpBtn(entry) {
      if (!entry.video_url) return null;
      const jump = document.createElement("a");
      jump.className = "vocab-jump-btn";
      jump.href = entry.video_url;
      jump.innerHTML = icon("jump");
      jump.title = "跳转到收藏时的视频位置";
      jump.setAttribute("aria-label", "跳转到收藏时的视频位置");
      jump.addEventListener("click", (e) => {
        // Already sitting on the same video? Seek in place instead of
        // reloading the exact page it's already on -- a navigation would
        // just tear down and re-fetch everything to end up right back here.
        const p = player();
        if (p && p.kind === "youtube" && entry.timestamp_seconds != null &&
            youtubeVideoId(entry.video_url) === youtubeVideoId(location.href)) {
          e.preventDefault();
          p.seekMs(entry.timestamp_seconds * 1000);
        }
      });
      return jump;
    }

    function renderVocabList(entries) {
      vocabList.innerHTML = "";
      if (!entries || entries.length === 0) {
        vocabEmpty.hidden = false;
        vocabEmpty.textContent = "还没有生词。在字幕里把鼠标放到单词上，点\"存生词\"。";
        vocabList.appendChild(vocabEmpty);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const entry of entries) {
        const card = document.createElement("div");
        card.className = "vocab-card";

        // Only meaningful between a first correct grading and either
        // mastery or the review actually coming due -- fmtDueIn already
        // returns null once next_review_at has passed, so a word that's
        // sitting in the quiz pool right now shows neither this nor the
        // mastered badge, same as it always has.
        const dueIn = (entry.streak || 0) > 0 && (entry.streak || 0) < MASTERED_STREAK
          ? fmtDueIn(entry.next_review_at || 0) : null;

        if (entry.created_at || (entry.streak || 0) >= MASTERED_STREAK || dueIn) {
          const meta = document.createElement("div");
          meta.className = "vocab-meta";
          meta.textContent = entry.created_at ? new Date(entry.created_at * 1000).toLocaleString() : "";
          if ((entry.streak || 0) >= MASTERED_STREAK) {
            const badge = document.createElement("button");
            badge.className = "vocab-mastered-badge";
            badge.innerHTML = `${icon("check")} 已掌握`;
            badge.title = "点一下重新放回抽查范围";
            badge.addEventListener("click", async () => {
              badge.disabled = true;
              try {
                await ctx.fns.gradeEntry(entry, "unknown");
                renderVocabList(ctx.state.vocabEntries);
              } catch (e) { badge.disabled = false; }
            });
            meta.appendChild(badge);
          } else if (dueIn) {
            const due = document.createElement("span");
            due.className = "vocab-due-badge";
            due.textContent = `${dueIn}复习`;
            meta.appendChild(due);
          }
          card.appendChild(meta);
        }
        if (entry.subtitle_text) {
          card.appendChild(buildSubtitleLine(entry));
        }

        const qRow = document.createElement("div");
        qRow.className = "vocab-question-row";
        const q = document.createElement("span");
        q.className = entry.answer ? "vocab-question" : "vocab-question vocab-word";
        q.textContent = entry.question;
        qRow.appendChild(q);
        const speak = document.createElement("button");
        speak.className = "vocab-speak-btn";
        speak.innerHTML = icon("speaker");
        speak.title = "朗读";
        speak.setAttribute("aria-label", "朗读");
        speak.addEventListener("click", () => ctx.fns.speakWord(entry.question));
        qRow.appendChild(speak);
        const jumpBtn = buildJumpBtn(entry);
        if (jumpBtn) qRow.appendChild(jumpBtn);
        card.appendChild(qRow);

        // Same exam-syllabus tags the quiz's scope filter reads (see
        // QUIZ_TAG_OPTIONS) -- read-only here, just labeling the word, not
        // another set of toggles. Only words saved after that feature
        // shipped (or backfilled) have any; most cards show nothing here,
        // same as before this existed.
        if (entry.tags && entry.tags.length > 0) {
          const tagsRow = document.createElement("div");
          tagsRow.className = "vocab-tags-row";
          for (const t of entry.tags) {
            const opt = QUIZ_TAG_OPTIONS.find((o) => o.value === t);
            if (!opt) continue;
            const pill = document.createElement("span");
            pill.className = "vocab-tag-pill";
            pill.textContent = opt.label;
            tagsRow.appendChild(pill);
          }
          if (tagsRow.children.length > 0) card.appendChild(tagsRow);
        }

        if (entry.answer) {
          const a = document.createElement("div");
          a.className = "vocab-answer";
          a.innerHTML = ctx.fns.renderMarkdown(entry.answer);
          card.appendChild(a);
        } else {
          const ask = document.createElement("button");
          ask.className = "vocab-ask-btn";
          ask.innerHTML = `${icon("help")} 问一下具体意思`;
          ask.addEventListener("click", () => {
            ctx.fns.switchPage("chat");
            const question = `"${entry.question}" 在这句话里是什么意思？请解释一下，并给出这个词/短语常见的其他用法：\n"${entry.subtitle_text || entry.question}"`;
            addMessage("user", question);
            runTurn(question);
          });
          card.appendChild(ask);
        }

        const del = document.createElement("button");
        del.className = "vocab-delete-btn";
        del.innerHTML = icon("trash");
        del.title = "删除这条";
        del.setAttribute("aria-label", "删除这条");
        del.addEventListener("click", async () => {
          del.disabled = true;
          try {
            await fetch(`${API}/api/vocab/${entry.id}`, { method: "DELETE" });
            card.remove();
            if (!vocabList.querySelector(".vocab-card")) renderVocabList([]);
          } catch (e) { del.disabled = false; }
        });
        card.appendChild(del);
        frag.appendChild(card);
      }
      vocabEmpty.hidden = true;
      vocabList.appendChild(frag);
    }

    ctx.fns.startVocabTest = startVocabTest;
    ctx.fns.exitVocabTest = exitVocabTest;
    ctx.fns.saveVocabEntry = saveVocabEntry;
    ctx.fns.loadVocabList = loadVocabList;
    ctx.fns.renderVocabList = renderVocabList;
    ctx.fns.buildJumpBtn = buildJumpBtn;
    }
    installVocabTest(ctx);
