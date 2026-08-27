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

// ---- cookie sync ----------------------------------------------------------
// yt-dlp's own `--cookies-from-browser` reads Chrome's cookie database
// directly off disk, which recent Chrome versions deliberately make
// unreliable on Windows (Chrome keeps it locked while running, and newer
// releases add "App-Bound Encryption" specifically to make that kind of
// external, non-interactive read hard -- the same technique credential
// -stealing malware relies on, so Chrome hardens against it on purpose).
// An extension asking for cookies through chrome.cookies.getAll() is a
// completely different, sanctioned path -- Chrome hands them over through
// its own API to whatever the user granted the "cookies" permission to,
// same as any cookie-export extension does. This keeps yt-dlp working
// through youtube.com's occasional "confirm you're not a bot" checks
// without giving up on Chrome or requiring a separate extension.
const COOKIE_SYNC_ALARM = "lingocue-cookie-sync";
const COOKIE_SYNC_PERIOD_MIN = 360; // 6h -- a YouTube session cookie is good for weeks; this just keeps the file from ever going stale long enough to matter.

function toNetscapeCookiesTxt(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# Written by the LingoCue extension -- do not edit."];
  for (const c of cookies) {
    // A leading dot means "this domain and all its subdomains" in the
    // Netscape format; chrome.cookies already prefixes non-host-only
    // cookies with one, so hostOnly is exactly the inverse of that flag.
    const domain = c.hostOnly ? c.domain.replace(/^\./, "") : (c.domain.startsWith(".") ? c.domain : `.${c.domain}`);
    const includeSubdomains = c.hostOnly ? "FALSE" : "TRUE";
    const secure = c.secure ? "TRUE" : "FALSE";
    // 0 is the conventional Netscape-format stand-in for "expires with the
    // session" -- there's no real expiry to report for those.
    const expiry = c.session ? 0 : Math.round(c.expirationDate || 0);
    lines.push([domain, includeSubdomains, c.path, secure, expiry, c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

async function syncYouTubeCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "youtube.com" });
    if (!cookies.length) {
      // Not an error -- getAll() resolves with an empty array rather than
      // rejecting when the extension lacks host permission for the
      // requested domain, so a silent `return` here would look identical to
      // "not signed into YouTube yet" and "the permission grant didn't take"
      // from the console. Logging it is what actually told us, the first
      // time this ever happened, that host_permissions needed to cover
      // *.youtube.com and not just www.youtube.com.
      console.log("[lingocue] cookie sync: chrome.cookies.getAll returned 0 cookies for youtube.com");
      return;
    }
    const base = await getBackendBase();
    await fetch(`${base}/api/youtube/cookies`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: toNetscapeCookiesTxt(cookies),
    });
    await chrome.storage.local.set({ lastCookieSyncAt: Date.now() });
    console.log(`[lingocue] synced ${cookies.length} youtube.com cookies`);
  } catch (e) {
    // Backend not running, or the extension lost host permission for
    // youtube.com -- neither is worth surfacing beyond the console; the
    // next scheduled sync (or the next video load, see below) tries again.
    console.error("[lingocue] cookie sync failed", e);
  }
}

// onInstalled/onStartup below are the "keep it fresh" path, but neither is
// guaranteed to actually fire for what most people mean by "I just enabled
// this" -- manually clicking Reload on an unpacked extension in
// chrome://extensions doesn't reliably raise onInstalled (reports of this
// vary by Chrome version), and onStartup only fires on a real browser
// launch, not a reload. So this is also checked opportunistically on every
// video load (see handle() below) -- throttled here, rather than in the
// caller, so every call site gets the same "don't sync more than once an
// hour" rule for free without having to remember to add it themselves.
const OPPORTUNISTIC_SYNC_MIN_GAP_MS = 60 * 60 * 1000;

async function maybeSyncYouTubeCookies() {
  const { lastCookieSyncAt } = await chrome.storage.local.get("lastCookieSyncAt");
  if (lastCookieSyncAt && Date.now() - lastCookieSyncAt < OPPORTUNISTIC_SYNC_MIN_GAP_MS) return;
  await syncYouTubeCookies();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COOKIE_SYNC_ALARM) syncYouTubeCookies();
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(COOKIE_SYNC_ALARM, { periodInMinutes: COOKIE_SYNC_PERIOD_MIN });
  syncYouTubeCookies();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(COOKIE_SYNC_ALARM, { periodInMinutes: COOKIE_SYNC_PERIOD_MIN });
  syncYouTubeCookies();
});

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
  // marked.min.js first: tutor-panel.js's own loadMarked() tries to fetch it
  // from the backend via a plain <script src>, which hits the exact same
  // wall tutor-panel.js itself used to (see the file-header comment) -- on
  // one real page the CSP encountered didn't even allowlist localhost for
  // script-src at all, Trusted Types aside. Pre-loading it here the same
  // privileged way means window.marked already exists by the time
  // loadMarked() runs, so it short-circuits before ever touching that
  // script tag. Bundled as a real file for the same reason tutor-panel.js
  // is (see below) -- it's a third-party library that essentially never
  // changes, so the "re-copy on update" tradeoff barely applies here.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["marked.min.js"],
  });
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
    maybeSyncYouTubeCookies(); // not awaited -- a slow/failed sync shouldn't hold up injection
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
