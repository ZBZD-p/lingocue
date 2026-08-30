// Isolated-world content script (see manifest.json) -- unlike
// content.js/tutor-panel.js this needs no window.__englishTutor* /
// MAIN-world access, so it skips the whole privileged-injection machinery
// those two need (see background.js's file header). Runs on every
// youtube.com page, not just /watch: painting a difficulty badge onto a
// video card is purely DOM-driven ("what's visible right now"), not tied to
// "what video is playing", so there's no SPA-navigation detection here at
// all -- cards just appear/disappear as YouTube's router swaps pages, and
// the MutationObserver below picks them up regardless of how they got there.
//
// Card markup note: the design this was originally sketched against assumed
// the older ytd-video-meta-block/#metadata-line structure. Confirmed for
// real (home page, current YouTube) that's been replaced by a
// yt-lockup-view-model component with none of those classes -- but the
// channel link itself (an <a href="/@handle">) is still there and stable,
// so that's what both the channel-handle extraction AND the badge's
// insertion point key off, rather than any container class that might be
// mid-redesign again next month.

(function () {
  "use strict";

  var DEFAULT_BACKEND = "http://127.0.0.1:8420";
  var CARD_SELECTOR = "ytd-rich-item-renderer, ytd-video-renderer, " +
    "ytd-compact-video-renderer, ytd-grid-video-renderer";
  var BADGE_CLASS = "lc-difficulty-badge";

  function videoIdOf(card) {
    var a = card.querySelector('a[href*="/watch?v="]');
    if (!a) return null;
    try { return new URL(a.href, location.href).searchParams.get("v"); }
    catch (e) { return null; }
  }

  function channelLinkOf(card) {
    var anchors = card.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      var path;
      try { path = new URL(anchors[i].href, location.href).pathname; }
      catch (e) { continue; }
      if (path.indexOf("/@") === 0) return { el: anchors[i], handle: path.slice(1) };
    }
    return null;
  }

  var LABEL_CLASS = { "轻松": "lc-ok", "刚好": "lc-ok", "有挑战": "lc-mid", "偏难": "lc-bad", "超难": "lc-bad" };

  function paintBadge(card, anchorEl, data) {
    if (data.status !== "ok") return;  // nothing worth showing -- leave the card alone
    var badge = document.createElement("span");
    badge.className = BADGE_CLASS + " " + (LABEL_CLASS[data.label] || "");
    badge.textContent = data.label + " · " + data.density_per_min + "/分钟";
    if (data.source === "channel") badge.title = "按该频道其他视频估计";
    if (anchorEl) {
      (anchorEl.parentElement || anchorEl).insertAdjacentElement("afterend", badge);
    } else {
      card.appendChild(badge);  // no channel link found -- fall back to just anchoring on the card
    }
  }

  function ensureStyle() {
    if (document.getElementById("lc-difficulty-style")) return;
    var style = document.createElement("style");
    style.id = "lc-difficulty-style";
    style.textContent =
      "." + BADGE_CLASS + "{display:inline-block;margin-left:6px;padding:1px 7px;" +
      "border-radius:999px;font-size:11px;line-height:1.7;vertical-align:middle;" +
      "background:rgba(128,128,128,.16);color:inherit;}" +
      "." + BADGE_CLASS + ".lc-ok{background:rgba(70,170,110,.18);color:#2e8b52;}" +
      "." + BADGE_CLASS + ".lc-mid{background:rgba(210,150,50,.18);color:#a5741f;}" +
      "." + BADGE_CLASS + ".lc-bad{background:rgba(210,80,70,.18);color:#b23e30;}";
    document.head.appendChild(style);
  }

  function getBackendBase(cb) {
    try {
      chrome.storage.local.get("backendBase", function (stored) {
        cb((stored && stored.backendBase) || DEFAULT_BACKEND);
      });
    } catch (e) { cb(DEFAULT_BACKEND); }
  }

  // videoId -> { card, anchorEl, channelId } for whatever's currently queued
  // to ask the backend about, flushed as one batch request rather than one
  // fetch per card.
  var pending = new Map();
  var flushTimer = null;

  function flush(base) {
    if (pending.size === 0) return;
    var batch = new Map(pending);
    pending.clear();
    var items = Array.from(batch.entries()).map(function (e) {
      return { id: e[0], channel_id: e[1].channelId };
    });
    fetch(base + "/api/difficulty/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items }),
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        var result = json.result || {};
        batch.forEach(function (entry, videoId) {
          var data = result[videoId];
          if (data) paintBadge(entry.card, entry.anchorEl, data);
        });
      })
      .catch(function () { /* best effort -- next intersection retries */ });
  }

  var io = new IntersectionObserver(function (entries) {
    var any = false;
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var card = entry.target;
      if (card.querySelector("." + BADGE_CLASS)) return;  // already badged
      var videoId = videoIdOf(card);
      if (!videoId) return;
      var channel = channelLinkOf(card);
      pending.set(videoId, { card: card, anchorEl: channel ? channel.el : null, channelId: channel ? channel.handle : "" });
      any = true;
    });
    if (!any) return;
    getBackendBase(function (base) {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(function () { flush(base); }, 300);
    });
  }, { rootMargin: "200px" });

  ensureStyle();
  // Scanning on every single mutation record was the actual perf bug here:
  // on a /watch page, YouTube's own caption renderer rewrites its overlay's
  // text nodes on essentially every subtitle update (multiple times per
  // second during dialogue), and each of those churns through this observer
  // too since it's watching the whole subtree. A raw per-mutation
  // querySelectorAll(document) then runs at that same multi-times-a-second
  // rate for the entire page, which is enough to pin a CPU core solid on
  // slower machines -- confirmed as the cause of severe, sustained jank
  // (not just a one-off stutter) that scaled with how much caption text was
  // on screen.
  //
  // Throttled by wall-clock time, not just per-frame: a new video card is
  // something a human notices on a timescale of "did the page finish
  // loading", not frames, so there's no reason to ever scan faster than
  // human-perceptible regardless of how fast mutations are arriving. Two
  // tiers rather than one fixed interval: while a video is actively
  // playing, caption churn is at its worst *and* the user's attention is on
  // the video, not on newly-appeared badges elsewhere on the page, so this
  // backs off hard (SCAN_INTERVAL_PLAYING_MS). Once nothing's playing
  // (browsing the home/recommendations feed, the actual point of this
  // feature) it goes back to a snappier interval so freshly-scrolled-in
  // cards get badged promptly -- still well above single-digit-ms, since
  // nothing about a badge appearing needs to beat the eye's own reaction
  // time (SCAN_INTERVAL_IDLE_MS).
  var SCAN_INTERVAL_PLAYING_MS = 1000;
  var SCAN_INTERVAL_IDLE_MS = 100;

  function isVideoPlaying() {
    var v = document.querySelector("video");
    return !!(v && !v.paused && !v.ended && v.readyState > 2);
  }

  var lastScanAt = 0;
  var scanTimer = null;
  function scanForCards() {
    scanTimer = null;
    lastScanAt = Date.now();
    document.querySelectorAll(CARD_SELECTOR + ":not([data-lc-observed])").forEach(function (card) {
      card.setAttribute("data-lc-observed", "1");
      io.observe(card);
    });
  }
  function scheduleScan() {
    if (scanTimer) return; // a scan is already queued -- this mutation rides along with it
    var interval = isVideoPlaying() ? SCAN_INTERVAL_PLAYING_MS : SCAN_INTERVAL_IDLE_MS;
    var wait = Math.max(0, interval - (Date.now() - lastScanAt));
    scanTimer = setTimeout(scanForCards, wait);
  }

  // Scoped to the page-manager (the SPA's own content root) rather than
  // document.documentElement -- excludes the masthead/header, which has its
  // own independent churn (notification badges, live search suggestions)
  // that's just as irrelevant to "did a video card appear" as the caption
  // overlay is. Falls back to documentElement if that element isn't there
  // yet (observed once at script-start, before YouTube's custom elements
  // are guaranteed to have mounted).
  var observeRoot = document.querySelector("ytd-page-manager") || document.documentElement;
  new MutationObserver(scheduleScan)
    .observe(observeRoot, { childList: true, subtree: true });
})();
