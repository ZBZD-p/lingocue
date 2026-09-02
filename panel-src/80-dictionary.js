    // ---- dictionary lookups ----
    // Cached per word for the life of the page: hovering back and forth
    // across a line re-requests the same handful of words constantly, and a
    // repeat lookup should never show the loading state a second time.
    const defCache = new Map();
    let defRequestId = 0;
    let popupAnchor = null;
    let popupWord = "";
    let popupCueIndex = -1;

    function updateWordPopupPKnown() {
      if (!showPKnownOn()) {
        wordPopupPKnown.hidden = true;
        wordPopupPKnown.textContent = "";
        return;
      }
      const norm = popupWord.replace(/^[^\w']+|[^\w']+$/g, "").toLowerCase();
      const byWord = cueWordScores[popupCueIndex];
      const detail = byWord && byWord.get(norm);
      if (!detail || !Number.isFinite(detail.p_known)) {
        wordPopupPKnown.hidden = true;
        wordPopupPKnown.textContent = "";
        return;
      }
      const sourceLabel = detail.source === "word_knowledge" ? "真实证据" : "先验估算";
      wordPopupPKnown.textContent = `p_known: ${detail.p_known.toFixed(3)}（${sourceLabel}）`;
      wordPopupPKnown.hidden = false;
      positionPopup();
    }

    async function fillDefinition(word) {
      // Each hover claims a ticket; a slower earlier request that lands
      // after the user has already moved on must not overwrite the popup.
      const myRequest = ++defRequestId;

      if (defCache.has(word)) {
        renderDefinition(defCache.get(word));
        return;
      }
      wordPopupDef.textContent = "查询中…";
      wordPopupDef.className = "word-popup-def loading";
      try {
        const data = await (await fetch(`${API}/api/define?word=${encodeURIComponent(word)}`)).json();
        defCache.set(word, data);
        if (myRequest === defRequestId) renderDefinition(data);
      } catch (e) {
        if (myRequest === defRequestId) {
          wordPopupDef.textContent = "查词失败";
          wordPopupDef.className = "word-popup-def empty";
          positionPopup();
        }
      }
    }

    // Pronunciation: prefer the online dictionary's recorded/high-quality
    // audio (much clearer than the OS voice pack), falling back to the
    // browser's built-in TTS if that request fails (offline, blocked, etc).
    let currentSpeechAudio = null;
    function speakWord(text) {
      if (currentSpeechAudio) { currentSpeechAudio.pause(); currentSpeechAudio = null; }
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();

      const fallbackToTTS = () => {
        if (!("speechSynthesis" in window)) return;
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = "en-US";
        window.speechSynthesis.speak(utter);
      };

      const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`);
      currentSpeechAudio = audio;
      audio.addEventListener("error", fallbackToTTS, { once: true });
      audio.play().catch(fallbackToTTS);
    }

    function renderDefinition(data) {
      wordPopupDef.innerHTML = "";
      if (!data || !data.found) {
        wordPopupDef.className = "word-popup-def empty";
        wordPopupDef.textContent = data && data.error
          ? data.error
          : "词典里没有这个词，点「问一下」让 AI 结合语境解释";
        positionPopup();
        return;
      }
      wordPopupDef.className = "word-popup-def";

      const head = document.createElement("div");
      head.className = "word-popup-head";
      const w = document.createElement("span");
      w.className = "word-popup-word";
      // Show the lemma when the hovered form differs, so "went" makes it
      // obvious the entry shown is "go".
      w.textContent = data.inflected ? `${data.queried} → ${data.word}` : data.word;
      head.appendChild(w);
      if (data.phonetic) {
        const p = document.createElement("span");
        p.className = "word-popup-phonetic";
        p.textContent = `/${data.phonetic}/`;
        head.appendChild(p);
      }
      wordPopupDef.appendChild(head);

      const body = document.createElement("div");
      body.className = "word-popup-trans";
      body.textContent = data.translation;
      wordPopupDef.appendChild(body);
      positionPopup();
    }

    // Re-run whenever the popup's contents change: the definition arrives
    // after the popup is already on screen, and a taller box positioned for
    // the old height would overhang the viewport or cover the word.
    function positionPopup() {
      if (!popupAnchor) return;
      const rect = popupAnchor.getBoundingClientRect();
      const margin = 8;
      let left = rect.left + rect.width / 2 - wordPopup.offsetWidth / 2;
      left = Math.min(Math.max(left, margin), window.innerWidth - wordPopup.offsetWidth - margin);
      let top = rect.top - wordPopup.offsetHeight - margin;
      if (top < margin) top = rect.bottom + margin;  // not enough room above
      wordPopup.style.left = `${left}px`;
      wordPopup.style.top = `${top}px`;
    }

    function showWordPopup(anchorEl, word, sentence, cueIndex) {
      cancelHide();
      popupAnchor = anchorEl;
      popupWord = word;
      popupCueIndex = cueIndex;
      wordPopup.classList.add("open");
      updateWordPopupPKnown();
      fillDefinition(word);
      positionPopup();

      wordPopup.querySelector(".word-popup-speak").onclick = () => speakWord(word);

      const saveBtn = wordPopup.querySelector(".word-popup-save");
      saveBtn.disabled = false;
      saveBtn.innerHTML = `${icon("star")} 存生词`;
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = "存中…";
        try {
          // Reuses whatever fillDefinition already fetched for the popup
          // itself -- the point is saving the Chinese gloss along with the
          // word, not looking it up a second time. A card with no answer
          // renders as "问一下具体意思" instead (see renderVocabList), so
          // an empty/not-yet-loaded lookup just falls back to that, same as
          // before this existed.
          const def = defCache.get(word);
          const answer = def && def.found ? def.translation : "";
          const tags = def && def.found ? def.tags : [];
          const { video_url, timestamp_seconds } = youtubeJumpTarget();
          await saveVocabEntry({
            video_title: lastKnownVideoTitle,
            subtitle_text: sentence,
            question: word,
            answer,
            tags,
            video_url,
            timestamp_seconds,
          });
          saveBtn.innerHTML = `${icon("check")} 已存`;
        } catch (e) {
          saveBtn.textContent = "失败，重试？";
          saveBtn.disabled = false;
        }
      };

      wordPopup.querySelector(".word-popup-ask").onclick = () => {
        wordPopup.classList.remove("open");
        switchPage("chat");
        const shown = `"${word}" 在这句话里是什么意思？请解释一下，并给出这个词/短语常见的其他用法：\n"${sentence}"`;
        addMessage("user", shown);
        // Same treatment as asking about a whole line: a word's sense often
        // only resolves from the scene around it.
        runTurn(shown + buildContextBlock(cueIndex == null ? -1 : cueIndex));
      };
    }

    function updateCurrentCue(positionMs, immediate = false) {
      if (subtitleCues.length === 0) return;
      let idx = currentCueIndex;
      // During normal playback timestamps only move forward, so advance the
      // existing index instead of rescanning the entire cue array. A seek or
      // rewind falls back to an upper-bound binary search.
      if (!Number.isFinite(lastPositionMs) || positionMs < lastPositionMs) {
        let lo = 0;
        let hi = subtitleCues.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (subtitleCues[mid].start_ms <= positionMs) lo = mid + 1;
          else hi = mid;
        }
        idx = lo - 1;
      } else {
        if (idx < -1 || idx >= subtitleCues.length) idx = -1;
        while (idx + 1 < subtitleCues.length &&
               subtitleCues[idx + 1].start_ms <= positionMs) idx++;
      }
      lastPositionMs = positionMs;
      // The loop's own seek deliberately lands LOOP_LEAD_MS before the
      // loop-start cue's start_ms, as a pre-roll so the line's first word
      // doesn't get clipped -- but that position genuinely falls inside the
      // *previous* cue's span, so without this the previous line's card
      // flashes "current" for that ~150ms on every single lap. While a loop
      // is running, the line being drilled is never actually the one before
      // it, so floor the display at the loop's own start.
      if (loopActive() && idx < loopStartIdx) idx = loopStartIdx;
      if (idx !== currentCueIndex) {
        const quietFor = Date.now() - Math.max(lastUserScrollAt, lastManualScrollAt);
        // A committed progress-bar seek is an explicit navigation command;
        // it must override the temporary "user is reading" follow-off window.
        highlightCue(idx, immediate || quietFor >= USER_SCROLL_QUIET_MS, immediate);
      }
      // Outside the cue-changed check on purpose: the whole point is to keep
      // moving *within* one line, which is exactly the case that check skips.
      updateSpokenWords(positionMs);
    }

    // How many words of the current line are lit. Kept so the common tick --
    // same word still being spoken -- costs one comparison instead of a
    // classList write per word, which at this poll rate is most ticks.
    let spokenWordCount = -1;

    function updateSpokenWords(positionMs) {
      // No match when the setting is off (nothing was requested, so no cue
      // carries the marker) or when this video has no per-word data at all,
      // which is what makes both cases a no-op without checking either.
      const spans = currentWordSpans;
      if (spans.length === 0) return;
      let lit = 0;
      while (lit < spans.length && Number(spans[lit].dataset.start) <= positionMs) lit++;
      if (lit === spokenWordCount) return;
      if (lit > spokenWordCount) {
        for (let i = Math.max(0, spokenWordCount); i < lit; i++) {
          spans[i].classList.add("spoken");
        }
      } else {
        for (let i = lit; i < spokenWordCount; i++) {
          if (spans[i]) spans[i].classList.remove("spoken");
        }
      }
      spokenWordCount = lit;
    }

    function highlightCue(idx, autoScroll, immediate = false) {
      const prev = currentCardEl;
      if (prev) prev.classList.remove("current");
      if (currentCueIndex >= 0 && cueActionEls[currentCueIndex]) {
        cueActionEls[currentCueIndex].replaceChildren();
      }
      if (currentWordSpans.length) {
        currentWordSpans.forEach((span) => span.classList.remove("spoken"));
      }
      currentCueIndex = idx;
      // The new line starts unlit, and its count has to be invalidated
      // rather than carried over -- otherwise the first tick on a line that
      // happens to light the same number of words as the last one would be
      // mistaken for "nothing changed" and never paint.
      spokenWordCount = -1;
      if (idx < 0) {
        currentCardEl = null;
        currentWordSpans = [];
        return;
      }
      // Playback can jump several minutes ahead of the mounted window. Bring
      // that cue into the small virtualized range before touching its DOM.
      ensureVirtualCueWindow(idx);
      const card = subtitleCardEls[idx];
      if (!card) {
        currentCardEl = null;
        currentWordSpans = [];
        return;
      }
      currentCardEl = card;
      currentWordSpans = subtitleCues[idx] && subtitleCues[idx].words
        ? (cueWordSpans[idx] || []) : [];
      decorateCardWords(idx);
      currentWordSpans = subtitleCues[idx] && subtitleCues[idx].words
        ? (cueWordSpans[idx] || []) : [];
      ensureCardActions(idx);
      card.classList.add("current");
      // Seek jumps use an immediate scroll rather than the normal spring:
      // an offscreen target may be mounted with an estimated height and then
      // corrected by the virtual-list measurement pass. smoothCenterCard()
      // performs a short, guarded post-layout recenter for that transition;
      // a long spring would keep chasing the moving geometry.
      // Every cue change gets its own exact center target, like a lyrics view.
      // There is no viewport tolerance here: even a short line-to-line height
      // difference should be corrected so the new active line lands on the
      // same visual baseline every time.
      let needsCenter = false;
      if (autoScroll && card.isConnected) {
        const rootRect = subsScroll.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const rootCenter = (rootRect.top + rootRect.bottom) / 2;
        const cardCenter = (cardRect.top + cardRect.bottom) / 2;
        needsCenter = !Number.isFinite(cardCenter) || Math.abs(cardCenter - rootCenter) > 1;
      }
      if (autoScroll && needsCenter &&
          (immediate || Date.now() - lastAutoScrollAt >= 180)) {
        // Animate scrollTop ourselves instead of using native smooth
        // scrollIntoView. The virtualized list can recycle cards while a
        // native animation is running; an explicit target plus cancellation
        // on user input keeps the lyric-style motion stable.
        smoothCenterCard(card, immediate);
        lastAutoScrollAt = Date.now();
      }
      scheduleVirtualMeasure();
    }

