    // ---- phrase collection ----
    // Cards reuse the vocab list's own CSS classes (.vocab-card etc.) --
    // same shape (phrase in the question slot, meaning in the answer slot),
    // no reason to duplicate the styling. Simpler than the vocab list in one
    // way: meaning is required by suggest_phrase's schema, so there's no
    // empty-answer / "问一下" branch to handle here at all.

    function installPhrases(ctx) {
      async function loadPhraseList() {
        phraseEmpty.hidden = false;
        phraseEmpty.textContent = "正在加载…";
        try {
          renderPhraseList(await (await fetch(`${API}/api/phrases`)).json());
        } catch (e) {
          phraseEmpty.hidden = false;
          phraseEmpty.textContent = `加载短语收藏失败：${e.message}`;
        }
      }

      function renderPhraseList(entries) {
        phraseList.innerHTML = "";
        if (!entries || entries.length === 0) {
          phraseEmpty.hidden = false;
          phraseEmpty.textContent =
            "还没有收藏的短语。跟 AI 聊字幕的时候，它觉得有值得记的短语会主动推荐，你在对话里点\"收藏\"就行。";
          phraseList.appendChild(phraseEmpty);
          return;
        }
        const frag = document.createDocumentFragment();
        for (const entry of entries) {
          const card = document.createElement("div");
          card.className = "vocab-card";

          if (entry.created_at) {
            const meta = document.createElement("div");
            meta.className = "vocab-meta";
            meta.textContent = new Date(entry.created_at * 1000).toLocaleString();
            card.appendChild(meta);
          }
          if (entry.subtitle_text) {
            card.appendChild(buildSubtitleLine(entry));
          }

          const qRow = document.createElement("div");
          qRow.className = "vocab-question-row";
          const q = document.createElement("span");
          q.className = "vocab-question";
          q.textContent = entry.phrase;
          qRow.appendChild(q);
          const jumpBtn = buildJumpBtn(entry);
          if (jumpBtn) qRow.appendChild(jumpBtn);
          card.appendChild(qRow);

          const a = document.createElement("div");
          a.className = "vocab-answer";
          a.innerHTML = ctx.fns.renderMarkdown(entry.meaning);
          card.appendChild(a);

          const del = document.createElement("button");
          del.className = "vocab-delete-btn";
          del.innerHTML = icon("trash");
          del.title = "删除这条";
          del.setAttribute("aria-label", "删除这条");
          del.addEventListener("click", async () => {
            del.disabled = true;
            try {
              await fetch(`${API}/api/phrases/${entry.id}`, { method: "DELETE" });
              card.remove();
              if (!phraseList.querySelector(".vocab-card")) renderPhraseList([]);
            } catch (e) { del.disabled = false; }
          });
          card.appendChild(del);
          frag.appendChild(card);
        }
        phraseEmpty.hidden = true;
        phraseList.appendChild(frag);
      }

      ctx.fns.loadPhraseList = loadPhraseList;
      ctx.fns.renderPhraseList = renderPhraseList;
    }
    installPhrases(ctx);

