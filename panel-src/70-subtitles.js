    // ---- subtitle cards ----

    let subtitleCues = [];
    let subtitleIsPartial = false;
    let subtitleCueSignature = "";
    // Keep direct references to rendered cards and their word spans. The
    // subtitle list can contain thousands of cards; querying the whole DOM
    // on every playback tick made the cost grow with video length.
    let subtitleCardEls = [];
    let cueWordSpans = [];
    let cueTextEls = [];
    let cueActionEls = [];
    let wordObserver = null;
    const mountedCueIndices = new Set();
    let currentCardEl = null;
    let currentWordSpans = [];
    let lastPositionMs = NaN;
    let lastAutoScrollAt = 0;
    let currentCueIndex = -1;
    // Card-level virtualization: keep the cue data in memory, but only mount
    // a bounded window of cards around the viewport/current line. The old
    // implementation still allocated one DOM subtree per cue, which made
    // long transcripts expensive even after word spans were lazy-loaded.
    let virtualTopSpacer = null;
    let virtualBottomSpacer = null;
    let virtualRangeStart = 0;
    let virtualRangeEnd = -1;
    let cueEstimatedHeights = [];
    let cueOffsets = [];
    const VIRTUAL_BUFFER_CUES = 72;
    const VIRTUAL_RECYCLE_MARGIN_CUES = 30;
    const DEFAULT_CUE_HEIGHT = 50;
    let lastUserScrollAt = 0;
    // Separate from lastUserScrollAt above (which only fires on mousedown --
    // see that listener's own comment for why wheel/trackpad scrolling was
    // deliberately left out of it, a different concern about the
    // still-extracting re-render below). This one exists specifically to
    // back off the current-line auto-scroll while the user is reading ahead,
    // so it does need to fire on every kind of scroll, wheel included --
    // confirmed for real that without it, wheel-scrolling down to read ahead
    // got yanked back to the current line on the very next cue change,
    // because nothing was ever resetting the clock for that input method.
    // Once this quiet period expires, scheduleManualCenter() restores the
    // current line even if playback has not advanced to another cue yet.
    let lastManualScrollAt = 0;
    // Set right before this script's own scrollCardIntoView() moves the
    // list, so the "scroll" listener below can tell that apart from the
    // user's own input and not treat it as "user just scrolled" -- without
    // this, every auto-scroll would immediately re-arm its own suppression
    // window and never manage to land.
    let programmaticScroll = false;
    let smoothScrollRaf = 0;
    let smoothScrollToken = 0;
    let smoothScrollVelocity = 0;
    let manualCenterTimer = 0;
    let virtualRecycleRaf = 0;
    let virtualMeasureRaf = 0;
    let virtualResizeRaf = 0;
    let extractPollTimer = null;
    let subtitleGeneration = 0;
    let subtitleRequestSeq = 0;
    let subtitleRequestController = null;
    let subtitleModelVersion = 0;
    let pendingSubtitleCommit = null;
    let pendingSubtitleCommitTimer = null;
    let subtitleResizeObserver = null;
    const USER_SCROLL_QUIET_MS = 4000;
    const EXTRACT_POLL_MS = 1000;
    // Punctuation restoration takes much longer than an extraction tick
    // (40-60s+, it's a whole local model pass), so checking back that often
    // would just be wasted requests -- this is purely a "did it finish yet"
    // poll, not something with real progress to report more granularly.
    const POLISH_POLL_MS = 5000;

    function invalidateSubtitleSession() {
      subtitleGeneration++;
      subtitleRequestSeq++;
      if (subtitleRequestController) subtitleRequestController.abort();
      subtitleRequestController = null;
      pendingSubtitleCommit = null;
      if (pendingSubtitleCommitTimer) { clearTimeout(pendingSubtitleCommitTimer); pendingSubtitleCommitTimer = null; }
      ctx.fns.abortVocabHighlight();
      if (virtualRecycleRaf) { cancelAnimationFrame(virtualRecycleRaf); virtualRecycleRaf = 0; }
      if (virtualMeasureRaf) { cancelAnimationFrame(virtualMeasureRaf); virtualMeasureRaf = 0; }
      if (virtualResizeRaf) { cancelAnimationFrame(virtualResizeRaf); virtualResizeRaf = 0; }
      if (manualCenterTimer) { clearTimeout(manualCenterTimer); manualCenterTimer = 0; }
      cancelSmoothScroll();
    }

    function clearSubtitleModel() {
      if (wordObserver) { wordObserver.disconnect(); wordObserver = null; }
      subtitleCues = [];
      subtitleIsPartial = false;
      subtitleCueSignature = "";
      subtitleModelVersion++;
      ctx.fns.abortVocabHighlight();
      subtitleCardEls = [];
      cueWordSpans = [];
      cueTextEls = [];
      cueActionEls = [];
      mountedCueIndices.clear();
      cueEstimatedHeights = [];
      cueOffsets = [];
      virtualRangeStart = 0;
      virtualRangeEnd = -1;
      virtualTopSpacer = null;
      virtualBottomSpacer = null;
      if (manualCenterTimer) { clearTimeout(manualCenterTimer); manualCenterTimer = 0; }
      currentCardEl = null;
      currentWordSpans = [];
      currentCueIndex = -1;
      lastPositionMs = NaN;
      ctx.state.spokenWordCount = -1;
      ctx.state.cueUnknownWords = [];
      ctx.state.cueWordScores = [];
      if (subsScroll) subsScroll.innerHTML = "";
    }

    function resetSubtitleSession() {
      invalidateSubtitleSession();
      ctx.fns.clearLoop();
      clearSubtitleModel();
    }

    function subtitleRequestIsCurrent(generation, requestId) {
      return generation === subtitleGeneration && requestId === subtitleRequestSeq;
    }

    function schedulePendingSubtitleCommit(generation) {
      if (pendingSubtitleCommitTimer) return;
      pendingSubtitleCommitTimer = setTimeout(() => {
        pendingSubtitleCommitTimer = null;
        if (generation !== subtitleGeneration || !pendingSubtitleCommit) return;
        const quietFor = Date.now() - lastUserScrollAt;
        if (quietFor < USER_SCROLL_QUIET_MS) {
          schedulePendingSubtitleCommit(generation);
          return;
        }
        const pending = pendingSubtitleCommit;
        pendingSubtitleCommit = null;
        commitSubtitleCues(pending.cues, pending.partial);
        subsEmpty.hidden = true;
      }, Math.max(50, USER_SCROLL_QUIET_MS - Math.max(0, Date.now() - lastUserScrollAt)));
    }

    function cueIdentity(cue) {
      if (!cue) return "";
      return `${cue.start_ms}|${cue.end_ms}|${cue.text || ""}`;
    }

    function cuesShareTimingPrefix(oldCues, nextCues) {
      if (!oldCues.length || nextCues.length < oldCues.length) return false;
      for (let i = 0; i < oldCues.length; i++) {
        if (oldCues[i].start_ms !== nextCues[i].start_ms ||
            oldCues[i].end_ms !== nextCues[i].end_ms) return false;
      }
      return true;
    }

    function cuesSignature(cues, isPartial) {
      return `${isPartial ? "partial" : "complete"}|${(cues || []).map((cue) =>
        `${cueIdentity(cue)}|${cue && cue.text2 || ""}|${cue && cue.words ? "words" : ""}`).join("\u001f")}`;
    }

    function findCueByIdentity(cues, identity, fallback = -1) {
      if (!identity) return fallback;
      const exact = cues.findIndex((cue) => cueIdentity(cue) === identity);
      return exact >= 0 ? exact : fallback;
    }

    function captureVirtualAnchor() {
      if (!subtitleCues.length || !subsScroll) return null;
      const index = virtualIndexAtOffset(subsScroll.scrollTop);
      const card = subtitleCardEls[index];
      if (!card || !card.isConnected) return { index, identity: cueIdentity(subtitleCues[index]), top: NaN };
      return { index, identity: cueIdentity(subtitleCues[index]), top: card.getBoundingClientRect().top };
    }

    function restoreVirtualAnchor(anchor) {
      if (!anchor || !subtitleCues.length) return;
      const index = findCueByIdentity(subtitleCues, anchor.identity, anchor.index);
      const card = subtitleCardEls[index];
      if (!card || !card.isConnected || !Number.isFinite(anchor.top)) return;
      const top = card.getBoundingClientRect().top;
      if (!Number.isFinite(top) || Math.abs(top - anchor.top) < 0.5) return;
      programmaticScroll = true;
      subsScroll.scrollTop += top - anchor.top;
      requestAnimationFrame(() => { programmaticScroll = false; });
    }

    function commitSubtitleCues(nextCues, isPartial, anchor = null) {
      const normalizedCues = Array.isArray(nextCues) ? nextCues : [];
      const nextSignature = cuesSignature(normalizedCues, isPartial);
      if (nextSignature === subtitleCueSignature) return false;
      const oldCues = subtitleCues;
      const oldCurrentKey = cueIdentity(oldCues[currentCueIndex]);
      const oldLoop = ctx.fns.loopActive()
        ? { start: cueIdentity(oldCues[ctx.state.loopStartIdx]), end: cueIdentity(oldCues[ctx.state.loopEndIdx]) }
        : null;
      const savedAnchor = anchor || captureVirtualAnchor();

      subtitleCues = normalizedCues;
      subtitleIsPartial = !!isPartial;
      subtitleCueSignature = nextSignature;
      subtitleModelVersion++;
      ctx.state.cueUnknownWords = [];
      ctx.state.cueWordScores = [];
      currentCueIndex = findCueByIdentity(subtitleCues, oldCurrentKey, -1);
      lastPositionMs = NaN;

      if (oldLoop) {
        const start = findCueByIdentity(subtitleCues, oldLoop.start, -1);
        const end = findCueByIdentity(subtitleCues, oldLoop.end, -1);
        if (start >= 0 && end >= 0) {
          ctx.state.loopStartIdx = Math.min(start, end);
          ctx.state.loopEndIdx = Math.max(start, end);
        } else {
          ctx.fns.clearLoop();
        }
      }

      renderSubtitleCards(savedAnchor);
      ctx.fns.refreshVocabHighlight();
      applyPreviewHighlight();
      return true;
    }

    function cancelSmoothScroll(resetVelocity = true) {
      smoothScrollToken++;
      if (smoothScrollRaf) cancelAnimationFrame(smoothScrollRaf);
      smoothScrollRaf = 0;
      programmaticScroll = false;
      if (resetVelocity) smoothScrollVelocity = 0;
    }

    function scheduleVirtualRecycle() {
      // Recycle on the next paint instead of waiting for a quiet period. A
      // debounce never fired while a touchpad kept emitting scroll events,
      // leaving the user at the end of the mounted range with empty space.
      if (virtualRecycleRaf) return;
      virtualRecycleRaf = requestAnimationFrame(() => {
        virtualRecycleRaf = 0;
        if (programmaticScroll) return;
        if (subtitleCues.length) renderVirtualWindow();
      });
    }

    function smoothCenterCard(card, immediate = false) {
      if (!card || !card.isConnected) return;
      const rootRect = subsScroll.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const delta = ((cardRect.top + cardRect.bottom) - (rootRect.top + rootRect.bottom)) / 2;
      if (!Number.isFinite(delta) || Math.abs(delta) < 3) return;
      const maxScroll = Math.max(0, subsScroll.scrollHeight - subsScroll.clientHeight);
      const start = subsScroll.scrollTop;
      const target = Math.max(0, Math.min(maxScroll, start + delta));
      if (Math.abs(target - start) < 3) return;
      if (immediate) {
        cancelSmoothScroll();
        programmaticScroll = true;
        subsScroll.scrollTop = target;
        // The target may have been outside the mounted window, and adding
        // .current also reveals its timestamp/actions. Both can change its
        // real height after this first write. Re-center for a couple of
        // layout frames while the internal-scroll guard is active, so one
        // seek still lands exactly once from the user's perspective.
        const token = smoothScrollToken;
        let settleFrames = 0;
        const settle = () => {
          if (token !== smoothScrollToken) return;
          if (!card.isConnected) {
            programmaticScroll = false;
            smoothScrollRaf = 0;
            smoothScrollVelocity = 0;
            return;
          }
          const nextRootRect = subsScroll.getBoundingClientRect();
          const nextCardRect = card.getBoundingClientRect();
          const correction = ((nextCardRect.top + nextCardRect.bottom) -
            (nextRootRect.top + nextRootRect.bottom)) / 2;
          if (Number.isFinite(correction) && Math.abs(correction) > 0.5) {
            const nextMax = Math.max(0, subsScroll.scrollHeight - subsScroll.clientHeight);
            subsScroll.scrollTop = Math.max(0, Math.min(nextMax, subsScroll.scrollTop + correction));
          }
          if (settleFrames++ < 2) {
            requestAnimationFrame(settle);
          } else {
            programmaticScroll = false;
            scheduleVirtualMeasure();
          }
        };
        requestAnimationFrame(settle);
        return;
      }
      // Keep the current velocity when a new cue retargets the center. That
      // continuity is what gives native lyrics views their gentle "drag"
      // instead of restarting every transition from a dead stop.
      cancelSmoothScroll(false);
      const token = smoothScrollToken;
      let position = start;
      let velocity = smoothScrollVelocity;
      let previousTime = performance.now();
      programmaticScroll = true;
      const step = (now) => {
        if (token !== smoothScrollToken) return;
        const dt = Math.min(0.034, Math.max(0.001, (now - previousTime) / 1000));
        previousTime = now;
        // Critically damped spring: smooth acceleration/deceleration with no
        // intentional overshoot, while preserving velocity across retargets.
        const acceleration = (target - position) * 180 - velocity * 26;
        velocity += acceleration * dt;
        position += velocity * dt;
        if ((target - start) * (target - position) < 0) {
          position = target;
          velocity = 0;
        }
        subsScroll.scrollTop = position;
        smoothScrollVelocity = velocity;
        if (Math.abs(target - position) > 0.35 || Math.abs(velocity) > 2) {
          smoothScrollRaf = requestAnimationFrame(step);
        } else {
          subsScroll.scrollTop = target;
          smoothScrollVelocity = 0;
          smoothScrollRaf = 0;
          // Let the final scroll event observe the programmatic flag before
          // user-scroll suppression is re-enabled.
          requestAnimationFrame(() => {
            if (token === smoothScrollToken) {
              programmaticScroll = false;
              scheduleVirtualMeasure();
            }
          });
        }
      };
      smoothScrollRaf = requestAnimationFrame(step);
    }

    function centerCurrentCueAfterScroll() {
      manualCenterTimer = 0;
      if (!subtitleCues.length || currentCueIndex < 0) return;
      const quietFor = Date.now() - Math.max(lastUserScrollAt, lastManualScrollAt);
      if (quietFor < USER_SCROLL_QUIET_MS) {
        scheduleManualCenter();
        return;
      }
      // The current line may have been recycled while the user read ahead.
      // Mount it again before measuring, then use the normal interruptible
      // centering animation so another wheel event can take control.
      ensureVirtualCueWindow(currentCueIndex);
      const card = subtitleCardEls[currentCueIndex];
      if (!card || !card.isConnected) return;
      const rootRect = subsScroll.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const rootCenter = (rootRect.top + rootRect.bottom) / 2;
      const cardCenter = (cardRect.top + cardRect.bottom) / 2;
      if (!Number.isFinite(cardCenter) || Math.abs(cardCenter - rootCenter) <= 1) return;
      if (Date.now() - lastAutoScrollAt < 180) return;
      smoothCenterCard(card);
      lastAutoScrollAt = Date.now();
    }

    function scheduleManualCenter() {
      if (manualCenterTimer) clearTimeout(manualCenterTimer);
      const quietFor = Date.now() - Math.max(lastUserScrollAt, lastManualScrollAt);
      manualCenterTimer = setTimeout(
        centerCurrentCueAfterScroll,
        Math.max(50, USER_SCROLL_QUIET_MS - Math.max(0, quietFor))
      );
    }

    function stopExtractPolling() {
      if (extractPollTimer) { clearTimeout(extractPollTimer); extractPollTimer = null; }
    }

    function fmtProgress(fraction) {
      return fraction > 0 ? `${Math.min(99, Math.round(fraction * 100))}%` : "…";
    }

    async function loadSubtitleCues(startedAt = null) {
      stopExtractPolling();
      const generation = subtitleGeneration;
      const requestId = ++subtitleRequestSeq;
      if (subtitleRequestController) subtitleRequestController.abort();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      subtitleRequestController = controller;
      if (startedAt === null) {
        subsEmpty.hidden = false;
        subsEmpty.textContent = "正在加载字幕…";
      }
      try {
        // Cards from whatever was loaded before are not this video's. Left in
        // place they sit there looking authoritative while the new video is
        // still being resolved -- and every path out of here that isn't
        // success renders into subsEmpty, not the card list.
        if (startedAt === null) {
          if (wordObserver) { wordObserver.disconnect(); wordObserver = null; }
          subsScroll.innerHTML = "";
        }
        const lang2 = settingValue("secondaryLang") || "";
        const response = await fetch(
          `${API}/api/subtitles?lang=en&tab_id=${TAB_ID}${lang2 ? `&secondary=${lang2}` : ""}` +
          `${wordHighlightOn() ? "&words=1" : ""}`,
          controller ? { signal: controller.signal } : undefined
        );
        const data = await response.json();
        if (!subtitleRequestIsCurrent(generation, requestId)) return;
        // "ready" | "extracting" | an error string; absent when no second
        // language was asked for.
        const sec = data.secondary_status;
        const secondaryPending = sec === "extracting";
        const secondaryFailed = sec && sec !== "ready" && !secondaryPending;

        if (data.status === "extracting") {
          const t0 = startedAt || Date.now();
          const secs = Math.round((Date.now() - t0) / 1000);
          subsEmpty.hidden = false;
          subsEmpty.innerHTML = "";
          const l1 = document.createElement("div");
          // YouTube reports a stage instead of a fraction -- there is no
          // honest percentage to give for a network round trip.
          l1.textContent = data.message
            ? `${data.message}…（已用 ${secs}s）`
            : `正在提取字幕 ${fmtProgress(data.progress || 0)}…（已用 ${secs}s）`;
          const l2 = document.createElement("div");
          l2.className = "subs-hint";
          l2.textContent = data.message
            ? "视频可以先看，字幕抓好会自动出现。这期间对话页可以照常用。"
            : "第一次打开这个视频要扫一遍文件（大文件约半分钟）。" +
              "字幕会从头逐段显示，不用等全部扫完。这期间对话页可以照常用。";
          subsEmpty.append(l1, l2);
          extractPollTimer = setTimeout(() => loadSubtitleCues(t0), EXTRACT_POLL_MS);
          return;
        }

        if (!data.available || !data.cues || data.cues.length === 0) {
          showSubtitleError(`没有可用字幕：${data.error || "未知原因"}`);
          clearSubtitleModel();
          return;
        }

        const nextCues = Array.isArray(data.cues) ? data.cues : [];
        const nextPartial = data.complete === false;
        const wasPartial = subtitleIsPartial;
        const userBusy = Date.now() - lastUserScrollAt < USER_SCROLL_QUIET_MS;
        // Partial extraction responses append the lines below the current
        // window. Commit those immediately even during scrolling; deferring
        // them makes the transcript appear stuck at the old end. A response
        // that preserves all existing cue timings is equally safe to apply,
        // since the virtual renderer keeps the viewport anchor stable.
        const canApplyDuringScroll = nextPartial ||
          cuesShareTimingPrefix(subtitleCues, nextCues);
        if (userBusy && subtitleCues.length && !canApplyDuringScroll) {
          pendingSubtitleCommit = { cues: nextCues, partial: nextPartial };
          schedulePendingSubtitleCommit(generation);
        } else {
          pendingSubtitleCommit = null;
          if (pendingSubtitleCommitTimer) { clearTimeout(pendingSubtitleCommitTimer); pendingSubtitleCommitTimer = null; }
          commitSubtitleCues(nextCues, nextPartial);
          subsEmpty.hidden = true;
        }

        if (nextPartial || secondaryPending) {
          const t0 = startedAt || Date.now();
          const secs = Math.round((Date.now() - t0) / 1000);
          subsNote.hidden = false;
          // The English side can be complete while the translation is still
          // being pulled, and that reads as a stall unless it's named.
          subsNote.textContent = subtitleIsPartial
            ? `⏳ 字幕提取中 ${fmtProgress(data.progress || 0)}（${secs}s）— ` +
              `已显示的部分可以正常用，后面的会自动补上`
            : `⏳ 中文字幕提取中（${secs}s）— 英文已经可以用了，中文会逐段补上`;
          extractPollTimer = setTimeout(() => loadSubtitleCues(t0), EXTRACT_POLL_MS);
        } else if (data.polishing) {
          // Cues shown are already usable (this is the "complete" reply) --
          // just possibly still the raw, unpunctuated fallback. Quietly
          // checks back without the "还在抓字幕" framing above, since
          // nothing here is actually missing yet, only maybe about to get
          // nicer.
          subsNote.hidden = false;
          subsNote.textContent = "🔧 字幕断句还在后台优化，好了会自动换成更好读的版本";
          extractPollTimer = setTimeout(
            () => loadSubtitleCues(startedAt || Date.now()), POLISH_POLL_MS
          );
        } else if (userBusy) {
          // Nothing left to wait on server-side, but the render above was
          // skipped because the user was mid-interaction -- what just got
          // fetched into subtitleCues never made it onto the page, and
          // nothing else re-checks this once polishing itself is done, so
          // without this branch a render that lost this race would just be
          // gone for good. A short catch-up poll here is what actually
          // flushes it once they let go, instead of leaving the page stuck
          // showing the old cues indefinitely.
          extractPollTimer = setTimeout(() => loadSubtitleCues(startedAt || Date.now()), 1000);
        } else if (secondaryFailed) {
          // English is fine, so this stays a note rather than an error page.
          subsNote.hidden = false;
          subsNote.textContent = `中文字幕不可用：${sec}`;
        } else {
          subsNote.hidden = true;
          // The DOM was just rebuilt with the complete list, so snap back to
          // whatever's playing rather than leaving the user mid-list.
          if (wasPartial) lastUserScrollAt = 0;
        }
      } catch (e) {
        if (!subtitleRequestIsCurrent(generation, requestId) || e.name === "AbortError") return;
        showSubtitleError(`加载字幕失败：${e.message}`);
      } finally {
        if (subtitleRequestIsCurrent(generation, requestId)) subtitleRequestController = null;
      }
    }

    function showSubtitleError(message) {
      subsNote.hidden = true;
      subsEmpty.hidden = false;
      subsEmpty.innerHTML = "";
      const text = document.createElement("div");
      text.textContent = message;
      const btn = document.createElement("button");
      btn.innerHTML = `${icon("retry")} 重试`;
      btn.addEventListener("click", () => { btn.disabled = true; loadSubtitleCues(); });
      subsEmpty.append(text, btn);
      ctx.fns.clearLoop();
    }

    // Virtualized subtitle renderer: the cue data remains in memory, while
    // only the bounded window around the viewport is mounted in the DOM.
    // Layout values are shared by the whole pass. Reading computed style and
    // clientWidth once per cue forces the browser to revisit layout thousands
    // of times on a long transcript, even though those values cannot change
    // during one estimate pass.
    function subtitleLayoutMetrics() {
      const width = Math.max(160, (subsScroll ? subsScroll.clientWidth : 440) - 44);
      const rootStyle = getComputedStyle(document.documentElement);
      const configured = parseFloat(rootStyle.getPropertyValue("--english-tutor-sub-size"));
      const fontSize = configured || (window.matchMedia("(max-width: 700px)").matches ? 18 : 16);
      return {
        fontSize,
        charsPerLine: Math.max(12, Math.floor(width / (fontSize * 0.56))),
        secondaryCharsPerLine: Math.max(10, Math.floor(width / (fontSize * 0.72))),
      };
    }

    function estimateCueHeight(cue, isLast = false, metrics = subtitleLayoutMetrics()) {
      const text = String(cue && cue.text || "");
      const text2 = String(cue && cue.text2 || "");
      const { fontSize, charsPerLine, secondaryCharsPerLine } = metrics;
      const primaryLines = Math.max(1, Math.ceil(text.length / charsPerLine));
      let height = primaryLines * fontSize * 1.5;
      if (text2) {
        const secondaryLines = Math.max(1, Math.ceil(text2.length / secondaryCharsPerLine));
        height += 6 + secondaryLines * fontSize * 0.75 * 1.6;
      }
      height += isLast ? 0 : 26;
      const minimum = isLast ? fontSize * 1.5 : DEFAULT_CUE_HEIGHT;
      return Math.max(minimum, Math.ceil(height));
    }

    function rebuildEstimatedCueGeometry() {
      const count = subtitleCues.length;
      const metrics = subtitleLayoutMetrics();
      cueEstimatedHeights = new Array(count);
      cueOffsets = new Array(count + 1);
      cueOffsets[0] = 0;
      for (let i = 0; i < count; i++) {
        const height = estimateCueHeight(subtitleCues[i], i === count - 1, metrics);
        cueEstimatedHeights[i] = height;
        cueOffsets[i + 1] = cueOffsets[i] + height;
      }
    }

    function rebuildCueOffsets() {
      cueOffsets[0] = 0;
      for (let i = 0; i < subtitleCues.length; i++) {
        cueOffsets[i + 1] = cueOffsets[i] + cueEstimatedHeights[i];
      }
    }

    function updateVirtualSpacers() {
      if (!virtualTopSpacer || !virtualBottomSpacer || !subtitleCues.length) return;
      const start = Math.max(0, virtualRangeStart);
      const end = Math.min(subtitleCues.length - 1, virtualRangeEnd);
      virtualTopSpacer.style.height = `${cueOffsets[start] || 0}px`;
      virtualBottomSpacer.style.height = `${Math.max(
        0, cueOffsets[subtitleCues.length] - (cueOffsets[end + 1] || cueOffsets[subtitleCues.length])
      )}px`;
    }

    // Only measure cards close to the real viewport, where the browser has
    // laid out their actual text; distant cards use the estimate above.
    function measureMountedCueHeight(card) {
      if (!card || !card.isConnected) return NaN;
      const rect = card.getBoundingClientRect();
      const margin = parseFloat(getComputedStyle(card).marginBottom) || 0;
      const height = rect.height + margin;
      return Number.isFinite(height) && height > 0 ? height : NaN;
    }

    function scheduleVirtualMeasure() {
      if (virtualMeasureRaf) return;
      virtualMeasureRaf = requestAnimationFrame(() => {
        virtualMeasureRaf = 0;
        if (programmaticScroll) return;
        if (subtitleCues.length && virtualRangeEnd >= virtualRangeStart) {
          measureVirtualWindow();
        }
      });
    }

    function invalidateVirtualMeasurements() {
      if (!subtitleCues.length || virtualResizeRaf) return;
      virtualResizeRaf = requestAnimationFrame(() => {
        virtualResizeRaf = 0;
        if (programmaticScroll) {
          invalidateVirtualMeasurements();
          return;
        }
        const anchor = captureVirtualAnchor();
        rebuildEstimatedCueGeometry();
        updateVirtualSpacers();
        restoreVirtualAnchor(anchor);
        scheduleVirtualMeasure();
      });
    }

    function measureVirtualWindow() {
      const rootRect = subsScroll.getBoundingClientRect();
      const activationMargin = 900;
      let anchorCard = null;
      let anchorTop = NaN;
      let changed = false;

      for (let i = virtualRangeStart; i <= virtualRangeEnd; i++) {
        const card = subtitleCardEls[i];
        if (!card || !card.isConnected) continue;
        const rect = card.getBoundingClientRect();
        if (!anchorCard && rect.bottom > rootRect.top) {
          anchorCard = card;
          anchorTop = rect.top;
        }
        if (rect.bottom < rootRect.top - activationMargin ||
            rect.top > rootRect.bottom + activationMargin) continue;
        const measured = measureMountedCueHeight(card);
        if (!Number.isFinite(measured) || Math.abs(measured - cueEstimatedHeights[i]) < 1) continue;
        cueEstimatedHeights[i] = measured;
        changed = true;
      }
      if (!changed) return;

      rebuildCueOffsets();
      updateVirtualSpacers();
      // Height corrections before the visible anchor must not move the line
      // the user is reading. Mark this write as internal so the scroll
      // listener does not immediately recycle the window a second time.
      if (anchorCard && Number.isFinite(anchorTop)) {
        const newTop = anchorCard.getBoundingClientRect().top;
        const correction = newTop - anchorTop;
        if (Number.isFinite(correction) && Math.abs(correction) > 0.5) {
          programmaticScroll = true;
          subsScroll.scrollTop += correction;
          requestAnimationFrame(() => { programmaticScroll = false; });
        }
      }
    }

    function virtualIndexAtOffset(offset) {
      const paddingTop = parseFloat(getComputedStyle(subsScroll).paddingTop) || 0;
      const target = Math.max(0, offset + paddingTop);
      let lo = 0, hi = Math.max(0, cueOffsets.length - 2);
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cueOffsets[mid] <= target) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    function createVirtualCueCard(i) {
      const cue = subtitleCues[i];
      const card = document.createElement("div");
      card.className = "sub-card";
      if (i === subtitleCues.length - 1) card.classList.add("sub-card-last");
      card.dataset.index = String(i);
      const time = document.createElement("span");
      time.className = "sub-time";
      const timeText = document.createElement("span");
      timeText.className = "sub-time-text";
      timeText.textContent = ctx.fns.fmt(cue.start_ms);
      time.appendChild(timeText);
      card.appendChild(time);
      const text = document.createElement("div");
      text.className = "sub-text";
      if (cue.words) text.classList.add("has-word-times");
      text.textContent = cue.text;
      cueTextEls[i] = text;
      card.appendChild(text);
      if (cue.text2) {
        const text2 = document.createElement("div");
        text2.className = "sub-text-2";
        text2.textContent = cue.text2;
        card.appendChild(text2);
      }
      const actions = document.createElement("div");
      actions.className = "sub-actions";
      cueActionEls[i] = actions;
      card.appendChild(actions);
      subtitleCardEls[i] = card;
      mountedCueIndices.add(i);
      return card;
    }

    function renderVirtualWindow(anchorIndex = -1, keepExistingRange = false) {
      if (!subtitleCues.length || !virtualTopSpacer || !virtualBottomSpacer) return;
      const firstVisible = virtualIndexAtOffset(subsScroll.scrollTop);
      const anchor = anchorIndex >= 0 ? anchorIndex : firstVisible;
      const center = anchorIndex >= 0 ? anchorIndex : firstVisible;
      // While the user is scrolling, keep the current window stable until
      // they approach its edge. Re-centering on every wheel tick makes all
      // cards get removed/reinserted continuously, which looks like shaking
      // and also defeats the point of virtualization. Explicit playback
      // jumps still re-center immediately via anchorIndex.
      if (anchorIndex < 0 && virtualRangeEnd >= virtualRangeStart &&
          firstVisible >= virtualRangeStart + VIRTUAL_RECYCLE_MARGIN_CUES &&
          firstVisible <= virtualRangeEnd - VIRTUAL_RECYCLE_MARGIN_CUES) return;
      const oldRangeStart = virtualRangeStart;
      const oldRangeEnd = virtualRangeEnd;
      let start = Math.max(0, center - VIRTUAL_BUFFER_CUES);
      let end = Math.min(subtitleCues.length - 1, center + VIRTUAL_BUFFER_CUES);
      if (keepExistingRange && oldRangeEnd >= oldRangeStart) {
        // Preloading during playback should expand the window without
        // throwing away already-mounted context on the opposite side.
        start = Math.min(start, oldRangeStart);
        end = Math.max(end, oldRangeEnd);
      }
      if (start === virtualRangeStart && end === virtualRangeEnd &&
          subtitleCardEls[anchor] && subtitleCardEls[anchor].isConnected) return;
      // When recycling because of user scrolling, preserve the current
      // viewport anchor. Changing the top spacer while replacing cards can
      // otherwise make the browser keep the old scrollTop but display a
      // different cue, producing the occasional large jump/overshoot.
      let preserveIndex = -1;
      let preserveTop = NaN;
      if (anchorIndex < 0 && virtualRangeEnd >= virtualRangeStart) {
        preserveIndex = firstVisible;
        const oldAnchor = subtitleCardEls[preserveIndex];
        if (oldAnchor && oldAnchor.isConnected) preserveTop = oldAnchor.getBoundingClientRect().top;
      }
      if (wordObserver) wordObserver.disconnect();
      wordObserver = null;
      // Recycle only the part that left the window. Keeping the overlap avoids
      // destroying word spans, focus and selection on every boundary crossing.
      const oldStart = virtualRangeStart;
      const oldEnd = virtualRangeEnd;
      for (let i = oldStart; i <= oldEnd; i++) {
        if (i >= start && i <= end) continue;
        const card = subtitleCardEls[i];
        if (card) {
          card.remove();
          subtitleCardEls[i] = null;
          cueTextEls[i] = null;
          cueActionEls[i] = null;
          cueWordSpans[i] = null;
          mountedCueIndices.delete(i);
          if (currentCardEl === card) {
            currentCardEl = null;
            currentWordSpans = [];
            ctx.state.spokenWordCount = -1;
          }
        }
      }
      virtualRangeStart = start;
      virtualRangeEnd = end;
      updateVirtualSpacers();
      // Insert each contiguous run of entering cards in one fragment. The
      // old per-card insertion also scanned forward for an anchor on every
      // iteration, making a fresh 145-card window do unnecessary quadratic
      // work and causing a visible pause before the first paint.
      let runStart = -1;
      for (let i = start; i <= end + 1; i++) {
        const missing = i <= end && !(subtitleCardEls[i] && subtitleCardEls[i].isConnected);
        if (missing && runStart < 0) {
          runStart = i;
          continue;
        }
        if (runStart < 0) continue;
        const runEnd = i - 1;
        let next = virtualBottomSpacer;
        for (let j = runEnd + 1; j <= end; j++) {
          if (subtitleCardEls[j] && subtitleCardEls[j].isConnected) {
            next = subtitleCardEls[j];
            break;
          }
        }
        const fragment = document.createDocumentFragment();
        for (let j = runStart; j <= runEnd; j++) {
          fragment.appendChild(subtitleCardEls[j] || createVirtualCueCard(j));
        }
        subsScroll.insertBefore(fragment, next);
        runStart = -1;
      }
      if (preserveIndex >= start && preserveIndex <= end && Number.isFinite(preserveTop)) {
        const newAnchor = subtitleCardEls[preserveIndex];
        if (newAnchor) {
          const newTop = newAnchor.getBoundingClientRect().top;
          if (Number.isFinite(newTop)) subsScroll.scrollTop += newTop - preserveTop;
        }
      }
      if (typeof IntersectionObserver === "function") {
        wordObserver = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            const index = Number(entry.target.dataset.index);
            if (!Number.isInteger(index) || subtitleCardEls[index] !== entry.target) return;
            // `isIntersecting` includes the 800px preload margin. Keep a
            // separate real-viewport test for auto-follow, otherwise a line
            // that is merely near the viewport suppresses centering.
            const root = entry.rootBounds;
            const rect = entry.boundingClientRect;
            if (entry.isIntersecting || index === currentCueIndex) decorateCardWords(index);
            else if (index !== currentCueIndex && cueWordSpans[index] !== null) {
              cueTextEls[index].textContent = subtitleCues[index].text;
              cueWordSpans[index] = null;
            }
          });
        }, { root: subsScroll, rootMargin: "800px 0px" });
        for (let i = start; i <= end; i++) if (subtitleCardEls[i]) wordObserver.observe(subtitleCardEls[i]);
      } else {
        for (let i = start; i <= end; i++) decorateCardWords(i);
      }
      if (currentCueIndex >= start && currentCueIndex <= end && subtitleCardEls[currentCueIndex]) {
        const current = subtitleCardEls[currentCueIndex];
        current.classList.add("current");
        decorateCardWords(currentCueIndex);
        ensureCardActions(currentCueIndex);
        currentCardEl = current;
        currentWordSpans = subtitleCues[currentCueIndex].words
          ? (cueWordSpans[currentCueIndex] || []) : [];
        ctx.state.spokenWordCount = -1;
      }
      ctx.fns.renderLoopState();
      scheduleVirtualMeasure();
    }

    function ensureVirtualCueWindow(index) {
      if (!subtitleCues.length || index < 0) return;
      const outside = index < virtualRangeStart || index > virtualRangeEnd;
      const canExpandTop = virtualRangeStart > 0 &&
        index < virtualRangeStart + VIRTUAL_RECYCLE_MARGIN_CUES;
      const canExpandBottom = virtualRangeEnd < subtitleCues.length - 1 &&
        index > virtualRangeEnd - VIRTUAL_RECYCLE_MARGIN_CUES;
      if (!outside && !canExpandTop && !canExpandBottom &&
          subtitleCardEls[index] && subtitleCardEls[index].isConnected) return;
      const anchor = captureVirtualAnchor();
      renderVirtualWindow(index, !outside);
      restoreVirtualAnchor(anchor);
    }

    function renderSubtitleCards(anchor = null) {
      const savedAnchor = anchor || captureVirtualAnchor();
      cancelSmoothScroll();
      if (virtualRecycleRaf) { cancelAnimationFrame(virtualRecycleRaf); virtualRecycleRaf = 0; }
      if (virtualMeasureRaf) { cancelAnimationFrame(virtualMeasureRaf); virtualMeasureRaf = 0; }
      subtitleCardEls = new Array(subtitleCues.length);
      cueWordSpans = new Array(subtitleCues.length).fill(null);
      cueTextEls = new Array(subtitleCues.length);
      cueActionEls = new Array(subtitleCues.length);
      mountedCueIndices.clear();
      rebuildEstimatedCueGeometry();
      if (wordObserver) wordObserver.disconnect();
      wordObserver = null;
      currentCardEl = null;
      currentWordSpans = [];
      ctx.state.spokenWordCount = -1;
      virtualRangeStart = 0;
      virtualRangeEnd = -1;
      subsScroll.innerHTML = "";
      virtualTopSpacer = document.createElement("div");
      virtualBottomSpacer = document.createElement("div");
      virtualTopSpacer.className = "subs-virtual-spacer";
      virtualBottomSpacer.className = "subs-virtual-spacer";
      subsScroll.append(virtualTopSpacer, virtualBottomSpacer);
      renderVirtualWindow(currentCueIndex);
      restoreVirtualAnchor(savedAnchor);
      ctx.fns.renderLoopState();
    }

    if (typeof ResizeObserver === "function") {
      subtitleResizeObserver = new ResizeObserver(() => invalidateVirtualMeasurements());
      subtitleResizeObserver.observe(subsScroll);
    }

    // A mousedown here usually means the user is about to drag-select
    // subtitle text, and the current-line auto-scroll (highlightCue below)
    // yanking the list mid-drag as playback advances would drag the text out
    // from under the selection. (There used to be a matching "wheel"
    // listener here too, but that one wasn't for this -- it was working
    // around Jellyfin binding wheel-to-volume at the document level, which
    // is already handled separately by the stopPropagation block further up
    // (search "Jellyfin binds wheel-to-volume"). Wiring plain scrolling into
    // this same busy-guard just meant any scroll over the list reset the
    // clock, so on a still-updating video the cards could keep missing their
    // window to ever re-render. The wheel listener below cancels an in-flight
    // lyric animation and starts the four-second recenter countdown.)
    subsScroll.addEventListener("mousedown", () => {
      cancelSmoothScroll();
      lastUserScrollAt = Date.now();
    }, { passive: true });
    subsScroll.addEventListener("wheel", () => {
      cancelSmoothScroll();
      lastUserScrollAt = Date.now();
      lastManualScrollAt = Date.now();
      scheduleManualCenter();
    }, { passive: true });
    subsScroll.addEventListener("pointerdown", () => {
      cancelSmoothScroll();
      lastUserScrollAt = Date.now();
      lastManualScrollAt = Date.now();
    }, { passive: true });
    subsScroll.addEventListener("touchstart", () => {
      cancelSmoothScroll();
      lastUserScrollAt = Date.now();
      lastManualScrollAt = Date.now();
    }, { passive: true });
    subsScroll.addEventListener("scroll", () => {
      wordPopup.classList.remove("open");
      if (!programmaticScroll) {
        cancelSmoothScroll();
        const now = Date.now();
        lastUserScrollAt = now;
        lastManualScrollAt = now;
        scheduleManualCenter();
      }
      // Recycle the card window as the user scrolls through a long transcript.
      // The range check makes ordinary playback scroll events effectively
      // free when the current card is already mounted.
      // During an automatic lyric animation, its scrollTop is the source of
      // truth. Rebuilding the virtual window from every intermediate scroll
      // event would apply a second anchor correction and make the animation
      // oscillate past the target. The explicit playback jump already mounts
      // the needed range before the animation starts.
      if (!programmaticScroll && subtitleCues.length) scheduleVirtualRecycle();
    }, { passive: true });

    // One delegated listener replaces thousands of per-card/per-word
    // listeners. The cue data remains in subtitleCues, so spans only need a
    // compact cue index and normalized word on themselves.
    subsScroll.addEventListener("click", (event) => {
      const target = event.target && event.target.closest
        ? event.target : event.target && event.target.parentElement;
      if (!target || !subsScroll.contains(target)) return;
      const wordSpan = target.closest(".sub-word");
      if (wordSpan) {
        const index = Number(wordSpan.dataset.cueIndex);
        const cue = subtitleCues[index];
        if (cue) ctx.fns.showWordPopup(wordSpan, wordSpan.dataset.word, cue.text, index);
        event.stopPropagation();
        return;
      }
      const action = target.closest("[data-sub-action]");
      const card = target.closest(".sub-card");
      if (!card || !subsScroll.contains(card)) return;
      const index = Number(card.dataset.index);
      if (!Number.isInteger(index) || !subtitleCues[index]) return;
      if (action) {
        event.stopPropagation();
        if (action.dataset.subAction === "loop") ctx.fns.toggleLoopAt(index);
        else if (action.dataset.subAction === "ask") ctx.fns.askAboutCue(index);
        else if (action.dataset.subAction === "read") ctx.fns.speakWord(subtitleCues[index].text);
        return;
      }
      if (ctx.fns.loopActive()) { ctx.fns.toggleLoopAt(index); return; }
      const p = player();
      if (p) p.seekMs(subtitleCues[index].start_ms);
      lastUserScrollAt = 0;
      lastPositionMs = NaN;
      ctx.fns.highlightCue(index, true);
    });
    subsScroll.addEventListener("mouseout", (event) => {
      const target = event.target && event.target.closest
        ? event.target : event.target && event.target.parentElement;
      if (target && target.closest && target.closest(".sub-word")) {
        const related = event.relatedTarget;
        if (!related || !related.closest || !related.closest(".sub-word")) {
          ctx.fns.scheduleHideWordPopup();
        }
      }
    }, { passive: true });

    // Split a line into hoverable per-word spans so the popup can target the
    // exact word under the cursor, not the whole sentence.
    function appendWordSpans(container, sentence, cueIndex, times) {
      // Counts every non-whitespace token, span or not. `times` came from
      // splitting the cue's text on whitespace server-side, so a token that
      // ends up as a bare text node below (pure punctuation, e.g. "--")
      // still occupies a slot in it -- skipping those here would shift the
      // rest of the line's timings by one and silently highlight the wrong
      // words from that point on.
      let wordIndex = 0;
      const spans = [];
      for (const token of sentence.split(/(\s+)/)) {
        if (!token) continue;
        if (/^\s+$/.test(token)) {
          container.appendChild(document.createTextNode(token));
          continue;
        }
        const time = times && times[wordIndex];
        wordIndex++;
        const word = token.replace(/^[^\w']+|[^\w']+$/g, "");
        if (!word) { container.appendChild(document.createTextNode(token)); continue; }
        const span = document.createElement("span");
        span.className = "sub-word";
        span.textContent = token;
        span.dataset.word = word;
        span.dataset.cueIndex = String(cueIndex);
        if (time) span.dataset.start = time[0];
        container.appendChild(span);
        spans.push(span);
      }
      return spans;
    }

    function decorateCardWords(index) {
      if (cueWordSpans[index] !== null) return;
      const cue = subtitleCues[index];
      const text = cueTextEls[index];
      if (!cue || !text) return;
      text.textContent = "";
      cueWordSpans[index] = appendWordSpans(text, cue.text, index, cue.words);
      ctx.fns.applyVocabHighlightToCard(index);
      applyPreviewHighlightToCard(index);
    }

    function ensureCardActions(index) {
      const actions = cueActionEls[index];
      if (!actions || actions.childElementCount) return;
      const cue = subtitleCues[index];
      if (!cue) return;
      const makeButton = (className, action, html, title) => {
        const button = document.createElement("button");
        button.className = className;
        button.dataset.subAction = action;
        button.innerHTML = html;
        button.title = title;
        button.setAttribute("aria-label", title);
        actions.appendChild(button);
      };
      makeButton("sub-loop-btn", "loop", `${icon("repeat")}循环`, "循环这句");
      makeButton("sub-ask-btn", "ask", `${icon("help")}问这句`, "问一下这句什么意思");
      makeButton("sub-read-btn", "read", `${icon("speaker")}朗读`, "朗读这句");
    }
