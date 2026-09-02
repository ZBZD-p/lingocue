    function installLoop(ctx) {
    // ---- Line loop (A-B repeat) ----
    // Hearing a line five times in a row is the drill that actually trains
    // the ear, so this is deliberately dumb: watch the clock and seek back
    // to the start when playback runs past the end, exactly what a scrubber
    // drag does. No Media Source or buffering tricks -- the panel already
    // has the real <video> element, and treating it like a remote control
    // keeps this working across Direct Play, Direct Stream and transcode
    // alike.

    // A cue's start_ms sits right at the first word's own timestamp, so
    // LOOP_LEAD_MS backs off a little before it -- otherwise the loop would
    // clip the word's own attack on every lap.
    const LOOP_LEAD_MS = 150;
    // A cue's end_ms is NOT "when this sentence's speech ends" -- by
    // construction (see youtube.py's _fill_word_gaps and cut_words_into_cues)
    // it's literally the start_ms of the next sentence's first word: a
    // word's end is defined as the next word's start, all the way through to
    // a cue's last word, whose "next word" is the next sentence's first one.
    // So end_ms already reaches into the next sentence, not short of this
    // one -- LOOP_TAIL_MS has to pull back from it, not pad past it, or
    // every lap plays a beat of the next line before jumping back.
    const LOOP_TAIL_MS = 250;
    // Bounds how far past the end playback can get before the seek fires,
    // so at 50ms the next line never becomes audible. The timer only exists
    // while a loop is on, so this costs nothing the rest of the time.
    const LOOP_TICK_MS = 50;
    // A position this far outside the range can't be the loop's own seek --
    // it's the user dragging Jellyfin's scrubber, so get out of their way
    // instead of yanking them back.
    const LOOP_ESCAPE_MS = 5000;

    let loopCount = 0;
    let loopTimer = null;

    const loopActive = () => ctx.state.loopStartIdx >= 0;

    function loopBounds() {
      const a = subtitleCues[ctx.state.loopStartIdx];
      const b = subtitleCues[ctx.state.loopEndIdx];
      if (!a || !b) return null;
      const startMs = Math.max(0, a.start_ms - LOOP_LEAD_MS);
      // A very short cue (a one-word "Yes." with barely a beat before the
      // next line) could see end_ms sit less than LOOP_TAIL_MS past its own
      // start, which would pull endMs back past startMs and stall the loop
      // (seek to startMs, immediately past endMs, seek again forever). Floor
      // it instead of letting that invert -- worst case such a cue plays a
      // sliver into the next line, same as before this fix, rather than
      // never playing at all.
      const endMs = Math.max(b.end_ms - LOOP_TAIL_MS, startMs + LOOP_TAIL_MS);
      return { startMs, endMs };
    }

    function setLoop(startIdx, endIdx) {
      ctx.state.loopStartIdx = Math.min(startIdx, endIdx);
      ctx.state.loopEndIdx = Math.max(startIdx, endIdx);
      loopCount = 0;
      const bounds = loopBounds();
      if (!bounds) { clearLoop(); return; }
      if (!loopTimer) loopTimer = setInterval(loopTick, LOOP_TICK_MS);

      // Jump to the top of the loop immediately when playback is outside it:
      // asking to loop a line that already went past means "play it again",
      // not "wait for the next lap". Already inside, leave the position
      // alone so widening a loop doesn't restart it mid-sentence.
      const p = player();
      if (p) {
        const nowMs = p.currentTimeMs();
        if (nowMs < bounds.startMs || nowMs > bounds.endMs) p.seekMs(bounds.startMs);
      }
      renderLoopState();
    }

    function clearLoop() {
      ctx.state.loopStartIdx = ctx.state.loopEndIdx = -1;
      loopCount = 0;
      clearInterval(loopTimer);
      loopTimer = null;
      renderLoopState();
    }

    function loopTick() {
      const bounds = loopBounds();
      if (!bounds) { clearLoop(); return; }
      const p = player();
      if (!p) return;
      const nowMs = p.currentTimeMs();
      if (isNaN(nowMs)) return;

      if (nowMs > bounds.endMs + LOOP_ESCAPE_MS || nowMs < bounds.startMs - LOOP_ESCAPE_MS) {
        clearLoop();
        return;
      }
      // Paused is left strictly alone: pausing mid-loop to read the line is
      // the normal way to use this, and moving the position then would fight
      // the user for no reason.
      if (p.paused() || nowMs < bounds.endMs) return;

      p.seekMs(bounds.startMs);
      loopCount++;
      renderLoopState();
    }

    /** The loop button on a card, and the only way a range gets built.
     *
     *  First click loops that line alone -- far and away the common case.
     *  With a loop already running, clicking a line outside it stretches the
     *  span to reach that line, which is how a two-person exchange gets
     *  drilled as a unit; clicking one inside narrows back down to just that
     *  line. Clicking the button of a single-line loop turns it off.
     *
     *  Extending only from the nearer end means a stray click on the wrong
     *  side of the range can't silently swallow a dozen lines.
     */
    function toggleLoopAt(idx) {
      if (!subtitleCues[idx]) return;
      if (!loopActive()) { setLoop(idx, idx); return; }
      if (ctx.state.loopStartIdx === idx && ctx.state.loopEndIdx === idx) { clearLoop(); return; }
      if (idx < ctx.state.loopStartIdx) setLoop(idx, ctx.state.loopEndIdx);
      else if (idx > ctx.state.loopEndIdx) setLoop(ctx.state.loopStartIdx, idx);
      else setLoop(idx, idx);
    }

    function renderLoopState() {
      for (const index of mountedCueIndices) {
        const el = subtitleCardEls[index];
        if (el) el.classList.remove("in-loop", "loop-edge");
      }
      const on = loopActive();
      loopPillWrap.hidden = !on;
      if (!on) return;

      for (let i = ctx.state.loopStartIdx; i <= ctx.state.loopEndIdx; i++) {
        const card = subtitleCardEls[i];
        if (!card) continue;
        card.classList.add("in-loop");
        if (i === ctx.state.loopStartIdx || i === ctx.state.loopEndIdx) card.classList.add("loop-edge");
      }

      const a = subtitleCues[ctx.state.loopStartIdx];
      const b = subtitleCues[ctx.state.loopEndIdx];
      const lines = ctx.state.loopEndIdx - ctx.state.loopStartIdx + 1;
      loopPillText.textContent =
        (lines === 1 ? ctx.fns.fmt(a.start_ms) : `${ctx.fns.fmt(a.start_ms)} – ${ctx.fns.fmt(b.end_ms)} · ${lines} 句`) +
        (loopCount ? ` · 第 ${loopCount + 1} 遍` : "");
    }

    loopStopBtn.addEventListener("click", clearLoop);
    // Lines either side of the one being asked about. The agent has MCP
    // tools that could fetch this itself, but a line of dialogue is often
    // meaningless alone -- pronouns, callbacks and sarcasm all depend on
    // what came before -- so handing over the window beats hoping it decides
    // to go looking, and saves a tool round trip.
    const CONTEXT_SPAN = 10;

    function buildContextBlock(centerIndex) {
      if (centerIndex < 0 || subtitleCues.length === 0) return "";
      const start = Math.max(0, centerIndex - CONTEXT_SPAN);
      const end = Math.min(subtitleCues.length, centerIndex + CONTEXT_SPAN + 1);
      const lines = [];
      for (let i = start; i < end; i++) {
        const cue = subtitleCues[i];
        // Marking the target line matters: otherwise the model has to guess
        // which of 21 lines the question is actually about.
        lines.push(`[${ctx.fns.fmt(cue.start_ms)}] ${cue.text}${i === centerIndex ? "   ← 问的是这句" : ""}`);
      }
      return `\n\n---\n以下是这句台词前后的对话，供你理解语境（不用逐句翻译）：\n${lines.join("\n")}`;
    }

    /** Ask about the cue at `index`. The chat bubble shows only the question
     *  -- the surrounding dialogue rides along in the prompt alone, so the
     *  transcript doesn't fill up with 21-line quotations. */
    function askAboutCue(index) {
      const cue = subtitleCues[index];
      if (!cue) return;
      ctx.fns.switchPage("chat");
      const shown = `这句台词是什么意思？请解释一下，顺便讲讲里面值得注意的单词/短语/语法：\n"${cue.text}"`;
      ctx.fns.addMessage("user", shown);
      ctx.fns.runTurn(shown + buildContextBlock(index));
    }

    ctx.fns.loopActive = loopActive;
    ctx.fns.toggleLoopAt = toggleLoopAt;
    ctx.fns.clearLoop = clearLoop;
    ctx.fns.renderLoopState = renderLoopState;
    ctx.fns.buildContextBlock = buildContextBlock;
    ctx.fns.askAboutCue = askAboutCue;
    }
    installLoop(ctx);
