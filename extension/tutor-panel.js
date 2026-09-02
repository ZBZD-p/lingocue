/*
 * English tutor panel, injected into Jellyfin's web UI.
 *
 * Loaded by a single <script> tag added to Jellyfin's own index.html. Running
 * inside Jellyfin's page (rather than beside it in an iframe) is what makes
 * playback tracking trivial: the real <video> element is right there, so
 * position comes from reading it directly instead of polling an API and
 * fighting cross-origin restrictions.
 *
 * Everything renders into a shadow root so Jellyfin's global stylesheet and
 * this panel's styles can't interfere with each other in either direction.
 */
(function () {
  "use strict";

  if (window.__englishTutorPanelLoaded) return;
  window.__englishTutorPanelLoaded = true;

  // A host page enforcing Trusted Types (seen on youtube.com, likely via
  // some other installed extension hardening page CSPs, not YouTube's own
  // default) blocks every plain-string assignment to innerHTML/script.src/
  // eval throughout this file -- there are too many of those to individually
  // rewrite to use a policy object. A policy literally named "default" is a
  // documented Trusted Types escape hatch for exactly this: once it exists,
  // the browser runs it automatically on any raw string handed to a
  // protected sink, so every existing `el.innerHTML = "..."` etc below keeps
  // working unchanged. Registering it this early, before any sink is ever
  // touched, is what makes that blanket coverage work. If the page's CSP
  // also restricts which policy names may be created, this throws and is
  // swallowed -- those sinks will keep failing, same as before this existed.
  if (window.trustedTypes && trustedTypes.createPolicy && !trustedTypes.defaultPolicy) {
    try {
      trustedTypes.createPolicy("default", {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
    } catch (e) { /* trusted-types directive doesn't allow this name -- nothing more to do here */ }
  }

  // Pages served by the backend itself (the standalone and YouTube views)
  // declare their own origin, which keeps them working on whatever port they
  // happen to be reached on. Injected into Jellyfin there is nothing to
  // declare: that page is served on :8096 by a different process, so the port
  // is spelled out -- while the host still comes from wherever the page was
  // loaded, because a literal 127.0.0.1 would mean "the phone itself" on a
  // phone.
  const API = window.__englishTutorApiBase
    || `${location.protocol}//${location.hostname}:8420`;
  // Stable per browser tab (sessionStorage, unlike localStorage, is never
  // shared between tabs even on the same origin) so the backend can tell
  // this tab's video apart from whatever's playing in another one -- see
  // playback.py's module docstring. content.js generates the same id
  // independently for /api/youtube/watch, since it's a separately-injected
  // script and can't assume load order against this one.
  //
  // Deliberately not crypto.randomUUID(): that's gated to secure contexts
  // (https, or http on localhost/127.0.0.1 specifically), and Jellyfin is
  // routinely reached over plain http on a LAN hostname or IP -- calling it
  // there throws, and since this ran before anything else on the page, that
  // exception took the whole panel down with it rather than just leaving
  // tabs unidentified. This ID is only ever compared for equality, never
  // trusted as unguessable, so Math.random() is plenty.
  const TAB_ID = (() => {
    const fresh = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    try {
      let id = sessionStorage.getItem("lingocueTabId");
      if (!id) { id = fresh(); sessionStorage.setItem("lingocueTabId", id); }
      return id;
    } catch (e) {
      return fresh(); // storage blocked (private browsing etc.) -- unique for this load, at least
    }
  })();
  const PLAYBACK_SESSION_ID = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const HISTORY_KEY = "english-tutor-chat-v1";
  const COLLAPSE_KEY = "english-tutor-collapsed";
  const WIDTH_KEY = "english-tutor-width";
  const THEME_KEY = "english-tutor-theme";
  const DEFAULT_WIDTH = 440;
  const MIN_WIDTH = 320;
  const MAX_WIDTH = 1000;

  const MODEL_OPTIONS = [
    { value: "", label: "模型：默认" },
    { value: "sonnet", label: "Sonnet 5（默认，均衡）" },
    { value: "opus", label: "Opus 5（最强，更贵更慢）" },
    { value: "haiku", label: "Haiku 4.5（快，便宜）" },
    { value: "fable", label: "Fable 5" },
  ];

  const EFFORT_OPTIONS = [
    { value: "", label: "思考程度：默认" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "很高" },
    { value: "max", label: "最高" },
  ];

  // `default: true` marks the tier populateSelect falls back to when nothing
  // is saved yet -- see its use below, distinct from array order so the
  // dropdown can still list small-to-large while defaulting to the top.
  const SUB_SIZE_OPTIONS = [
    { value: "16px", label: "小" },
    { value: "20px", label: "中" },
    { value: "24px", label: "大" },
    { value: "28px", label: "更大" },
    { value: "32px", label: "最大", default: true },
  ];

  // Figtree (see panel.css's @font-face) is a variable font whose weight
  // axis only spans 400-700 -- values outside that range just clamp to the
  // nearest end, so there's no point offering them here.
  const SUB_WEIGHT_OPTIONS = [
    { value: "400", label: "常规" },
    { value: "600", label: "半粗", default: true },
    { value: "700", label: "加粗" },
  ];

  const SECONDARY_LANG_OPTIONS = [
    { value: "", label: "关闭" },
    { value: "zh", label: "中文（中英对照）" },
  ];

  const THEME_OPTIONS = [
    { value: "dark", label: "深色" },
    { value: "light", label: "浅色" },
  ];

  // First entry is the default (see populateSelect), so this ships on.
  const WORD_HIGHLIGHT_OPTIONS = [
    { value: "on", label: "开" },
    { value: "off", label: "关" },
  ];

  const WORD_LIFT_OPTIONS = [
    { value: "on", label: "开", default: true },
    { value: "off", label: "关" },
  ];

  // Off by default -- unlike wordHighlight above, this depends on a
  // vocabulary-size estimate that starts at a guessed bootstrap value (see
  // knowledge.DEFAULT_VOCAB_SIZE) until the user actually takes the test,
  // so it's opt-in rather than shipping on for everyone.
  const VOCAB_HIGHLIGHT_OPTIONS = [
    { value: "off", label: "关" },
    { value: "on", label: "开" },
  ];

  const DEVELOPER_MODE_OPTIONS = [
    { value: "off", label: "关" },
    { value: "on", label: "开" },
  ];

  // DeepSeek-only -- Claude's extended thinking has no "off" state exposed
  // through the CLI's --effort flag, so this doesn't belong on the shared
  // 思考程度 dropdown (see its showWhen).
  const THINKING_OPTIONS = [
    { value: "on", label: "开" },
    { value: "off", label: "关" },
  ];

  // Everything on the settings page is declared here and rendered by one
  // generic pass, so adding a setting later means adding an entry rather
  // than touching markup, styles and wiring in three places. A setting that
  // has to take effect the moment it changes (rather than being read when
  // it's next needed) also needs an entry in SETTING_HANDLERS inside boot().
  const ENGINE_OPTIONS = [
    { value: "deepseek", label: "DeepSeek（默认，更快，需要在下面配置 key）", default: true },
    { value: "claude", label: "Claude Code（需要安装并登录 CLI）" },
  ];

  const SETTINGS_SECTIONS = [
    {
      key: "conversation",
      label: "AI 对话",
      hint: "选择对话引擎，并调整回答风格。",
    },
    {
      key: "subtitles",
      label: "字幕阅读",
      hint: "控制字幕的显示方式和逐词阅读效果。",
    },
    {
      key: "learning",
      label: "生词学习",
      hint: "决定哪些词会在字幕中作为生词提示。",
    },
    {
      key: "developer",
      label: "开发者选项",
      hint: "用于排查掌握度数据，普通使用不需要打开。",
    },
    {
      key: "appearance",
      label: "界面外观",
      hint: "调整面板的配色主题。",
    },
  ];

  const SETTINGS = [
    {
      key: "engine",
      section: "conversation",
      label: "对话引擎",
      hint: "Claude Code 每次对话有约 13 秒的固定启动开销；DeepSeek 是直接的 API 调用，没有这层开销，明显更快。" +
        "换了不会丢当前对话历史（会分别记各自的），但两边的回复不会共享上下文。",
      options: ENGINE_OPTIONS,
      storageKey: "english-tutor-engine",
    },
    {
      key: "deepseekKey",
      section: "conversation",
      label: "DeepSeek API Key",
      hint: "存在本地配置文件里，不会显示已保存的内容。",
      type: "text",
      inputType: "password",
      placeholder: "sk-...",
      storageKey: "english-tutor-deepseek-key",
      showWhen: (engine) => engine === "deepseek",
    },
    {
      key: "deepseekModel",
      section: "conversation",
      label: "DeepSeek 模型",
      hint: "留空默认用 deepseek-v4-flash（快，均衡）。深度推理可以填 deepseek-v4-pro。",
      type: "text",
      inputType: "text",
      placeholder: "deepseek-v4-flash",
      storageKey: "english-tutor-deepseek-model",
      showWhen: (engine) => engine === "deepseek",
    },
    {
      key: "deepseekThinking",
      section: "conversation",
      label: "DeepSeek 思考模式",
      hint: "开启时会先想再答（回复里能看到思考过程），关闭更快但准确度可能下降。" +
        "关闭时下面的思考程度设置对 DeepSeek 不生效。",
      options: THINKING_OPTIONS,
      storageKey: "english-tutor-deepseek-thinking",
      showWhen: (engine) => engine === "deepseek",
    },
    {
      key: "model",
      section: "conversation",
      label: "AI 模型",
      hint: "换模型不会中断当前对话。",
      options: MODEL_OPTIONS,
      storageKey: "english-tutor-model",
      showWhen: (engine) => engine !== "deepseek",
    },
    {
      key: "effort",
      section: "conversation",
      label: "思考程度",
      hint: "越高回答越细致，但更慢也更贵。解释语法/语境时调高比较值得。" +
        "两边引擎共用这一个设置，但各自的默认不同：Claude 留空按中等算；" +
        "DeepSeek 留空则用它自己的默认强度（高），且不区分中/很高，都按高处理。",
      options: EFFORT_OPTIONS,
      storageKey: "english-tutor-effort",
    },
    {
      key: "customPrompt",
      section: "conversation",
      label: "自定义提示词",
      hint: "追加在默认设定后面，不会替换掉工具调用相关的说明。留空则不变。下一条消息开始生效。",
      type: "textarea",
      placeholder: "比如：多用生活化的例句；语法解释尽量简短，除非我追问。",
      storageKey: "english-tutor-custom-prompt",
    },
    {
      key: "subSize",
      section: "subtitles",
      label: "字幕字号",
      hint: "只影响字幕卡片，不改对话区。",
      options: SUB_SIZE_OPTIONS,
      storageKey: "english-tutor-sub-size",
    },
    {
      key: "subWeight",
      section: "subtitles",
      label: "字幕粗细",
      hint: "只影响字幕卡片，不改对话区。",
      options: SUB_WEIGHT_OPTIONS,
      storageKey: "english-tutor-sub-weight",
    },
    {
      key: "secondaryLang",
      section: "subtitles",
      label: "副字幕",
      hint: "在每句英文下面显示对应的中文。第一次开启要再扫一遍视频提取中文轨（大文件约半分钟），英文会先显示出来。",
      options: SECONDARY_LANG_OPTIONS,
      storageKey: "english-tutor-secondary-lang",
    },
    {
      key: "wordHighlight",
      section: "subtitles",
      label: "逐词高亮",
      hint: "当前这句跟着语音一个词一个词点亮，已经念过的保持亮色。" +
        "只有 YouTube 自动字幕带逐词时间，人工字幕和本地视频没有这个数据，会自动跳过。",
      options: WORD_HIGHLIGHT_OPTIONS,
      storageKey: "english-tutor-word-highlight",
    },
    {
      key: "wordLiftAnimation",
      section: "subtitles",
      label: "逐词上移动画",
      hint: "逐词高亮时让当前单词轻微上移并回弹。关闭后仍保留颜色高亮。",
      options: WORD_LIFT_OPTIONS,
      storageKey: "english-tutor-word-lift-animation",
    },
    {
      key: "vocabHighlight",
      section: "learning",
      label: "生词高亮",
      hint: "按你的词汇量测试结果（没测过就按默认水平），把字幕里大概率不认识的词标出来。" +
        "人名地名这类专有名词不算在内。",
      options: VOCAB_HIGHLIGHT_OPTIONS,
      storageKey: "english-tutor-vocab-highlight",
    },
    {
      key: "developerMode",
      section: "developer",
      label: "开发者模式",
      hint: "打开后可以启用用于排查的掌握度诊断信息。",
      options: DEVELOPER_MODE_OPTIONS,
      storageKey: "english-tutor-developer-mode",
    },
    {
      key: "showPKnown",
      section: "developer",
      label: "显示 p_known",
      hint: "在词汇弹窗中显示掌握度数值，以及它来自真实证据还是先验估算。",
      options: DEVELOPER_MODE_OPTIONS,
      storageKey: "english-tutor-show-p-known",
    },
    {
      key: "theme",
      section: "appearance",
      label: "外观",
      hint: "切换后立即生效。",
      options: THEME_OPTIONS,
      storageKey: "english-tutor-theme",
    },
  ];

  const THINKING_VERBS = [
    "Pondering", "Contemplating", "Percolating", "Noodling", "Simmering",
    "Mulling", "Ruminating", "Cogitating", "Marinating", "Deliberating",
    "Processing", "Puzzling", "Musing", "Reflecting",
  ];

  // Small inline-SVG icon set, used instead of emoji: emoji glyphs render as
  // empty boxes on hosts without a color-emoji font installed (this panel
  // runs inside Jellyfin's Chromium-based webviews on all sorts of devices),
  // while an inline SVG always renders identically.
  const ICONS = {
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.1-5.4A8.5 8.5 0 1 1 21 11.5z"/>',
    subs: '<rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="M7 14h4M14 14h3"/>',
    vocab: '<path d="M6 3h12a1 1 0 0 1 1 1v16l-7-4-7 4V4a1 1 0 0 1 1-1z"/>',
    settings: '<path d="M4 8h9M18 8h2M4 16h3M12 16h8"/><circle cx="15.5" cy="8" r="2"/><circle cx="9.5" cy="16" r="2"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    chevron: '<path d="M14 6l-6 6 6 6"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
    star: '<path fill="currentColor" stroke="none" d="M12 2.5l2.9 5.88 6.5.94-4.7 4.58 1.1 6.47L12 17.27l-5.8 3.1 1.1-6.47-4.7-4.58 6.5-.94z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 1 1 4.2 2.73c-.9.42-1.3 1-1.3 1.77"/><line x1="12" y1="17" x2="12" y2="17.01"/>',
    retry: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
    repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    spinner: '<circle cx="12" cy="12" r="9" opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9"/>',
    speaker: '<path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 8a5 5 0 0 1 0 8"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    jump: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  };
  function icon(name, size) {
    return `<svg class="icon" width="${size || 16}" height="${size || 16}" viewBox="0 0 24 24" ` +
      `fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  }

  const MARKUP = `
    <button class="toggle" title="收起/展开" aria-label="收起/展开面板">${icon("chevron")}</button>
    <div class="resizer" title="拖动调整宽度"></div>
    <div class="shell">
      <div class="topbar">
        <div class="tabs">
          <button class="tab-btn active" data-page="chat" title="对话">${icon("chat")}<span class="tab-label">对话</span><span class="tab-dot"></span></button>
          <button class="tab-btn" data-page="subs" title="字幕">${icon("subs")}<span class="tab-label">字幕</span><span class="tab-dot"></span></button>
          <button class="tab-btn" data-page="vocab" title="生词本">${icon("vocab")}<span class="tab-label">生词本</span><span class="tab-dot"></span></button>
          <button class="tab-btn" data-page="phrases" title="短语">${icon("star")}<span class="tab-label">短语</span><span class="tab-dot"></span></button>
          <button class="tab-btn" data-page="quiz" title="抽查">${icon("repeat")}<span class="tab-label">抽查</span><span class="tab-dot"></span></button>
          <button class="tab-btn" data-page="settings" title="设置">${icon("settings")}<span class="tab-label">设置</span><span class="tab-dot"></span></button>
        </div>
        <div class="difficulty-badge" id="difficultyBadge" hidden></div>
        <button id="newChatBtn" class="new-chat-btn" title="开始新对话" aria-label="开始新对话">${icon("plus")}</button>
        <div class="preview-bar" id="previewBar" hidden>
          <span class="preview-bar-text" id="previewBarText"></span>
          <div class="preview-bar-btns">
            <button class="preview-btn primary" id="previewStartBtn">花 30 秒过一遍</button>
            <button class="preview-btn" id="previewSkipBtn">直接看</button>
          </div>
        </div>
      </div>
      <div class="body">
        <div class="page active" id="chatPage"><div class="chat" id="chat"></div></div>
        <div class="page" id="subsPage">
          <div class="subs-note" id="subsNote" hidden></div>
          <div class="subs-scroll" id="subsScroll"></div>
          <div class="subs-empty" id="subsEmpty">开始播放视频后，这里会显示字幕卡片。</div>
          <div class="subs-float-bar">
            <div class="loop-pill-wrap" id="loopPillWrap" hidden>
              <div class="loop-pill" id="loopPill">
                <span class="loop-pill-icon">${icon("repeat")}</span>
                <span id="loopPillText"></span>
                <button class="loop-pill-stop" id="loopStopBtn" title="停止循环" aria-label="停止循环">${icon("close")}</button>
              </div>
              <div class="loop-hint">点其他句子可以扩大/缩小循环范围</div>
            </div>
          </div>
        </div>
        <div class="page" id="vocabPage">
          <div class="vocab-list" id="vocabList">
            <div class="vocab-empty" id="vocabEmpty">还没有生词。在字幕里把鼠标放到单词上，点"存生词"。</div>
          </div>
        </div>
        <div class="page" id="phrasesPage">
          <div class="vocab-list" id="phraseList">
            <div class="vocab-empty" id="phraseEmpty">还没有收藏的短语。跟 AI 聊字幕的时候，它觉得有值得记的短语会主动推荐，你在对话里点"收藏"就行。</div>
          </div>
        </div>
        <div class="page" id="quizPage">
          <div class="vocab-quiz" id="vocabQuiz"></div>
        </div>
        <div class="page" id="settingsPage">
          <div class="settings-list" id="settingsList">
            <section class="settings-section settings-diagnostic">
              <div class="settings-section-heading">
                <h2>播放状态</h2>
                <p>诊断字幕和播放同步问题时查看。</p>
              </div>
              <div class="settings-section-items">
                <div class="setting-row setting-row-diagnostic">
                  <div class="context-bar" id="contextBar">还没开始播放</div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
      <div class="composer" id="composer">
        <div class="composer-inner">
          <textarea id="input" rows="2" placeholder="问点什么，比如：刚才那句里 'brace yourself' 是什么意思？"></textarea>
          <button id="sendBtn" title="发送" aria-label="发送">${icon("send")}</button>
        </div>
      </div>
      <div class="word-popup" id="wordPopup">
        <div class="word-popup-def" id="wordPopupDef"></div>
        <div class="word-popup-def" id="wordPopupPKnown" hidden></div>
        <div class="word-popup-actions">
          <button class="word-popup-speak" title="朗读">${icon("speaker")}</button>
          <button class="word-popup-save">${icon("star")} 存生词</button>
          <button class="word-popup-ask">${icon("help")} 问一下</button>
        </div>
      </div>
    </div>
    <div class="preview-overlay" id="previewOverlay" hidden></div>
  `;

  // ---- bootstrap ---------------------------------------------------------

  function loadMarked() {
    return new Promise((resolve) => {
      if (window.marked) return resolve();
      try {
        const s = document.createElement("script");
        const url = `${API}/static/marked.min.js`;
        // Not relying on the "default" Trusted Types policy registered
        // above for this one: only one "default" policy can exist per
        // document, so if the host page (or another extension) already
        // registered its own before this ran, ours was skipped and
        // whatever's already there wins -- and it may well implement
        // createHTML (which is why innerHTML elsewhere in this file still
        // works under Trusted Types) without ever implementing
        // createScriptURL, since its own code likely never needed to build
        // a URL from a string. A policy under our own name is ours
        // regardless of what else is registered as default.
        if (window.trustedTypes && trustedTypes.createPolicy) {
          try {
            const policy = trustedTypes.createPolicy("english-tutor-marked", {
              createScriptURL: (u) => u,
            });
            s.src = policy.createScriptURL(url);
          } catch (e) {
            s.src = url; // no Trusted Types enforcement, or this name is disallowed too
          }
        } else {
          s.src = url;
        }
        s.onload = resolve;
        // Markdown is a nicety; if it can't load, answers still render as text.
        s.onerror = resolve;
        document.head.appendChild(s);
      } catch (e) {
        // A host page enforcing Trusted Types can make the `s.src =`
        // assignment itself throw *synchronously* ("This document requires
        // 'TrustedScriptURL' assignment") -- onerror above only catches an
        // async load failure, not this. Uncaught, it would abort boot()
        // right here (this is its first await) and the whole panel would
        // silently never appear.
        resolve();
      }
    });
  }

  /** Width lives on <html> as a custom property: the panel inherits it into
   *  its shadow root, and the body-squeeze rule reads the same value, so the
   *  two can never drift apart. */
  function setPanelWidth(px) {
    const clamped = Math.min(Math.max(Math.round(px), MIN_WIDTH), MAX_WIDTH);
    document.documentElement.style.setProperty("--english-tutor-width", clamped + "px");
    return clamped;
  }

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

    // ---- helpers ----

    function installHelpers(ctx) {
      function fmt(ms) {
        if (ms == null || ms < 0) return "?";
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n) => String(n).padStart(2, "0");
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
      }

      function escapeHtml(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }

      function renderMarkdown(text) {
        if (!window.marked) return escapeHtml(text || "");
        try {
          return marked.parse(text || "");
        } catch (e) {
          return escapeHtml(text || "");
        }
      }

      function fmtElapsed(ms) {
        const total = Math.floor(ms / 1000);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
      }

      ctx.fns.fmt = fmt;
      ctx.fns.escapeHtml = escapeHtml;
      ctx.fns.renderMarkdown = renderMarkdown;
      ctx.fns.fmtElapsed = fmtElapsed;
    }
    installHelpers(ctx);

    // ---- dropdowns ----
    // Hand-rolled rather than <select>, because a native popup renders
    // outside the shadow root with none of these styles applied.
    function populateSelect(dropdownEl, options, storageKey, onChange) {
      const valueEl = dropdownEl.querySelector(".dropdown-value");
      const menuEl = dropdownEl.querySelector(".dropdown-menu");
      const itemEls = new Map();
      let currentValue = null;
      dropdownEl.setAttribute("aria-expanded", "false");
      menuEl.setAttribute("role", "listbox");

      function select(value, persist) {
        currentValue = value;
        const opt = options.find((o) => o.value === value);
        valueEl.textContent = opt ? opt.label : "";
        itemEls.forEach((el, v) => {
          const selected = v === value;
          el.classList.toggle("selected", selected);
          el.setAttribute("aria-selected", selected ? "true" : "false");
        });
        if (persist) localStorage.setItem(storageKey, value);
        // `persist` doubles as "a person just picked this", which lets a
        // handler tell a real change from the restore that happens at boot.
        if (onChange) onChange(value, persist);
      }

      options.forEach((opt) => {
        const el = document.createElement("div");
        el.className = "dropdown-item";
        el.setAttribute("role", "option");
        el.textContent = opt.label;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          select(opt.value, true);
          dropdownEl.classList.remove("open");
          dropdownEl.setAttribute("aria-expanded", "false");
        });
        menuEl.appendChild(el);
        itemEls.set(opt.value, el);
      });

      dropdownEl.addEventListener("click", () => {
        root.querySelectorAll(".dropdown.open").forEach((el) => {
          if (el !== dropdownEl) {
            el.classList.remove("open");
            el.setAttribute("aria-expanded", "false");
          }
        });
        const open = dropdownEl.classList.toggle("open");
        dropdownEl.setAttribute("aria-expanded", open ? "true" : "false");
      });

      dropdownEl.addEventListener("keydown", (e) => {
        const index = options.findIndex((option) => option.value === currentValue);
        if (e.key === "Escape") {
          dropdownEl.classList.remove("open");
          dropdownEl.setAttribute("aria-expanded", "false");
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const open = dropdownEl.classList.toggle("open");
          dropdownEl.setAttribute("aria-expanded", open ? "true" : "false");
          return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = (index + delta + options.length) % options.length;
        select(options[next].value, true);
        dropdownEl.classList.add("open");
        dropdownEl.setAttribute("aria-expanded", "true");
      });

      Object.defineProperty(dropdownEl, "value", { get: () => currentValue });

      const saved = localStorage.getItem(storageKey);
      const fallback = (options.find((o) => o.default) || options[0]).value;
      const initial = saved != null && options.some((o) => o.value === saved)
        ? saved : fallback;
      select(initial, false);
    }

    /** Subtitle size is a CSS variable rather than a class, for the same
     *  reason the panel width is one: the styles live in a shadow root, and
     *  a custom property set on <html> is the one thing that crosses that
     *  boundary. Clearing it hands each breakpoint its own default back. */
    function applySubSize(value) {
      const style = document.documentElement.style;
      if (value) style.setProperty("--english-tutor-sub-size", value);
      else style.removeProperty("--english-tutor-sub-size");
    }

    /** Same custom-property approach as applySubSize, and for the same
     *  reason: it has to cross the shadow-root boundary via <html>. */
    function applySubWeight(value) {
      const style = document.documentElement.style;
      if (value) style.setProperty("--english-tutor-sub-weight", value);
      else style.removeProperty("--english-tutor-sub-weight");
    }

    function applySubSizeAndInvalidate(value, isUserChange) {
      applySubSize(value);
      if (isUserChange && typeof invalidateVirtualMeasurements === "function") {
        invalidateVirtualMeasurements();
      }
    }

    function applySubWeightAndInvalidate(value, isUserChange) {
      applySubWeight(value);
      if (isUserChange && typeof invalidateVirtualMeasurements === "function") {
        invalidateVirtualMeasurements();
      }
    }

    /** Turning the second language on or off changes what the backend has to
     *  merge, so the cue list has to be refetched. Only on a real change --
     *  at boot the cards load lazily when the subtitle tab is first opened,
     *  and half the state this touches hasn't been declared yet. */
    function reloadForSecondary(value, isUserChange) {
      if (!isUserChange) return;
      resetSubtitleSession();
      subsNote.hidden = true;
      if (ctx.state.currentPage === "subs") loadSubtitleCues();
    }

    const wordHighlightOn = () => settingValue("wordHighlight") !== "off";
    const vocabHighlightOn = () => settingValue("vocabHighlight") === "on";
    const showPKnownOn = () => settingValue("developerMode") === "on" &&
      settingValue("showPKnown") === "on";

    /** Same refetch reasoning as reloadForSecondary above -- the per-word
     *  timings ride along in the cue payload and are only asked for when
     *  this is on, so flipping it changes the request. It also changes how
     *  often playback position has to be sampled (see startPositionPolling),
     *  which is why this isn't purely a render concern. */
    function reloadForWordHighlight(value, isUserChange) {
      if (!isUserChange) return;
      startPositionPolling();
      resetSubtitleSession();
      if (ctx.state.currentPage === "subs") loadSubtitleCues();
    }

    // No reload needed -- the cue text already loaded didn't change, only
    // whether it's decorated. Turning it on fetches once against what's
    // already showing; turning it off just strips the classes back out.
    //
    // isUserChange must gate this, same as the `engine` handler below --
    // populateSelect calls every handler once synchronously during the
    // settings-render loop to restore a saved value (persist=false), which
    // runs *before* settingValue is declared further down in init().
    // Confirmed for real: with this setting saved "on" from a previous
    // session, that restore call reached refreshVocabHighlight ->
    // vocabHighlightOn -> settingValue while it was still in its temporal
    // dead zone, threw, and since nothing past that point in init() ever
    // ran, no tab button ever got its click listener attached -- the whole
    // panel looked frozen, not just this feature.
    function toggleVocabHighlight(value, isUserChange) {
      if (!isUserChange) return;
      if (value === "on") {
        ctx.fns.refreshVocabHighlight();
      } else {
        ctx.fns.abortVocabHighlight();
        ctx.state.cueUnknownWords = [];
        ctx.fns.applyVocabHighlight();
        if (showPKnownOn()) {
          ctx.fns.refreshVocabHighlight();
        } else {
          ctx.state.cueWordScores = [];
          updateWordPopupPKnown();
        }
      }
    }

    function toggleDeveloperDiagnostics(value, isUserChange) {
      if (!isUserChange) return;
      if (showPKnownOn()) {
        ctx.fns.refreshVocabHighlight();
      } else {
        ctx.state.cueWordScores = [];
        updateWordPopupPKnown();
      }
    }

    // Settings whose effect is immediate rather than read-on-demand.
    // The key/model live in localStorage (so the field shows what you typed
    // last) but deepseek_chat.py runs as part of app.py, a separate process
    // that can't read the browser's localStorage -- so a change here also
    // has to reach the backend over HTTP, not just persist client-side.
    async function pushDeepSeekConfig() {
      const key = settingValue("deepseekKey");
      if (!key) return;  // nothing to save yet; don't overwrite a saved key with blank
      try {
        await fetch(`${API}/api/deepseek-config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: key,
            model: settingValue("deepseekModel") || undefined,
          }),
        });
      } catch (e) {
        // Best-effort: the field still has the value locally, and the next
        // successful save (or app.py restart picking up a manually-edited
        // config file) reconciles it. Not worth surfacing a chat-page error
        // for a settings-page network hiccup.
      }
    }

    // Only one engine's settings are ever relevant at a time (see each
    // setting's `showWhen` above) -- recomputed on every engine switch
    // rather than kept in sync incrementally, since it's just a handful of
    // rows and this way it can't drift out of sync with SETTINGS itself.
    function updateSettingVisibility() {
      const engine = settingValue("engine") || "";
      for (const setting of SETTINGS) {
        if (!setting.showWhen) continue;
        const row = settingRows.get(setting.key);
        if (row) row.hidden = !setting.showWhen(engine);
      }
    }

    const SETTING_HANDLERS = {
      subSize: applySubSizeAndInvalidate,
      subWeight: applySubWeightAndInvalidate,
      secondaryLang: reloadForSecondary,
      wordHighlight: reloadForWordHighlight,
      wordLiftAnimation: (value) => host.toggleAttribute("word-lift-off", value === "off"),
      vocabHighlight: toggleVocabHighlight,
      deepseekKey: pushDeepSeekConfig,
      deepseekModel: pushDeepSeekConfig,
      developerMode: toggleDeveloperDiagnostics,
      showPKnown: toggleDeveloperDiagnostics,
      theme: (value) => host.setAttribute("theme", value || "dark"),
      // Not called during the boot-time restore (isUserChange false) --
      // at that point the loop below hasn't reached the later rows yet
      // (engine is declared first in SETTINGS), so settingRows wouldn't
      // have them. The explicit call after the loop handles that initial
      // pass; this only needs to cover it changing again afterwards.
      engine: (value, isUserChange) => { if (isUserChange) updateSettingVisibility(); },
    };

    // Rendered from the SETTINGS declaration, and the resulting controls are
    // kept in a map so the rest of the panel reads values by key
    // (settingValue("model")) instead of holding element references.
    const settingControls = new Map();
    const settingRows = new Map();

    // A free-text field (the DeepSeek key/model) has no fixed option set, so
    // it can't go through populateSelect -- but it still needs to behave
    // like one from the outside: read via settingValue(), persisted to
    // localStorage, and able to fire a handler on a real change. Committing
    // on blur/Enter rather than every keystroke matters more here than for a
    // dropdown, since the handler for the key field makes a network request.
    function populateText(inputEl, setting) {
      const saved = localStorage.getItem(setting.storageKey) || "";
      inputEl.value = saved;
      let lastCommitted = saved;
      function commit() {
        const value = inputEl.value.trim();
        if (value === lastCommitted) return;
        lastCommitted = value;
        localStorage.setItem(setting.storageKey, value);
        const handler = SETTING_HANDLERS[setting.key];
        if (handler) handler(value, true);
      }
      inputEl.addEventListener("blur", commit);
      // Enter commits and blurs for a single-line <input>; a <textarea>
      // needs Enter to just type a newline, so only wire this for the former.
      if (setting.type !== "textarea") {
        inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { commit(); inputEl.blur(); } });
      }
      // No custom `.value` needed: <input>/<textarea> already have a native
      // one, which is exactly what settingValue(key) -> control.value
      // already reads for the dropdown case too -- same interface, no extra
      // plumbing.
    }

    const settingSections = new Map();
    const diagnosticSection = settingsList.querySelector(".settings-diagnostic");
    for (const section of SETTINGS_SECTIONS) {
      const sectionEl = document.createElement("section");
      sectionEl.className = "settings-section";
      sectionEl.dataset.section = section.key;

      const heading = document.createElement("div");
      heading.className = "settings-section-heading";
      const title = document.createElement("h2");
      title.textContent = section.label;
      heading.appendChild(title);
      if (section.hint) {
        const description = document.createElement("p");
        description.textContent = section.hint;
        heading.appendChild(description);
      }
      sectionEl.appendChild(heading);

      const items = document.createElement("div");
      items.className = "settings-section-items";
      sectionEl.appendChild(items);
      settingsList.insertBefore(sectionEl, diagnosticSection);
      settingSections.set(section.key, items);
    }

    for (const setting of SETTINGS) {
      const row = document.createElement("div");
      row.className = "setting-row";

      const label = document.createElement("div");
      label.className = "setting-label";
      label.textContent = setting.label;
      row.appendChild(label);

      let control;
      if (setting.type === "text" || setting.type === "textarea") {
        control = document.createElement(setting.type === "textarea" ? "textarea" : "input");
        if (setting.type === "text") control.type = setting.inputType || "text";
        control.setAttribute("aria-label", setting.label);
        control.placeholder = setting.placeholder || "";
        control.className = setting.type === "textarea" ? "setting-textarea" : "setting-text-input";
        row.appendChild(control);
        const items = settingSections.get(setting.section) || settingsList;
        items.appendChild(row);
        populateText(control, setting);
      } else {
        control = document.createElement("div");
        control.className = "dropdown";
        control.setAttribute("role", "combobox");
        control.setAttribute("tabindex", "0");
        control.setAttribute("aria-label", setting.label);
        control.setAttribute("aria-haspopup", "listbox");
        control.innerHTML = `<div class="dropdown-value"></div><div class="dropdown-menu"></div>`;
        row.appendChild(control);
        const items = settingSections.get(setting.section) || settingsList;
        items.appendChild(row);
        populateSelect(control, setting.options, setting.storageKey,
                       SETTING_HANDLERS[setting.key]);
      }

      if (setting.hint) {
        const hint = document.createElement("div");
        hint.className = "setting-hint";
        hint.textContent = setting.hint;
        row.appendChild(hint);
      }

      settingControls.set(setting.key, control);
      settingRows.set(setting.key, row);
    }

    const settingValue = (key) => {
      const control = settingControls.get(key);
      return control ? control.value : null;
    };
    updateSettingVisibility(); // initial pass -- covers a saved engine choice from a previous visit; needs settingValue, so after its declaration

    root.addEventListener("click", (e) => {
      if (!e.target.closest(".dropdown")) {
        root.querySelectorAll(".dropdown.open").forEach((el) => {
          el.classList.remove("open");
          el.setAttribute("aria-expanded", "false");
        });
      }
    });

    // ---- chat history ----

    function saveHistory() {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify({ sessionId, html: chatEl.innerHTML }));
      } catch (e) { /* quota/unavailable -- not worth surfacing */ }
    }

    (function restoreHistory() {
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        sessionId = data.sessionId || null;
        chatEl.innerHTML = data.html || "";
        chatEl.scrollTop = chatEl.scrollHeight;
        // Raw innerHTML restore doesn't bring event listeners back -- an
        // already-resolved phrase card has no buttons left to rewire (see
        // resolvePhraseSuggestionCard), but one the user never got to
        // click before reloading still needs its accept/decline handlers.
        chatEl.querySelectorAll(".phrase-suggestion-card:not(.phrase-suggestion-resolved)")
          .forEach(wirePhraseSuggestionCard);
      } catch (e) { /* corrupt/old format -- start fresh */ }
    })();

    // Streaming deltas (onThinkingDelta/onTextDelta below) never auto-scroll
    // at all -- constantly chasing the growing text mid-stream is exactly
    // the jitter this used to cause. addMessage/createAiMessage still jump
    // to the bottom once, unconditionally, for the new message they're
    // adding; finalize() below is the one mid-turn spot that still checks
    // nearBottom() first, so the one-time settle when a reply completes
    // doesn't yank someone back down if they'd scrolled up to re-read
    // something earlier in the conversation.
    const BOTTOM_THRESHOLD_PX = 80;
    const nearBottom = () =>
      chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < BOTTOM_THRESHOLD_PX;
    const toBottom = () => { chatEl.scrollTop = chatEl.scrollHeight; };

    // Same guard as the subtitle list's mousedown listener further down
    // (shares lastUserScrollAt/USER_SCROLL_QUIET_MS): a mousedown here means
    // the user is likely dragging to select a reply's text, and the
    // streaming re-render in onTextDelta below would wipe that selection out
    // on the very next token if it didn't back off.
    chatEl.addEventListener("mousedown", () => { lastUserScrollAt = Date.now(); }, { passive: true });

    function addMessage(role, text) {
      const div = document.createElement("div");
      div.className = `msg ${role}`;
      div.textContent = text;
      chatEl.appendChild(div);
      toBottom();
      saveHistory();
      return div;
    }

    /** A "save this phrase?" prompt the AI triggered via its suggest_phrase
     *  tool call -- built once per suggestion, appended into the AI message
     *  bubble it arrived in (see onPhraseSuggestion above). The phrase/
     *  meaning/subtitle live as data-* attributes on the card itself, not
     *  just in closures, because chat history is persisted as raw innerHTML
     *  (see saveHistory/restoreHistory) -- a still-pending card surviving a
     *  reload needs to be able to answer "what do I even save" from its own
     *  markup, since nothing else remembers evt past this call. */
    function buildPhraseSuggestionCard(evt) {
      const card = document.createElement("div");
      card.className = "phrase-suggestion-card";
      card.dataset.phrase = evt.phrase || "";
      card.dataset.meaning = evt.meaning || "";
      card.dataset.subtitle = evt.subtitle_text || "";
      const { video_url, timestamp_seconds } = youtubeJumpTarget();
      card.dataset.videoUrl = video_url || "";
      card.dataset.timestampSeconds = timestamp_seconds == null ? "" : String(timestamp_seconds);
      card.innerHTML = `
        <div class="phrase-suggestion-phrase">${ctx.fns.escapeHtml(evt.phrase || "")}</div>
        ${evt.meaning ? `<div class="phrase-suggestion-meaning">${ctx.fns.escapeHtml(evt.meaning)}</div>` : ""}
        ${evt.subtitle_text ? `<div class="phrase-suggestion-subtitle">"${ctx.fns.escapeHtml(evt.subtitle_text)}"</div>` : ""}
        <div class="phrase-suggestion-actions">
          <button class="phrase-suggestion-decline">不用了</button>
          <button class="phrase-suggestion-accept">${icon("star")} 收藏</button>
        </div>
      `;
      wirePhraseSuggestionCard(card);
      return card;
    }

    /** Attaches the accept/decline handlers to a still-pending card.
     *  Called both right after building one (above) and, for whatever
     *  wasn't resolved before the last reload, once over chat history after
     *  restoreHistory() repopulates chatEl -- raw innerHTML restore doesn't
     *  bring event listeners back on its own. Safe to call on an
     *  already-resolved card (querySelector just finds nothing and no-ops). */
    function wirePhraseSuggestionCard(card) {
      const acceptBtn = card.querySelector(".phrase-suggestion-accept");
      const declineBtn = card.querySelector(".phrase-suggestion-decline");
      if (!acceptBtn || !declineBtn) return;
      acceptBtn.addEventListener("click", async () => {
        acceptBtn.disabled = true;
        declineBtn.disabled = true;
        try {
          await fetch(`${API}/api/phrases`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              video_title: lastKnownVideoTitle,
              subtitle_text: card.dataset.subtitle,
              phrase: card.dataset.phrase,
              meaning: card.dataset.meaning,
              video_url: card.dataset.videoUrl || null,
              timestamp_seconds: card.dataset.timestampSeconds ? Number(card.dataset.timestampSeconds) : null,
            }),
          });
          resolvePhraseSuggestionCard(card, "已收藏");
        } catch (e) {
          acceptBtn.disabled = false;
          declineBtn.disabled = false;
        }
      });
      declineBtn.addEventListener("click", () => resolvePhraseSuggestionCard(card, "已忽略"));
    }

    /** Swaps the action buttons for a static resolved line -- baked into
     *  whatever gets saved to history right after, so a resolved card comes
     *  back from a reload with no buttons at all (nothing left to rewire,
     *  see wirePhraseSuggestionCard's early-return). */
    function resolvePhraseSuggestionCard(card, label) {
      const actions = card.querySelector(".phrase-suggestion-actions");
      if (actions) actions.outerHTML = `<div class="phrase-suggestion-resolved">${icon("check")} ${label}</div>`;
      card.classList.add("phrase-suggestion-resolved");
      saveHistory();
    }

    /**
     * Live "thinking" block for one AI turn: pulsing icon + rotating verb +
     * elapsed time while streaming, collapsing to "Thought for Ns" once the
     * answer starts arriving (thinking text stays available behind a toggle).
     */
    function createAiMessage(effortLabel) {
      const wrap = document.createElement("div");
      wrap.className = "msg ai";
      const status = document.createElement("div");
      status.className = "status-line";
      status.innerHTML = `<span class="pulse-icon">${icon("spinner")}</span><span class="status-text"></span>`;
      wrap.appendChild(status);

      const thinkingBox = document.createElement("details");
      thinkingBox.className = "thinking-box";
      thinkingBox.style.display = "none";
      thinkingBox.innerHTML = `<summary></summary><div class="thinking-content"></div>`;
      wrap.appendChild(thinkingBox);

      const content = document.createElement("div");
      content.className = "answer-content";
      wrap.appendChild(content);
      chatEl.appendChild(wrap);
      toBottom();

      const startTime = performance.now();
      let charCount = 0;
      let verbIndex = Math.floor(Math.random() * THINKING_VERBS.length);
      let latestTokens = null;
      let answerStarted = false;
      let finalized = false;
      let rawAnswer = "";

      function statusText() {
        const elapsed = ctx.fns.fmtElapsed(performance.now() - startTime);
        const n = latestTokens != null ? latestTokens : Math.round(charCount / 4);
        const tokens = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
        return `${THINKING_VERBS[verbIndex]}… (${elapsed} · ↓ ${tokens} tokens` +
          `${effortLabel ? ` · ${effortLabel}` : ""})`;
      }

      const tick = setInterval(() => {
        if (!finalized) status.querySelector(".status-text").textContent = statusText();
      }, 500);
      const verbTick = setInterval(() => {
        if (!finalized) verbIndex = (verbIndex + 1) % THINKING_VERBS.length;
      }, 2800);
      status.querySelector(".status-text").textContent = statusText();

      return {
        onThinkingDelta(text) {
          charCount += text.length;
          thinkingBox.style.display = "block";
          thinkingBox.querySelector(".thinking-content").textContent += text;
          status.querySelector(".status-text").textContent = statusText();
        },
        onTextDelta(text) {
          charCount += text.length;
          rawAnswer += text;
          if (!answerStarted) {
            answerStarted = true;
            const elapsed = ctx.fns.fmtElapsed(performance.now() - startTime);
            status.innerHTML =
              `<span class="pulse-icon done">${icon("check")}</span><span class="status-text">Thought for ${elapsed}</span>`;
            if (thinkingBox.querySelector(".thinking-content").textContent) {
              thinkingBox.querySelector("summary").textContent = "查看思考过程";
            } else {
              thinkingBox.style.display = "none";
            }
          }
          // Skip the rebuild while the user looks like they're mid-drag-select
          // in the chat -- rawAnswer keeps accumulating regardless, so the
          // next delta (or finalize, which always flushes) catches it up.
          if (Date.now() - lastUserScrollAt >= USER_SCROLL_QUIET_MS) {
            content.innerHTML = ctx.fns.renderMarkdown(rawAnswer);
          }
        },
        onPhraseSuggestion(evt) {
          // Appended straight to wrap, not content: content.innerHTML gets
          // fully overwritten on every text delta above, which would wipe
          // the card out the moment the next token arrives if it lived in
          // there instead. No toBottom() either, same reasoning as the
          // deltas -- a tool call happening mid-stream shouldn't yank the
          // view down.
          wrap.appendChild(buildPhraseSuggestionCard(evt));
          saveHistory();
        },
        onUsage(tokens) { if (tokens != null) latestTokens = tokens; },
        finalize(evt) {
          const stick = nearBottom();
          finalized = true;
          clearInterval(tick);
          clearInterval(verbTick);
          if (!answerStarted) {
            status.remove();
            rawAnswer = evt.reply || "(空回复)";
          } else if (evt.reply) {
            rawAnswer = evt.reply;
          }
          // Unconditional: onTextDelta may have skipped its own render while
          // the user was selecting text, so content.innerHTML can't be
          // trusted to already match rawAnswer here.
          content.innerHTML = ctx.fns.renderMarkdown(rawAnswer);
          if (evt.cost_usd != null) {
            const m = document.createElement("span");
            m.className = "meta";
            m.textContent = `本轮花费 $${evt.cost_usd.toFixed(4)}`;
            content.appendChild(m);
          }
          if (stick) toBottom();
          saveHistory();
        },
        error(message, onRetry) {
          finalized = true;
          clearInterval(tick);
          clearInterval(verbTick);
          if (status.parentNode) status.remove();
          // Keep whatever already streamed -- the error is what dropped
          // mid-stream, not a replacement for the text before it.
          const note = document.createElement("div");
          note.className = "error-note";
          note.textContent = answerStarted
            ? `⚠ 连接中断：${message}（上面的回答可能不完整）`
            : `⚠ 出错了：${message}`;
          wrap.appendChild(note);
          if (onRetry) {
            const btn = document.createElement("button");
            btn.className = "retry-btn";
            btn.innerHTML = `${icon("retry")} 重试`;
            btn.addEventListener("click", () => { btn.disabled = true; onRetry(); });
            wrap.appendChild(btn);
          }
          toBottom();
          saveHistory();
        },
      };
    }

    const TRANSIENT_ERROR_RE = /connection lost|network|econnreset|timeout|socket hang up/i;

    async function streamChat(text, ai) {
      try {
        const res = await fetch(`${API}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            session_id: sessionId,
            engine: settingValue("engine") || null,
            // The model dropdown is Claude-specific -- DeepSeek's own model
            // comes from deepseek_config.json instead, via the DeepSeek 模型
            // field -- but effort applies to both engines now.
            model: settingValue("engine") === "deepseek" ? null : (settingValue("model") || null),
            effort: settingValue("effort") || null,
            thinking: settingValue("engine") === "deepseek" ? settingValue("deepseekThinking") : null,
            custom_prompt: settingValue("customPrompt") || null,
          }),
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `请求失败（HTTP ${res.status}）`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let streamError = null;

        const handleLine = (line) => {
          if (!line.trim()) return;
          const evt = JSON.parse(line);
          switch (evt.type) {
            case "thinking_delta": ai.onThinkingDelta(evt.text || ""); break;
            case "text_delta": ai.onTextDelta(evt.text || ""); break;
            case "usage": ai.onUsage(evt.output_tokens); break;
            case "phrase_suggestion": ai.onPhraseSuggestion(evt); break;
            case "done": sessionId = evt.session_id || sessionId; ai.finalize(evt); break;
            case "error": streamError = evt.message || "未知错误"; break;
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          lines.forEach(handleLine);
        }
        if (buffer.trim()) handleLine(buffer);

        return streamError ? { ok: false, message: streamError } : { ok: true };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    }

    function currentEffortLabel() {
      const opt = EFFORT_OPTIONS.find((o) => o.value === settingValue("effort"));
      return opt && opt.value ? opt.label : null;
    }

    /** One chat turn, retrying once on a failure that looks transient. */
    async function runTurn(text, attempt = 1) {
      const ai = createAiMessage(currentEffortLabel());
      sendBtn.disabled = true;
      const result = await streamChat(text, ai);
      sendBtn.disabled = false;
      if (result.ok) return;
      if (TRANSIENT_ERROR_RE.test(result.message) && attempt < 2) {
        ai.error(`${result.message}，2 秒后自动重试…`);
        await new Promise((r) => setTimeout(r, 2000));
        await runTurn(text, attempt + 1);
      } else {
        ai.error(result.message, () => runTurn(text, 1));
      }
    }

    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = "";
      addMessage("user", text);
      runTurn(text);
    }

    sendBtn.addEventListener("click", sendMessage);
    // Propagation out of the panel is already stopped for every field at the
    // host level (see its own comment); this just handles the composer's
    // own Enter-to-send behavior.
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    newChatBtn.addEventListener("click", () => {
      sessionId = null;
      chatEl.innerHTML = "";
      localStorage.removeItem(HISTORY_KEY);
    });

    // ---- pages ----

    function installPages(ctx) {
      function switchPage(name) {
        ctx.state.currentPage = name;
        tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.page === name));
        Object.entries(pages).forEach(([k, el]) => el.classList.toggle("active", k === name));
        composerEl.hidden = name !== "chat";
        if (name === "subs" && subtitleCues.length === 0) loadSubtitleCues();
        if (name === "vocab") loadVocabList();
        if (name === "phrases") ctx.fns.loadPhraseList();
        // Own tab now (not a mode switched into from the vocab list), so
        // entering it always starts fresh at the "开始抽查" prompt rather than
        // trying to resume whatever card a previous visit left off on --
        // same "just reload" philosophy as the vocab list above.
        if (name === "quiz") loadQuizStart();
      }
      tabBtns.forEach((b) => b.addEventListener("click", () => switchPage(b.dataset.page)));
      ctx.fns.switchPage = switchPage;
    }
    installPages(ctx);

    // ---- subtitle cards ----

    let subtitleCues = [];
    let subtitleIsPartial = false;
    let subtitleCueSignature = "";
    // Keep direct references to rendered cards and their word spans. The
    // subtitle list can contain thousands of cards; querying the whole DOM
    // on every playback tick made the cost grow with video length.
    let subtitleCardEls = [];
    let cueWordSpans = [];
    let cueTextEls = [];
    let cueActionEls = [];
    let wordObserver = null;
    const mountedCueIndices = new Set();
    let currentCardEl = null;
    let currentWordSpans = [];
    let lastPositionMs = NaN;
    let lastAutoScrollAt = 0;
    let currentCueIndex = -1;
    // Card-level virtualization: keep the cue data in memory, but only mount
    // a bounded window of cards around the viewport/current line. The old
    // implementation still allocated one DOM subtree per cue, which made
    // long transcripts expensive even after word spans were lazy-loaded.
    let virtualTopSpacer = null;
    let virtualBottomSpacer = null;
    let virtualRangeStart = 0;
    let virtualRangeEnd = -1;
    let cueEstimatedHeights = [];
    let cueOffsets = [];
    const VIRTUAL_BUFFER_CUES = 72;
    const VIRTUAL_RECYCLE_MARGIN_CUES = 30;
    const DEFAULT_CUE_HEIGHT = 50;
    let lastUserScrollAt = 0;
    // Separate from lastUserScrollAt above (which only fires on mousedown --
    // see that listener's own comment for why wheel/trackpad scrolling was
    // deliberately left out of it, a different concern about the
    // still-extracting re-render below). This one exists specifically to
    // back off the current-line auto-scroll while the user is reading ahead,
    // so it does need to fire on every kind of scroll, wheel included --
    // confirmed for real that without it, wheel-scrolling down to read ahead
    // got yanked back to the current line on the very next cue change,
    // because nothing was ever resetting the clock for that input method.
    // Once this quiet period expires, scheduleManualCenter() restores the
    // current line even if playback has not advanced to another cue yet.
    let lastManualScrollAt = 0;
    // Set right before this script's own scrollCardIntoView() moves the
    // list, so the "scroll" listener below can tell that apart from the
    // user's own input and not treat it as "user just scrolled" -- without
    // this, every auto-scroll would immediately re-arm its own suppression
    // window and never manage to land.
    let programmaticScroll = false;
    let smoothScrollRaf = 0;
    let smoothScrollToken = 0;
    let smoothScrollVelocity = 0;
    let manualCenterTimer = 0;
    let virtualRecycleRaf = 0;
    let virtualMeasureRaf = 0;
    let virtualResizeRaf = 0;
    let extractPollTimer = null;
    let subtitleGeneration = 0;
    let subtitleRequestSeq = 0;
    let subtitleRequestController = null;
    let subtitleModelVersion = 0;
    let pendingSubtitleCommit = null;
    let pendingSubtitleCommitTimer = null;
    let subtitleResizeObserver = null;
    const USER_SCROLL_QUIET_MS = 4000;
    const EXTRACT_POLL_MS = 1000;
    // Punctuation restoration takes much longer than an extraction tick
    // (40-60s+, it's a whole local model pass), so checking back that often
    // would just be wasted requests -- this is purely a "did it finish yet"
    // poll, not something with real progress to report more granularly.
    const POLISH_POLL_MS = 5000;

    function invalidateSubtitleSession() {
      subtitleGeneration++;
      subtitleRequestSeq++;
      if (subtitleRequestController) subtitleRequestController.abort();
      subtitleRequestController = null;
      pendingSubtitleCommit = null;
      if (pendingSubtitleCommitTimer) { clearTimeout(pendingSubtitleCommitTimer); pendingSubtitleCommitTimer = null; }
      ctx.fns.abortVocabHighlight();
      if (virtualRecycleRaf) { cancelAnimationFrame(virtualRecycleRaf); virtualRecycleRaf = 0; }
      if (virtualMeasureRaf) { cancelAnimationFrame(virtualMeasureRaf); virtualMeasureRaf = 0; }
      if (virtualResizeRaf) { cancelAnimationFrame(virtualResizeRaf); virtualResizeRaf = 0; }
      if (manualCenterTimer) { clearTimeout(manualCenterTimer); manualCenterTimer = 0; }
      cancelSmoothScroll();
    }

    function clearSubtitleModel() {
      if (wordObserver) { wordObserver.disconnect(); wordObserver = null; }
      subtitleCues = [];
      subtitleIsPartial = false;
      subtitleCueSignature = "";
      subtitleModelVersion++;
      ctx.fns.abortVocabHighlight();
      subtitleCardEls = [];
      cueWordSpans = [];
      cueTextEls = [];
      cueActionEls = [];
      mountedCueIndices.clear();
      cueEstimatedHeights = [];
      cueOffsets = [];
      virtualRangeStart = 0;
      virtualRangeEnd = -1;
      virtualTopSpacer = null;
      virtualBottomSpacer = null;
      if (manualCenterTimer) { clearTimeout(manualCenterTimer); manualCenterTimer = 0; }
      currentCardEl = null;
      currentWordSpans = [];
      currentCueIndex = -1;
      lastPositionMs = NaN;
      spokenWordCount = -1;
      ctx.state.cueUnknownWords = [];
      ctx.state.cueWordScores = [];
      if (subsScroll) subsScroll.innerHTML = "";
    }

    function resetSubtitleSession() {
      invalidateSubtitleSession();
      if (typeof clearLoop === "function") clearLoop();
      clearSubtitleModel();
    }

    function subtitleRequestIsCurrent(generation, requestId) {
      return generation === subtitleGeneration && requestId === subtitleRequestSeq;
    }

    function schedulePendingSubtitleCommit(generation) {
      if (pendingSubtitleCommitTimer) return;
      pendingSubtitleCommitTimer = setTimeout(() => {
        pendingSubtitleCommitTimer = null;
        if (generation !== subtitleGeneration || !pendingSubtitleCommit) return;
        const quietFor = Date.now() - lastUserScrollAt;
        if (quietFor < USER_SCROLL_QUIET_MS) {
          schedulePendingSubtitleCommit(generation);
          return;
        }
        const pending = pendingSubtitleCommit;
        pendingSubtitleCommit = null;
        commitSubtitleCues(pending.cues, pending.partial);
        subsEmpty.hidden = true;
      }, Math.max(50, USER_SCROLL_QUIET_MS - Math.max(0, Date.now() - lastUserScrollAt)));
    }

    function cueIdentity(cue) {
      if (!cue) return "";
      return `${cue.start_ms}|${cue.end_ms}|${cue.text || ""}`;
    }

    function cuesShareTimingPrefix(oldCues, nextCues) {
      if (!oldCues.length || nextCues.length < oldCues.length) return false;
      for (let i = 0; i < oldCues.length; i++) {
        if (oldCues[i].start_ms !== nextCues[i].start_ms ||
            oldCues[i].end_ms !== nextCues[i].end_ms) return false;
      }
      return true;
    }

    function cuesSignature(cues, isPartial) {
      return `${isPartial ? "partial" : "complete"}|${(cues || []).map((cue) =>
        `${cueIdentity(cue)}|${cue && cue.text2 || ""}|${cue && cue.words ? "words" : ""}`).join("\u001f")}`;
    }

    function findCueByIdentity(cues, identity, fallback = -1) {
      if (!identity) return fallback;
      const exact = cues.findIndex((cue) => cueIdentity(cue) === identity);
      return exact >= 0 ? exact : fallback;
    }

    function captureVirtualAnchor() {
      if (!subtitleCues.length || !subsScroll) return null;
      const index = virtualIndexAtOffset(subsScroll.scrollTop);
      const card = subtitleCardEls[index];
      if (!card || !card.isConnected) return { index, identity: cueIdentity(subtitleCues[index]), top: NaN };
      return { index, identity: cueIdentity(subtitleCues[index]), top: card.getBoundingClientRect().top };
    }

    function restoreVirtualAnchor(anchor) {
      if (!anchor || !subtitleCues.length) return;
      const index = findCueByIdentity(subtitleCues, anchor.identity, anchor.index);
      const card = subtitleCardEls[index];
      if (!card || !card.isConnected || !Number.isFinite(anchor.top)) return;
      const top = card.getBoundingClientRect().top;
      if (!Number.isFinite(top) || Math.abs(top - anchor.top) < 0.5) return;
      programmaticScroll = true;
      subsScroll.scrollTop += top - anchor.top;
      requestAnimationFrame(() => { programmaticScroll = false; });
    }

    function commitSubtitleCues(nextCues, isPartial, anchor = null) {
      const normalizedCues = Array.isArray(nextCues) ? nextCues : [];
      const nextSignature = cuesSignature(normalizedCues, isPartial);
      if (nextSignature === subtitleCueSignature) return false;
      const oldCues = subtitleCues;
      const oldCurrentKey = cueIdentity(oldCues[currentCueIndex]);
      const oldLoop = typeof loopActive === "function" && loopActive()
        ? { start: cueIdentity(oldCues[loopStartIdx]), end: cueIdentity(oldCues[loopEndIdx]) }
        : null;
      const savedAnchor = anchor || captureVirtualAnchor();

      subtitleCues = normalizedCues;
      subtitleIsPartial = !!isPartial;
      subtitleCueSignature = nextSignature;
      subtitleModelVersion++;
      ctx.state.cueUnknownWords = [];
      ctx.state.cueWordScores = [];
      currentCueIndex = findCueByIdentity(subtitleCues, oldCurrentKey, -1);
      lastPositionMs = NaN;

      if (oldLoop) {
        const start = findCueByIdentity(subtitleCues, oldLoop.start, -1);
        const end = findCueByIdentity(subtitleCues, oldLoop.end, -1);
        if (start >= 0 && end >= 0) {
          loopStartIdx = Math.min(start, end);
          loopEndIdx = Math.max(start, end);
        } else {
          clearLoop();
        }
      }

      renderSubtitleCards(savedAnchor);
      ctx.fns.refreshVocabHighlight();
      applyPreviewHighlight();
      return true;
    }

    function cancelSmoothScroll(resetVelocity = true) {
      smoothScrollToken++;
      if (smoothScrollRaf) cancelAnimationFrame(smoothScrollRaf);
      smoothScrollRaf = 0;
      programmaticScroll = false;
      if (resetVelocity) smoothScrollVelocity = 0;
    }

    function scheduleVirtualRecycle() {
      // Recycle on the next paint instead of waiting for a quiet period. A
      // debounce never fired while a touchpad kept emitting scroll events,
      // leaving the user at the end of the mounted range with empty space.
      if (virtualRecycleRaf) return;
      virtualRecycleRaf = requestAnimationFrame(() => {
        virtualRecycleRaf = 0;
        if (programmaticScroll) return;
        if (subtitleCues.length) renderVirtualWindow();
      });
    }

    function smoothCenterCard(card, immediate = false) {
      if (!card || !card.isConnected) return;
      const rootRect = subsScroll.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const delta = ((cardRect.top + cardRect.bottom) - (rootRect.top + rootRect.bottom)) / 2;
      if (!Number.isFinite(delta) || Math.abs(delta) < 3) return;
      const maxScroll = Math.max(0, subsScroll.scrollHeight - subsScroll.clientHeight);
      const start = subsScroll.scrollTop;
      const target = Math.max(0, Math.min(maxScroll, start + delta));
      if (Math.abs(target - start) < 3) return;
      if (immediate) {
        cancelSmoothScroll();
        programmaticScroll = true;
        subsScroll.scrollTop = target;
        // The target may have been outside the mounted window, and adding
        // .current also reveals its timestamp/actions. Both can change its
        // real height after this first write. Re-center for a couple of
        // layout frames while the internal-scroll guard is active, so one
        // seek still lands exactly once from the user's perspective.
        const token = smoothScrollToken;
        let settleFrames = 0;
        const settle = () => {
          if (token !== smoothScrollToken) return;
          if (!card.isConnected) {
            programmaticScroll = false;
            smoothScrollRaf = 0;
            smoothScrollVelocity = 0;
            return;
          }
          const nextRootRect = subsScroll.getBoundingClientRect();
          const nextCardRect = card.getBoundingClientRect();
          const correction = ((nextCardRect.top + nextCardRect.bottom) -
            (nextRootRect.top + nextRootRect.bottom)) / 2;
          if (Number.isFinite(correction) && Math.abs(correction) > 0.5) {
            const nextMax = Math.max(0, subsScroll.scrollHeight - subsScroll.clientHeight);
            subsScroll.scrollTop = Math.max(0, Math.min(nextMax, subsScroll.scrollTop + correction));
          }
          if (settleFrames++ < 2) {
            requestAnimationFrame(settle);
          } else {
            programmaticScroll = false;
            scheduleVirtualMeasure();
          }
        };
        requestAnimationFrame(settle);
        return;
      }
      // Keep the current velocity when a new cue retargets the center. That
      // continuity is what gives native lyrics views their gentle "drag"
      // instead of restarting every transition from a dead stop.
      cancelSmoothScroll(false);
      const token = smoothScrollToken;
      let position = start;
      let velocity = smoothScrollVelocity;
      let previousTime = performance.now();
      programmaticScroll = true;
      const step = (now) => {
        if (token !== smoothScrollToken) return;
        const dt = Math.min(0.034, Math.max(0.001, (now - previousTime) / 1000));
        previousTime = now;
        // Critically damped spring: smooth acceleration/deceleration with no
        // intentional overshoot, while preserving velocity across retargets.
        const acceleration = (target - position) * 180 - velocity * 26;
        velocity += acceleration * dt;
        position += velocity * dt;
        if ((target - start) * (target - position) < 0) {
          position = target;
          velocity = 0;
        }
        subsScroll.scrollTop = position;
        smoothScrollVelocity = velocity;
        if (Math.abs(target - position) > 0.35 || Math.abs(velocity) > 2) {
          smoothScrollRaf = requestAnimationFrame(step);
        } else {
          subsScroll.scrollTop = target;
          smoothScrollVelocity = 0;
          smoothScrollRaf = 0;
          // Let the final scroll event observe the programmatic flag before
          // user-scroll suppression is re-enabled.
          requestAnimationFrame(() => {
            if (token === smoothScrollToken) {
              programmaticScroll = false;
              scheduleVirtualMeasure();
            }
          });
        }
      };
      smoothScrollRaf = requestAnimationFrame(step);
    }

    function centerCurrentCueAfterScroll() {
      manualCenterTimer = 0;
      if (!subtitleCues.length || currentCueIndex < 0) return;
      const quietFor = Date.now() - Math.max(lastUserScrollAt, lastManualScrollAt);
      if (quietFor < USER_SCROLL_QUIET_MS) {
        scheduleManualCenter();
        return;
      }
      // The current line may have been recycled while the user read ahead.
      // Mount it again before measuring, then use the normal interruptible
      // centering animation so another wheel event can take control.
      ensureVirtualCueWindow(currentCueIndex);
      const card = subtitleCardEls[currentCueIndex];
      if (!card || !card.isConnected) return;
      const rootRect = subsScroll.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const rootCenter = (rootRect.top + rootRect.bottom) / 2;
      const cardCenter = (cardRect.top + cardRect.bottom) / 2;
      if (!Number.isFinite(cardCenter) || Math.abs(cardCenter - rootCenter) <= 1) return;
      if (Date.now() - lastAutoScrollAt < 180) return;
      smoothCenterCard(card);
      lastAutoScrollAt = Date.now();
    }

    function scheduleManualCenter() {
      if (manualCenterTimer) clearTimeout(manualCenterTimer);
      const quietFor = Date.now() - Math.max(lastUserScrollAt, lastManualScrollAt);
      manualCenterTimer = setTimeout(
        centerCurrentCueAfterScroll,
        Math.max(50, USER_SCROLL_QUIET_MS - Math.max(0, quietFor))
      );
    }

    function stopExtractPolling() {
      if (extractPollTimer) { clearTimeout(extractPollTimer); extractPollTimer = null; }
    }

    function fmtProgress(fraction) {
      return fraction > 0 ? `${Math.min(99, Math.round(fraction * 100))}%` : "…";
    }

    async function loadSubtitleCues(startedAt = null) {
      stopExtractPolling();
      const generation = subtitleGeneration;
      const requestId = ++subtitleRequestSeq;
      if (subtitleRequestController) subtitleRequestController.abort();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      subtitleRequestController = controller;
      if (startedAt === null) {
        subsEmpty.hidden = false;
        subsEmpty.textContent = "正在加载字幕…";
      }
      try {
        // Cards from whatever was loaded before are not this video's. Left in
        // place they sit there looking authoritative while the new video is
        // still being resolved -- and every path out of here that isn't
        // success renders into subsEmpty, not the card list.
        if (startedAt === null) {
          if (wordObserver) { wordObserver.disconnect(); wordObserver = null; }
          subsScroll.innerHTML = "";
        }
        const lang2 = settingValue("secondaryLang") || "";
        const response = await fetch(
          `${API}/api/subtitles?lang=en&tab_id=${TAB_ID}${lang2 ? `&secondary=${lang2}` : ""}` +
          `${wordHighlightOn() ? "&words=1" : ""}`,
          controller ? { signal: controller.signal } : undefined
        );
        const data = await response.json();
        if (!subtitleRequestIsCurrent(generation, requestId)) return;
        // "ready" | "extracting" | an error string; absent when no second
        // language was asked for.
        const sec = data.secondary_status;
        const secondaryPending = sec === "extracting";
        const secondaryFailed = sec && sec !== "ready" && !secondaryPending;

        if (data.status === "extracting") {
          const t0 = startedAt || Date.now();
          const secs = Math.round((Date.now() - t0) / 1000);
          subsEmpty.hidden = false;
          subsEmpty.innerHTML = "";
          const l1 = document.createElement("div");
          // YouTube reports a stage instead of a fraction -- there is no
          // honest percentage to give for a network round trip.
          l1.textContent = data.message
            ? `${data.message}…（已用 ${secs}s）`
            : `正在提取字幕 ${fmtProgress(data.progress || 0)}…（已用 ${secs}s）`;
          const l2 = document.createElement("div");
          l2.className = "subs-hint";
          l2.textContent = data.message
            ? "视频可以先看，字幕抓好会自动出现。这期间对话页可以照常用。"
            : "第一次打开这个视频要扫一遍文件（大文件约半分钟）。" +
              "字幕会从头逐段显示，不用等全部扫完。这期间对话页可以照常用。";
          subsEmpty.append(l1, l2);
          extractPollTimer = setTimeout(() => loadSubtitleCues(t0), EXTRACT_POLL_MS);
          return;
        }

        if (!data.available || !data.cues || data.cues.length === 0) {
          showSubtitleError(`没有可用字幕：${data.error || "未知原因"}`);
          clearSubtitleModel();
          return;
        }

        const nextCues = Array.isArray(data.cues) ? data.cues : [];
        const nextPartial = data.complete === false;
        const wasPartial = subtitleIsPartial;
        const userBusy = Date.now() - lastUserScrollAt < USER_SCROLL_QUIET_MS;
        // Partial extraction responses append the lines below the current
        // window. Commit those immediately even during scrolling; deferring
        // them makes the transcript appear stuck at the old end. A response
        // that preserves all existing cue timings is equally safe to apply,
        // since the virtual renderer keeps the viewport anchor stable.
        const canApplyDuringScroll = nextPartial ||
          cuesShareTimingPrefix(subtitleCues, nextCues);
        if (userBusy && subtitleCues.length && !canApplyDuringScroll) {
          pendingSubtitleCommit = { cues: nextCues, partial: nextPartial };
          schedulePendingSubtitleCommit(generation);
        } else {
          pendingSubtitleCommit = null;
          if (pendingSubtitleCommitTimer) { clearTimeout(pendingSubtitleCommitTimer); pendingSubtitleCommitTimer = null; }
          commitSubtitleCues(nextCues, nextPartial);
          subsEmpty.hidden = true;
        }

        if (nextPartial || secondaryPending) {
          const t0 = startedAt || Date.now();
          const secs = Math.round((Date.now() - t0) / 1000);
          subsNote.hidden = false;
          // The English side can be complete while the translation is still
          // being pulled, and that reads as a stall unless it's named.
          subsNote.textContent = subtitleIsPartial
            ? `⏳ 字幕提取中 ${fmtProgress(data.progress || 0)}（${secs}s）— ` +
              `已显示的部分可以正常用，后面的会自动补上`
            : `⏳ 中文字幕提取中（${secs}s）— 英文已经可以用了，中文会逐段补上`;
          extractPollTimer = setTimeout(() => loadSubtitleCues(t0), EXTRACT_POLL_MS);
        } else if (data.polishing) {
          // Cues shown are already usable (this is the "complete" reply) --
          // just possibly still the raw, unpunctuated fallback. Quietly
          // checks back without the "还在抓字幕" framing above, since
          // nothing here is actually missing yet, only maybe about to get
          // nicer.
          subsNote.hidden = false;
          subsNote.textContent = "🔧 字幕断句还在后台优化，好了会自动换成更好读的版本";
          extractPollTimer = setTimeout(
            () => loadSubtitleCues(startedAt || Date.now()), POLISH_POLL_MS
          );
        } else if (userBusy) {
          // Nothing left to wait on server-side, but the render above was
          // skipped because the user was mid-interaction -- what just got
          // fetched into subtitleCues never made it onto the page, and
          // nothing else re-checks this once polishing itself is done, so
          // without this branch a render that lost this race would just be
          // gone for good. A short catch-up poll here is what actually
          // flushes it once they let go, instead of leaving the page stuck
          // showing the old cues indefinitely.
          extractPollTimer = setTimeout(() => loadSubtitleCues(startedAt || Date.now()), 1000);
        } else if (secondaryFailed) {
          // English is fine, so this stays a note rather than an error page.
          subsNote.hidden = false;
          subsNote.textContent = `中文字幕不可用：${sec}`;
        } else {
          subsNote.hidden = true;
          // The DOM was just rebuilt with the complete list, so snap back to
          // whatever's playing rather than leaving the user mid-list.
          if (wasPartial) lastUserScrollAt = 0;
        }
      } catch (e) {
        if (!subtitleRequestIsCurrent(generation, requestId) || e.name === "AbortError") return;
        showSubtitleError(`加载字幕失败：${e.message}`);
      } finally {
        if (subtitleRequestIsCurrent(generation, requestId)) subtitleRequestController = null;
      }
    }

    function showSubtitleError(message) {
      subsNote.hidden = true;
      subsEmpty.hidden = false;
      subsEmpty.innerHTML = "";
      const text = document.createElement("div");
      text.textContent = message;
      const btn = document.createElement("button");
      btn.innerHTML = `${icon("retry")} 重试`;
      btn.addEventListener("click", () => { btn.disabled = true; loadSubtitleCues(); });
      subsEmpty.append(text, btn);
      clearLoop();
    }

    // Virtualized subtitle renderer: the cue data remains in memory, while
    // only the bounded window around the viewport is mounted in the DOM.
    // Layout values are shared by the whole pass. Reading computed style and
    // clientWidth once per cue forces the browser to revisit layout thousands
    // of times on a long transcript, even though those values cannot change
    // during one estimate pass.
    function subtitleLayoutMetrics() {
      const width = Math.max(160, (subsScroll ? subsScroll.clientWidth : 440) - 44);
      const rootStyle = getComputedStyle(document.documentElement);
      const configured = parseFloat(rootStyle.getPropertyValue("--english-tutor-sub-size"));
      const fontSize = configured || (window.matchMedia("(max-width: 700px)").matches ? 18 : 16);
      return {
        fontSize,
        charsPerLine: Math.max(12, Math.floor(width / (fontSize * 0.56))),
        secondaryCharsPerLine: Math.max(10, Math.floor(width / (fontSize * 0.72))),
      };
    }

    function estimateCueHeight(cue, isLast = false, metrics = subtitleLayoutMetrics()) {
      const text = String(cue && cue.text || "");
      const text2 = String(cue && cue.text2 || "");
      const { fontSize, charsPerLine, secondaryCharsPerLine } = metrics;
      const primaryLines = Math.max(1, Math.ceil(text.length / charsPerLine));
      let height = primaryLines * fontSize * 1.5;
      if (text2) {
        const secondaryLines = Math.max(1, Math.ceil(text2.length / secondaryCharsPerLine));
        height += 6 + secondaryLines * fontSize * 0.75 * 1.6;
      }
      height += isLast ? 0 : 26;
      const minimum = isLast ? fontSize * 1.5 : DEFAULT_CUE_HEIGHT;
      return Math.max(minimum, Math.ceil(height));
    }

    function rebuildEstimatedCueGeometry() {
      const count = subtitleCues.length;
      const metrics = subtitleLayoutMetrics();
      cueEstimatedHeights = new Array(count);
      cueOffsets = new Array(count + 1);
      cueOffsets[0] = 0;
      for (let i = 0; i < count; i++) {
        const height = estimateCueHeight(subtitleCues[i], i === count - 1, metrics);
        cueEstimatedHeights[i] = height;
        cueOffsets[i + 1] = cueOffsets[i] + height;
      }
    }

    function rebuildCueOffsets() {
      cueOffsets[0] = 0;
      for (let i = 0; i < subtitleCues.length; i++) {
        cueOffsets[i + 1] = cueOffsets[i] + cueEstimatedHeights[i];
      }
    }

    function updateVirtualSpacers() {
      if (!virtualTopSpacer || !virtualBottomSpacer || !subtitleCues.length) return;
      const start = Math.max(0, virtualRangeStart);
      const end = Math.min(subtitleCues.length - 1, virtualRangeEnd);
      virtualTopSpacer.style.height = `${cueOffsets[start] || 0}px`;
      virtualBottomSpacer.style.height = `${Math.max(
        0, cueOffsets[subtitleCues.length] - (cueOffsets[end + 1] || cueOffsets[subtitleCues.length])
      )}px`;
    }

    // Only measure cards close to the real viewport, where the browser has
    // laid out their actual text; distant cards use the estimate above.
    function measureMountedCueHeight(card) {
      if (!card || !card.isConnected) return NaN;
      const rect = card.getBoundingClientRect();
      const margin = parseFloat(getComputedStyle(card).marginBottom) || 0;
      const height = rect.height + margin;
      return Number.isFinite(height) && height > 0 ? height : NaN;
    }

    function scheduleVirtualMeasure() {
      if (virtualMeasureRaf) return;
      virtualMeasureRaf = requestAnimationFrame(() => {
        virtualMeasureRaf = 0;
        if (programmaticScroll) return;
        if (subtitleCues.length && virtualRangeEnd >= virtualRangeStart) {
          measureVirtualWindow();
        }
      });
    }

    function invalidateVirtualMeasurements() {
      if (!subtitleCues.length || virtualResizeRaf) return;
      virtualResizeRaf = requestAnimationFrame(() => {
        virtualResizeRaf = 0;
        if (programmaticScroll) {
          invalidateVirtualMeasurements();
          return;
        }
        const anchor = captureVirtualAnchor();
        rebuildEstimatedCueGeometry();
        updateVirtualSpacers();
        restoreVirtualAnchor(anchor);
        scheduleVirtualMeasure();
      });
    }

    function measureVirtualWindow() {
      const rootRect = subsScroll.getBoundingClientRect();
      const activationMargin = 900;
      let anchorCard = null;
      let anchorTop = NaN;
      let changed = false;

      for (let i = virtualRangeStart; i <= virtualRangeEnd; i++) {
        const card = subtitleCardEls[i];
        if (!card || !card.isConnected) continue;
        const rect = card.getBoundingClientRect();
        if (!anchorCard && rect.bottom > rootRect.top) {
          anchorCard = card;
          anchorTop = rect.top;
        }
        if (rect.bottom < rootRect.top - activationMargin ||
            rect.top > rootRect.bottom + activationMargin) continue;
        const measured = measureMountedCueHeight(card);
        if (!Number.isFinite(measured) || Math.abs(measured - cueEstimatedHeights[i]) < 1) continue;
        cueEstimatedHeights[i] = measured;
        changed = true;
      }
      if (!changed) return;

      rebuildCueOffsets();
      updateVirtualSpacers();
      // Height corrections before the visible anchor must not move the line
      // the user is reading. Mark this write as internal so the scroll
      // listener does not immediately recycle the window a second time.
      if (anchorCard && Number.isFinite(anchorTop)) {
        const newTop = anchorCard.getBoundingClientRect().top;
        const correction = newTop - anchorTop;
        if (Number.isFinite(correction) && Math.abs(correction) > 0.5) {
          programmaticScroll = true;
          subsScroll.scrollTop += correction;
          requestAnimationFrame(() => { programmaticScroll = false; });
        }
      }
    }

    function virtualIndexAtOffset(offset) {
      const paddingTop = parseFloat(getComputedStyle(subsScroll).paddingTop) || 0;
      const target = Math.max(0, offset + paddingTop);
      let lo = 0, hi = Math.max(0, cueOffsets.length - 2);
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cueOffsets[mid] <= target) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    function createVirtualCueCard(i) {
      const cue = subtitleCues[i];
      const card = document.createElement("div");
      card.className = "sub-card";
      if (i === subtitleCues.length - 1) card.classList.add("sub-card-last");
      card.dataset.index = String(i);
      const time = document.createElement("span");
      time.className = "sub-time";
      const timeText = document.createElement("span");
      timeText.className = "sub-time-text";
      timeText.textContent = ctx.fns.fmt(cue.start_ms);
      time.appendChild(timeText);
      card.appendChild(time);
      const text = document.createElement("div");
      text.className = "sub-text";
      if (cue.words) text.classList.add("has-word-times");
      text.textContent = cue.text;
      cueTextEls[i] = text;
      card.appendChild(text);
      if (cue.text2) {
        const text2 = document.createElement("div");
        text2.className = "sub-text-2";
        text2.textContent = cue.text2;
        card.appendChild(text2);
      }
      const actions = document.createElement("div");
      actions.className = "sub-actions";
      cueActionEls[i] = actions;
      card.appendChild(actions);
      subtitleCardEls[i] = card;
      mountedCueIndices.add(i);
      return card;
    }

    function renderVirtualWindow(anchorIndex = -1, keepExistingRange = false) {
      if (!subtitleCues.length || !virtualTopSpacer || !virtualBottomSpacer) return;
      const firstVisible = virtualIndexAtOffset(subsScroll.scrollTop);
      const anchor = anchorIndex >= 0 ? anchorIndex : firstVisible;
      const center = anchorIndex >= 0 ? anchorIndex : firstVisible;
      // While the user is scrolling, keep the current window stable until
      // they approach its edge. Re-centering on every wheel tick makes all
      // cards get removed/reinserted continuously, which looks like shaking
      // and also defeats the point of virtualization. Explicit playback
      // jumps still re-center immediately via anchorIndex.
      if (anchorIndex < 0 && virtualRangeEnd >= virtualRangeStart &&
          firstVisible >= virtualRangeStart + VIRTUAL_RECYCLE_MARGIN_CUES &&
          firstVisible <= virtualRangeEnd - VIRTUAL_RECYCLE_MARGIN_CUES) return;
      const oldRangeStart = virtualRangeStart;
      const oldRangeEnd = virtualRangeEnd;
      let start = Math.max(0, center - VIRTUAL_BUFFER_CUES);
      let end = Math.min(subtitleCues.length - 1, center + VIRTUAL_BUFFER_CUES);
      if (keepExistingRange && oldRangeEnd >= oldRangeStart) {
        // Preloading during playback should expand the window without
        // throwing away already-mounted context on the opposite side.
        start = Math.min(start, oldRangeStart);
        end = Math.max(end, oldRangeEnd);
      }
      if (start === virtualRangeStart && end === virtualRangeEnd &&
          subtitleCardEls[anchor] && subtitleCardEls[anchor].isConnected) return;
      // When recycling because of user scrolling, preserve the current
      // viewport anchor. Changing the top spacer while replacing cards can
      // otherwise make the browser keep the old scrollTop but display a
      // different cue, producing the occasional large jump/overshoot.
      let preserveIndex = -1;
      let preserveTop = NaN;
      if (anchorIndex < 0 && virtualRangeEnd >= virtualRangeStart) {
        preserveIndex = firstVisible;
        const oldAnchor = subtitleCardEls[preserveIndex];
        if (oldAnchor && oldAnchor.isConnected) preserveTop = oldAnchor.getBoundingClientRect().top;
      }
      if (wordObserver) wordObserver.disconnect();
      wordObserver = null;
      // Recycle only the part that left the window. Keeping the overlap avoids
      // destroying word spans, focus and selection on every boundary crossing.
      const oldStart = virtualRangeStart;
      const oldEnd = virtualRangeEnd;
      for (let i = oldStart; i <= oldEnd; i++) {
        if (i >= start && i <= end) continue;
        const card = subtitleCardEls[i];
        if (card) {
          card.remove();
          subtitleCardEls[i] = null;
          cueTextEls[i] = null;
          cueActionEls[i] = null;
          cueWordSpans[i] = null;
          mountedCueIndices.delete(i);
          if (currentCardEl === card) {
            currentCardEl = null;
            currentWordSpans = [];
            spokenWordCount = -1;
          }
        }
      }
      virtualRangeStart = start;
      virtualRangeEnd = end;
      updateVirtualSpacers();
      // Insert each contiguous run of entering cards in one fragment. The
      // old per-card insertion also scanned forward for an anchor on every
      // iteration, making a fresh 145-card window do unnecessary quadratic
      // work and causing a visible pause before the first paint.
      let runStart = -1;
      for (let i = start; i <= end + 1; i++) {
        const missing = i <= end && !(subtitleCardEls[i] && subtitleCardEls[i].isConnected);
        if (missing && runStart < 0) {
          runStart = i;
          continue;
        }
        if (runStart < 0) continue;
        const runEnd = i - 1;
        let next = virtualBottomSpacer;
        for (let j = runEnd + 1; j <= end; j++) {
          if (subtitleCardEls[j] && subtitleCardEls[j].isConnected) {
            next = subtitleCardEls[j];
            break;
          }
        }
        const fragment = document.createDocumentFragment();
        for (let j = runStart; j <= runEnd; j++) {
          fragment.appendChild(subtitleCardEls[j] || createVirtualCueCard(j));
        }
        subsScroll.insertBefore(fragment, next);
        runStart = -1;
      }
      if (preserveIndex >= start && preserveIndex <= end && Number.isFinite(preserveTop)) {
        const newAnchor = subtitleCardEls[preserveIndex];
        if (newAnchor) {
          const newTop = newAnchor.getBoundingClientRect().top;
          if (Number.isFinite(newTop)) subsScroll.scrollTop += newTop - preserveTop;
        }
      }
      if (typeof IntersectionObserver === "function") {
        wordObserver = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            const index = Number(entry.target.dataset.index);
            if (!Number.isInteger(index) || subtitleCardEls[index] !== entry.target) return;
            // `isIntersecting` includes the 800px preload margin. Keep a
            // separate real-viewport test for auto-follow, otherwise a line
            // that is merely near the viewport suppresses centering.
            const root = entry.rootBounds;
            const rect = entry.boundingClientRect;
            if (entry.isIntersecting || index === currentCueIndex) decorateCardWords(index);
            else if (index !== currentCueIndex && cueWordSpans[index] !== null) {
              cueTextEls[index].textContent = subtitleCues[index].text;
              cueWordSpans[index] = null;
            }
          });
        }, { root: subsScroll, rootMargin: "800px 0px" });
        for (let i = start; i <= end; i++) if (subtitleCardEls[i]) wordObserver.observe(subtitleCardEls[i]);
      } else {
        for (let i = start; i <= end; i++) decorateCardWords(i);
      }
      if (currentCueIndex >= start && currentCueIndex <= end && subtitleCardEls[currentCueIndex]) {
        const current = subtitleCardEls[currentCueIndex];
        current.classList.add("current");
        decorateCardWords(currentCueIndex);
        ensureCardActions(currentCueIndex);
        currentCardEl = current;
        currentWordSpans = subtitleCues[currentCueIndex].words
          ? (cueWordSpans[currentCueIndex] || []) : [];
        spokenWordCount = -1;
      }
      renderLoopState();
      scheduleVirtualMeasure();
    }

    function ensureVirtualCueWindow(index) {
      if (!subtitleCues.length || index < 0) return;
      const outside = index < virtualRangeStart || index > virtualRangeEnd;
      const canExpandTop = virtualRangeStart > 0 &&
        index < virtualRangeStart + VIRTUAL_RECYCLE_MARGIN_CUES;
      const canExpandBottom = virtualRangeEnd < subtitleCues.length - 1 &&
        index > virtualRangeEnd - VIRTUAL_RECYCLE_MARGIN_CUES;
      if (!outside && !canExpandTop && !canExpandBottom &&
          subtitleCardEls[index] && subtitleCardEls[index].isConnected) return;
      const anchor = captureVirtualAnchor();
      renderVirtualWindow(index, !outside);
      restoreVirtualAnchor(anchor);
    }

    function renderSubtitleCards(anchor = null) {
      const savedAnchor = anchor || captureVirtualAnchor();
      cancelSmoothScroll();
      if (virtualRecycleRaf) { cancelAnimationFrame(virtualRecycleRaf); virtualRecycleRaf = 0; }
      if (virtualMeasureRaf) { cancelAnimationFrame(virtualMeasureRaf); virtualMeasureRaf = 0; }
      subtitleCardEls = new Array(subtitleCues.length);
      cueWordSpans = new Array(subtitleCues.length).fill(null);
      cueTextEls = new Array(subtitleCues.length);
      cueActionEls = new Array(subtitleCues.length);
      mountedCueIndices.clear();
      rebuildEstimatedCueGeometry();
      if (wordObserver) wordObserver.disconnect();
      wordObserver = null;
      currentCardEl = null;
      currentWordSpans = [];
      spokenWordCount = -1;
      virtualRangeStart = 0;
      virtualRangeEnd = -1;
      subsScroll.innerHTML = "";
      virtualTopSpacer = document.createElement("div");
      virtualBottomSpacer = document.createElement("div");
      virtualTopSpacer.className = "subs-virtual-spacer";
      virtualBottomSpacer.className = "subs-virtual-spacer";
      subsScroll.append(virtualTopSpacer, virtualBottomSpacer);
      renderVirtualWindow(currentCueIndex);
      restoreVirtualAnchor(savedAnchor);
      renderLoopState();
    }

    if (typeof ResizeObserver === "function") {
      subtitleResizeObserver = new ResizeObserver(() => invalidateVirtualMeasurements());
      subtitleResizeObserver.observe(subsScroll);
    }

    // A mousedown here usually means the user is about to drag-select
    // subtitle text, and the current-line auto-scroll (highlightCue below)
    // yanking the list mid-drag as playback advances would drag the text out
    // from under the selection. (There used to be a matching "wheel"
    // listener here too, but that one wasn't for this -- it was working
    // around Jellyfin binding wheel-to-volume at the document level, which
    // is already handled separately by the stopPropagation block further up
    // (search "Jellyfin binds wheel-to-volume"). Wiring plain scrolling into
    // this same busy-guard just meant any scroll over the list reset the
    // clock, so on a still-updating video the cards could keep missing their
    // window to ever re-render. The wheel listener below cancels an in-flight
    // lyric animation and starts the four-second recenter countdown.)
    subsScroll.addEventListener("mousedown", () => {
      cancelSmoothScroll();
      lastUserScrollAt = Date.now();
    }, { passive: true });
    subsScroll.addEventListener("wheel", () => {
      cancelSmoothScroll();
      lastUserScrollAt = Date.now();
      lastManualScrollAt = Date.now();
      scheduleManualCenter();
    }, { passive: true });
    subsScroll.addEventListener("pointerdown", () => {
      cancelSmoothScroll();
      lastUserScrollAt = Date.now();
      lastManualScrollAt = Date.now();
    }, { passive: true });
    subsScroll.addEventListener("touchstart", () => {
      cancelSmoothScroll();
      lastUserScrollAt = Date.now();
      lastManualScrollAt = Date.now();
    }, { passive: true });
    subsScroll.addEventListener("scroll", () => {
      wordPopup.classList.remove("open");
      if (!programmaticScroll) {
        cancelSmoothScroll();
        const now = Date.now();
        lastUserScrollAt = now;
        lastManualScrollAt = now;
        scheduleManualCenter();
      }
      // Recycle the card window as the user scrolls through a long transcript.
      // The range check makes ordinary playback scroll events effectively
      // free when the current card is already mounted.
      // During an automatic lyric animation, its scrollTop is the source of
      // truth. Rebuilding the virtual window from every intermediate scroll
      // event would apply a second anchor correction and make the animation
      // oscillate past the target. The explicit playback jump already mounts
      // the needed range before the animation starts.
      if (!programmaticScroll && subtitleCues.length) scheduleVirtualRecycle();
    }, { passive: true });

    // One delegated listener replaces thousands of per-card/per-word
    // listeners. The cue data remains in subtitleCues, so spans only need a
    // compact cue index and normalized word on themselves.
    subsScroll.addEventListener("click", (event) => {
      const target = event.target && event.target.closest
        ? event.target : event.target && event.target.parentElement;
      if (!target || !subsScroll.contains(target)) return;
      const wordSpan = target.closest(".sub-word");
      if (wordSpan) {
        const index = Number(wordSpan.dataset.cueIndex);
        const cue = subtitleCues[index];
        if (cue) showWordPopup(wordSpan, wordSpan.dataset.word, cue.text, index);
        event.stopPropagation();
        return;
      }
      const action = target.closest("[data-sub-action]");
      const card = target.closest(".sub-card");
      if (!card || !subsScroll.contains(card)) return;
      const index = Number(card.dataset.index);
      if (!Number.isInteger(index) || !subtitleCues[index]) return;
      if (action) {
        event.stopPropagation();
        if (action.dataset.subAction === "loop") toggleLoopAt(index);
        else if (action.dataset.subAction === "ask") askAboutCue(index);
        else if (action.dataset.subAction === "read") speakWord(subtitleCues[index].text);
        return;
      }
      if (loopActive()) { toggleLoopAt(index); return; }
      const p = player();
      if (p) p.seekMs(subtitleCues[index].start_ms);
      lastUserScrollAt = 0;
      lastPositionMs = NaN;
      highlightCue(index, true);
    });
    subsScroll.addEventListener("mouseout", (event) => {
      const target = event.target && event.target.closest
        ? event.target : event.target && event.target.parentElement;
      if (target && target.closest && target.closest(".sub-word")) {
        const related = event.relatedTarget;
        if (!related || !related.closest || !related.closest(".sub-word")) {
          ctx.fns.scheduleHideWordPopup();
        }
      }
    }, { passive: true });

    // Split a line into hoverable per-word spans so the popup can target the
    // exact word under the cursor, not the whole sentence.
    function appendWordSpans(container, sentence, cueIndex, times) {
      // Counts every non-whitespace token, span or not. `times` came from
      // splitting the cue's text on whitespace server-side, so a token that
      // ends up as a bare text node below (pure punctuation, e.g. "--")
      // still occupies a slot in it -- skipping those here would shift the
      // rest of the line's timings by one and silently highlight the wrong
      // words from that point on.
      let wordIndex = 0;
      const spans = [];
      for (const token of sentence.split(/(\s+)/)) {
        if (!token) continue;
        if (/^\s+$/.test(token)) {
          container.appendChild(document.createTextNode(token));
          continue;
        }
        const time = times && times[wordIndex];
        wordIndex++;
        const word = token.replace(/^[^\w']+|[^\w']+$/g, "");
        if (!word) { container.appendChild(document.createTextNode(token)); continue; }
        const span = document.createElement("span");
        span.className = "sub-word";
        span.textContent = token;
        span.dataset.word = word;
        span.dataset.cueIndex = String(cueIndex);
        if (time) span.dataset.start = time[0];
        container.appendChild(span);
        spans.push(span);
      }
      return spans;
    }

    function decorateCardWords(index) {
      if (cueWordSpans[index] !== null) return;
      const cue = subtitleCues[index];
      const text = cueTextEls[index];
      if (!cue || !text) return;
      text.textContent = "";
      cueWordSpans[index] = appendWordSpans(text, cue.text, index, cue.words);
      ctx.fns.applyVocabHighlightToCard(index);
      applyPreviewHighlightToCard(index);
    }

    function ensureCardActions(index) {
      const actions = cueActionEls[index];
      if (!actions || actions.childElementCount) return;
      const cue = subtitleCues[index];
      if (!cue) return;
      const makeButton = (className, action, html, title) => {
        const button = document.createElement("button");
        button.className = className;
        button.dataset.subAction = action;
        button.innerHTML = html;
        button.title = title;
        button.setAttribute("aria-label", title);
        actions.appendChild(button);
      };
      makeButton("sub-loop-btn", "loop", `${icon("repeat")}循环`, "循环这句");
      makeButton("sub-ask-btn", "ask", `${icon("help")}问这句`, "问一下这句什么意思");
      makeButton("sub-read-btn", "read", `${icon("speaker")}朗读`, "朗读这句");
    }

    // ---- vocab-highlight ("生词高亮") -------------------------------------
    //
    // Applied as a second pass over already-rendered .sub-word spans, not
    // baked into appendWordSpans itself: the subtitle cards need to appear
    // immediately when a video opens, and this is one extra network round
    // trip per video (batched -- the whole video's cues in one request, not
    // one per line) that shouldn't hold that up. The highlight fades in a
    // beat after the text itself, same tradeoff subtitleIsPartial's
    // progressive rendering already makes elsewhere on this page.

    function installVocabHighlight(ctx) {
      let vocabHighlightSeq = 0;
      let vocabHighlightController = null;

      function abortVocabHighlight() {
        vocabHighlightSeq++;
        if (vocabHighlightController) vocabHighlightController.abort();
        vocabHighlightController = null;
      }

      async function refreshVocabHighlight() {
        const includeScores = showPKnownOn();
        if ((!vocabHighlightOn() && !includeScores) || subtitleCues.length === 0) return;
        const generation = subtitleGeneration;
        const modelVersion = subtitleModelVersion;
        const requestId = ++vocabHighlightSeq;
        if (vocabHighlightController) vocabHighlightController.abort();
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        vocabHighlightController = controller;
        const cues = subtitleCues.map((c) => c.text);
        try {
          const res = await fetch(`${API}/api/vocab-highlight`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(includeScores ? { cues, include_scores: true } : { cues }),
            ...(controller ? { signal: controller.signal } : {}),
          });
          const data = await res.json();
          if (generation !== subtitleGeneration || modelVersion !== subtitleModelVersion ||
              requestId !== vocabHighlightSeq ||
              (!vocabHighlightOn() && !showPKnownOn()) ||
              includeScores !== showPKnownOn()) return;
          ctx.state.cueUnknownWords = vocabHighlightOn() && Array.isArray(data.result)
            ? data.result.map((words) => new Set(words)) : [];
          ctx.state.cueWordScores = includeScores && Array.isArray(data.scores)
            ? data.scores.map((entries) => {
              const byWord = new Map();
              if (!Array.isArray(entries)) return byWord;
              entries.forEach((entry) => {
                if (!entry || typeof entry.word !== "string") return;
                const p = Number(entry.p_known);
                if (!Number.isFinite(p)) return;
                byWord.set(entry.word.toLowerCase(), { p_known: p, source: entry.source });
              });
              return byWord;
            }) : [];
        } catch (e) {
          return;  // best-effort -- cards just stay unhighlighted
        } finally {
          if (requestId === vocabHighlightSeq) vocabHighlightController = null;
        }
        if (generation !== subtitleGeneration || modelVersion !== subtitleModelVersion) return;
        applyVocabHighlight();
        updateWordPopupPKnown();
      }

      function applyVocabHighlight() {
        for (const index of mountedCueIndices) applyVocabHighlightToCard(index);
      }

      function applyVocabHighlightToCard(index) {
        const unknown = ctx.state.cueUnknownWords[index];
        const spans = cueWordSpans[index];
        if (!spans) return;
        spans.forEach((span) => {
          const norm = span.textContent.replace(/^[^\w']+|[^\w']+$/g, "").toLowerCase();
          span.classList.toggle("sub-word-unknown", !!(unknown && unknown.has(norm)));
        });
      }

      let hideWordPopupTimer = null;
      const cancelHide = () => { clearTimeout(hideWordPopupTimer); hideWordPopupTimer = null; };
      function scheduleHideWordPopup() {
        cancelHide();
        hideWordPopupTimer = setTimeout(() => wordPopup.classList.remove("open"), 250);
      }
      wordPopup.addEventListener("mouseenter", cancelHide);
      wordPopup.addEventListener("mouseleave", scheduleHideWordPopup);

      ctx.fns.refreshVocabHighlight = refreshVocabHighlight;
      ctx.fns.abortVocabHighlight = abortVocabHighlight;
      ctx.fns.applyVocabHighlight = applyVocabHighlight;
      ctx.fns.applyVocabHighlightToCard = applyVocabHighlightToCard;
      ctx.fns.cancelHide = cancelHide;
      ctx.fns.scheduleHideWordPopup = scheduleHideWordPopup;
    }
    installVocabHighlight(ctx);

    // ---- dictionary lookups ----
    // Cached per word for the life of the page: hovering back and forth
    // across a line re-requests the same handful of words constantly, and a
    // repeat lookup should never show the loading state a second time.
    const defCache = new Map();
    let defRequestId = 0;
    let popupAnchor = null;
    let popupWord = "";
    let popupCueIndex = -1;

    function updateWordPopupPKnown() {
      if (!showPKnownOn()) {
        wordPopupPKnown.hidden = true;
        wordPopupPKnown.textContent = "";
        return;
      }
      const norm = popupWord.replace(/^[^\w']+|[^\w']+$/g, "").toLowerCase();
      const byWord = ctx.state.cueWordScores[popupCueIndex];
      const detail = byWord && byWord.get(norm);
      if (!detail || !Number.isFinite(detail.p_known)) {
        wordPopupPKnown.hidden = true;
        wordPopupPKnown.textContent = "";
        return;
      }
      const sourceLabel = detail.source === "word_knowledge" ? "真实证据" : "先验估算";
      wordPopupPKnown.textContent = `p_known: ${detail.p_known.toFixed(3)}（${sourceLabel}）`;
      wordPopupPKnown.hidden = false;
      positionPopup();
    }

    async function fillDefinition(word) {
      // Each hover claims a ticket; a slower earlier request that lands
      // after the user has already moved on must not overwrite the popup.
      const myRequest = ++defRequestId;

      if (defCache.has(word)) {
        renderDefinition(defCache.get(word));
        return;
      }
      wordPopupDef.textContent = "查询中…";
      wordPopupDef.className = "word-popup-def loading";
      try {
        const data = await (await fetch(`${API}/api/define?word=${encodeURIComponent(word)}`)).json();
        defCache.set(word, data);
        if (myRequest === defRequestId) renderDefinition(data);
      } catch (e) {
        if (myRequest === defRequestId) {
          wordPopupDef.textContent = "查词失败";
          wordPopupDef.className = "word-popup-def empty";
          positionPopup();
        }
      }
    }

    // Pronunciation: prefer the online dictionary's recorded/high-quality
    // audio (much clearer than the OS voice pack), falling back to the
    // browser's built-in TTS if that request fails (offline, blocked, etc).
    let currentSpeechAudio = null;
    function speakWord(text) {
      if (currentSpeechAudio) { currentSpeechAudio.pause(); currentSpeechAudio = null; }
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();

      const fallbackToTTS = () => {
        if (!("speechSynthesis" in window)) return;
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = "en-US";
        window.speechSynthesis.speak(utter);
      };

      const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`);
      currentSpeechAudio = audio;
      audio.addEventListener("error", fallbackToTTS, { once: true });
      audio.play().catch(fallbackToTTS);
    }

    function renderDefinition(data) {
      wordPopupDef.innerHTML = "";
      if (!data || !data.found) {
        wordPopupDef.className = "word-popup-def empty";
        wordPopupDef.textContent = data && data.error
          ? data.error
          : "词典里没有这个词，点「问一下」让 AI 结合语境解释";
        positionPopup();
        return;
      }
      wordPopupDef.className = "word-popup-def";

      const head = document.createElement("div");
      head.className = "word-popup-head";
      const w = document.createElement("span");
      w.className = "word-popup-word";
      // Show the lemma when the hovered form differs, so "went" makes it
      // obvious the entry shown is "go".
      w.textContent = data.inflected ? `${data.queried} → ${data.word}` : data.word;
      head.appendChild(w);
      if (data.phonetic) {
        const p = document.createElement("span");
        p.className = "word-popup-phonetic";
        p.textContent = `/${data.phonetic}/`;
        head.appendChild(p);
      }
      wordPopupDef.appendChild(head);

      const body = document.createElement("div");
      body.className = "word-popup-trans";
      body.textContent = data.translation;
      wordPopupDef.appendChild(body);
      positionPopup();
    }

    // Re-run whenever the popup's contents change: the definition arrives
    // after the popup is already on screen, and a taller box positioned for
    // the old height would overhang the viewport or cover the word.
    function positionPopup() {
      if (!popupAnchor) return;
      const rect = popupAnchor.getBoundingClientRect();
      const margin = 8;
      let left = rect.left + rect.width / 2 - wordPopup.offsetWidth / 2;
      left = Math.min(Math.max(left, margin), window.innerWidth - wordPopup.offsetWidth - margin);
      let top = rect.top - wordPopup.offsetHeight - margin;
      if (top < margin) top = rect.bottom + margin;  // not enough room above
      wordPopup.style.left = `${left}px`;
      wordPopup.style.top = `${top}px`;
    }

    function showWordPopup(anchorEl, word, sentence, cueIndex) {
      ctx.fns.cancelHide();
      popupAnchor = anchorEl;
      popupWord = word;
      popupCueIndex = cueIndex;
      wordPopup.classList.add("open");
      updateWordPopupPKnown();
      fillDefinition(word);
      positionPopup();

      wordPopup.querySelector(".word-popup-speak").onclick = () => speakWord(word);

      const saveBtn = wordPopup.querySelector(".word-popup-save");
      saveBtn.disabled = false;
      saveBtn.innerHTML = `${icon("star")} 存生词`;
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = "存中…";
        try {
          // Reuses whatever fillDefinition already fetched for the popup
          // itself -- the point is saving the Chinese gloss along with the
          // word, not looking it up a second time. A card with no answer
          // renders as "问一下具体意思" instead (see renderVocabList), so
          // an empty/not-yet-loaded lookup just falls back to that, same as
          // before this existed.
          const def = defCache.get(word);
          const answer = def && def.found ? def.translation : "";
          const tags = def && def.found ? def.tags : [];
          const { video_url, timestamp_seconds } = youtubeJumpTarget();
          await saveVocabEntry({
            video_title: lastKnownVideoTitle,
            subtitle_text: sentence,
            question: word,
            answer,
            tags,
            video_url,
            timestamp_seconds,
          });
          saveBtn.innerHTML = `${icon("check")} 已存`;
        } catch (e) {
          saveBtn.textContent = "失败，重试？";
          saveBtn.disabled = false;
        }
      };

      wordPopup.querySelector(".word-popup-ask").onclick = () => {
        wordPopup.classList.remove("open");
        ctx.fns.switchPage("chat");
        const shown = `"${word}" 在这句话里是什么意思？请解释一下，并给出这个词/短语常见的其他用法：\n"${sentence}"`;
        addMessage("user", shown);
        // Same treatment as asking about a whole line: a word's sense often
        // only resolves from the scene around it.
        runTurn(shown + buildContextBlock(cueIndex == null ? -1 : cueIndex));
      };
    }

    function updateCurrentCue(positionMs, immediate = false) {
      if (subtitleCues.length === 0) return;
      let idx = currentCueIndex;
      // During normal playback timestamps only move forward, so advance the
      // existing index instead of rescanning the entire cue array. A seek or
      // rewind falls back to an upper-bound binary search.
      if (!Number.isFinite(lastPositionMs) || positionMs < lastPositionMs) {
        let lo = 0;
        let hi = subtitleCues.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (subtitleCues[mid].start_ms <= positionMs) lo = mid + 1;
          else hi = mid;
        }
        idx = lo - 1;
      } else {
        if (idx < -1 || idx >= subtitleCues.length) idx = -1;
        while (idx + 1 < subtitleCues.length &&
               subtitleCues[idx + 1].start_ms <= positionMs) idx++;
      }
      lastPositionMs = positionMs;
      // The loop's own seek deliberately lands LOOP_LEAD_MS before the
      // loop-start cue's start_ms, as a pre-roll so the line's first word
      // doesn't get clipped -- but that position genuinely falls inside the
      // *previous* cue's span, so without this the previous line's card
      // flashes "current" for that ~150ms on every single lap. While a loop
      // is running, the line being drilled is never actually the one before
      // it, so floor the display at the loop's own start.
      if (loopActive() && idx < loopStartIdx) idx = loopStartIdx;
      if (idx !== currentCueIndex) {
        const quietFor = Date.now() - Math.max(lastUserScrollAt, lastManualScrollAt);
        // A committed progress-bar seek is an explicit navigation command;
        // it must override the temporary "user is reading" follow-off window.
        highlightCue(idx, immediate || quietFor >= USER_SCROLL_QUIET_MS, immediate);
      }
      // Outside the cue-changed check on purpose: the whole point is to keep
      // moving *within* one line, which is exactly the case that check skips.
      updateSpokenWords(positionMs);
    }

    // How many words of the current line are lit. Kept so the common tick --
    // same word still being spoken -- costs one comparison instead of a
    // classList write per word, which at this poll rate is most ticks.
    let spokenWordCount = -1;

    function updateSpokenWords(positionMs) {
      // No match when the setting is off (nothing was requested, so no cue
      // carries the marker) or when this video has no per-word data at all,
      // which is what makes both cases a no-op without checking either.
      const spans = currentWordSpans;
      if (spans.length === 0) return;
      let lit = 0;
      while (lit < spans.length && Number(spans[lit].dataset.start) <= positionMs) lit++;
      if (lit === spokenWordCount) return;
      if (lit > spokenWordCount) {
        for (let i = Math.max(0, spokenWordCount); i < lit; i++) {
          spans[i].classList.add("spoken");
        }
      } else {
        for (let i = lit; i < spokenWordCount; i++) {
          if (spans[i]) spans[i].classList.remove("spoken");
        }
      }
      spokenWordCount = lit;
    }

    function highlightCue(idx, autoScroll, immediate = false) {
      const prev = currentCardEl;
      if (prev) prev.classList.remove("current");
      if (currentCueIndex >= 0 && cueActionEls[currentCueIndex]) {
        cueActionEls[currentCueIndex].replaceChildren();
      }
      if (currentWordSpans.length) {
        currentWordSpans.forEach((span) => span.classList.remove("spoken"));
      }
      currentCueIndex = idx;
      // The new line starts unlit, and its count has to be invalidated
      // rather than carried over -- otherwise the first tick on a line that
      // happens to light the same number of words as the last one would be
      // mistaken for "nothing changed" and never paint.
      spokenWordCount = -1;
      if (idx < 0) {
        currentCardEl = null;
        currentWordSpans = [];
        return;
      }
      // Playback can jump several minutes ahead of the mounted window. Bring
      // that cue into the small virtualized range before touching its DOM.
      ensureVirtualCueWindow(idx);
      const card = subtitleCardEls[idx];
      if (!card) {
        currentCardEl = null;
        currentWordSpans = [];
        return;
      }
      currentCardEl = card;
      currentWordSpans = subtitleCues[idx] && subtitleCues[idx].words
        ? (cueWordSpans[idx] || []) : [];
      decorateCardWords(idx);
      currentWordSpans = subtitleCues[idx] && subtitleCues[idx].words
        ? (cueWordSpans[idx] || []) : [];
      ensureCardActions(idx);
      card.classList.add("current");
      // Seek jumps use an immediate scroll rather than the normal spring:
      // an offscreen target may be mounted with an estimated height and then
      // corrected by the virtual-list measurement pass. smoothCenterCard()
      // performs a short, guarded post-layout recenter for that transition;
      // a long spring would keep chasing the moving geometry.
      // Every cue change gets its own exact center target, like a lyrics view.
      // There is no viewport tolerance here: even a short line-to-line height
      // difference should be corrected so the new active line lands on the
      // same visual baseline every time.
      let needsCenter = false;
      if (autoScroll && card.isConnected) {
        const rootRect = subsScroll.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const rootCenter = (rootRect.top + rootRect.bottom) / 2;
        const cardCenter = (cardRect.top + cardRect.bottom) / 2;
        needsCenter = !Number.isFinite(cardCenter) || Math.abs(cardCenter - rootCenter) > 1;
      }
      if (autoScroll && needsCenter &&
          (immediate || Date.now() - lastAutoScrollAt >= 180)) {
        // Animate scrollTop ourselves instead of using native smooth
        // scrollIntoView. The virtualized list can recycle cards while a
        // native animation is running; an explicit target plus cancellation
        // on user input keeps the lyric-style motion stable.
        smoothCenterCard(card, immediate);
        lastAutoScrollAt = Date.now();
      }
      scheduleVirtualMeasure();
    }

    // ---- Line loop (A-B repeat) ----
    // Hearing a line five times in a row is the drill that actually trains
    // the ear, so this is deliberately dumb: watch the clock and seek back
    // to the start when playback runs past the end, exactly what a scrubber
    // drag does. No Media Source or buffering tricks -- the panel already
    // has the real <video> element, and treating it like a remote control
    // keeps this working across Direct Play, Direct Stream and transcode
    // alike.

    // A cue's start_ms sits right at the first word's own timestamp, so
    // LOOP_LEAD_MS backs off a little before it -- otherwise the loop would
    // clip the word's own attack on every lap.
    const LOOP_LEAD_MS = 150;
    // A cue's end_ms is NOT "when this sentence's speech ends" -- by
    // construction (see youtube.py's _fill_word_gaps and cut_words_into_cues)
    // it's literally the start_ms of the next sentence's first word: a
    // word's end is defined as the next word's start, all the way through to
    // a cue's last word, whose "next word" is the next sentence's first one.
    // So end_ms already reaches into the next sentence, not short of this
    // one -- LOOP_TAIL_MS has to pull back from it, not pad past it, or
    // every lap plays a beat of the next line before jumping back.
    const LOOP_TAIL_MS = 250;
    // Bounds how far past the end playback can get before the seek fires,
    // so at 50ms the next line never becomes audible. The timer only exists
    // while a loop is on, so this costs nothing the rest of the time.
    const LOOP_TICK_MS = 50;
    // A position this far outside the range can't be the loop's own seek --
    // it's the user dragging Jellyfin's scrubber, so get out of their way
    // instead of yanking them back.
    const LOOP_ESCAPE_MS = 5000;

    let loopStartIdx = -1;
    let loopEndIdx = -1;
    let loopCount = 0;
    let loopTimer = null;

    const loopActive = () => loopStartIdx >= 0;

    function loopBounds() {
      const a = subtitleCues[loopStartIdx];
      const b = subtitleCues[loopEndIdx];
      if (!a || !b) return null;
      const startMs = Math.max(0, a.start_ms - LOOP_LEAD_MS);
      // A very short cue (a one-word "Yes." with barely a beat before the
      // next line) could see end_ms sit less than LOOP_TAIL_MS past its own
      // start, which would pull endMs back past startMs and stall the loop
      // (seek to startMs, immediately past endMs, seek again forever). Floor
      // it instead of letting that invert -- worst case such a cue plays a
      // sliver into the next line, same as before this fix, rather than
      // never playing at all.
      const endMs = Math.max(b.end_ms - LOOP_TAIL_MS, startMs + LOOP_TAIL_MS);
      return { startMs, endMs };
    }

    function setLoop(startIdx, endIdx) {
      loopStartIdx = Math.min(startIdx, endIdx);
      loopEndIdx = Math.max(startIdx, endIdx);
      loopCount = 0;
      const bounds = loopBounds();
      if (!bounds) { clearLoop(); return; }
      if (!loopTimer) loopTimer = setInterval(loopTick, LOOP_TICK_MS);

      // Jump to the top of the loop immediately when playback is outside it:
      // asking to loop a line that already went past means "play it again",
      // not "wait for the next lap". Already inside, leave the position
      // alone so widening a loop doesn't restart it mid-sentence.
      const p = player();
      if (p) {
        const nowMs = p.currentTimeMs();
        if (nowMs < bounds.startMs || nowMs > bounds.endMs) p.seekMs(bounds.startMs);
      }
      renderLoopState();
    }

    function clearLoop() {
      loopStartIdx = loopEndIdx = -1;
      loopCount = 0;
      clearInterval(loopTimer);
      loopTimer = null;
      renderLoopState();
    }

    function loopTick() {
      const bounds = loopBounds();
      if (!bounds) { clearLoop(); return; }
      const p = player();
      if (!p) return;
      const nowMs = p.currentTimeMs();
      if (isNaN(nowMs)) return;

      if (nowMs > bounds.endMs + LOOP_ESCAPE_MS || nowMs < bounds.startMs - LOOP_ESCAPE_MS) {
        clearLoop();
        return;
      }
      // Paused is left strictly alone: pausing mid-loop to read the line is
      // the normal way to use this, and moving the position then would fight
      // the user for no reason.
      if (p.paused() || nowMs < bounds.endMs) return;

      p.seekMs(bounds.startMs);
      loopCount++;
      renderLoopState();
    }

    /** The loop button on a card, and the only way a range gets built.
     *
     *  First click loops that line alone -- far and away the common case.
     *  With a loop already running, clicking a line outside it stretches the
     *  span to reach that line, which is how a two-person exchange gets
     *  drilled as a unit; clicking one inside narrows back down to just that
     *  line. Clicking the button of a single-line loop turns it off.
     *
     *  Extending only from the nearer end means a stray click on the wrong
     *  side of the range can't silently swallow a dozen lines.
     */
    function toggleLoopAt(idx) {
      if (!subtitleCues[idx]) return;
      if (!loopActive()) { setLoop(idx, idx); return; }
      if (loopStartIdx === idx && loopEndIdx === idx) { clearLoop(); return; }
      if (idx < loopStartIdx) setLoop(idx, loopEndIdx);
      else if (idx > loopEndIdx) setLoop(loopStartIdx, idx);
      else setLoop(idx, idx);
    }

    function renderLoopState() {
      for (const index of mountedCueIndices) {
        const el = subtitleCardEls[index];
        if (el) el.classList.remove("in-loop", "loop-edge");
      }
      const on = loopActive();
      loopPillWrap.hidden = !on;
      if (!on) return;

      for (let i = loopStartIdx; i <= loopEndIdx; i++) {
        const card = subtitleCardEls[i];
        if (!card) continue;
        card.classList.add("in-loop");
        if (i === loopStartIdx || i === loopEndIdx) card.classList.add("loop-edge");
      }

      const a = subtitleCues[loopStartIdx];
      const b = subtitleCues[loopEndIdx];
      const lines = loopEndIdx - loopStartIdx + 1;
      loopPillText.textContent =
        (lines === 1 ? ctx.fns.fmt(a.start_ms) : `${ctx.fns.fmt(a.start_ms)} – ${ctx.fns.fmt(b.end_ms)} · ${lines} 句`) +
        (loopCount ? ` · 第 ${loopCount + 1} 遍` : "");
    }

    loopStopBtn.addEventListener("click", clearLoop);
    // Lines either side of the one being asked about. The agent has MCP
    // tools that could fetch this itself, but a line of dialogue is often
    // meaningless alone -- pronouns, callbacks and sarcasm all depend on
    // what came before -- so handing over the window beats hoping it decides
    // to go looking, and saves a tool round trip.
    const CONTEXT_SPAN = 10;

    function buildContextBlock(centerIndex) {
      if (centerIndex < 0 || subtitleCues.length === 0) return "";
      const start = Math.max(0, centerIndex - CONTEXT_SPAN);
      const end = Math.min(subtitleCues.length, centerIndex + CONTEXT_SPAN + 1);
      const lines = [];
      for (let i = start; i < end; i++) {
        const cue = subtitleCues[i];
        // Marking the target line matters: otherwise the model has to guess
        // which of 21 lines the question is actually about.
        lines.push(`[${ctx.fns.fmt(cue.start_ms)}] ${cue.text}${i === centerIndex ? "   ← 问的是这句" : ""}`);
      }
      return `\n\n---\n以下是这句台词前后的对话，供你理解语境（不用逐句翻译）：\n${lines.join("\n")}`;
    }

    /** Ask about the cue at `index`. The chat bubble shows only the question
     *  -- the surrounding dialogue rides along in the prompt alone, so the
     *  transcript doesn't fill up with 21-line quotations. */
    function askAboutCue(index) {
      const cue = subtitleCues[index];
      if (!cue) return;
      ctx.fns.switchPage("chat");
      const shown = `这句台词是什么意思？请解释一下，顺便讲讲里面值得注意的单词/短语/语法：\n"${cue.text}"`;
      addMessage("user", shown);
      runTurn(shown + buildContextBlock(index));
    }

    // ---- vocab ----

    // Matches app.py's MASTERED_STREAK -- a word this many consecutive
    // "known" gradings in a row drops out of the quiz pool (but stays in
    // the vocab book). Duplicated rather than fetched because it only ever
    // needs to agree with the backend's own constant, never be configurable
    // per-request.
    const MASTERED_STREAK = 6;

    // ms -> "明天" / "3 天后" / null if already due. Shared by the quiz's
    // idle screen (nothing due right now, but something will be) and the
    // vocab list's per-card countdown.
    function fmtDueIn(ts) {
      const ms = ts * 1000 - Date.now();
      if (ms <= 0) return null;
      const days = Math.round(ms / 86400000);
      return days <= 0 ? "今天晚些时候" : days === 1 ? "明天" : `${days} 天后`;
    }

    // The full list as last fetched -- kept around (not just handed to
    // renderVocabList and discarded) so the quiz can build its pool and
    // mirror a grading's returned streak locally without a second request.
    let vocabEntries = [];

    let quizQueue = [];
    let quizIndex = 0;
    let quizKnown = 0;
    let quizUnknown = 0;
    let quizMissed = [];

    // Vocabulary-size test state -- separate from the review-quiz state
    // above, since the two run through the same vocabQuiz container but are
    // otherwise unrelated flows.
    let vocabTestStage = 1;
    let vocabTestItems = [];
    let vocabTestIndex = 0;
    let vocabTestAnswers = [];
    let vocabTestStatus = null;  // last /api/vocab-test/status fetch, for the promo line

    function shuffled(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    // Exam-syllabus tags a saved word can carry (see dictionary.py/
    // build_dict.py) -- only words saved after that feature shipped have
    // any of these; older entries just have no tags array to match against,
    // which the scope filter below treats as "excluded once a scope is
    // actually chosen", same as a word genuinely off every list.
    const QUIZ_TAG_OPTIONS = [
      { value: "zk", label: "中考" },
      { value: "gk", label: "高考" },
      { value: "cet4", label: "四级" },
      { value: "cet6", label: "六级" },
      { value: "ky", label: "考研" },
      { value: "toefl", label: "托福" },
      { value: "ielts", label: "雅思" },
      { value: "gre", label: "GRE" },
    ];
    // "0" = 不限 (whatever's due, all at once) -- the original behavior,
    // still the default for anyone who never touches this setting.
    const QUIZ_BATCH_OPTIONS = ["10", "20", "30", "0"];
    const QUIZ_SCOPE_KEY = "english-tutor-quiz-scope";
    const QUIZ_BATCH_KEY = "english-tutor-quiz-batch";

    function loadQuizScope() {
      try {
        const saved = JSON.parse(localStorage.getItem(QUIZ_SCOPE_KEY));
        return Array.isArray(saved) ? saved : [];
      } catch (e) {
        return [];
      }
    }
    function saveQuizScope(tags) { localStorage.setItem(QUIZ_SCOPE_KEY, JSON.stringify(tags)); }
    function loadQuizBatch() { return localStorage.getItem(QUIZ_BATCH_KEY) || "0"; }
    function saveQuizBatch(v) { localStorage.setItem(QUIZ_BATCH_KEY, v); }

    // Has a captured meaning (nothing to self-test against otherwise),
    // hasn't hit MASTERED_STREAK (see renderVocabList's badge, which is
    // the way back in), and matches the current scope filter -- everything
    // except whether it's actually due today, which quizPool below adds.
    // Split out from quizPool so renderQuizStart can tell "nothing due"
    // apart from "nothing matches this scope at all" using the same
    // filtering logic instead of two separate implementations of it.
    function scopedEligible() {
      const scope = loadQuizScope();
      // Checking every single box reads as "don't filter" to anyone
      // clicking it, not "only words carrying at least one exam tag" --
      // the latter would silently exclude every untagged word (most of a
      // real vocab book, including anything saved before tags existed at
      // all, or a word genuinely off all 8 lists), which is the opposite
      // of what "select everything" means to someone using the checkboxes.
      const noFilter = scope.length === 0 || scope.length === QUIZ_TAG_OPTIONS.length;
      return vocabEntries.filter((e) => {
        if (!e.answer || (e.streak || 0) >= MASTERED_STREAK) return false;
        if (noFilter) return true;
        return (e.tags || []).some((t) => scope.includes(t));
      });
    }

    function quizPool() {
      const now = Date.now() / 1000;
      return scopedEligible().filter((e) => (e.next_review_at || 0) <= now);
    }

    async function gradeEntry(entry, result) {
      const res = await fetch(`${API}/api/vocab/${entry.id}/grade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result }),
      });
      const data = await res.json();
      // Mirrors the persisted values onto the in-memory record so the vocab
      // list (mastered badge / due countdown) and the next quiz's pool are
      // correct without re-fetching the whole list.
      if (data && data.ok) {
        entry.streak = data.streak;
        entry.next_review_at = data.next_review_at;
        if (result === "known") {
          ctx.fns.refreshVocabHighlight();
          invalidateDifficultyBadge();
          updateDifficultyBadge();
        }
      }
      return data;
    }

    function startQuiz(pool) {
      const batch = parseInt(loadQuizBatch(), 10) || 0;
      quizQueue = shuffled(pool);
      if (batch > 0) quizQueue = quizQueue.slice(0, batch);
      quizIndex = 0;
      quizKnown = 0;
      quizUnknown = 0;
      quizMissed = [];
      renderQuizCard();
    }

    // Own tab's idle state -- what "抽查" shows before a round is started,
    // and what "退出抽查" returns to. Doesn't re-fetch: vocabEntries is
    // already current enough (loaded when this tab was entered, kept in
    // sync locally by gradeEntry as gradings come in during the round).
    function renderQuizStart() {
      const pool = quizPool();
      const scoped = scopedEligible();
      let emptyReason;
      if (vocabEntries.length === 0) {
        emptyReason = "还没有生词。去生词本页存一些吧。";
      } else {
        // Has an answer and isn't mastered yet, ignoring the scope filter --
        // distinct from "scoped is empty", which could just mean the chosen
        // tags don't match anything even though the book has plenty left.
        const unscopedEligible = vocabEntries.filter((e) => e.answer && (e.streak || 0) < MASTERED_STREAK);
        if (unscopedEligible.length === 0) {
          emptyReason = "没有可抽查的词——生词都已掌握，或者还没查过意思。";
        } else if (scoped.length === 0) {
          emptyReason = "你选的范围里没有符合的生词，换个范围或者取消筛选试试。";
        } else {
          const soonest = Math.min(...scoped.map((e) => e.next_review_at || 0));
          emptyReason = `今天的复习都做完了，下一个词 ${fmtDueIn(soonest) || "很快"} 到期。`;
        }
      }

      // Plain toggle buttons, not native checkboxes/<select> -- this panel
      // doesn't use native form controls anywhere else (the settings page's
      // own dropdowns are hand-rolled too, see populateSelect, precisely
      // because a native popup renders outside the shadow root with none of
      // this stylesheet applied to it). Pills match the same accent-select
      // language already used for .tab-btn.active/.dropdown-item.selected.
      const scope = loadQuizScope();
      const batch = loadQuizBatch();
      const scopeHtml = QUIZ_TAG_OPTIONS.map((opt) => `
        <button class="quiz-scope-pill${scope.includes(opt.value) ? " selected" : ""}" data-tag="${opt.value}">${opt.label}</button>
      `).join("");
      const batchHtml = QUIZ_BATCH_OPTIONS.map((v) => `
        <button class="quiz-batch-pill${v === batch ? " selected" : ""}" data-batch="${v}">${v === "0" ? "不限" : v}</button>
      `).join("");

      const statusLine = vocabTestStatus
        ? (vocabTestStatus.is_default
            ? "还没测过，视频难度目前按默认水平估计"
            : `约 ${vocabTestStatus.vocab_size} 词 · ${vocabTestStatus.level_label}`)
        : "加载中…";

      vocabQuiz.innerHTML = `
        <div class="vocab-test-promo">
          <div class="vocab-test-promo-text">
            <div class="vocab-test-promo-title">你的词汇量</div>
            <div class="vocab-test-promo-sub">${ctx.fns.escapeHtml(statusLine)}</div>
          </div>
          <button class="vocab-test-start-btn">${vocabTestStatus && !vocabTestStatus.is_default ? "重新测一下" : "测一下"}</button>
        </div>
        <div class="quiz-scope">
          <div class="quiz-scope-row">${scopeHtml}</div>
          <div class="quiz-batch-row">
            <span class="quiz-batch-label">一次抽查</span>
            <div class="quiz-batch-pills">${batchHtml}</div>
          </div>
        </div>
        ${pool.length > 0 ? `
          <div class="quiz-start">
            <div class="quiz-start-count">${pool.length} 个词可以抽查</div>
            <button class="quiz-start-btn">${icon("repeat")} 开始抽查</button>
          </div>
        ` : `
          <div class="quiz-start">
            <div class="quiz-start-empty">${ctx.fns.escapeHtml(emptyReason)}</div>
          </div>
        `}
      `;

      // Any pill flipping re-renders the whole thing (simplest way to keep
      // the "X 个词可以抽查" count live as the filter changes) --
      // loadQuizScope() reflected into each pill's `.selected` class above
      // is what makes that rebuild preserve the selection instead of
      // losing it.
      vocabQuiz.querySelectorAll(".quiz-scope-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          const current = loadQuizScope();
          const tag = pill.dataset.tag;
          const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
          saveQuizScope(next);
          renderQuizStart();
        });
      });
      // No re-render here: batch size only affects how many due words get
      // pulled into a round once started, not what's currently eligible/due.
      vocabQuiz.querySelectorAll(".quiz-batch-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          saveQuizBatch(pill.dataset.batch);
          vocabQuiz.querySelectorAll(".quiz-batch-pill").forEach((p) => p.classList.toggle("selected", p === pill));
        });
      });

      const startBtn = vocabQuiz.querySelector(".quiz-start-btn");
      if (startBtn) startBtn.addEventListener("click", () => startQuiz(pool));
      vocabQuiz.querySelector(".vocab-test-start-btn").addEventListener("click", startVocabTest);
    }

    async function loadQuizStart() {
      vocabQuiz.innerHTML = `<div class="quiz-start"><div class="quiz-start-count">加载中…</div></div>`;
      try {
        [vocabEntries, vocabTestStatus] = await Promise.all([
          fetch(`${API}/api/vocab`).then((r) => r.json()),
          fetch(`${API}/api/vocab-test/status`).then((r) => r.json()),
        ]);
      } catch (e) {
        vocabQuiz.innerHTML = `<div class="quiz-start"><div class="quiz-start-empty">加载生词本失败：${ctx.fns.escapeHtml(e.message)}</div></div>`;
        return;
      }
      renderQuizStart();
    }

    // The "退出抽查" click handler.
    function exitQuiz() {
      renderQuizStart();
    }

    function renderQuizCard() {
      if (quizIndex >= quizQueue.length) { renderQuizSummary(); return; }
      const entry = quizQueue[quizIndex];
      // Before the answer's revealed, not after -- hearing the word while
      // trying to recall its meaning is the point, same reasoning as why
      // the word itself is shown first. Reuses the same pronunciation path
      // as the vocab list's speak button (Youdao audio, falling back to the
      // browser's own TTS).
      speakWord(entry.question);
      vocabQuiz.innerHTML = `
        <div class="quiz-topbar">
          <div class="quiz-progress">${quizIndex + 1} / ${quizQueue.length}</div>
          <button class="quiz-exit-btn" title="退出抽查" aria-label="退出抽查">${icon("close")}</button>
        </div>
        <div class="quiz-card">
          <div class="quiz-word">${ctx.fns.escapeHtml(entry.question)}</div>
          <button class="quiz-reveal-btn">显示答案</button>
        </div>
      `;
      vocabQuiz.querySelector(".quiz-exit-btn").addEventListener("click", exitQuiz);
      vocabQuiz.querySelector(".quiz-reveal-btn").addEventListener("click", () => renderQuizCardRevealed(entry));
    }

    function renderQuizCardRevealed(entry) {
      // Same word again on reveal -- this click is a direct user gesture
      // (unlike the auto-play on card arrival above), so there's no
      // autoplay-restriction risk here even if the first one got blocked.
      speakWord(entry.question);
      const quizCard = vocabQuiz.querySelector(".quiz-card");
      quizCard.innerHTML = `
        <div class="quiz-word">${ctx.fns.escapeHtml(entry.question)}</div>
        ${entry.subtitle_text ? `<div class="quiz-subtitle">"${ctx.fns.escapeHtml(entry.subtitle_text)}"</div>` : ""}
        <div class="quiz-answer">${ctx.fns.renderMarkdown(entry.answer)}</div>
        <div class="quiz-grade-row">
          <button class="quiz-grade-btn quiz-grade-unknown">${icon("close")} 不认识</button>
          <button class="quiz-grade-btn quiz-grade-known">${icon("check")} 认识</button>
        </div>
      `;
      quizCard.querySelector(".quiz-grade-unknown").addEventListener("click", () => submitGrade(entry, false));
      quizCard.querySelector(".quiz-grade-known").addEventListener("click", () => submitGrade(entry, true));
    }

    async function submitGrade(entry, known) {
      vocabQuiz.querySelectorAll(".quiz-grade-btn").forEach((b) => { b.disabled = true; });
      try {
        await gradeEntry(entry, known ? "known" : "unknown");
      } catch (e) {
        // Best-effort: session counters below still advance so one network
        // hiccup doesn't stall the whole quiz -- this grading just won't
        // have persisted, same tradeoff as pushDeepSeekConfig elsewhere.
      }
      if (known) quizKnown++; else { quizUnknown++; quizMissed.push(entry); }
      quizIndex++;
      renderQuizCard();
    }

    function renderQuizSummary() {
      vocabQuiz.innerHTML = `
        <div class="quiz-topbar">
          <div class="quiz-progress">完成</div>
          <button class="quiz-exit-btn" title="退出抽查" aria-label="退出抽查">${icon("close")}</button>
        </div>
        <div class="quiz-summary">
          <div class="quiz-summary-line quiz-summary-known">${icon("check")} 认识 ${quizKnown} 个</div>
          <div class="quiz-summary-line quiz-summary-unknown">${icon("close")} 不认识 ${quizUnknown} 个</div>
          <div class="quiz-summary-actions">
            ${quizMissed.length > 0
              ? `<button class="quiz-retry-missed-btn">只复习刚才不认识的（${quizMissed.length}）</button>` : ""}
            <button class="quiz-exit-summary-btn">退出抽查</button>
          </div>
        </div>
      `;
      vocabQuiz.querySelector(".quiz-exit-btn").addEventListener("click", exitQuiz);
      vocabQuiz.querySelector(".quiz-exit-summary-btn").addEventListener("click", exitQuiz);
      const retryBtn = vocabQuiz.querySelector(".quiz-retry-missed-btn");
      if (retryBtn) retryBtn.addEventListener("click", () => startQuiz(quizMissed));
    }

    // ---- vocabulary-size test -------------------------------------------
    //
    // Two-stage adaptive test (see vocab_test.py): stage 1 samples 5 widely-
    // spaced frequency ranks to get a rough estimate, stage 2 re-samples 5
    // ranks around that estimate to refine it. Reuses
    // .quiz-card/.quiz-topbar from the review quiz above -- it's the same
    // "one word, one decision" shape, just without an answer to reveal.

    function exitVocabTest() {
      previewOverlay.hidden = true;
      previewOverlay.innerHTML = "";
      vocabTestInOverlay = false;
      renderQuizStart();
    }

    let vocabTestInOverlay = false;
    const vocabTestHost = () => vocabTestInOverlay ? previewOverlay : vocabQuiz;

    async function startVocabTest() {
      vocabTestInOverlay = true;
      previewOverlay.hidden = false;
      const host = vocabTestHost();
      host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-count">准备题目中…</div></div></div>`;
      vocabTestAnswers = [];
      vocabTestStage = 1;
      try {
        const data = await (await fetch(`${API}/api/vocab-test/stage1`, { method: "POST" })).json();
        vocabTestItems = data.items;
        vocabTestTotal = vocabTestItems.length;
      } catch (e) {
        host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-empty">题目加载失败：${ctx.fns.escapeHtml(e.message)}</div></div></div>`;
        return;
      }
      vocabTestIndex = 0;
      renderVocabTestCard();
    }

    let vocabTestTotal = null;

    function renderVocabTestCard() {
      if (vocabTestIndex >= vocabTestItems.length) {
        if (vocabTestStage === 1) { advanceVocabTestToStage2(); return; }
        finishVocabTest();
        return;
      }
      const item = vocabTestItems[vocabTestIndex];
      const doneSoFar = vocabTestAnswers.length;
      const meaning = Array.isArray(item.meaning_options) && item.meaning_options.length === 6;
      const host = vocabTestHost();
      host.innerHTML = `
        <div class="vocab-test-modal">
        <div class="quiz-topbar">
          <div class="quiz-progress">第 ${doneSoFar + 1} 题${vocabTestTotal ? `（共 ${vocabTestTotal} 题）` : ""}</div>
          <button class="quiz-exit-btn" title="退出测试" aria-label="退出测试">${icon("close")}</button>
        </div>
        <div class="quiz-card">
          <div class="vocab-test-kicker">${meaning ? "选择最接近的中文释义" : "凭第一反应回答，不确定就选“模糊”"}</div>
          <div class="quiz-word">${ctx.fns.escapeHtml(item.lemma)}</div>
          ${meaning
            ? `<div class="vocab-meaning-options">${item.meaning_options.map((option, i) =>
                `<button class="vocab-meaning-option" data-option="${i}">${ctx.fns.escapeHtml(option)}</button>`).join("")}
                <button class="vocab-meaning-unknown">${icon("close")} 不认识，不做猜测</button></div>`
            : `<div class="quiz-grade-row">
                <button class="quiz-grade-btn quiz-grade-unknown">${icon("close")} 不认识</button>
                <button class="quiz-grade-btn quiz-grade-unsure">模糊</button>
                <button class="quiz-grade-btn quiz-grade-known">${icon("check")} 认识</button>
              </div>`}
        </div>
        </div>
      `;
      host.querySelector(".quiz-exit-btn").addEventListener("click", exitVocabTest);
      const meaningOptions = host.querySelectorAll(".vocab-meaning-option");
      if (meaningOptions.length) meaningOptions.forEach((button) => button.addEventListener("click", () => {
        const selected = Number(button.dataset.option);
        submitVocabTestAnswer(item, selected === item.correct_option ? 2 : 0);
      }));
      const meaningUnknown = host.querySelector(".vocab-meaning-unknown");
      if (meaningUnknown) meaningUnknown.addEventListener("click", () => submitVocabTestAnswer(item, 0));
      const unknown = host.querySelector(".quiz-grade-unknown");
      const unsure = host.querySelector(".quiz-grade-unsure");
      const known = host.querySelector(".quiz-grade-known");
      if (unknown) unknown.addEventListener("click", () => submitVocabTestAnswer(item, 0));
      if (unsure) unsure.addEventListener("click", () => submitVocabTestAnswer(item, 1));
      if (known) known.addEventListener("click", () => submitVocabTestAnswer(item, 2));
    }

    function submitVocabTestAnswer(item, rating) {
      vocabTestAnswers.push({ lemma: item.lemma, rank: item.rank, rating,
        known: rating === 2, is_fake: !!item.is_fake });
      vocabTestIndex++;
      renderVocabTestCard();
    }

    async function advanceVocabTestToStage2() {
      const host = vocabTestHost();
      host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-count">准备第二阶段…</div></div></div>`;
      try {
        const data = await (await fetch(`${API}/api/vocab-test/stage2`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: vocabTestAnswers }),
        })).json();
        vocabTestItems = data.items;
        vocabTestTotal = vocabTestAnswers.length + vocabTestItems.length;
      } catch (e) {
        host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-empty">题目加载失败：${ctx.fns.escapeHtml(e.message)}</div></div></div>`;
        return;
      }
      vocabTestStage = 2;
      vocabTestIndex = 0;
      renderVocabTestCard();
    }

    async function finishVocabTest() {
      const host = vocabTestHost();
      host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-count">算分中…</div></div></div>`;
      let result;
      try {
        result = await (await fetch(`${API}/api/vocab-test/finish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: vocabTestAnswers }),
        })).json();
      } catch (e) {
        host.innerHTML = `<div class="vocab-test-modal"><div class="quiz-start"><div class="quiz-start-empty">提交失败：${ctx.fns.escapeHtml(e.message)}</div></div></div>`;
        return;
      }
      vocabTestStatus = { vocab_size: result.vocab_size, level_label: result.level_label, is_default: false };
      host.innerHTML = `
        <div class="vocab-test-modal">
        <div class="quiz-topbar">
          <div class="quiz-progress">完成</div>
          <button class="quiz-exit-btn" title="退出测试" aria-label="退出测试">${icon("close")}</button>
        </div>
        <div class="vocab-test-result">
          <div class="vocab-test-result-size">约 ${result.vocab_size} 词</div>
          <div class="vocab-test-result-range">合理范围 ${result.vocab_size_low} - ${result.vocab_size_high} 词</div>
          <div class="vocab-test-result-label">${ctx.fns.escapeHtml(result.level_label)}</div>
          ${result.retake_suggested
            ? `<div class="vocab-test-retake-warning">这次答题里有 ${result.fake_known} 个"认识"给了不存在的词，结果可能不准，建议重新测一次。</div>`
            : ""}
          <div class="quiz-summary-actions">
            ${result.retake_suggested ? `<button class="quiz-retry-missed-btn">重新测一次</button>` : ""}
            <button class="quiz-exit-summary-btn">完成</button>
          </div>
        </div>
        </div>
      `;
      host.querySelector(".quiz-exit-btn").addEventListener("click", exitVocabTest);
      host.querySelector(".quiz-exit-summary-btn").addEventListener("click", exitVocabTest);
      const retryBtn = host.querySelector(".quiz-retry-missed-btn");
      if (retryBtn) retryBtn.addEventListener("click", startVocabTest);
    }

    async function saveVocabEntry(payload) {
      const res = await fetch(`${API}/api/vocab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`保存失败（HTTP ${res.status}）`);
      const data = await res.json();
      ctx.fns.refreshVocabHighlight();
      invalidateDifficultyBadge();
      updateDifficultyBadge();
      return data;
    }

    async function loadVocabList() {
      vocabEmpty.hidden = false;
      vocabEmpty.textContent = "正在加载…";
      try {
        vocabEntries = await (await fetch(`${API}/api/vocab`)).json();
        renderVocabList(vocabEntries);
      } catch (e) {
        vocabEmpty.hidden = false;
        vocabEmpty.textContent = `加载生词本失败：${e.message}`;
      }
    }

    function buildSubtitleLine(entry) {
      const sub = document.createElement("div");
      sub.className = "vocab-subtitle";
      sub.textContent = `"${entry.subtitle_text}"`;
      return sub;
    }

    /** Jump-to-video button for a card that has one (YouTube only -- see
     *  youtubeJumpTarget; older entries and anything saved on Jellyfin just
     *  don't have video_url, so this returns null and callers skip it).
     *  Plain `href`, no target="_blank": this panel is injected right into
     *  the YouTube tab itself, so the useful thing is jumping the same tab
     *  to that moment, not opening a second one next to it. */
    function buildJumpBtn(entry) {
      if (!entry.video_url) return null;
      const jump = document.createElement("a");
      jump.className = "vocab-jump-btn";
      jump.href = entry.video_url;
      jump.innerHTML = icon("jump");
      jump.title = "跳转到收藏时的视频位置";
      jump.setAttribute("aria-label", "跳转到收藏时的视频位置");
      jump.addEventListener("click", (e) => {
        // Already sitting on the same video? Seek in place instead of
        // reloading the exact page it's already on -- a navigation would
        // just tear down and re-fetch everything to end up right back here.
        const p = player();
        if (p && p.kind === "youtube" && entry.timestamp_seconds != null &&
            youtubeVideoId(entry.video_url) === youtubeVideoId(location.href)) {
          e.preventDefault();
          p.seekMs(entry.timestamp_seconds * 1000);
        }
      });
      return jump;
    }

    function renderVocabList(entries) {
      vocabList.innerHTML = "";
      if (!entries || entries.length === 0) {
        vocabEmpty.hidden = false;
        vocabEmpty.textContent = "还没有生词。在字幕里把鼠标放到单词上，点\"存生词\"。";
        vocabList.appendChild(vocabEmpty);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const entry of entries) {
        const card = document.createElement("div");
        card.className = "vocab-card";

        // Only meaningful between a first correct grading and either
        // mastery or the review actually coming due -- fmtDueIn already
        // returns null once next_review_at has passed, so a word that's
        // sitting in the quiz pool right now shows neither this nor the
        // mastered badge, same as it always has.
        const dueIn = (entry.streak || 0) > 0 && (entry.streak || 0) < MASTERED_STREAK
          ? fmtDueIn(entry.next_review_at || 0) : null;

        if (entry.created_at || (entry.streak || 0) >= MASTERED_STREAK || dueIn) {
          const meta = document.createElement("div");
          meta.className = "vocab-meta";
          meta.textContent = entry.created_at ? new Date(entry.created_at * 1000).toLocaleString() : "";
          if ((entry.streak || 0) >= MASTERED_STREAK) {
            const badge = document.createElement("button");
            badge.className = "vocab-mastered-badge";
            badge.innerHTML = `${icon("check")} 已掌握`;
            badge.title = "点一下重新放回抽查范围";
            badge.addEventListener("click", async () => {
              badge.disabled = true;
              try {
                await gradeEntry(entry, "unknown");
                renderVocabList(vocabEntries);
              } catch (e) { badge.disabled = false; }
            });
            meta.appendChild(badge);
          } else if (dueIn) {
            const due = document.createElement("span");
            due.className = "vocab-due-badge";
            due.textContent = `${dueIn}复习`;
            meta.appendChild(due);
          }
          card.appendChild(meta);
        }
        if (entry.subtitle_text) {
          card.appendChild(buildSubtitleLine(entry));
        }

        const qRow = document.createElement("div");
        qRow.className = "vocab-question-row";
        const q = document.createElement("span");
        q.className = entry.answer ? "vocab-question" : "vocab-question vocab-word";
        q.textContent = entry.question;
        qRow.appendChild(q);
        const speak = document.createElement("button");
        speak.className = "vocab-speak-btn";
        speak.innerHTML = icon("speaker");
        speak.title = "朗读";
        speak.setAttribute("aria-label", "朗读");
        speak.addEventListener("click", () => speakWord(entry.question));
        qRow.appendChild(speak);
        const jumpBtn = buildJumpBtn(entry);
        if (jumpBtn) qRow.appendChild(jumpBtn);
        card.appendChild(qRow);

        // Same exam-syllabus tags the quiz's scope filter reads (see
        // QUIZ_TAG_OPTIONS) -- read-only here, just labeling the word, not
        // another set of toggles. Only words saved after that feature
        // shipped (or backfilled) have any; most cards show nothing here,
        // same as before this existed.
        if (entry.tags && entry.tags.length > 0) {
          const tagsRow = document.createElement("div");
          tagsRow.className = "vocab-tags-row";
          for (const t of entry.tags) {
            const opt = QUIZ_TAG_OPTIONS.find((o) => o.value === t);
            if (!opt) continue;
            const pill = document.createElement("span");
            pill.className = "vocab-tag-pill";
            pill.textContent = opt.label;
            tagsRow.appendChild(pill);
          }
          if (tagsRow.children.length > 0) card.appendChild(tagsRow);
        }

        if (entry.answer) {
          const a = document.createElement("div");
          a.className = "vocab-answer";
          a.innerHTML = ctx.fns.renderMarkdown(entry.answer);
          card.appendChild(a);
        } else {
          const ask = document.createElement("button");
          ask.className = "vocab-ask-btn";
          ask.innerHTML = `${icon("help")} 问一下具体意思`;
          ask.addEventListener("click", () => {
            ctx.fns.switchPage("chat");
            const question = `"${entry.question}" 在这句话里是什么意思？请解释一下，并给出这个词/短语常见的其他用法：\n"${entry.subtitle_text || entry.question}"`;
            addMessage("user", question);
            runTurn(question);
          });
          card.appendChild(ask);
        }

        const del = document.createElement("button");
        del.className = "vocab-delete-btn";
        del.innerHTML = icon("trash");
        del.title = "删除这条";
        del.setAttribute("aria-label", "删除这条");
        del.addEventListener("click", async () => {
          del.disabled = true;
          try {
            await fetch(`${API}/api/vocab/${entry.id}`, { method: "DELETE" });
            card.remove();
            if (!vocabList.querySelector(".vocab-card")) renderVocabList([]);
          } catch (e) { del.disabled = false; }
        });
        card.appendChild(del);
        frag.appendChild(card);
      }
      vocabEmpty.hidden = true;
      vocabList.appendChild(frag);
    }

    // ---- phrase collection ----
    // Cards reuse the vocab list's own CSS classes (.vocab-card etc.) --
    // same shape (phrase in the question slot, meaning in the answer slot),
    // no reason to duplicate the styling. Simpler than the vocab list in one
    // way: meaning is required by suggest_phrase's schema, so there's no
    // empty-answer / "问一下" branch to handle here at all.

    function installPhrases(ctx) {
      async function loadPhraseList() {
        phraseEmpty.hidden = false;
        phraseEmpty.textContent = "正在加载…";
        try {
          renderPhraseList(await (await fetch(`${API}/api/phrases`)).json());
        } catch (e) {
          phraseEmpty.hidden = false;
          phraseEmpty.textContent = `加载短语收藏失败：${e.message}`;
        }
      }

      function renderPhraseList(entries) {
        phraseList.innerHTML = "";
        if (!entries || entries.length === 0) {
          phraseEmpty.hidden = false;
          phraseEmpty.textContent =
            "还没有收藏的短语。跟 AI 聊字幕的时候，它觉得有值得记的短语会主动推荐，你在对话里点\"收藏\"就行。";
          phraseList.appendChild(phraseEmpty);
          return;
        }
        const frag = document.createDocumentFragment();
        for (const entry of entries) {
          const card = document.createElement("div");
          card.className = "vocab-card";

          if (entry.created_at) {
            const meta = document.createElement("div");
            meta.className = "vocab-meta";
            meta.textContent = new Date(entry.created_at * 1000).toLocaleString();
            card.appendChild(meta);
          }
          if (entry.subtitle_text) {
            card.appendChild(buildSubtitleLine(entry));
          }

          const qRow = document.createElement("div");
          qRow.className = "vocab-question-row";
          const q = document.createElement("span");
          q.className = "vocab-question";
          q.textContent = entry.phrase;
          qRow.appendChild(q);
          const jumpBtn = buildJumpBtn(entry);
          if (jumpBtn) qRow.appendChild(jumpBtn);
          card.appendChild(qRow);

          const a = document.createElement("div");
          a.className = "vocab-answer";
          a.innerHTML = ctx.fns.renderMarkdown(entry.meaning);
          card.appendChild(a);

          const del = document.createElement("button");
          del.className = "vocab-delete-btn";
          del.innerHTML = icon("trash");
          del.title = "删除这条";
          del.setAttribute("aria-label", "删除这条");
          del.addEventListener("click", async () => {
            del.disabled = true;
            try {
              await fetch(`${API}/api/phrases/${entry.id}`, { method: "DELETE" });
              card.remove();
              if (!phraseList.querySelector(".vocab-card")) renderPhraseList([]);
            } catch (e) { del.disabled = false; }
          });
          card.appendChild(del);
          frag.appendChild(card);
        }
        phraseEmpty.hidden = true;
        phraseList.appendChild(frag);
      }

      ctx.fns.loadPhraseList = loadPhraseList;
      ctx.fns.renderPhraseList = renderPhraseList;
    }
    installPhrases(ctx);

    // ---- Jellyfin playback tracking ----
    // The whole reason for injecting into Jellyfin's page instead of framing
    // it: the real <video> element is reachable, so position is read straight
    // off it rather than polled out of an API.

    function installJellyfin(ctx) {
      function findVideo() {
        // Jellyfin creates and destroys the element per playback session, and
        // on an episode change the outgoing one can still be in the DOM while
        // the new one spins up. Taking the first match would then read the
        // previous episode's clock, which is what made subtitle highlighting
        // drift after switching videos -- so prefer one that's actually live.
        const candidates = Array.from(document.querySelectorAll("video"));
        // Some Jellyfin builds mount the player inside a web component, where
        // a document-level query can't see it -- walk open shadow roots too.
        for (const el of document.querySelectorAll("*")) {
          if (el.shadowRoot) candidates.push(...el.shadowRoot.querySelectorAll("video"));
        }
        const usable = candidates.filter(
          (v) => v.isConnected && v.duration && !isNaN(v.duration)
        );
        return usable.find((v) => !v.paused) || usable[0] || candidates[0] || null;
      }
      ctx.fns.findVideo = findVideo;
    }
    installJellyfin(ctx);

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
          if (ctx.state.currentPage === "subs") loadSubtitleCues();
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
      if (ctx.state.currentPage === "subs") loadSubtitleCues();
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
          `▶ ${p.title} — ${ctx.fns.fmt(p.position_ms)}/${ctx.fns.fmt(p.duration_ms)}  |  ${data.status_line || ""}`;
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

    // ---- 预习卡片 ----------------------------------------------------------
    //
    // YouTube only, same scoping as the difficulty badge and jump-to-moment:
    // built around YouTube's video-open moment and /api/preview. The endpoint
    // can use either an anonymous caption track or the browser-authenticated
    // local track uploaded for a members-only video.

    const PREVIEW_SHOWN_KEY = "english-tutor-preview-shown";        // { [videoId]: shownAtMs }
    const PREVIEW_DISMISSED_KEY = "english-tutor-preview-dismissed-at"; // { [videoId]: dismissedAtMs }
    const PREVIEW_SHOWN_TTL_MS = 10 * 60 * 1000;        // 同一视频 10 分钟内不重复
    const PREVIEW_DISMISS_COOLDOWN_MS = 60 * 60 * 1000; // 上次点了"直接看" < 1h 不显示

    let previewedWordForms = new Set();

    function loadPreviewShownMap() {
      try { return JSON.parse(localStorage.getItem(PREVIEW_SHOWN_KEY) || "{}"); }
      catch (e) { return {}; }
    }
    function markPreviewShown(videoId) {
      const m = loadPreviewShownMap();
      m[videoId] = Date.now();
      const trimmed = Object.fromEntries(
        Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 50));
      try { localStorage.setItem(PREVIEW_SHOWN_KEY, JSON.stringify(trimmed)); } catch (e) {}
    }
    function previewRecentlyShown(videoId) {
      const t = loadPreviewShownMap()[videoId];
      return !!t && (Date.now() - t) < PREVIEW_SHOWN_TTL_MS;
    }
    function loadPreviewDismissedMap() {
      try {
        const value = JSON.parse(localStorage.getItem(PREVIEW_DISMISSED_KEY) || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch (e) { return {}; }
    }
    function markPreviewDismissed(videoId) {
      if (!videoId) return;
      const m = loadPreviewDismissedMap();
      m[videoId] = Date.now();
      const trimmed = Object.fromEntries(
        Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 50));
      try { localStorage.setItem(PREVIEW_DISMISSED_KEY, JSON.stringify(trimmed)); } catch (e) {}
    }
    function previewRecentlyDismissed(videoId) {
      const t = loadPreviewDismissedMap()[videoId];
      return (Date.now() - t) < PREVIEW_DISMISS_COOLDOWN_MS;
    }

    /** The gate rules that are about *user/timing state* rather than the
     *  video's own word data -- that half (凑不够 2 个词) lives server-side
     *  in /api/preview's MIN_PREVIEW_CANDIDATES check. No minimum-watched-
     *  time gate here on purpose: the prompt is meant to show the instant
     *  the word list is ready, not some fixed delay after that. */
    function previewGateOpen(videoId) {
      if (previewRecentlyShown(videoId)) return false;
      if (previewRecentlyDismissed(videoId)) return false;
      return true;
    }

    async function updatePreviewPrompt() {
      const p = player();
      const videoId = p && p.kind === "youtube" ? youtubeVideoId(location.href) : null;
      if (!videoId) {
        previewBar.hidden = true;
        previewLastVideoId = null;
        previewAnswered = false;
        return;
      }
      if (videoId !== previewLastVideoId) {
        previewLastVideoId = videoId;
        previewRequestSeq++;
        previewAnswered = false;
        previewBar.hidden = true;
        previewPrefetchPromise = null;
      }
      if (previewSession) return;      // a round is already on screen
      if (!previewBar.hidden) return;  // already showing for this video
      if (previewAnswered) return;     // already decided (shown, or "no") for this video

      // Kicked off the instant the video is known, and shown the instant
      // it resolves -- no artificial delay before either. The fetch itself
      // is two sequential network round trips to YouTube (list tracks,
      // pull one track's text) and measured 3-4s regardless of video
      // length (a 4+ hour video timed the same as a 13-minute one -- this
      // is fixed round-trip latency, not something that scales with
      // transcript size), so that's the only wait there is.
      if (!previewPrefetchPromise) {
        previewPrefetchPromise = fetch(`${API}/api/preview/${encodeURIComponent(videoId)}`)
          .then((res) => res.json())
          .catch(() => null);
      }
      if (!previewGateOpen(videoId)) return;
      if (previewFetchInFlight) return;

      const requestSeq = previewRequestSeq;
      previewFetchInFlight = true;
      try {
        const data = await previewPrefetchPromise;
        if (videoId !== previewLastVideoId || requestSeq !== previewRequestSeq) return;
        if (!data) {
          previewPrefetchPromise = null;  // network hiccup -- next tick retries the fetch itself
          return;
        }
        if (!data.should_show) {
          previewAnswered = true;
          return;
        }
        showPreviewBar(videoId, data);
      } finally {
        previewFetchInFlight = false;
      }
    }

    function showPreviewBar(videoId, data) {
      previewAnswered = true;
      const total = data.cards.length + data.more;
      const repeated = data.cards.filter((c) => c.hits > 1).length;
      previewBarText.innerHTML = `这个视频里有 <b>${total}</b> 个你可能不认识的词` +
        (repeated > 0 ? `，<b>${repeated}</b> 个会反复出现` : "");
      previewBar.hidden = false;
      previewBar.__data = data;
    }

    previewSkipBtn.addEventListener("click", () => {
      previewBar.hidden = true;
      markPreviewDismissed(previewLastVideoId);
    });

    previewStartBtn.addEventListener("click", () => {
      const p = player();
      const data = previewBar.__data;
      if (!p || !data) return;
      previewBar.hidden = true;
      markPreviewShown(previewLastVideoId);
      // The first few seconds are usually a greeting/intro -- seeking to 0
      // is zero loss, and lets a round started a little into playback
      // still start from the top.
      p.pause();
      p.seekMs(0);
      startPreviewSession(previewLastVideoId, data.cards, data.more);
    });

    function startPreviewSession(videoId, cards, more) {
      previewSession = { videoId, cards, index: 0, more };
      previewOverlay.hidden = false;
      renderPreviewCard();
    }

    function renderPreviewCard() {
      const s = previewSession;
      const c = s.cards[s.index];
      const tagsText = c.tags && c.tags.length ? ` · ${c.tags.join("/")}` : "";
      previewOverlay.innerHTML = `
        <div class="preview-card">
          <div class="pc-row1">
            <span class="pc-word">${ctx.fns.escapeHtml(c.lemma)}</span>
            <span class="pc-idx">${s.index + 1} / ${s.cards.length}</span>
          </div>
          <div class="pc-phon">
            <button class="pc-speak" type="button" title="发音" aria-label="发音">${icon("speaker", 12)}</button>
            <span>${ctx.fns.escapeHtml(c.phonetic || "")}</span>
          </div>
          <p class="pc-def">${ctx.fns.escapeHtml(c.definition || "词典里没查到这个词")}</p>
          ${c.sentence ? `<p class="pc-quote">${ctx.fns.escapeHtml(c.sentence)}</p>` : ""}
          <div class="pc-facts">本视频出现 ${c.hits} 次${c.in_wordbook ? " · 已在生词本" : ""}${tagsText}</div>
          <div class="pc-acts">
            <button class="preview-btn" id="pcKnownBtn" type="button">我认识这个</button>
            <button class="preview-btn primary" id="pcNextBtn" type="button">${s.index === s.cards.length - 1 ? "完成" : "下一个 →"}</button>
          </div>
        </div>`;
      previewOverlay.querySelector(".pc-speak").addEventListener("click", () => speakWord(c.lemma));
      $("pcKnownBtn").addEventListener("click", () => advancePreviewCard("known"));
      $("pcNextBtn").addEventListener("click", () => advancePreviewCard("next"));
    }

    function advancePreviewCard(action) {
      const s = previewSession;
      const c = s.cards[s.index];
      const resultRequest = fetch(`${API}/api/preview/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lemma: c.lemma, action }),
      }).catch(() => {});
      (c.forms && c.forms.length ? c.forms : [c.lemma]).forEach((f) => previewedWordForms.add(f));
      applyPreviewHighlight();
      if (action === "known") {
        // The previous vocab-highlight response may still have this word in
        // its unknown set. Remove that stale underline immediately, then let
        // the server-backed refresh reconcile every mounted cue.
        for (const index of mountedCueIndices) {
          const spans = cueWordSpans[index];
          if (!spans) continue;
          spans.forEach((span) => {
            const norm = span.textContent.replace(/^[^\w']+|[^\w']+$/g, "").toLowerCase();
            if (previewedWordForms.has(norm)) span.classList.remove("sub-word-unknown");
          });
        }
        // Wait for the evidence write before re-reading the server-side
        // knowledge map; otherwise the highlight request can win the race
        // and briefly restore the old unknown underline.
        resultRequest.then(() => {
          ctx.fns.refreshVocabHighlight();
          invalidateDifficultyBadge();
          updateDifficultyBadge();
        });
      }
      s.index++;
      if (s.index < s.cards.length) {
        renderPreviewCard();
      } else {
        renderPreviewEnd();
      }
    }

    function renderPreviewEnd() {
      const s = previewSession;
      if (s.more <= 0) {
        finishPreviewSession();
        return;
      }
      // Matches app.py's PREVIEW_CARDS_PER_ROUND -- the server always
      // returns up to that many regardless of what's asked for, so the
      // button promising a different number would be a lie half the time.
      const nextBatch = Math.min(4, s.more);
      previewOverlay.innerHTML = `
        <div class="preview-end">
          <div class="pe-text">还有 <b>${s.more}</b> 个词没过。这 ${s.cards.length} 个已经在字幕里标出来了。</div>
          <div class="pe-btns">
            <button class="preview-btn" id="peMoreBtn" type="button">再来 ${nextBatch} 张</button>
            <button class="preview-btn primary" id="peDoneBtn" type="button">开始看</button>
          </div>
        </div>`;
      $("peDoneBtn").addEventListener("click", finishPreviewSession);
      $("peMoreBtn").addEventListener("click", loadMorePreviewCards);
    }

    async function loadMorePreviewCards() {
      const s = previewSession;
      const seen = s.cards.map((c) => c.lemma).join(",");
      previewOverlay.innerHTML = `<div class="preview-end"><div class="pe-text">加载中…</div></div>`;
      try {
        const res = await fetch(
          `${API}/api/preview/${encodeURIComponent(s.videoId)}?exclude=${encodeURIComponent(seen)}`);
        const data = await res.json();
        if (previewSession !== s) return;
        if (!data.should_show || !data.cards.length) {
          finishPreviewSession();
          return;
        }
        s.cards = s.cards.concat(data.cards);
        s.more = data.more;
        s.index = s.cards.length - data.cards.length;  // resume at the first new card
        renderPreviewCard();
      } catch (e) {
        if (previewSession === s) finishPreviewSession();
      }
    }

    function finishPreviewSession() {
      previewOverlay.hidden = true;
      previewOverlay.innerHTML = "";
      previewSession = null;
      const p = player();
      if (p) p.play();
    }

    /** Preview-cards收口: previously-previewed words, spotted for real in
     *  the subtitle cards -- see .sub-word-previewed in panel.css. Same
     *  shape as applyVocabHighlight, but not per-cue: a previewed word is
     *  marked wherever it appears, not looked up by cue index. */
    function applyPreviewHighlight() {
      if (previewedWordForms.size === 0) return;
      for (const index of mountedCueIndices) applyPreviewHighlightToCard(index);
    }

    function applyPreviewHighlightToCard(index) {
      const spans = cueWordSpans[index];
      if (!spans) return;
      spans.forEach((span) => {
        const norm = span.textContent.replace(/^[^\w']+|[^\w']+$/g, "").toLowerCase();
        if (previewedWordForms.has(norm)) span.classList.add("sub-word-previewed");
      });
    }

    refreshContext();
    setInterval(refreshContext, 4000);
    loadVocabList();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
