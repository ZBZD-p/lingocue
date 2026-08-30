// Injected by background.js into MAIN world (see background.js's
// file-header comment for why: tutor-panel.js is loaded via a real
// <script src>, which always runs in the page's real world regardless of
// which world inserted the tag -- so this needs to be in that same world
// too, for window.__englishTutorApiBase/__englishTutorYouTube set here to
// be visible to it) on every navigation to a /watch page, including
// YouTube's own SPA navigations between videos, not just full page loads.
//
// Two jobs: (1) keep window.__englishTutorYouTube -- the player bridge
// tutor-panel.js reads through youtubePlayer() -- pointed at the real,
// same-origin <video> element; (2) tell the backend which video is current,
// and (if the backend's own unauthenticated fetch can't reach it -- see
// save_uploaded_subtitles's docstring in youtube.py) fetch its captions
// from inside this real, logged-in tab instead.
//
// State lives on `window`, not in this function's own closures: this whole
// script re-runs from scratch on every navigation (it's re-injected each
// time, not a long-lived listener), so anything that needs to survive
// between runs -- or be readable by tutor-panel.js's ongoing polling --
// has to be a window property.
//
// The registration/fallback orchestration below is deliberately structured
// as a small session store + two "ports" (backend HTTP, live page/player)
// feeding one orchestrator, rather than the flatter version this used to
// be. Reason: a real bug shipped here twice from the flat version -- an
// async response arriving after the user had already navigated on would
// overwrite newer state, because the "is this still current" check was a
// convention each callback had to remember individually (and one of them,
// registerVideo's own success handler, didn't). Routing every callback
// through one token's guard() makes that check structural instead of a
// convention -- see makeSessionStore below.

