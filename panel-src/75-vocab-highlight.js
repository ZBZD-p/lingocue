    // ---- vocab-highlight ("生词高亮") -------------------------------------
    //
    // Applied as a second pass over already-rendered .sub-word spans, not
    // baked into appendWordSpans itself: the subtitle cards need to appear
    // immediately when a video opens, and this is one extra network round
    // trip per video (batched -- the whole video's cues in one request, not
    // one per line) that shouldn't hold that up. The highlight fades in a
    // beat after the text itself, same tradeoff subtitleIsPartial's
    // progressive rendering already makes elsewhere on this page.

    function installVocabHighlight(ctx) {
      let vocabHighlightSeq = 0;
      let vocabHighlightController = null;

      function abortVocabHighlight() {
        vocabHighlightSeq++;
        if (vocabHighlightController) vocabHighlightController.abort();
        vocabHighlightController = null;
      }

      async function refreshVocabHighlight() {
        const includeScores = showPKnownOn();
        if ((!vocabHighlightOn() && !includeScores) || subtitleCues.length === 0) return;
        const generation = subtitleGeneration;
        const modelVersion = subtitleModelVersion;
        const requestId = ++vocabHighlightSeq;
        if (vocabHighlightController) vocabHighlightController.abort();
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        vocabHighlightController = controller;
        const cues = subtitleCues.map((c) => c.text);
        try {
          const res = await fetch(`${API}/api/vocab-highlight`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(includeScores ? { cues, include_scores: true } : { cues }),
            ...(controller ? { signal: controller.signal } : {}),
          });
          const data = await res.json();
          if (generation !== subtitleGeneration || modelVersion !== subtitleModelVersion ||
              requestId !== vocabHighlightSeq ||
              (!vocabHighlightOn() && !showPKnownOn()) ||
              includeScores !== showPKnownOn()) return;
          ctx.state.cueUnknownWords = vocabHighlightOn() && Array.isArray(data.result)
            ? data.result.map((words) => new Set(words)) : [];
          ctx.state.cueWordScores = includeScores && Array.isArray(data.scores)
            ? data.scores.map((entries) => {
              const byWord = new Map();
              if (!Array.isArray(entries)) return byWord;
              entries.forEach((entry) => {
                if (!entry || typeof entry.word !== "string") return;
                const p = Number(entry.p_known);
                if (!Number.isFinite(p)) return;
                byWord.set(entry.word.toLowerCase(), { p_known: p, source: entry.source });
              });
              return byWord;
            }) : [];
        } catch (e) {
          return;  // best-effort -- cards just stay unhighlighted
        } finally {
          if (requestId === vocabHighlightSeq) vocabHighlightController = null;
        }
        if (generation !== subtitleGeneration || modelVersion !== subtitleModelVersion) return;
        applyVocabHighlight();
        ctx.fns.updateWordPopupPKnown();
      }

      function applyVocabHighlight() {
        for (const index of mountedCueIndices) applyVocabHighlightToCard(index);
      }

      function applyVocabHighlightToCard(index) {
        const unknown = ctx.state.cueUnknownWords[index];
        const spans = cueWordSpans[index];
        if (!spans) return;
        spans.forEach((span) => {
          const norm = span.textContent.replace(/^[^\w']+|[^\w']+$/g, "").toLowerCase();
          span.classList.toggle("sub-word-unknown", !!(unknown && unknown.has(norm)));
        });
      }

      let hideWordPopupTimer = null;
      const cancelHide = () => { clearTimeout(hideWordPopupTimer); hideWordPopupTimer = null; };
      function scheduleHideWordPopup() {
        cancelHide();
        hideWordPopupTimer = setTimeout(() => wordPopup.classList.remove("open"), 250);
      }
      wordPopup.addEventListener("mouseenter", cancelHide);
      wordPopup.addEventListener("mouseleave", scheduleHideWordPopup);

      ctx.fns.refreshVocabHighlight = refreshVocabHighlight;
      ctx.fns.abortVocabHighlight = abortVocabHighlight;
      ctx.fns.applyVocabHighlight = applyVocabHighlight;
      ctx.fns.applyVocabHighlightToCard = applyVocabHighlightToCard;
      ctx.fns.cancelHide = cancelHide;
      ctx.fns.scheduleHideWordPopup = scheduleHideWordPopup;
    }
    installVocabHighlight(ctx);
