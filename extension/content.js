// Injected by background.js into MAIN world (see background.js's
// file-header comment for why: tutor-panel.js is loaded via a real
// <script src>, which always runs in the page's real world regardless of
// which world inserted the tag -- so this needs to be in that same world
// too, for window.__englishTutorApiBase/__englishTutorYouTube set here to
// be visible to it) on every navigation to a /watch page, including
// YouTube's own SPA navigations between videos, not just full page loads.
//
// Two jobs: (1) keep window.__englishTutorYouTube -- the same bridge shape
// static/youtube.html has always provided (tutor-panel.js:1644) -- pointed
// at the real, same-origin <video> element instead of an IFrame API player;
// (2) tell the backend which video is current, the equivalent of the old
// library's add()+select() combined into one call.
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

  // The tab title trails the SPA navigation by a beat on a fresh load, so an
  // occasional stale/placeholder title making it into the cached filename is
  // a known rough edge, not a bug to chase preemptively -- video_id_for()
  // only reads the id back out of the filename, so a wrong title in the
  // human-readable part doesn't break lookups, just cosmetics.
  function titleFromPage() {
    var t = (document.title || "").replace(/ - YouTube$/, "").trim();
    return t || "YouTube video";
  }

  var id = videoIdFromUrl();
  if (!id || id === window.__lingocueLastVideoId) return;
  window.__lingocueLastVideoId = id;
  window.__lingocueCurrentSource = null; // cleared until the backend confirms it

  fetch(window.__englishTutorApiBase + "/api/youtube/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: id, title: titleFromPage(), url: location.href }),
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || !data.ok) return;
      window.__lingocueCurrentSource = data.path;
      // Same event static/youtube.html's own script dispatches on a video
      // switch -- tutor-panel.js already knows how to handle it.
      window.dispatchEvent(new CustomEvent("english-tutor:source-changed"));
    })
    .catch(function (e) { console.error("[lingocue] failed to register video", e); });
})();
