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
// same-origin <video> element; (2) tell the backend which video is current.
//
// State lives on `window`, not in this function's own closures: this whole
// script re-runs from scratch on every navigation (it's re-injected each
// time, not a long-lived listener), so anything that needs to survive
// between runs -- or be readable by tutor-panel.js's ongoing polling --
// has to be a window property.

(function () {
  "use strict";

  if (!window.__englishTutorYouTube) {
    window.__englishTutorYouTube = {
      ready: function () {
        var v = document.querySelector("video");
        return !!(v && window.__lingocueCurrentSource && v.duration > 0);
      },
      source: function () { return window.__lingocueCurrentSource || null; },
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

  var id = videoIdFromUrl();
  if (!id || id === window.__lingocueLastVideoId) return;
  window.__lingocueLastVideoId = id;
  window.__lingocueCurrentSource = null; // cleared until the backend confirms it

  function registerVideo(title) {
    fetch(window.__englishTutorApiBase + "/api/youtube/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, title: title, url: location.href, tab_id: TAB_ID }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok) return;
        window.__lingocueCurrentSource = data.path;
        // tutor-panel.js listens for this and reloads its cue list; it's the
        // only signal it gets that the video changed under it.
        window.dispatchEvent(new CustomEvent("english-tutor:source-changed"));
      })
      .catch(function (e) { console.error("[lingocue] failed to register video", e); });
  }

  function registerWhenReady(attemptsLeft) {
    var title = titleFromPage();
    if (isPlaceholderTitle(title) && attemptsLeft > 0) {
      setTimeout(function () { registerWhenReady(attemptsLeft - 1); }, 300);
      return;
    }
    registerVideo(title);
    // Case (b) above: the title read just now looked plausible but could
    // still be the previous video's leftover. A plain retry loop can't tell
    // the difference by looking at the string alone, so instead this
    // re-reads the title a beat later and, if it actually changed (and
    // isn't itself a placeholder), registers again under the corrected one
    // -- self-correcting rather than trying to guess up front whether the
    // first read was trustworthy.
    setTimeout(function () {
      if (id !== window.__lingocueLastVideoId) return; // already on to another video
      var laterTitle = titleFromPage();
      if (laterTitle !== title && !isPlaceholderTitle(laterTitle)) {
        registerVideo(laterTitle);
      }
    }, 1500);
  }
  registerWhenReady(5); // ~1.5s of retries at 300ms apart if it starts out blank
})();
