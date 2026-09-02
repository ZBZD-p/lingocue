    // ---- chat history ----

    function saveHistory() {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify({ sessionId, html: chatEl.innerHTML }));
      } catch (e) { /* quota/unavailable -- not worth surfacing */ }
    }

    (function restoreHistory() {
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        sessionId = data.sessionId || null;
        chatEl.innerHTML = data.html || "";
        chatEl.scrollTop = chatEl.scrollHeight;
        // Raw innerHTML restore doesn't bring event listeners back -- an
        // already-resolved phrase card has no buttons left to rewire (see
        // resolvePhraseSuggestionCard), but one the user never got to
        // click before reloading still needs its accept/decline handlers.
        chatEl.querySelectorAll(".phrase-suggestion-card:not(.phrase-suggestion-resolved)")
          .forEach(wirePhraseSuggestionCard);
      } catch (e) { /* corrupt/old format -- start fresh */ }
    })();

    // Streaming deltas (onThinkingDelta/onTextDelta below) never auto-scroll
    // at all -- constantly chasing the growing text mid-stream is exactly
    // the jitter this used to cause. addMessage/createAiMessage still jump
    // to the bottom once, unconditionally, for the new message they're
    // adding; finalize() below is the one mid-turn spot that still checks
    // nearBottom() first, so the one-time settle when a reply completes
    // doesn't yank someone back down if they'd scrolled up to re-read
    // something earlier in the conversation.
    const BOTTOM_THRESHOLD_PX = 80;
    const nearBottom = () =>
      chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < BOTTOM_THRESHOLD_PX;
    const toBottom = () => { chatEl.scrollTop = chatEl.scrollHeight; };

    // Same guard as the subtitle list's mousedown listener further down
    // (shares lastUserScrollAt/USER_SCROLL_QUIET_MS): a mousedown here means
    // the user is likely dragging to select a reply's text, and the
    // streaming re-render in onTextDelta below would wipe that selection out
    // on the very next token if it didn't back off.
    chatEl.addEventListener("mousedown", () => { lastUserScrollAt = Date.now(); }, { passive: true });

    function addMessage(role, text) {
      const div = document.createElement("div");
      div.className = `msg ${role}`;
      div.textContent = text;
      chatEl.appendChild(div);
      toBottom();
      saveHistory();
      return div;
    }

    /** A "save this phrase?" prompt the AI triggered via its suggest_phrase
     *  tool call -- built once per suggestion, appended into the AI message
     *  bubble it arrived in (see onPhraseSuggestion above). The phrase/
     *  meaning/subtitle live as data-* attributes on the card itself, not
     *  just in closures, because chat history is persisted as raw innerHTML
     *  (see saveHistory/restoreHistory) -- a still-pending card surviving a
     *  reload needs to be able to answer "what do I even save" from its own
     *  markup, since nothing else remembers evt past this call. */
    function buildPhraseSuggestionCard(evt) {
      const card = document.createElement("div");
      card.className = "phrase-suggestion-card";
      card.dataset.phrase = evt.phrase || "";
      card.dataset.meaning = evt.meaning || "";
      card.dataset.subtitle = evt.subtitle_text || "";
      const { video_url, timestamp_seconds } = youtubeJumpTarget();
      card.dataset.videoUrl = video_url || "";
      card.dataset.timestampSeconds = timestamp_seconds == null ? "" : String(timestamp_seconds);
      card.innerHTML = `
        <div class="phrase-suggestion-phrase">${ctx.fns.escapeHtml(evt.phrase || "")}</div>
        ${evt.meaning ? `<div class="phrase-suggestion-meaning">${ctx.fns.escapeHtml(evt.meaning)}</div>` : ""}
        ${evt.subtitle_text ? `<div class="phrase-suggestion-subtitle">"${ctx.fns.escapeHtml(evt.subtitle_text)}"</div>` : ""}
        <div class="phrase-suggestion-actions">
          <button class="phrase-suggestion-decline">不用了</button>
          <button class="phrase-suggestion-accept">${icon("star")} 收藏</button>
        </div>
      `;
      wirePhraseSuggestionCard(card);
      return card;
    }

    /** Attaches the accept/decline handlers to a still-pending card.
     *  Called both right after building one (above) and, for whatever
     *  wasn't resolved before the last reload, once over chat history after
     *  restoreHistory() repopulates chatEl -- raw innerHTML restore doesn't
     *  bring event listeners back on its own. Safe to call on an
     *  already-resolved card (querySelector just finds nothing and no-ops). */
    function wirePhraseSuggestionCard(card) {
      const acceptBtn = card.querySelector(".phrase-suggestion-accept");
      const declineBtn = card.querySelector(".phrase-suggestion-decline");
      if (!acceptBtn || !declineBtn) return;
      acceptBtn.addEventListener("click", async () => {
        acceptBtn.disabled = true;
        declineBtn.disabled = true;
        try {
          await fetch(`${API}/api/phrases`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              video_title: lastKnownVideoTitle,
              subtitle_text: card.dataset.subtitle,
              phrase: card.dataset.phrase,
              meaning: card.dataset.meaning,
              video_url: card.dataset.videoUrl || null,
              timestamp_seconds: card.dataset.timestampSeconds ? Number(card.dataset.timestampSeconds) : null,
            }),
          });
          resolvePhraseSuggestionCard(card, "已收藏");
        } catch (e) {
          acceptBtn.disabled = false;
          declineBtn.disabled = false;
        }
      });
      declineBtn.addEventListener("click", () => resolvePhraseSuggestionCard(card, "已忽略"));
    }

    /** Swaps the action buttons for a static resolved line -- baked into
     *  whatever gets saved to history right after, so a resolved card comes
     *  back from a reload with no buttons at all (nothing left to rewire,
     *  see wirePhraseSuggestionCard's early-return). */
    function resolvePhraseSuggestionCard(card, label) {
      const actions = card.querySelector(".phrase-suggestion-actions");
      if (actions) actions.outerHTML = `<div class="phrase-suggestion-resolved">${icon("check")} ${label}</div>`;
      card.classList.add("phrase-suggestion-resolved");
      saveHistory();
    }

    /**
     * Live "thinking" block for one AI turn: pulsing icon + rotating verb +
     * elapsed time while streaming, collapsing to "Thought for Ns" once the
     * answer starts arriving (thinking text stays available behind a toggle).
     */
    function createAiMessage(effortLabel) {
      const wrap = document.createElement("div");
      wrap.className = "msg ai";
      const status = document.createElement("div");
      status.className = "status-line";
      status.innerHTML = `<span class="pulse-icon">${icon("spinner")}</span><span class="status-text"></span>`;
      wrap.appendChild(status);

      const thinkingBox = document.createElement("details");
      thinkingBox.className = "thinking-box";
      thinkingBox.style.display = "none";
      thinkingBox.innerHTML = `<summary></summary><div class="thinking-content"></div>`;
      wrap.appendChild(thinkingBox);

      const content = document.createElement("div");
      content.className = "answer-content";
      wrap.appendChild(content);
      chatEl.appendChild(wrap);
      toBottom();

      const startTime = performance.now();
      let charCount = 0;
      let verbIndex = Math.floor(Math.random() * THINKING_VERBS.length);
      let latestTokens = null;
      let answerStarted = false;
      let finalized = false;
      let rawAnswer = "";

      function statusText() {
        const elapsed = ctx.fns.fmtElapsed(performance.now() - startTime);
        const n = latestTokens != null ? latestTokens : Math.round(charCount / 4);
        const tokens = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
        return `${THINKING_VERBS[verbIndex]}… (${elapsed} · ↓ ${tokens} tokens` +
          `${effortLabel ? ` · ${effortLabel}` : ""})`;
      }

      const tick = setInterval(() => {
        if (!finalized) status.querySelector(".status-text").textContent = statusText();
      }, 500);
      const verbTick = setInterval(() => {
        if (!finalized) verbIndex = (verbIndex + 1) % THINKING_VERBS.length;
      }, 2800);
      status.querySelector(".status-text").textContent = statusText();

      return {
        onThinkingDelta(text) {
          charCount += text.length;
          thinkingBox.style.display = "block";
          thinkingBox.querySelector(".thinking-content").textContent += text;
          status.querySelector(".status-text").textContent = statusText();
        },
        onTextDelta(text) {
          charCount += text.length;
          rawAnswer += text;
          if (!answerStarted) {
            answerStarted = true;
            const elapsed = ctx.fns.fmtElapsed(performance.now() - startTime);
            status.innerHTML =
              `<span class="pulse-icon done">${icon("check")}</span><span class="status-text">Thought for ${elapsed}</span>`;
            if (thinkingBox.querySelector(".thinking-content").textContent) {
              thinkingBox.querySelector("summary").textContent = "查看思考过程";
            } else {
              thinkingBox.style.display = "none";
            }
          }
          // Skip the rebuild while the user looks like they're mid-drag-select
          // in the chat -- rawAnswer keeps accumulating regardless, so the
          // next delta (or finalize, which always flushes) catches it up.
          if (Date.now() - lastUserScrollAt >= USER_SCROLL_QUIET_MS) {
            content.innerHTML = ctx.fns.renderMarkdown(rawAnswer);
          }
        },
        onPhraseSuggestion(evt) {
          // Appended straight to wrap, not content: content.innerHTML gets
          // fully overwritten on every text delta above, which would wipe
          // the card out the moment the next token arrives if it lived in
          // there instead. No toBottom() either, same reasoning as the
          // deltas -- a tool call happening mid-stream shouldn't yank the
          // view down.
          wrap.appendChild(buildPhraseSuggestionCard(evt));
          saveHistory();
        },
        onUsage(tokens) { if (tokens != null) latestTokens = tokens; },
        finalize(evt) {
          const stick = nearBottom();
          finalized = true;
          clearInterval(tick);
          clearInterval(verbTick);
          if (!answerStarted) {
            status.remove();
            rawAnswer = evt.reply || "(空回复)";
          } else if (evt.reply) {
            rawAnswer = evt.reply;
          }
          // Unconditional: onTextDelta may have skipped its own render while
          // the user was selecting text, so content.innerHTML can't be
          // trusted to already match rawAnswer here.
          content.innerHTML = ctx.fns.renderMarkdown(rawAnswer);
          if (evt.cost_usd != null) {
            const m = document.createElement("span");
            m.className = "meta";
            m.textContent = `本轮花费 $${evt.cost_usd.toFixed(4)}`;
            content.appendChild(m);
          }
          if (stick) toBottom();
          saveHistory();
        },
        error(message, onRetry) {
          finalized = true;
          clearInterval(tick);
          clearInterval(verbTick);
          if (status.parentNode) status.remove();
          // Keep whatever already streamed -- the error is what dropped
          // mid-stream, not a replacement for the text before it.
          const note = document.createElement("div");
          note.className = "error-note";
          note.textContent = answerStarted
            ? `⚠ 连接中断：${message}（上面的回答可能不完整）`
            : `⚠ 出错了：${message}`;
          wrap.appendChild(note);
          if (onRetry) {
            const btn = document.createElement("button");
            btn.className = "retry-btn";
            btn.innerHTML = `${icon("retry")} 重试`;
            btn.addEventListener("click", () => { btn.disabled = true; onRetry(); });
            wrap.appendChild(btn);
          }
          toBottom();
          saveHistory();
        },
      };
    }

    const TRANSIENT_ERROR_RE = /connection lost|network|econnreset|timeout|socket hang up/i;

    async function streamChat(text, ai) {
      try {
        const res = await fetch(`${API}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            session_id: sessionId,
            engine: settingValue("engine") || null,
            // The model dropdown is Claude-specific -- DeepSeek's own model
            // comes from deepseek_config.json instead, via the DeepSeek 模型
            // field -- but effort applies to both engines now.
            model: settingValue("engine") === "deepseek" ? null : (settingValue("model") || null),
            effort: settingValue("effort") || null,
            thinking: settingValue("engine") === "deepseek" ? settingValue("deepseekThinking") : null,
            custom_prompt: settingValue("customPrompt") || null,
          }),
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `请求失败（HTTP ${res.status}）`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let streamError = null;

        const handleLine = (line) => {
          if (!line.trim()) return;
          const evt = JSON.parse(line);
          switch (evt.type) {
            case "thinking_delta": ai.onThinkingDelta(evt.text || ""); break;
            case "text_delta": ai.onTextDelta(evt.text || ""); break;
            case "usage": ai.onUsage(evt.output_tokens); break;
            case "phrase_suggestion": ai.onPhraseSuggestion(evt); break;
            case "done": sessionId = evt.session_id || sessionId; ai.finalize(evt); break;
            case "error": streamError = evt.message || "未知错误"; break;
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          lines.forEach(handleLine);
        }
        if (buffer.trim()) handleLine(buffer);

        return streamError ? { ok: false, message: streamError } : { ok: true };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    }

    function currentEffortLabel() {
      const opt = EFFORT_OPTIONS.find((o) => o.value === settingValue("effort"));
      return opt && opt.value ? opt.label : null;
    }

    /** One chat turn, retrying once on a failure that looks transient. */
    async function runTurn(text, attempt = 1) {
      const ai = createAiMessage(currentEffortLabel());
      sendBtn.disabled = true;
      const result = await streamChat(text, ai);
      sendBtn.disabled = false;
      if (result.ok) return;
      if (TRANSIENT_ERROR_RE.test(result.message) && attempt < 2) {
        ai.error(`${result.message}，2 秒后自动重试…`);
        await new Promise((r) => setTimeout(r, 2000));
        await runTurn(text, attempt + 1);
      } else {
        ai.error(result.message, () => runTurn(text, 1));
      }
    }

    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = "";
      addMessage("user", text);
      runTurn(text);
    }

    sendBtn.addEventListener("click", sendMessage);
    // Propagation out of the panel is already stopped for every field at the
    // host level (see its own comment); this just handles the composer's
    // own Enter-to-send behavior.
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    newChatBtn.addEventListener("click", () => {
      sessionId = null;
      chatEl.innerHTML = "";
      localStorage.removeItem(HISTORY_KEY);
    });

