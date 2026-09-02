  function init(host, root) {
    const ctx = {
      state: Object.create(null),
      fns: Object.create(null),
    };
    ctx.state.currentItemId = null;
    ctx.state.currentPage = "chat";
    // What the last detection attempt actually saw. Surfaced in the context
    // bar when there's no playback record, so a failure to find the player
    // reads as a specific reason instead of a blank "还没开始播放".
    ctx.state.lastProbe = "尚未检测";
    // Parallel to subtitleCues -- cueUnknownWords[i] is a Set of the
    // lowercased words in subtitleCues[i].text flagged likely-unknown, or
    // undefined until /api/vocab-highlight has answered for this render.
    ctx.state.cueUnknownWords = [];
    // Parallel to cueUnknownWords -- cueWordScores[i] is a Map keyed by the
    // lowercased surface word, populated only when the developer diagnostic
    // setting asks the backend for p_known details.
    ctx.state.cueWordScores = [];

    const $ = (id) => root.getElementById(id);
    const chatEl = $("chat");
    const inputEl = $("input");
    const sendBtn = $("sendBtn");
    const settingsList = $("settingsList");
    const contextBar = $("contextBar");
    const newChatBtn = $("newChatBtn");
    const composerEl = $("composer");
    const subsScroll = $("subsScroll");
    const subsEmpty = $("subsEmpty");
    const subsNote = $("subsNote");
    const loopPillWrap = $("loopPillWrap");
    const loopPillText = $("loopPillText");
    const loopStopBtn = $("loopStopBtn");
    const vocabList = $("vocabList");
    const vocabEmpty = $("vocabEmpty");
    const vocabQuiz = $("vocabQuiz");
    const phraseList = $("phraseList");
    const phraseEmpty = $("phraseEmpty");
    const wordPopup = $("wordPopup");
    const wordPopupDef = $("wordPopupDef");
    const wordPopupPKnown = $("wordPopupPKnown");
    const difficultyBadge = $("difficultyBadge");
    const previewBar = $("previewBar");
    const previewBarText = $("previewBarText");
    const previewStartBtn = $("previewStartBtn");
    const previewSkipBtn = $("previewSkipBtn");
    const previewOverlay = $("previewOverlay");
    const tabBtns = root.querySelectorAll(".tab-btn");
    const pages = {
      chat: $("chatPage"),
      subs: $("subsPage"),
      vocab: $("vocabPage"),
      phrases: $("phrasesPage"),
      quiz: $("quizPage"),
      settings: $("settingsPage"),
    };

    let sessionId = null;
    let lastKnownVideoTitle = null;
    let lastDifficultyKey = null;
    let previewLastVideoId = null;
    let previewAnswered = false;   // this video already got a should_show decision
    let previewFetchInFlight = false;
    let previewPrefetchPromise = null;  // in-flight/settled /api/preview fetch for previewLastVideoId
    let previewRequestSeq = 0;
    let previewSession = null;     // { videoId, cards, index, more, shown } while a round is on screen

    const toggleBtn = root.querySelector(".toggle");

    // A phone held upright has no room to show the panel and the video at
    // once, and the panel covering the whole screen mid-episode is worse
    // than not having it. So portrait on a touch device force-collapses it
    // and hides the toggle; rotating back to landscape restores whatever
    // the user last chose.
    const portraitLock = window.matchMedia("(orientation: portrait) and (pointer: coarse)");

    function applyOrientationLock() {
      if (portraitLock.matches) {
        host.setAttribute("orientation-locked", "");
        host.setAttribute("hidden-panel", "");
        document.documentElement.classList.remove("english-tutor-open");
      } else {
        host.removeAttribute("orientation-locked");
        // Deliberately reads the stored preference rather than whatever the
        // lock left behind, so a forced collapse never overwrites the user's
        // actual choice.
        const collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
        host.toggleAttribute("hidden-panel", collapsed);
        document.documentElement.classList.toggle("english-tutor-open", !collapsed);
      }
      window.dispatchEvent(new Event("resize"));
    }

    portraitLock.addEventListener("change", applyOrientationLock);

    toggleBtn.addEventListener("click", () => {
      if (portraitLock.matches) return;  // locked closed in portrait
      const collapsed = host.toggleAttribute("hidden-panel");
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
      document.documentElement.classList.toggle("english-tutor-open", !collapsed);
      // Jellyfin's player sizes its canvas to the container on resize, but
      // a class toggle isn't a resize as far as it's concerned.
      window.dispatchEvent(new Event("resize"));
    });

    applyOrientationLock();

    // Jellyfin binds wheel-to-volume at the document level, so scrolling the
    // chat or the subtitle list was changing playback volume. Stopping
    // propagation at the host keeps the event from ever reaching that
    // handler; it does not preventDefault, so scrolling inside the panel
    // still works normally. mousewheel is the legacy alias some of
    // Jellyfin's older handlers still listen on.
    for (const evt of ["wheel", "mousewheel", "DOMMouseScroll"]) {
      host.addEventListener(evt, (e) => e.stopPropagation());
    }

    // Same reasoning, for keyboard: both Jellyfin and YouTube bind global
    // hotkeys at the document level (space = play/pause, arrows = seek, ...)
    // and neither one can tell a keystroke landed in one of this panel's own
    // text fields -- shadow DOM retargets `event.target` on the page's own
    // listener to this custom element itself, not the actual <input>/
    // <textarea> inside, so the host page's usual "ignore it, they're
    // typing" check never sees an editable element and fires anyway.
    // Confirmed for real on YouTube: hitting space anywhere in the panel
    // toggled video playback. Stopping propagation at the host, once, covers
    // every field in the panel instead of needing this wired per-input.
    for (const evt of ["keydown", "keyup", "keypress"]) {
      host.addEventListener(evt, (e) => e.stopPropagation());
    }

    // Drag the left edge to resize.
    //
    // Pointer events rather than mouse events: a touchscreen drag never
    // produces mousemove at all (browsers only synthesise mouse events from
    // a tap, after the fact), so a mouse-only handler is unusable by finger.
    // setPointerCapture keeps the move stream coming to this element even
    // once the finger/cursor wanders off the thin strip onto Jellyfin's
    // content, which also removes the need for window-level listeners.
    const resizer = root.querySelector(".resizer");
    let priorSelect = "";

    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add("dragging");
      priorSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";  // stop Jellyfin selecting text mid-drag
    });

    resizer.addEventListener("pointermove", (e) => {
      if (!resizer.hasPointerCapture(e.pointerId)) return;
      setPanelWidth(window.innerWidth - e.clientX);
    });

    const endResize = (e) => {
      if (!resizer.hasPointerCapture(e.pointerId)) return;
      resizer.releasePointerCapture(e.pointerId);
      resizer.classList.remove("dragging");
      document.body.style.userSelect = priorSelect;
      localStorage.setItem(WIDTH_KEY, String(setPanelWidth(window.innerWidth - e.clientX)));
      window.dispatchEvent(new Event("resize"));  // let Jellyfin re-fit its player
    };
    resizer.addEventListener("pointerup", endResize);
    resizer.addEventListener("pointercancel", endResize);

