// Service worker: not subject to page CSP or CORS, so this is where the
// network calls happen.
//
// content.js and the tutor-panel.js loader below both run in MAIN world (see
// the executeScript calls), so they share `window` with youtube.com's own
// scripts -- required for tutor-panel.js to read window.__englishTutorApiBase
// / window.__englishTutorYouTube the same way it already does on
// static/youtube.html.
//
// Getting here took four wrong turns, worth recording so nobody re-tries them:
//   1. `func: (src) => eval(src)` in MAIN world -- blocked by youtube.com's
//      Trusted Types policy ("violates this document's Trusted Type
//      assignment requirements").
//   2. The same eval, moved to isolated world to dodge Trusted Types -- ran
//      into a *different* wall: "Evaluating a string as JavaScript violates
//      ... 'unsafe-eval' is not an allowed source of script" (isolated world
//      escapes Trusted Types but not the script-src eval keyword).
//   3. A plain `<script src="http://127.0.0.1:8420/static/tutor-panel.js">`
//      tag -- worked on the machine this was first tried on (its CSP
//      happened to allowlist localhost, probably via some other installed
//      extension hardening page CSPs), but that's not something to depend
//      on in general: a *remote* script source is still checked against the
//      page's own script-src.
//   4. A `<script>` element with `.src` set to a `chrome.runtime.getURL()`
//      (chrome-extension://) URL, modeled on how the open-source asbplayer
//      extension (https://github.com/asbplayer/asbplayer) injects into
//      YouTube/Netflix/Disney+/etc -- chrome-extension:// script sources are
//      genuinely exempt from a page's script-src, but this page's Trusted
//      Types policy turned out to *also* cover the `HTMLScriptElement.src`
//      DOM sink itself ("This document requires 'TrustedScriptURL'
//      assignment"), independent of what URL scheme was being assigned.
// What actually works: chrome.scripting.executeScript's `files:` option
// (used below) is a privileged extension API call, not a DOM sink -- it
// never touches HTMLScriptElement.src or eval, so neither script-src nor any
// Trusted Types sink applies to it at all. This is the same mechanism
// content.js already loads through further down. The tradeoff: tutor-panel.js
// has to be a real file bundled in this extension, not fetched live from the
// backend on every load like the other three delivery contexts
// (standalone.html, youtube.html, Jellyfin injection) get to do -- editing
// static/tutor-panel.js for this path means re-copying it to
// extension/tutor-panel.js too.

const DEFAULT_BACKEND = "http://127.0.0.1:8420";
const WATCH_URL_FILTER = [{ hostEquals: "www.youtube.com", pathEquals: "/watch" }];

async function getBackendBase() {
  const stored = await chrome.storage.local.get("backendBase");
  return stored.backendBase || DEFAULT_BACKEND;
}

async function isPanelLoaded(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => !!window.__englishTutorPanelLoaded,
  });
  return !!result;
}

async function setApiBase(tabId, base) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (b) => { window.__englishTutorApiBase = b; },
    args: [base],
  });
}

async function runContentBridge(tabId) {
  // Re-run on every navigation: it re-checks the video id and, if it
  // changed, tells the backend and re-dispatches english-tutor:source-changed.
  // Cheap and idempotent when the video hasn't actually changed (see the
  // `id === window.__lingocueLastVideoId` short-circuit in content.js).
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["content.js"],
  });
}

async function injectPanelIfNeeded(tabId) {
  if (await isPanelLoaded(tabId)) return;
  // files:, not a manually-created <script> element -- Trusted Types turned
  // out to also cover HTMLScriptElement.src assignment itself (not just
  // eval/script-src), regardless of what URL scheme it's set to. files:
  // injection is a privileged extension API call, not a DOM sink, so it
  // never touches that check at all -- same mechanism content.js above
  // already loads through successfully.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["tutor-panel.js"],
  });
}

async function handle(tabId) {
  try {
    const base = await getBackendBase();
    await setApiBase(tabId, base);
    await runContentBridge(tabId);
    await injectPanelIfNeeded(tabId);
  } catch (e) {
    // Tab navigated away/closed mid-injection, or the extension lacks
    // permission for this origin yet -- neither is worth surfacing to the
    // user, but worth keeping in the console for whoever's debugging next.
    console.error("[lingocue] injection failed", e);
  }
}

// Fresh loads and reloads.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !/^https:\/\/www\.youtube\.com\/watch/.test(tab.url)) return;
  handle(tabId);
});

// YouTube is a single-page app; switching videos from a recommendation or
// the up-next autoplay never fires a normal navigation/reload, only a
// pushState. This is the event YouTube's own player dispatches for that.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  handle(details.tabId);
}, { url: WATCH_URL_FILTER });
