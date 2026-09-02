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
