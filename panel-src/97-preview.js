    // ---- 预习卡片 ----------------------------------------------------------
    //
    // YouTube only, same scoping as the difficulty badge and jump-to-moment:
    // built around YouTube's video-open moment and /api/preview. The endpoint
    // can use either an anonymous caption track or the browser-authenticated
    // local track uploaded for a members-only video.

    function installPreview(ctx) {
    const PREVIEW_SHOWN_KEY = "english-tutor-preview-shown";        // { [videoId]: shownAtMs }
    const PREVIEW_DISMISSED_KEY = "english-tutor-preview-dismissed-at"; // { [videoId]: dismissedAtMs }
    const PREVIEW_SHOWN_TTL_MS = 10 * 60 * 1000;        // 同一视频 10 分钟内不重复
    const PREVIEW_DISMISS_COOLDOWN_MS = 60 * 60 * 1000; // 上次点了"直接看" < 1h 不显示

    function loadPreviewShownMap() {
      try { return JSON.parse(localStorage.getItem(PREVIEW_SHOWN_KEY) || "{}"); }
      catch (e) { return {}; }
    }
    function markPreviewShown(videoId) {
      const m = loadPreviewShownMap();
      m[videoId] = Date.now();
      const trimmed = Object.fromEntries(
        Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 50));
      try { localStorage.setItem(PREVIEW_SHOWN_KEY, JSON.stringify(trimmed)); } catch (e) {}
    }
    function previewRecentlyShown(videoId) {
      const t = loadPreviewShownMap()[videoId];
      return !!t && (Date.now() - t) < PREVIEW_SHOWN_TTL_MS;
    }
    function loadPreviewDismissedMap() {
      try {
        const value = JSON.parse(localStorage.getItem(PREVIEW_DISMISSED_KEY) || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch (e) { return {}; }
    }
    function markPreviewDismissed(videoId) {
      if (!videoId) return;
      const m = loadPreviewDismissedMap();
      m[videoId] = Date.now();
      const trimmed = Object.fromEntries(
        Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 50));
      try { localStorage.setItem(PREVIEW_DISMISSED_KEY, JSON.stringify(trimmed)); } catch (e) {}
    }
    function previewRecentlyDismissed(videoId) {
      const t = loadPreviewDismissedMap()[videoId];
      return (Date.now() - t) < PREVIEW_DISMISS_COOLDOWN_MS;
    }

    /** The gate rules that are about *user/timing state* rather than the
     *  video's own word data -- that half (凑不够 2 个词) lives server-side
     *  in /api/preview's MIN_PREVIEW_CANDIDATES check. No minimum-watched-
     *  time gate here on purpose: the prompt is meant to show the instant
     *  the word list is ready, not some fixed delay after that. */
    function previewGateOpen(videoId) {
      if (previewRecentlyShown(videoId)) return false;
      if (previewRecentlyDismissed(videoId)) return false;
      return true;
    }

    async function updatePreviewPrompt() {
      const p = player();
      const videoId = p && p.kind === "youtube" ? youtubeVideoId(location.href) : null;
      if (!videoId) {
        previewBar.hidden = true;
        ctx.state.previewLastVideoId = null;
        ctx.state.previewAnswered = false;
        return;
      }
      if (videoId !== ctx.state.previewLastVideoId) {
        ctx.state.previewLastVideoId = videoId;
        ctx.state.previewRequestSeq++;
        ctx.state.previewAnswered = false;
        previewBar.hidden = true;
        ctx.state.previewPrefetchPromise = null;
      }
      if (ctx.state.previewSession) return;      // a round is already on screen
      if (!previewBar.hidden) return;  // already showing for this video
      if (ctx.state.previewAnswered) return;     // already decided (shown, or "no") for this video

      // Kicked off the instant the video is known, and shown the instant
      // it resolves -- no artificial delay before either. The fetch itself
      // is two sequential network round trips to YouTube (list tracks,
      // pull one track's text) and measured 3-4s regardless of video
      // length (a 4+ hour video timed the same as a 13-minute one -- this
      // is fixed round-trip latency, not something that scales with
      // transcript size), so that's the only wait there is.
      if (!ctx.state.previewPrefetchPromise) {
        ctx.state.previewPrefetchPromise = fetch(`${API}/api/preview/${encodeURIComponent(videoId)}`)
          .then((res) => res.json())
          .catch(() => null);
      }
      if (!previewGateOpen(videoId)) return;
      if (ctx.state.previewFetchInFlight) return;

      const requestSeq = ctx.state.previewRequestSeq;
      ctx.state.previewFetchInFlight = true;
      try {
        const data = await ctx.state.previewPrefetchPromise;
        if (videoId !== ctx.state.previewLastVideoId || requestSeq !== ctx.state.previewRequestSeq) return;
        if (!data) {
          ctx.state.previewPrefetchPromise = null;  // network hiccup -- next tick retries the fetch itself
          return;
        }
        if (!data.should_show) {
          ctx.state.previewAnswered = true;
          return;
        }
        showPreviewBar(videoId, data);
      } finally {
        ctx.state.previewFetchInFlight = false;
      }
    }

    function showPreviewBar(videoId, data) {
      ctx.state.previewAnswered = true;
      const total = data.cards.length + data.more;
      const repeated = data.cards.filter((c) => c.hits > 1).length;
      previewBarText.innerHTML = `这个视频里有 <b>${total}</b> 个你可能不认识的词` +
        (repeated > 0 ? `，<b>${repeated}</b> 个会反复出现` : "");
      previewBar.hidden = false;
      previewBar.__data = data;
    }

    previewSkipBtn.addEventListener("click", () => {
      previewBar.hidden = true;
      markPreviewDismissed(ctx.state.previewLastVideoId);
    });

    previewStartBtn.addEventListener("click", () => {
      const p = player();
      const data = previewBar.__data;
      if (!p || !data) return;
      previewBar.hidden = true;
      markPreviewShown(ctx.state.previewLastVideoId);
      // The first few seconds are usually a greeting/intro -- seeking to 0
      // is zero loss, and lets a round started a little into playback
      // still start from the top.
      p.pause();
      p.seekMs(0);
      startPreviewSession(ctx.state.previewLastVideoId, data.cards, data.more);
    });

    function startPreviewSession(videoId, cards, more) {
      ctx.state.previewSession = { videoId, cards, index: 0, more };
      previewOverlay.hidden = false;
      renderPreviewCard();
    }

    function renderPreviewCard() {
      const s = ctx.state.previewSession;
      const c = s.cards[s.index];
      const tagsText = c.tags && c.tags.length ? ` · ${c.tags.join("/")}` : "";
      previewOverlay.innerHTML = `
        <div class="preview-card">
          <div class="pc-row1">
            <span class="pc-word">${ctx.fns.escapeHtml(c.lemma)}</span>
            <span class="pc-idx">${s.index + 1} / ${s.cards.length}</span>
          </div>
          <div class="pc-phon">
            <button class="pc-speak" type="button" title="发音" aria-label="发音">${icon("speaker", 12)}</button>
            <span>${ctx.fns.escapeHtml(c.phonetic || "")}</span>
          </div>
          <p class="pc-def">${ctx.fns.escapeHtml(c.definition || "词典里没查到这个词")}</p>
          ${c.sentence ? `<p class="pc-quote">${ctx.fns.escapeHtml(c.sentence)}</p>` : ""}
          <div class="pc-facts">本视频出现 ${c.hits} 次${c.in_wordbook ? " · 已在生词本" : ""}${tagsText}</div>
          <div class="pc-acts">
            <button class="preview-btn" id="pcKnownBtn" type="button">我认识这个</button>
            <button class="preview-btn primary" id="pcNextBtn" type="button">${s.index === s.cards.length - 1 ? "完成" : "下一个 →"}</button>
          </div>
        </div>`;
      previewOverlay.querySelector(".pc-speak").addEventListener("click", () => ctx.fns.speakWord(c.lemma));
      $("pcKnownBtn").addEventListener("click", () => advancePreviewCard("known"));
      $("pcNextBtn").addEventListener("click", () => advancePreviewCard("next"));
    }

    function advancePreviewCard(action) {
      const s = ctx.state.previewSession;
      const c = s.cards[s.index];
      const resultRequest = fetch(`${API}/api/preview/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lemma: c.lemma, action }),
      }).catch(() => {});
      (c.forms && c.forms.length ? c.forms : [c.lemma]).forEach((f) => ctx.state.previewedWordForms.add(f));
      applyPreviewHighlight();
      if (action === "known") {
        // The previous vocab-highlight response may still have this word in
        // its unknown set. Remove that stale underline immediately, then let
        // the server-backed refresh reconcile every mounted cue.
        for (const index of mountedCueIndices) {
          const spans = cueWordSpans[index];
          if (!spans) continue;
          spans.forEach((span) => {
            const norm = span.textContent.replace(/^[^\w']+|[^\w']+$/g, "").toLowerCase();
            if (ctx.state.previewedWordForms.has(norm)) span.classList.remove("sub-word-unknown");
          });
        }
        // Wait for the evidence write before re-reading the server-side
        // knowledge map; otherwise the highlight request can win the race
        // and briefly restore the old unknown underline.
        resultRequest.then(() => {
          ctx.fns.refreshVocabHighlight();
          invalidateDifficultyBadge();
          updateDifficultyBadge();
        });
      }
      s.index++;
      if (s.index < s.cards.length) {
        renderPreviewCard();
      } else {
        renderPreviewEnd();
      }
    }

    function renderPreviewEnd() {
      const s = ctx.state.previewSession;
      if (s.more <= 0) {
        finishPreviewSession();
        return;
      }
      // Matches app.py's PREVIEW_CARDS_PER_ROUND -- the server always
      // returns up to that many regardless of what's asked for, so the
      // button promising a different number would be a lie half the time.
      const nextBatch = Math.min(4, s.more);
      previewOverlay.innerHTML = `
        <div class="preview-end">
          <div class="pe-text">还有 <b>${s.more}</b> 个词没过。这 ${s.cards.length} 个已经在字幕里标出来了。</div>
          <div class="pe-btns">
            <button class="preview-btn" id="peMoreBtn" type="button">再来 ${nextBatch} 张</button>
            <button class="preview-btn primary" id="peDoneBtn" type="button">开始看</button>
          </div>
        </div>`;
      $("peDoneBtn").addEventListener("click", finishPreviewSession);
      $("peMoreBtn").addEventListener("click", loadMorePreviewCards);
    }

    async function loadMorePreviewCards() {
      const s = ctx.state.previewSession;
      const seen = s.cards.map((c) => c.lemma).join(",");
      previewOverlay.innerHTML = `<div class="preview-end"><div class="pe-text">加载中…</div></div>`;
      try {
        const res = await fetch(
          `${API}/api/preview/${encodeURIComponent(s.videoId)}?exclude=${encodeURIComponent(seen)}`);
        const data = await res.json();
        if (ctx.state.previewSession !== s) return;
        if (!data.should_show || !data.cards.length) {
          finishPreviewSession();
          return;
        }
        s.cards = s.cards.concat(data.cards);
        s.more = data.more;
        s.index = s.cards.length - data.cards.length;  // resume at the first new card
        renderPreviewCard();
      } catch (e) {
        if (ctx.state.previewSession === s) finishPreviewSession();
      }
    }

    function finishPreviewSession() {
      previewOverlay.hidden = true;
      previewOverlay.innerHTML = "";
      ctx.state.previewSession = null;
      const p = player();
      if (p) p.play();
    }

    /** Preview-cards收口: previously-previewed words, spotted for real in
     *  the subtitle cards -- see .sub-word-previewed in panel.css. Same
     *  shape as applyVocabHighlight, but not per-cue: a previewed word is
     *  marked wherever it appears, not looked up by cue index. */
    function applyPreviewHighlight() {
      if (ctx.state.previewedWordForms.size === 0) return;
      for (const index of mountedCueIndices) applyPreviewHighlightToCard(index);
    }

    function applyPreviewHighlightToCard(index) {
      const spans = cueWordSpans[index];
      if (!spans) return;
      spans.forEach((span) => {
        const norm = span.textContent.replace(/^[^\w']+|[^\w']+$/g, "").toLowerCase();
        if (ctx.state.previewedWordForms.has(norm)) span.classList.add("sub-word-previewed");
      });
    }

    ctx.fns.updatePreviewPrompt = updatePreviewPrompt;
    ctx.fns.applyPreviewHighlight = applyPreviewHighlight;
    ctx.fns.applyPreviewHighlightToCard = applyPreviewHighlightToCard;
    ctx.fns.finishPreviewSession = finishPreviewSession;
    ctx.fns.previewGateOpen = previewGateOpen;

    refreshContext();
    setInterval(refreshContext, 4000);
    ctx.fns.loadVocabList();
    }
    installPreview(ctx);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
