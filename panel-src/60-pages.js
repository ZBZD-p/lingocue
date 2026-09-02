    // ---- pages ----

    function installPages(ctx) {
      function switchPage(name) {
        ctx.state.currentPage = name;
        tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.page === name));
        Object.entries(pages).forEach(([k, el]) => el.classList.toggle("active", k === name));
        composerEl.hidden = name !== "chat";
        if (name === "subs" && ctx.state.subtitleCues.length === 0) ctx.fns.loadSubtitleCues();
        if (name === "vocab") ctx.fns.loadVocabList();
        if (name === "phrases") ctx.fns.loadPhraseList();
        // Own tab now (not a mode switched into from the vocab list), so
        // entering it always starts fresh at the "开始抽查" prompt rather than
        // trying to resume whatever card a previous visit left off on --
        // same "just reload" philosophy as the vocab list above.
        if (name === "quiz") ctx.fns.loadQuizStart();
      }
      tabBtns.forEach((b) => b.addEventListener("click", () => switchPage(b.dataset.page)));
      ctx.fns.switchPage = switchPage;
    }
    installPages(ctx);
