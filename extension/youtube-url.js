// Shared YouTube URL parsing for extension scripts.
// This file is injected into both the isolated and MAIN worlds, so consumers
// read the same pure function without relying on cross-world globals.
(function () {
  "use strict";

  var URL_BASE = "https://www.youtube.com/";

  function videoIdFromUrl(href) {
    try {
      var parsed = new URL(href, URL_BASE);
      if (parsed.pathname === "/watch") {
        return parsed.searchParams.get("v") || null;
      }
      var match = parsed.pathname.match(/^\/shorts\/([^/]+)(?:\/|$)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch (e) {
      return null;
    }
  }

  window.__lingocueYouTubeUrl = {
    videoIdFromUrl: videoIdFromUrl,
  };
})();