(function () {
  "use strict";

  if (!window.__englishTutorYouTube) {
    window.__englishTutorYouTube = {
      ready: function () {
        var v = document.querySelector("video");
        return !!(v && window.__lingocueOrchestrator && window.__lingocueOrchestrator.currentSource() && v.duration > 0);
      },
      source: function () {
        return (window.__lingocueOrchestrator && window.__lingocueOrchestrator.currentSource()) || null;
      },
      currentTime: function () {
        var v = document.querySelector("video");
        return v ? v.currentTime : 0;
      },
      duration: function () {
        var v = document.querySelector("video");
        return v ? v.duration : 0;
      },
      paused: function () {
        var v = document.querySelector("video");
        return v ? v.paused : true;
      },
      seek: function (seconds) {
        var v = document.querySelector("video");
        if (v) v.currentTime = seconds;
      },
      // Preview cards (tutor-panel.js's updatePreviewPrompt) pausing to run
      // a round and resuming after -- YouTube's player is a real <video>
      // element under the hood, same as everywhere else in this bridge.
      pause: function () {
        var v = document.querySelector("video");
        if (v) v.pause();
      },
      play: function () {
        var v = document.querySelector("video");
        if (v) v.play().catch(function () {});
      },
    };
  }

  function videoIdFromUrl() {
    try { return new URL(location.href).searchParams.get("v"); }
    catch (e) { return null; }
  }

  function titleFromPage() {
    var t = (document.title || "").replace(/ - YouTube$/, "").trim();
    return t || "YouTube video";
  }

  // The authoritative title for `videoId`, or null if the player hasn't
  // caught up to it yet -- same source and same videoId guard as
  // pagePort.captionTracks below. Confirmed for real to settle correctly
  // well before document.title does: after a related-video click,
  // document.title sat on the *previous* video's title for 13+ seconds
  // (not a brief flicker -- long enough that the old single-recheck-at-1.5s
  // correction below had already given up), while this was already correct
  // within a couple of seconds. Used to confirm/correct titleFromPage()'s
  // guess rather than replace it outright, since the player response isn't
  // available yet at the very first read right after navigating.
  function playerTitleFor(videoId) {
    var player = document.querySelector("#movie_player");
    var pr = player && typeof player.getPlayerResponse === "function"
      ? player.getPlayerResponse() : null;
    if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== videoId) return null;
    return pr.videoDetails.title || null;
  }

  // The tab title trails the SPA navigation by a beat, so the very first
  // read can be wrong in two different ways -- both confirmed for real, not
  // just theoretical: (a) the generic "(12) YouTube" placeholder, if
  // nothing's been filled in yet, or (b) the *previous* video's title,
  // still sitting there because YouTube hasn't overwritten it yet even
  // though the URL/video element already changed. (b) is the sneakier one:
  // it looks like a perfectly valid title, so there's no way to catch it by
  // pattern-matching the string the way (a) can be. That's not just
  // cosmetic -- the backend derives its cache filename from the title, so
  // registering under the wrong one makes this video look like a brand new
  // one on the *next* correct detection, and that "new" registration wipes
  // and re-fetches subtitles from scratch, discarding any
  // punctuation-restoration work already done under the wrong name.
  function isPlaceholderTitle(t) {
    return /^(\(\d+\)\s*)?YouTube$/.test(t);
  }

  // Same key, same derivation as tutor-panel.js's TAB_ID -- this script and
  // that one are injected independently (see background.js) so neither can
  // assume the other has run first; sessionStorage makes whichever runs
  // first create it and the other just read it back, no ordering needed.
  // Math.random() rather than crypto.randomUUID(): the latter is gated to
  // secure contexts and this only ever needs to be compared for equality,
  // never unguessable -- see tutor-panel.js's TAB_ID for the fuller reason
  // (it bit the Jellyfin panel there since that one isn't always reached
  // over a secure origin; youtube.com always is, but keeping both the same
  // avoids two divergent implementations of one id scheme).
  var TAB_ID = (function () {
    function fresh() { return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
    try {
      var id = sessionStorage.getItem("lingocueTabId");
      if (!id) { id = fresh(); sessionStorage.setItem("lingocueTabId", id); }
      return id;
    } catch (e) {
      return fresh();
    }
  })();

  // ---- session store: the one place "is this still current" is decided --
  //
  // A token is a receipt for one call to enterVideo(). Every async
  // continuation anywhere in the orchestrator wraps itself in that token's
  // guard() before touching shared state, so a response that arrives after
  // a newer enterVideo() call has superseded it is silently dropped instead
  // of overwriting fresher state with staler data -- this is the actual
  // fix for the bug described in this file's header comment. No call site
  // compares a raw id against a raw global by hand anymore; they can't, by
  // construction, forget to.
  //
  // Exposed on window (not a closure var) for the same reason TAB_ID would
  // need to be if it survived navigations: this script re-runs from
  // scratch on every SPA navigation, so only a window property survives
  // from one run to the next.
  function makeSessionStore() {
    var epoch = 0;
    var claimedVideoId = null; // set synchronously, see claim() below
    var source = null;

    return {
      // Claims a video id immediately and synchronously, before any of the
      // async title-resolution work (registerWhenReady's placeholder-title
      // retry loop) even starts. This is deliberately separate from
      // begin()/epoch below: it's what the top-level dedup check uses, so a
      // second script re-injection for a video whose title is still being
      // resolved doesn't restart that whole process from scratch.
      isClaimed: function (vid) { return vid === claimedVideoId; },
      claim: function (vid) { claimedVideoId = vid; source = null; },
      currentSource: function () { return source; },
      // Mints a token for guarding ASYNC responses (the actual bug fix).
      // Independent of claim() above -- can be called more than once for
      // the same claimed video (the title-correction re-registration does
      // exactly that), each call superseding the last token's guard.
      begin: function (vid) {
        var myEpoch = ++epoch;
        return {
          videoId: vid,
          isCurrent: function () { return myEpoch === epoch; },
          setSource: function (path) { if (myEpoch === epoch) source = path; },
          // Wraps an async callback so it silently no-ops once superseded,
          // instead of every call site re-deriving that check by hand.
          guard: function (fn) {
            return function (a, b) {
              if (myEpoch !== epoch) return;
              return fn(a, b);
            };
          },
        };
      },
    };
  }
  var session = window.__lingocueSession || (window.__lingocueSession = makeSessionStore());

  // ---- backend port: the local FastAPI server -------------------------
  var backendPort = {
    registerVideo: function (videoId, title, channelId) {
      return fetch(window.__englishTutorApiBase + "/api/youtube/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: videoId, title: title, url: location.href, tab_id: TAB_ID,
          channel_id: channelId || "",
        }),
      }).then(function (res) { return res.json(); });
    },
    getSubtitleStatus: function () {
      return fetch(window.__englishTutorApiBase + "/api/subtitles?tab_id=" + encodeURIComponent(TAB_ID))
        .then(function (res) { return res.json(); });
    },
    uploadCaptions: function (videoId, title, kind, json3Text) {
      return fetch(window.__englishTutorApiBase + "/api/youtube/subtitles-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: videoId, title: title, kind: kind, json3: json3Text }),
      }).then(function (res) { return res.json(); });
    },
  };

  // ---- page port: the live YouTube DOM/player --------------------------
  //
  // Everything here reads whatever's on screen *right now* -- notably
  // player.getPlayerResponse(), not window.ytInitialPlayerResponse, which
  // is set once at the very first page load and never again (confirmed for
  // real: clicking through a chain of recommended videos, it kept
  // reporting the first one's title and captions three videos later). The
  // videoId check on the response is an extra guard against reading it
  // before the player itself has caught up.
  var pagePort = {
    notifySourceChanged: function () {
      // tutor-panel.js listens for this and reloads its cue list; it's the
      // only signal it gets that the video changed under it.
      window.dispatchEvent(new CustomEvent("english-tutor:source-changed"));
    },
    captionTracks: function (videoId) {
      var player = document.querySelector("#movie_player");
      var pr = player && typeof player.getPlayerResponse === "function"
        ? player.getPlayerResponse() : null;
      if (!pr || (pr.videoDetails && pr.videoDetails.videoId !== videoId)) return null;
      return (pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
              pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    },
    // For the difficulty engine's channel-level fallback (see app.py's
    // channel_id threading and indexer.py's channel_profile). Reads the
    // channel's @handle out of the owner link's DOM href, NOT
    // videoDetails.channelId (the stable UC... id) -- confirmed for real
    // that a video grid card (ytd-rich-item-renderer, the only place a
    // video the user hasn't watched yet can be badged from) only ever
    // exposes a channel's /@handle in its own DOM, never its UC... id, so
    // that id would be a join key the batch endpoint could never match
    // anything up with. The handle is stable and available identically in
    // both places, so it's what's used everywhere instead. Guarded by
    // videoId only loosely (via the player, not per-element) since unlike
    // playerTitleFor/captionTracks there's no per-owner-element videoId to
    // check against -- acceptable because a stale read here just means one
    // registration call passes an empty or slightly-stale handle, which
    // self-heals the same way a stale title does (see confirmTitle).
    channelIdFor: function (videoId) {
      var player = document.querySelector("#movie_player");
      var pr = player && typeof player.getPlayerResponse === "function"
        ? player.getPlayerResponse() : null;
      if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== videoId) return "";
      var owner = document.querySelector("ytd-video-owner-renderer a, #channel-name a, ytd-channel-name a");
      if (!owner || !owner.href) return "";
      try {
        var path = new URL(owner.href).pathname;
        return path.indexOf("/@") === 0 ? path.slice(1) : "";
      } catch (e) { return ""; }
    },
    // Toggling captions off (if already on) then back on reliably fires a
    // fresh timedtext request -- confirmed for real, an already-on button
    // that's clicked once doesn't necessarily re-request anything.
    toggleCaptionsButton: function () {
      var btn = document.querySelector(".ytp-subtitles-button");
      if (!btn) return false;
      if (btn.getAttribute("aria-pressed") === "true") btn.click();
      btn.click();
      return true;
    },
    // performance's resource-timing entries persist across this script's
    // own re-injection (they're the tab's, not this closure's), so a
    // request fired by the click above shows up here shortly after --
    // polled rather than awaited since there's no event for "a resource
    // entry appeared".
    waitForTimedtextRequest: function (videoId, attemptsLeft, cb) {
      var entries = performance.getEntriesByType("resource");
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name.indexOf("/api/timedtext") !== -1 &&
            entries[i].name.indexOf("v=" + videoId) !== -1) {
          cb(entries[i].name);
          return;
        }
      }
      if (attemptsLeft <= 0) { cb(null); return; }
      var self = this;
      setTimeout(function () { self.waitForTimedtextRequest(videoId, attemptsLeft - 1, cb); }, 500);
    },
    fetchCaptionText: function (url) {
      return fetch(url, { credentials: "include" }).then(function (res) { return res.text(); });
    },
  };

  // ---- fallback cooldown, unchanged from before -------------------------
  //
  // Same cooldown value and reasoning as youtube.py's RETRY_COOLDOWN_S (that
  // one guards the backend's own plain request; this guards this one) --
  // long enough that idle re-navigation stops re-triggering it, short
  // enough that a one-off glitch (the CC button not mounted yet, a request
  // that never showed up in time) isn't stuck retrying-never until then.
  // localStorage rather than a module-level variable: this whole script
  // re-runs from scratch on every navigation, so nothing in its own closures
  // survives to remember an earlier attempt the way youtube.py's
  // _fetch_failed_at dict can.
  //
  // Keyed by title+id, not id alone: the same video can get registered
  // twice under two different titles (the page's title element trailing
  // the SPA navigation -- see isPlaceholderTitle's comment), and each is a
  // genuinely different backend cache entry (youtube.safe_base_name folds
  // the title in too). Keying on id alone was confirmed for real to cost a
  // video its subtitles: the first (stale-title) registration's fallback
  // won the race, marked the video's id as attempted, and the second,
  // *correctly*-titled registration -- the one the panel actually ends up
  // reading from -- silently found itself on cooldown and never even tried.
  var fallbackCooldown = (function () {
    var COOLDOWN_MS = 600000;
    var STORAGE_KEY = "lingocueCaptionFallbackAttempts";
    function readMap() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
      catch (e) { return {}; }
    }
    return {
      key: function (videoId, title) { return videoId + "::" + title; },
      recentlyAttempted: function (key) {
        var map = readMap();
        return typeof map[key] === "number" && Date.now() - map[key] < COOLDOWN_MS;
      },
      markAttempted: function (key) {
        var map = readMap();
        map[key] = Date.now();
        // Trimmed on write rather than kept forever -- this is scratch
        // state for a rate limit, not a record anything needs to look back on.
        var cutoff = Date.now() - COOLDOWN_MS;
        for (var k in map) { if (map[k] < cutoff) delete map[k]; }
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (e) { /* full/disabled storage -- best effort only */ }
      },
    };
  })();

  // ---- orchestrator: the actual decision logic, port-agnostic ----------
  function createVideoOrchestrator(deps) {
    function registerVideo(token, title) {
      var channelId = deps.page.channelIdFor(token.videoId);
      deps.backend.registerVideo(token.videoId, title, channelId)
        .then(token.guard(function (data) {
          if (!data || !data.ok) return;
          token.setSource(data.path);
          deps.page.notifySourceChanged();
          // The backend's own fetch has no login of its own, so it comes up
          // empty for anything gated behind one -- members-only being the
          // main case. Only this tab, actually signed in, can do any
          // better; watchSubtitleFailure below finds out whether it needs to.
          watchSubtitleFailure(token, title, 40);
        }))
        .catch(function (e) { console.error("[lingocue] failed to register video", e); });
    }

    // Polls the same status the panel's subtitle tab does, purely to
    // notice a failure -- success needs nothing from this script, and
    // "still fetching" just means keep waiting (subtitle fetch normally
    // takes ~12s per youtube.py). Stops on its own once this navigation is
    // superseded or attempts run out (~60s).
    function watchSubtitleFailure(token, title, attemptsLeft) {
      if (attemptsLeft <= 0 || !token.isCurrent()) return;
      deps.backend.getSubtitleStatus()
        .then(token.guard(function (data) {
          if (data && data.available) return; // succeeded the normal way
          if (data && data.status === "error") {
            tryBrowserCaptionFallback(token, title);
            return;
          }
          setTimeout(function () { watchSubtitleFailure(token, title, attemptsLeft - 1); }, 1500);
        }))
        .catch(function () {
          setTimeout(function () { watchSubtitleFailure(token, title, attemptsLeft - 1); }, 1500);
        });
    }

    // The fallback itself: reuse a caption request the player already made
    // -- it carries a Proof-of-Origin token this tab's own JS can't mint,
    // tied to this video and this login, which is exactly what the
    // backend's plain request above lacks. See youtube.py's
    // save_uploaded_subtitles docstring for the full picture, including why
    // this is safe to just always try rather than needing to first detect
    // "is this members-only": a video with no caption track at all (the
    // ordinary case a failure usually means) shows that here too, and this
    // quietly does nothing.
    function tryBrowserCaptionFallback(token, title) {
      var key = fallbackCooldown.key(token.videoId, title);
      if (fallbackCooldown.recentlyAttempted(key)) return;
      fallbackCooldown.markAttempted(key);

      var tracks = deps.page.captionTracks(token.videoId);
      if (!tracks) return; // player hasn't caught up to this video yet
      var target = null;
      for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].languageCode === "en" && tracks[i].kind !== "asr") { target = tracks[i]; break; }
      }
      var isGenerated = false;
      if (!target) {
        for (var j = 0; j < tracks.length; j++) {
          if (tracks[j].languageCode === "en" && tracks[j].kind === "asr") { target = tracks[j]; isGenerated = true; break; }
        }
      }
      if (!target) return; // this tab has no English track either -- nothing to fetch
      if (!deps.page.toggleCaptionsButton()) return;

      deps.page.waitForTimedtextRequest(token.videoId, 10, function (rawUrl) {
        if (!rawUrl || !token.isCurrent()) return;
        var u;
        try { u = new URL(rawUrl); } catch (e) { return; }
        // The signature covers v/ei/caps/... (see sparams in the URL
        // itself) but not lang/kind -- confirmed for real by swapping them
        // on an already-issued URL and still getting a valid response back
        // -- so whatever track the player happened to request first can be
        // redirected at the one actually wanted here.
        u.searchParams.set("lang", target.languageCode);
        if (isGenerated) u.searchParams.set("kind", "asr");
        else u.searchParams.delete("kind");

        deps.page.fetchCaptionText(u.toString())
          .then(function (text) {
            if (!text || !token.isCurrent()) return null;
            return deps.backend.uploadCaptions(token.videoId, title, isGenerated ? "auto" : "manual", text);
          })
          .then(token.guard(function (data) {
            if (data && data.ok) deps.page.notifySourceChanged();
          }))
          .catch(function (e) { console.error("[lingocue] browser caption fallback failed", e); });
      });
    }

    return {
      // Starts (or restarts, under a corrected title) registration for a
      // video. Each call supersedes whatever the previous token was doing.
      enterVideo: function (videoId, title) {
        var token = deps.session.begin(videoId);
        registerVideo(token, title);
        return token;
      },
      currentSource: function () { return deps.session.currentSource(); },
    };
  }

  var orchestrator = window.__lingocueOrchestrator || (window.__lingocueOrchestrator = createVideoOrchestrator({
    backend: backendPort,
    page: pagePort,
    session: session,
  }));

  var id = videoIdFromUrl();
  if (!id || session.isClaimed(id)) return;
  session.claim(id);

  // The title read just now looked plausible but could still be the
  // previous video's leftover (case (b) above) -- a plain retry loop can't
  // tell the difference by looking at the string alone. So instead of
  // trusting it, this polls playerTitleFor(videoId) -- guarded by videoId,
  // so it can't hand back a wrong video's title the way document.title's
  // silent staleness can -- and re-registers under the corrected title the
  // moment it disagrees. Stops as soon as it either confirms the title used
  // was right or the player itself confirms it (even if unchanged), rather
  // than a single check-once-and-give-up: confirmed for real that
  // document.title can still be wrong 13+ seconds after navigating, far
  // past what one recheck covers. enterVideo again (not a bare
  // registerVideo) so a correction gets its own fresh token, superseding
  // the first registration the same way a real re-navigation would.
  function confirmTitle(token, videoId, usedTitle, attemptsLeft) {
    if (!token.isCurrent()) return; // already on to another video
    var authoritative = playerTitleFor(videoId);
    if (authoritative) {
      if (authoritative !== usedTitle) orchestrator.enterVideo(videoId, authoritative);
      return; // confirmed either way -- nothing left to poll for
    }
    if (attemptsLeft <= 0) return; // player never caught up in time; best effort ends here
    setTimeout(function () { confirmTitle(token, videoId, usedTitle, attemptsLeft - 1); }, 500);
  }

  function registerWhenReady(attemptsLeft) {
    var title = titleFromPage();
    if (isPlaceholderTitle(title) && attemptsLeft > 0) {
      setTimeout(function () { registerWhenReady(attemptsLeft - 1); }, 300);
      return;
    }
    var token = orchestrator.enterVideo(id, title);
    confirmTitle(token, id, title, 16); // ~8s of polling at 500ms apart
  }
  registerWhenReady(5); // ~1.5s of retries at 300ms apart if it starts out blank
})();
