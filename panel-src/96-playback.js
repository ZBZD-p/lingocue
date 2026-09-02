    // ---- playback source ----
    // Two very different things can be driving playback: the <video> element
    // inside Jellyfin's page, and YouTube's embedded player on /youtube,
    // which has no element to reach at all -- only an API of methods. Cue
    // highlighting, the loop and position reporting all go through this one
    // shape, so none of them has to know which is behind it.
    //
    // Times are in ms throughout, matching the cue timestamps everything
    // else here is already expressed in, rather than the seconds both
    // underlying players happen to use.

    function html5Player() {
      const v = ctx.fns.findVideo();
      if (!v) {
        ctx.state.lastProbe = "面板没在页面上找到 <video> 元素";
        return null;
      }
      if (!v.duration || isNaN(v.duration)) {
        ctx.state.lastProbe = `找到 <video> 但还没有时长（src=${(v.currentSrc || v.src || "空").slice(0, 60)}）`;
        return null;
      }
      return {
        kind: "html5",
        source: null,
        currentTimeMs: () => v.currentTime * 1000,
        durationMs: () => v.duration * 1000,
        paused: () => v.paused,
        seekMs: (ms) => { v.currentTime = ms / 1000; },
        pause: () => v.pause(),
        play: () => v.play().catch(() => {}),
      };
    }

    function youtubePlayer() {
      const yt = window.__englishTutorYouTube;
      if (!yt || !yt.ready()) {
        ctx.state.lastProbe = "YouTube 播放器还没就绪";
        return null;
      }
      return {
        kind: "youtube",
        // Unlike Jellyfin, this page knows exactly what it loaded, so it
        // tells the backend rather than having it ask elsewhere.
        source: yt.source(),
        currentTimeMs: () => yt.currentTime() * 1000,
        durationMs: () => yt.duration() * 1000,
        paused: () => yt.paused(),
        seekMs: (ms) => yt.seek(ms / 1000),
        pause: () => yt.pause(),
        play: () => yt.play(),
      };
    }

    /** The thing currently playing, or null with `lastProbe` explaining why
     *  not. Never cached: Jellyfin destroys and recreates its element on
     *  every episode change. */
    function player() {
      return window.__englishTutorYouTube ? youtubePlayer() : html5Player();
    }

    /** {video_url, timestamp_seconds} for wherever playback is right now,
     *  YouTube only -- both null on Jellyfin/local video, which has no
     *  external address to hand back to. `location.href` is the actual
     *  youtube.com video URL here (this script runs injected into that
     *  page itself when it's the YouTube extension), so this just folds
     *  the current position into a `t=` param the same way YouTube's own
     *  share-at-timestamp links do. Read at save time, not click time, so
     *  a phrase card resolved a while after the AI suggested it still
     *  points at the moment it was actually about, not wherever playback
     *  has drifted to since. */
    function youtubeJumpTarget() {
      const p = player();
      if (!p || p.kind !== "youtube") return { video_url: null, timestamp_seconds: null };
      const seconds = Math.max(0, Math.floor(p.currentTimeMs() / 1000));
      let url;
      try {
        url = new URL(location.href);
        url.searchParams.set("t", `${seconds}s`);
      } catch (e) {
        return { video_url: null, timestamp_seconds: seconds };
      }
      return { video_url: url.toString(), timestamp_seconds: seconds };
    }

    /** The video id out of a YouTube watch or Shorts URL, or null if it isn't one --
     *  used to tell whether a saved jump target is the video already open
     *  (see buildJumpBtn), so a click there can just seek instead of
     *  reloading the exact page it's already sitting on. */
    function youtubeVideoId(url) {
      try {
        const parsed = new URL(url, "https://www.youtube.com/");
        if (parsed.pathname === "/watch") {
          return parsed.searchParams.get("v") || null;
        }
        const match = parsed.pathname.match(/^\/shorts\/([^/]+)(?:\/|$)/);
        return match ? decodeURIComponent(match[1]) : null;
      }
      catch (e) { return null; }
    }

    let playbackReportSeq = 0;
    let playbackReportController = null;

    async function reportPlaybackState() {
      const p = player();
      if (!p) return;  // html5Player/youtubePlayer already set lastProbe
      const reportSeq = ++playbackReportSeq;
      if (playbackReportController) playbackReportController.abort();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      playbackReportController = controller;

      // Under Jellyfin only position/duration go up: the element's src is an
      // opaque blob: URL under MSE, so identity has to come from /Sessions on
      // the backend. The YouTube page knows what it loaded and says so.
      try {
        const res = await fetch(`${API}/api/playback-state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            position_ms: Math.round(p.currentTimeMs()),
            duration_ms: Math.round(p.durationMs()),
            status: p.paused() ? "paused" : "playing",
            tab_id: TAB_ID,
            client_session: PLAYBACK_SESSION_ID,
            client_seq: reportSeq,
            ...(p.source ? { source: p.source } : {}),
          }),
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (reportSeq !== playbackReportSeq) return;
        if (!res.ok) {
          ctx.state.lastProbe = res.status === 409
            ? "Jellyfin 还没报告播放会话，稍等几秒"
            : `上报播放状态失败（HTTP ${res.status}）`;
          return;
        }
        ctx.state.lastProbe = "";

        const data = await res.json();
        if (data.path && data.path !== ctx.state.currentItemId) {
          ctx.state.currentItemId = data.path;
          // New episode -- drop the old cues so the subtitle page reloads
          // for what's playing now, not the previous episode.
          invalidateDifficultyBadge();
          resetSubtitleSession();
          detachSeekVideo();
          // Loop bounds are indices into the cue list that just went away.
          subsNote.hidden = true;
          stopExtractPolling();
          if (currentPage === "subs") loadSubtitleCues();
        }
      } catch (e) {
        if (e.name === "AbortError" || reportSeq !== playbackReportSeq) return;
        ctx.state.lastProbe = "连不上后端 app.py";
      } finally {
        if (reportSeq === playbackReportSeq) playbackReportController = null;
      }
    }

    // The YouTube page changes videos without playback necessarily starting,
    // and a cued-but-unplayed player reports no duration -- so the position
    // report that normally notices a switch never fires. The page says so
    // outright instead of leaving the panel showing the previous video's
    // subtitles, which look perfectly plausible and are entirely wrong.
    window.addEventListener("english-tutor:source-changed", () => {
      playbackReportSeq++;
      if (playbackReportController) playbackReportController.abort();
      playbackReportController = null;
      invalidateDifficultyBadge();
      resetSubtitleSession();
      detachSeekVideo();
      ctx.state.currentItemId = null;
      subsNote.hidden = true;
      previewedWordForms.clear();
      if (previewSession) {
        previewSession = null;
        previewOverlay.hidden = true;
        previewOverlay.innerHTML = "";
      }
      if (currentPage === "subs") loadSubtitleCues();
    });

    window.addEventListener("english-tutor:captions-ready", () => {
      const p = player();
      const videoId = p && p.kind === "youtube" ? youtubeVideoId(location.href) : null;
      if (!videoId) return;
      // The first preview request may have finished before the browser-side
      // member caption upload. Invalidate that decision and fetch again from
      // the newly written local subtitle cache.
      previewRequestSeq++;
      previewLastVideoId = videoId;
      previewAnswered = false;
      previewPrefetchPromise = null;
      const retry = () => {
        if (videoId !== previewLastVideoId || previewSession) return;
        if (previewFetchInFlight) {
          setTimeout(retry, 100);
          return;
        }
        updatePreviewPrompt();
      };
      retry();
    });

    // Position for the highlight comes from the element directly (smooth, no
    // network); the POST above is throttled separately since it only needs to
    // keep the backend roughly current for chat/MCP lookups.
    //
    // A quarter second is plenty to land on the right *line*, but plenty of
    // spoken words are shorter than that, so the word-by-word highlight
    // needs a finer clock. Only when it's actually on -- the extra ticks buy
    // nothing for anyone who has it off, and nothing at all under Jellyfin,
    // where no video has per-word timings to begin with.
    const POSITION_POLL_MS = 250;
    const POSITION_POLL_WORD_MS = 100;
    let positionTimer = null;
    let seekVideo = null;
    let seekInProgress = false;
    let seekCommitTimer = 0;
    let lastSeekProbeAt = 0;

    function resetSeekTransaction() {
      if (seekCommitTimer) clearTimeout(seekCommitTimer);
      seekCommitTimer = 0;
      seekInProgress = false;
    }

    function detachSeekVideo() {
      if (seekVideo) {
        seekVideo.removeEventListener("seeking", handleVideoSeeking);
        seekVideo.removeEventListener("seeked", handleVideoSeeked);
      }
      seekVideo = null;
      lastSeekProbeAt = 0;
      resetSeekTransaction();
    }

    function commitVideoSeek() {
      seekCommitTimer = 0;
      seekInProgress = false;
      const p = player();
      if (!p) return;
      const nowMs = p.currentTimeMs();
      if (!Number.isFinite(nowMs)) return;
      lastPositionMs = NaN;
      updateCurrentCue(nowMs, true);
    }

    function handleVideoSeeking() {
      if (seekCommitTimer) { clearTimeout(seekCommitTimer); seekCommitTimer = 0; }
      seekInProgress = true;
      cancelSmoothScroll();
      // A progress-bar drag emits several intermediate currentTime values.
      // Do not render each one as a separate jump; seeked will commit the
      // final position once the player has settled.
      lastPositionMs = NaN;
    }

    function handleVideoSeeked() {
      if (seekCommitTimer) clearTimeout(seekCommitTimer);
      // Dragging a progress bar can produce several seeked events. Wait for
      // the burst to settle, then read the player's final position once.
      seekCommitTimer = setTimeout(commitVideoSeek, 80);
    }

    function bindSeekEvents() {
      // findVideo() also walks open shadow roots, which is where some
      // Jellyfin builds mount their player. Missing that element meant seek
      // events were never seen there and the polling path processed every
      // intermediate drag position instead.
      // Once attached, keep the listener until that element leaves the DOM.
      // Scanning every element in the page at the position-poll frequency
      // made YouTube drags compete with the player on the main thread.
      if (seekVideo && seekVideo.isConnected) return;
      const now = Date.now();
      if (now - lastSeekProbeAt < 500) return;
      lastSeekProbeAt = now;
      const video = ctx.fns.findVideo();
      if (video === seekVideo) return;
      if (seekVideo) {
        seekVideo.removeEventListener("seeking", handleVideoSeeking);
        seekVideo.removeEventListener("seeked", handleVideoSeeked);
      }
      seekVideo = video || null;
      resetSeekTransaction();
      if (seekVideo) {
        seekVideo.addEventListener("seeking", handleVideoSeeking, { passive: true });
        seekVideo.addEventListener("seeked", handleVideoSeeked, { passive: true });
      }
    }

    function startPositionPolling() {
      clearInterval(positionTimer);
      positionTimer = setInterval(() => {
        bindSeekEvents();
        // A native media element can briefly miss a seeked event while its
        // source is being replaced. The property check is a fallback so a
        // stale seek transaction cannot suppress subtitle updates forever.
        let commitSeek = false;
        if (seekInProgress) {
          if (!seekVideo || seekVideo.seeking || seekCommitTimer) return;
          seekInProgress = false;
          commitSeek = true;
        }
        const p = player();
        if (!p) return;
        const nowMs = p.currentTimeMs();
        if (!isNaN(nowMs)) updateCurrentCue(nowMs, commitSeek);
      }, wordHighlightOn() ? POSITION_POLL_WORD_MS : POSITION_POLL_MS);
    }
    startPositionPolling();
    setInterval(reportPlaybackState, 2000);

    let contextRequestSeq = 0;
    let contextRequestController = null;

    async function refreshContext() {
      const contextSeq = ++contextRequestSeq;
      if (contextRequestController) contextRequestController.abort();
      const contextController = typeof AbortController === "function" ? new AbortController() : null;
      contextRequestController = contextController;
      // Independent of whether /api/context below has anything to say: the
      // badge only needs the video id straight out of the URL, not the
      // playback-state pipeline's own "is anything reporting in yet" state
      // -- gating it on that meant a video switch where reportPlaybackState
      // hadn't caught up yet (still very possible right after a switch)
      // silently skipped the badge for that whole poll tick too.
      updateDifficultyBadge();
      updatePreviewPrompt();
      try {
        const response = await fetch(`${API}/api/context?tab_id=${TAB_ID}`,
          contextController ? { signal: contextController.signal } : undefined);
        const data = await response.json();
        if (contextSeq !== contextRequestSeq) return;
        if (!data.available) {
          // lastProbe says what the panel itself sees; without it a detection
          // failure is indistinguishable from "nothing is playing yet".
          contextBar.textContent = ctx.state.lastProbe
            ? `⚠ ${ctx.state.lastProbe}`
            : (data.error || "还没开始播放");
          return;
        }
        const p = data.progress;
        lastKnownVideoTitle = p.title || lastKnownVideoTitle;
        contextBar.textContent =
          `▶ ${p.title} — ${fmt(p.position_ms)}/${fmt(p.duration_ms)}  |  ${data.status_line || ""}`;
      } catch (e) {
        if (e.name === "AbortError" || contextSeq !== contextRequestSeq) return;
        contextBar.textContent = "读取播放状态失败（后端 app.py 没启动？）";
      } finally {
        if (contextSeq === contextRequestSeq) contextRequestController = null;
      }
    }

    let difficultyFetchInFlight = false;
    let difficultyFetchSeq = 0;
    let difficultyFetchController = null;

    function invalidateDifficultyBadge() {
      difficultyFetchSeq++;
      if (difficultyFetchController) difficultyFetchController.abort();
      difficultyFetchController = null;
      difficultyFetchInFlight = false;
      difficultyBadge.hidden = true;
    }
    // Same three colors/thresholds as extension/grid-badges.js's card
    // badges (see .lc-ok/.lc-mid/.lc-bad in panel.css) -- one system, two
    // surfaces.
    const DIFFICULTY_LABEL_CLASS = { "轻松": "lc-ok", "刚好": "lc-ok", "有挑战": "lc-mid", "偏难": "lc-bad", "超难": "lc-bad" };

    /** New-words-per-minute badge for the video currently open. YouTube
     *  identifies itself with a video_id straight out of the URL; Jellyfin
     *  and other local playback have no such id client-side (the <video>
     *  element's src is an opaque blob: URL), so those go through
     *  /api/difficulty-local instead, which resolves identity from tab_id
     *  server-side the same way /api/subtitles and /api/context already do.
     *  Grid-page badges (grid-badges.js) stay YouTube-only regardless --
     *  there's no equivalent library-grid injection into Jellyfin's UI.
     *
     *  Change detection for the local case piggybacks on lastKnownVideoTitle
     *  (updated by the /api/context poll this runs alongside) rather than
     *  a video_id, since there isn't one to compare -- one extra ~4s tick of
     *  lag before the badge blanks on a switch, which is the same order of
     *  staleness this already tolerates for "just switched, not indexed yet".
     *
     *  A freshly-opened video's subtitles usually aren't cached yet (the
     *  backend's fetch takes ~12s), so the very first check after switching
     *  routinely comes back "unindexed" -- confirmed for real. That must not
     *  be treated as a final answer: this only stops retrying once a check
     *  actually succeeds (hidden becomes false) or the video changes again,
     *  polling again on every 4s context tick in between rather than giving
     *  up on the first miss. */
    async function updateDifficultyBadge() {
      const p = player();
      const isYouTube = p && p.kind === "youtube";
      const key = isYouTube ? youtubeVideoId(location.href) : (p ? lastKnownVideoTitle : null);
      if (!key) {
        difficultyBadge.hidden = true;
        lastDifficultyKey = null;
        return;
      }
      if (key !== lastDifficultyKey) {
        lastDifficultyKey = key;
        difficultyBadge.hidden = true;  // nothing confirmed for this video yet
      } else if (!difficultyBadge.hidden) {
        return;  // already showing a confirmed result for this exact video
      }
      if (difficultyFetchInFlight) return;
      const requestSeq = ++difficultyFetchSeq;
      if (difficultyFetchController) difficultyFetchController.abort();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      difficultyFetchController = controller;
      difficultyFetchInFlight = true;
      try {
        const url = isYouTube
          ? `${API}/api/difficulty/${encodeURIComponent(key)}`
          : `${API}/api/difficulty-local?tab_id=${TAB_ID}`;
        const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
        const data = await res.json();
        // Stale (moved on before this resolved) or not ready yet (subtitles
        // still fetching) -- either way, leave hidden and let the next 4s
        // tick try again rather than treating this as a final no.
        if (requestSeq !== difficultyFetchSeq || key !== lastDifficultyKey || data.status !== "ok") return;
        difficultyBadge.hidden = false;
        difficultyBadge.className = `difficulty-badge ${DIFFICULTY_LABEL_CLASS[data.label] || ""}`;
        difficultyBadge.textContent = `${data.label} · ${data.density_per_min}/分钟${data.personalized ? " · 个性化" : ""}`;
        difficultyBadge.title = data.personalized
          ? `已根据你的词汇量和个人掌握记录计算（${data.known_words_used || 0} 个已记录词）`
          : `当前使用词频估算；完成词汇测试后会更准确（约 ${data.vocab_size} 词）`;
      } catch (e) {
        // Network hiccup -- next tick retries.
      } finally {
        if (requestSeq === difficultyFetchSeq) {
          difficultyFetchInFlight = false;
          difficultyFetchController = null;
        }
      }
    }

