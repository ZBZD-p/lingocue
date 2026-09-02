
  async function boot() {
    await loadMarked();
    if (window.marked) marked.setOptions({ breaks: true, gfm: true });

    const host = document.createElement("div");
    host.id = "english-tutor-host";
    const root = host.attachShadow({ mode: "open" });

    let css = "";
    try {
      css = await (await fetch(`${API}/static/panel.css`)).text();
    } catch (e) {
      console.error("[tutor] 样式加载失败，后端没启动？", e);
    }
    root.innerHTML = `<style>${css}</style>${MARKUP}`;

    // Mounted on <html>, not <body>, so the squeeze rule below (which
    // targets body) can't shrink the panel along with Jellyfin's UI.
    document.documentElement.appendChild(host);

    const squeeze = document.createElement("style");
    squeeze.textContent = `
      /* Only above the phone breakpoint: on a narrow screen the panel is a
         full-screen overlay, so there is nothing to make room beside it and
         squeezing body would just shrink Jellyfin to nothing behind it. */
      @media (min-width: 701px) {
        html.english-tutor-open > body {
          width: calc(100% - var(--english-tutor-width, ${DEFAULT_WIDTH}px)) !important;
          overflow-x: hidden;
          /* Jellyfin positions its player, header and drawer with
             position:fixed, which resolves against the viewport and would
             happily sit under the panel no matter how narrow body gets. A
             transformed ancestor becomes the containing block for its fixed
             descendants, so this one declaration is what actually makes them
             respect the reduced width. */
          transform: translateZ(0);
        }
      }
    `;
    document.head.appendChild(squeeze);

    const savedWidth = parseInt(localStorage.getItem(WIDTH_KEY), 10);
    setPanelWidth(Number.isFinite(savedWidth) ? savedWidth : DEFAULT_WIDTH);

    host.setAttribute("theme", localStorage.getItem(THEME_KEY) || "dark");

    const collapsePref = localStorage.getItem(COLLAPSE_KEY);
    // On a phone the panel covers the whole screen, so starting expanded
    // would hide the video behind it before the user asked for anything.
    const startCollapsed = collapsePref === null
      ? window.matchMedia("(max-width: 700px)").matches
      : collapsePref === "1";
    if (startCollapsed) host.setAttribute("hidden-panel", "");
    document.documentElement.classList.toggle(
      "english-tutor-open", !host.hasAttribute("hidden-panel")
    );
    init(host, root);
  }

  // ---- panel -------------------------------------------------------------

