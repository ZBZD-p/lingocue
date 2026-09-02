# tutor-panel.js 拆分方案

> 基线：只分析，不改变行为；当前 static/tutor-panel.js 为 4,676 行，extension/tutor-panel.js 要求与它逐字节一致。阶段 0 已将可重复构建接入仓库，后续拆分仍以本方案为约束。

## 阶段 0：已完成

阶段 0 已按第 522 行完成机械切分，并已接入可重复构建：

- 源码分片目录：`panel-src/`
- 分片 manifest：`panel-src/manifest.json`（显式顺序为 `00-prelude.js`、`99-rest.js`）
- 构建命令：`python tools/build_panel.py`
- CI/本地校验命令：`python tools/build_panel.py --check`
- 构建输出：`static/tutor-panel.js` 和 `extension/tutor-panel.js`

分片按原文件字节读取和拼接，不进行换行转换或代码格式化；阶段 0 的验收以构建结果与基线文件的 SHA-256 一致为准。

## 1. 闭包状态清单

以下表格完整转录 .codex-inventory.txt，声明行号以当前基线为准。分组按“引用它的分节数量”，不是引用次数；同一分节内多次引用仍只算一个分节。

### 0 个分节（仅 init 局部/未被分节引用）

| 变量与声明行 | 引用分节与次数 |
|---|---|
| $@586 | (none) |
| toggleBtn@635 | (none) |
| portraitLock@642 | (none) |
| resizer@707 | (none) |
| priorSelect@708 | (none) |
| endResize@723 | (none) |

### 1 个分节（可随该分节搬迁）

| 变量与声明行 | 引用分节与次数 |
|---|---|
| chatEl@587 | chat history=11 |
| sendBtn@589 | chat history=3 |
| settingsList@590 | dropdowns=4 |
| contextBar@591 | playback source=3 |
| newChatBtn@592 | chat history=1 |
| composerEl@593 | pages=1 |
| subsEmpty@595 | subtitle cards=11 |
| loopPillWrap@597 | Line loop=1 |
| loopPillText@598 | Line loop=1 |
| loopStopBtn@599 | Line loop=1 |
| vocabList@600 | vocabulary-size test=4 |
| vocabEmpty@601 | vocabulary-size test=8 |
| phraseList@603 | phrase collection=4 |
| phraseEmpty@604 | phrase collection=8 |
| wordPopupDef@606 | dictionary lookups=10 |
| wordPopupPKnown@607 | dictionary lookups=6 |
| difficultyBadge@608 | playback source=8 |
| previewBar@609 | 预习卡片=8 |
| previewBarText@610 | 预习卡片=1 |
| previewStartBtn@611 | 预习卡片=1 |
| previewSkipBtn@612 | 预习卡片=1 |
| tabBtns@614 | pages=2 |
| pages@615 | pages=2 |
| sessionId@624 | chat history=5 |
| lastDifficultyKey@627 | playback source=4 |
| SETTING_HANDLERS@989 | dropdowns=3 |
| settingControls@1012 | dropdowns=3 |
| settingRows@1013 | dropdowns=4 |
| settingSections@1045 | dropdowns=4 |
| diagnosticSection@1046 | dropdowns=2 |
| BOTTOM_THRESHOLD_PX@1165 | chat history=2 |
| nearBottom@1166 | chat history=3 |
| toBottom@1168 | chat history=6 |
| TRANSIENT_ERROR_RE@1401 | chat history=2 |
| subtitleCueSignature@1524 | subtitle cards=4 |
| cueTextEls@1530 | subtitle cards=7 |
| wordObserver@1532 | subtitle cards=9 |
| virtualTopSpacer@1551 | subtitle cards=8 |
| virtualBottomSpacer@1552 | subtitle cards=9 |
| virtualRangeStart@1553 | subtitle cards=16 |
| virtualRangeEnd@1554 | subtitle cards=16 |
| cueEstimatedHeights@1555 | subtitle cards=7 |
| cueOffsets@1556 | subtitle cards=11 |
| VIRTUAL_BUFFER_CUES@1557 | subtitle cards=3 |
| VIRTUAL_RECYCLE_MARGIN_CUES@1558 | subtitle cards=5 |
| DEFAULT_CUE_HEIGHT@1559 | subtitle cards=2 |
| programmaticScroll@1578 | subtitle cards=16 |
| smoothScrollRaf@1579 | subtitle cards=7 |
| smoothScrollToken@1580 | subtitle cards=7 |
| smoothScrollVelocity@1581 | subtitle cards=6 |
| manualCenterTimer@1582 | subtitle cards=6 |
| virtualRecycleRaf@1583 | subtitle cards=6 |
| virtualMeasureRaf@1584 | subtitle cards=6 |
| virtualResizeRaf@1585 | subtitle cards=5 |
| extractPollTimer@1586 | subtitle cards=6 |
| subtitleRequestSeq@1588 | subtitle cards=4 |
| subtitleRequestController@1589 | subtitle cards=6 |
| pendingSubtitleCommit@1591 | subtitle cards=7 |
| pendingSubtitleCommitTimer@1592 | subtitle cards=6 |
| subtitleResizeObserver@1595 | subtitle cards=3 |
| EXTRACT_POLL_MS@1597 | subtitle cards=3 |
| POLISH_POLL_MS@1602 | subtitle cards=2 |
| hideWordPopupTimer@2654 | vocab-highlight=3 |
| defCache@2667 | dictionary lookups=5 |
| defRequestId@2668 | dictionary lookups=4 |
| popupAnchor@2669 | dictionary lookups=4 |
| popupWord@2670 | dictionary lookups=3 |
| popupCueIndex@2671 | dictionary lookups=3 |
| currentSpeechAudio@2720 | dictionary lookups=3 |
| LOOP_TAIL_MS@2997 | Line loop=4 |
| LOOP_TICK_MS@3001 | Line loop=2 |
| LOOP_ESCAPE_MS@3005 | Line loop=2 |
| loopCount@3009 | Line loop=5 |
| loopTimer@3010 | Line loop=4 |
| CONTEXT_SPAN@3130 | Line loop=3 |
| quizQueue@3182 | vocab=6 |
| quizIndex@3183 | vocab=6 |
| quizKnown@3184 | vocab=4 |
| quizUnknown@3185 | vocab=4 |
| quizMissed@3186 | vocab=6 |
| QUIZ_BATCH_OPTIONS@3223 | vocab=2 |
| QUIZ_SCOPE_KEY@3224 | vocab=3 |
| QUIZ_BATCH_KEY@3225 | vocab=3 |
| vocabTestInOverlay@3513 | vocabulary-size test=4 |
| vocabTestHost@3514 | vocabulary-size test=5 |
| vocabTestTotal@3535 | vocabulary-size test=4 |
| playbackReportSeq@4043 | playback source=6 |
| playbackReportController@4044 | playback source=6 |
| POSITION_POLL_MS@4156 | playback source=2 |
| POSITION_POLL_WORD_MS@4157 | playback source=2 |
| positionTimer@4158 | playback source=3 |
| seekVideo@4159 | playback source=15 |
| seekInProgress@4160 | playback source=6 |
| seekCommitTimer@4161 | playback source=8 |
| lastSeekProbeAt@4162 | playback source=4 |
| contextRequestSeq@4256 | playback source=5 |
| contextRequestController@4257 | playback source=4 |
| difficultyFetchInFlight@4297 | playback source=5 |
| difficultyFetchSeq@4298 | playback source=5 |
| difficultyFetchController@4299 | playback source=6 |
| DIFFICULTY_LABEL_CLASS@4311 | playback source=2 |
| PREVIEW_SHOWN_KEY@4389 | 预习卡片=3 |
| PREVIEW_DISMISSED_KEY@4390 | 预习卡片=3 |
| PREVIEW_SHOWN_TTL_MS@4391 | 预习卡片=2 |
| PREVIEW_DISMISS_COOLDOWN_MS@4392 | 预习卡片=2 |

### 2–3 个分节

| 变量与声明行 | 引用分节与次数 |
|---|---|
| inputEl@588 | dropdowns=5, chat history=3 |
| subsScroll@594 | subtitle cards=35, dictionary lookups=1 |
| subsNote@596 | dropdowns=1, subtitle cards=8, playback source=2 |
| vocabQuiz@602 | vocab=18, vocabulary-size test=1 |
| wordPopup@605 | subtitle cards=1, vocab-highlight=3, dictionary lookups=10 |
| previewOverlay@613 | vocabulary-size test=4, playback source=2, 预习卡片=7 |
| currentPage@625 | dropdowns=2, pages=1, playback source=2 |
| lastKnownVideoTitle@626 | chat history=1, dictionary lookups=1, playback source=3 |
| previewLastVideoId@628 | playback source=2, 预习卡片=7 |
| previewAnswered@629 | playback source=1, 预习卡片=5 |
| previewFetchInFlight@630 | playback source=1, 预习卡片=3 |
| previewPrefetchPromise@631 | playback source=1, 预习卡片=5 |
| previewRequestSeq@632 | playback source=1, 预习卡片=3 |
| previewSession@633 | playback source=3, 预习卡片=9 |
| wordHighlightOn@893 | dropdowns=1, subtitle cards=1, playback source=1 |
| vocabHighlightOn@894 | dropdowns=2, vocab-highlight=3 |
| showPKnownOn@895 | dropdowns=3, vocab-highlight=3, dictionary lookups=1 |
| settingValue@1117 | dropdowns=14, chat history=6, subtitle cards=1 |
| subtitleIsPartial@1523 | subtitle cards=5, vocab-highlight=1 |
| subtitleCardEls@1528 | subtitle cards=22, dictionary lookups=1, Line loop=2 |
| cueActionEls@1531 | subtitle cards=6, dictionary lookups=2 |
| currentCardEl@1534 | subtitle cards=6, dictionary lookups=4 |
| currentWordSpans@1535 | subtitle cards=5, dictionary lookups=7 |
| lastPositionMs@1536 | subtitle cards=4, dictionary lookups=2, playback source=2 |
| lastAutoScrollAt@1537 | subtitle cards=3, dictionary lookups=2 |
| cueUnknownWords@1541 | dropdowns=1, subtitle cards=5, vocab-highlight=2 |
| currentCueIndex@1546 | subtitle cards=16, dictionary lookups=5 |
| lastUserScrollAt@1560 | chat history=3, subtitle cards=14, dictionary lookups=1 |
| lastManualScrollAt@1572 | subtitle cards=7, dictionary lookups=1 |
| subtitleGeneration@1587 | subtitle cards=5, vocab-highlight=3 |
| subtitleModelVersion@1590 | subtitle cards=3, vocab-highlight=3 |
| vocabHighlightSeq@1593 | subtitle cards=2, vocab-highlight=3 |
| vocabHighlightController@1594 | subtitle cards=3, vocab-highlight=3 |
| USER_SCROLL_QUIET_MS@1596 | chat history=2, subtitle cards=6, dictionary lookups=1 |
| cancelHide@2655 | vocab-highlight=3, dictionary lookups=1 |
| spokenWordCount@2887 | subtitle cards=4, dictionary lookups=7 |
| LOOP_LEAD_MS@2988 | dictionary lookups=1, Line loop=3 |
| loopStartIdx@3007 | subtitle cards=2, dictionary lookups=1, Line loop=12 |
| loopEndIdx@3008 | subtitle cards=2, Line loop=11 |
| loopActive@3012 | subtitle cards=2, dictionary lookups=1, Line loop=3 |
| MASTERED_STREAK@3165 | vocab=5, vocabulary-size test=3 |
| vocabEntries@3180 | vocab=6, vocabulary-size test=3 |
| vocabTestStage@3191 | vocab=1, vocabulary-size test=3 |
| vocabTestItems@3192 | vocab=1, vocabulary-size test=6 |
| vocabTestIndex@3193 | vocab=1, vocabulary-size test=5 |
| vocabTestAnswers@3194 | vocab=1, vocabulary-size test=6 |
| vocabTestStatus@3195 | vocab=6, vocabulary-size test=1 |
| QUIZ_TAG_OPTIONS@3211 | vocab=3, vocabulary-size test=2 |
| currentItemId@3919 | Jellyfin playback tracking=1, playback source=3 |
| lastProbe@3923 | Jellyfin playback tracking=1, playback source=11 |
| previewedWordForms@4394 | playback source=1, 预习卡片=5 |

### 4 个以上分节（主要切分障碍）

| 变量与声明行 | 引用分节与次数 |
|---|---|
| subtitleCues@1522 | pages=1, subtitle cards=47, vocab-highlight=2, dictionary lookups=8, Line loop=9 |
| cueWordSpans@1529 | subtitle cards=9, vocab-highlight=1, dictionary lookups=2, 预习卡片=2 |
| mountedCueIndices@1533 | subtitle cards=5, vocab-highlight=1, Line loop=1, 预习卡片=2 |
| cueWordScores@1545 | dropdowns=2, subtitle cards=4, vocab-highlight=1, dictionary lookups=1 |

## 2. 分节依赖关系

约定：表中的 A → B 表示 A 的代码调用 B，或直接读写 B 的状态；这比只看函数声明位置更接近拆分后的真实约束。

| 分节 | 主要依赖（A → B） | 对外提供/被调用 |
|---|---|---|
| helpers | 无其他分节；renderMarkdown 依赖全局 marked | 所有渲染分节使用 fmt、escapeHtml、renderMarkdown、fmtElapsed |
| dropdowns | → subtitle cards（重置/加载字幕、虚拟测量）；→ vocab-highlight（刷新/取消/应用）；→ playback source（重启位置轮询）；→ dictionary（更新 p_known）；读写 settingValue 和顶层 SETTINGS | init 的设置渲染和用户变更处理 |
| chat history | → helpers；→ dropdowns（settingValue）；→ playback source（youtubeJumpTarget）；读写 lastUserScrollAt | dictionary、Line loop、vocab 会调用 addMessage/runTurn；pages 通过 composer 显隐间接控制 |
| pages | → subtitle cards（loadSubtitleCues）；→ vocab（loadQuizStart、loadVocabList）；→ phrase collection（loadPhraseList） | tab 按钮以及 dictionary/vocab/Line loop 的跳转入口 |
| subtitle cards | → helpers、dropdowns；→ vocab-highlight；→ dictionary（弹词典/朗读）；→ Line loop（循环按钮/状态）；→ playback source（player、位置相关）；维护字幕核心状态 | pages 加载；playback source 驱动 updateCurrentCue；多个功能读 subtitleCues 和已挂载卡片 |
| vocab-highlight | → dropdowns（开关判断）；→ subtitle cards（subtitleCues、cueWordSpans、mountedCueIndices）；→ dictionary（updateWordPopupPKnown） | subtitle cards 提交新 cue 后刷新；dropdowns 用户切换时刷新 |
| dictionary lookups | → helpers、dropdowns（showPKnownOn）；→ subtitle cards（current cue/span）；→ chat history（问 AI）；→ playback source（youtubeJumpTarget）；→ vocab（saveVocabEntry） | subtitle cards 的单词点击，vocab/quiz/preview 的朗读入口 |
| Line loop | → subtitle cards（cue/card/index）；→ playback source（player、seek）；→ chat history 和 pages（askAboutCue 的跳转和提问）；→ helpers | subtitle cards 委托 toggleLoopAt；播放轮询调用 loopTick |
| vocab | → helpers、pages、chat history、dictionary（speakWord）；→ playback source（player、youtubeJumpTarget）；与 vocabulary-size test 共用 vocabQuiz、vocabTestStatus 和 MASTERED_STREAK | pages 调用 loadQuizStart/loadVocabList；dictionary 保存后刷新列表/状态 |
| vocabulary-size test | → helpers、vocab（exit 后 renderQuizStart）；直接占用 vocabQuiz 或 previewOverlay；与 vocab 共享 init 状态 | vocab 的测验宣传入口调用 startVocabTest |
| phrase collection | → helpers；→ playback source（buildJumpBtn 的 player/youtubeVideoId）；复用 vocab 卡片样式 | pages 调用 loadPhraseList/renderPhraseList；chat history 的 suggest_phrase 写入同一后端集合 |
| Jellyfin playback tracking | 只提供 findVideo，以及 currentItemId/lastProbe 状态；不调用其他分节 | playback source 的 html5Player/reportPlaybackState 依赖它 |
| playback source | → Jellyfin playback tracking；→ subtitle cards（updateCurrentCue、reset/load）；→ dropdowns（wordHighlightOn）；→ preview cards（刷新/取消预习）；→ helpers | subtitle、Line loop、dictionary、vocab、preview 都依赖 player/youtubeJumpTarget；refreshContext 是定时入口 |
| 预习卡片 | → helpers；→ playback source（player、youtubeVideoId、invalidate/update difficulty）；→ subtitle cards（mountedCueIndices/cueWordSpans）；→ vocab-highlight；→ dictionary（speakWord） | playback source 的 refreshContext、captions-ready 事件调用；自身按钮驱动会话 |

### 叶子与双向纠缠

本表采用“调用者 → 被调用者”的箭头。按用户文字“叶子 = 不被其他分节依赖”（入度为 0）检查，这 14 个分节没有真正的孤立叶子：每个分节都被 init 或另一个分节接入。若把叶子理解为“自己不再调用其他分节”（出度为 0 的终点），则 helpers 和 Jellyfin playback tracking 是终点；它们仍可能被很多分节调用，不能先搬而不保留接口。

必须一起设计接口的双向纠缠如下：

- subtitle cards ↔ vocab-highlight：字幕重建后触发高亮，高亮又按字幕卡/span 索引回写 class。
- subtitle cards ↔ dictionary lookups：字幕事件打开 popup，dictionary 读取当前 cue/span 并把保存/提问动作写回页面。
- subtitle cards ↔ Line loop：卡片点击建立循环，字幕刷新要按 cue identity 恢复或清掉循环。
- subtitle cards ↔ playback source：播放适配器驱动当前 cue，卡片点击又通过适配器 seek。
- vocab ↔ vocabulary-size test：共用 vocabQuiz 容器；退出测试必须回到 review quiz 的 renderQuizStart，测试状态也显示在 review 入口。
- playback source ↔ 预习卡片：定时 context 调预习 gate；换片/字幕就绪事件又要取消预习请求、清 overlay 并重置 playback 状态。
- dictionary lookups ↔ vocab：dictionary 保存单词要调用 vocab 的 saveVocabEntry；vocab 卡片和 quiz 又复用 dictionary 的 speakWord。
- pages 与 chat/dictionary/vocab/Line loop 构成跳转回路：这些分节都会调用 switchPage，而 switchPage 再触发各自的加载函数，不能把 pages 当纯展示层。

高扇出共享状态（应集中放在 ctx.state，而不是复制）包括 subtitleCues、subtitleCardEls、cueWordSpans、mountedCueIndices、currentCueIndex、lastPositionMs；playbackReport/context/difficulty 的 abort controller 与 seq；vocabEntries、quizQueue、vocabTest*；previewOverlay、previewSession、currentPage；以及 settingControls/settingValue。复制其中任何一个数组或序列号都会让旧请求或旧卡片看起来仍然有效。
## 3. 拆分方案

### 推荐的文件边界

下面是按逻辑职责拆开的源码分片，行数是以当前 4,676 行为基线的粗估，包含原有注释和少量 ctx/factory 胶水；不是承诺的最终行号。

| 分片 | 包含内容 | 粗估行数 | 对外接口（写入 ctx.fns） |
|---|---|---:|---|
| panel-core.js | 外层 IIFE/重复注入保护、Trusted Types、API/TAB_ID、配置常量、ICONS/icon、MARKUP、boot、DOM 取引用、ctx.state 初值、方向锁/折叠/拖拽和最终启动器 | 730–800 | createContext、boot、start |
| panel-helpers.js | fmt、escapeHtml、renderMarkdown、fmtElapsed | 35–50 | fmt、escapeHtml、renderMarkdown、fmtElapsed |
| panel-settings.js | dropdowns、文本设置、SETTINGS 渲染、SETTING_HANDLERS、visibility 及设置变更回调 | 350–410 | settingValue、wordHighlightOn、vocabHighlightOn、showPKnownOn |
| panel-chat.js | history restore/save、消息渲染、phrase suggestion、AI 流式处理、重试和发送 | 360–420 | addMessage、runTurn、chat lifecycle hooks |
| panel-pages.js | switchPage 和 tab 绑定 | 20–35 | switchPage |
| panel-subtitles.js | cue 请求/增量提交、虚拟列表、滚动/测量、word span、卡片动作、当前句和 spoken word | 1,000–1,100 | loadSubtitleCues、updateCurrentCue、highlightCue、subtitle state accessors |
| panel-vocab-highlight.js | /api/vocab-highlight、unknown/p_known 映射、class 应用和 abort | 75–100 | refreshVocabHighlight、abortVocabHighlight、applyVocabHighlight |
| panel-dictionary.js | popup、define 缓存、p_known 展示、朗读、保存/问 AI 动作 | 300–340 | showWordPopup、speakWord、updateWordPopupPKnown |
| panel-loop.js | A-B 边界、计时器、循环按钮/状态、上下文窗口和 askAboutCue | 180–210 | loopActive、toggleLoopAt、clearLoop、buildContextBlock |
| panel-vocab.js | vocabEntries、review quiz、词汇本加载/渲染、gradeEntry、jump button | 500–560 | loadQuizStart、loadVocabList、saveVocabEntry、gradeEntry |
| panel-vocab-test.js | 两阶段 vocabulary-size test；只借用 vocabQuiz/previewOverlay 容器 | 180–230 | startVocabTest、exitVocabTest |
| panel-phrases.js | phrase collection 列表加载/渲染 | 70–95 | loadPhraseList、renderPhraseList |
| panel-jellyfin.js | findVideo、currentItemId、lastProbe | 25–45 | findVideo |
| panel-playback.js | html5/youtube adapter、seek 事务、位置轮询、playback-state、context、difficulty badge | 420–480 | player、youtubeVideoId、youtubeJumpTarget、startPositionPolling、refreshContext |
| panel-preview.js | 预习 gate、预取、overlay 卡片、结果提交和 preview highlight | 290–330 | updatePreviewPrompt、resetPreview、preview state accessors |

现有源码把词汇本列表放在 vocabulary-size test 注释之后；拆分时应按上表移动到 panel-vocab.js，而不是为了保留旧行号制造反向依赖。

### 共享状态处理

不把 ctx 或任何业务状态挂到 window。面板运行在 YouTube 的 MAIN world，window 与 YouTube 自己的脚本同一对象；已有的外部契约（__englishTutorApiBase、__englishTutorYouTube、__englishTutorPanelLoaded）保留，新增状态一律留在单次 boot 的词法闭包中。

core 在 init 里建立一次上下文：

    const ctx = {
      api: API,
      tabId: TAB_ID,
      playbackSessionId: PLAYBACK_SESSION_ID,
      host, root,
      dom: { ...所有 root 内节点... },
      config: { ...顶层 SETTINGS/OPTIONS/常量... },
      state: { ...inventory 中的局部变量... },
      fns: Object.create(null)
    };

每个分片导出 installX(ctx)，只把需要跨分片调用的函数放进 ctx.fns；高频内部辅助函数留在自己的 factory 闭包内。state 只保留一份，特别是 subtitleCues/cueWordSpans/mountedCueIndices/currentCueIndex、所有 request seq/controller、vocabEntries/quiz 状态、previewSession/previewOverlay 和 currentPage。不要把这些数组复制给另一个分片，也不要用同名的第二份局部变量。

双向依赖用两阶段安装解决：先按顺序运行所有 installX(ctx)，让每个分片注册函数和事件工厂；再运行 wireCrossFeatureEvents(ctx)，把字幕、词典、高亮、循环、播放和预习的回调接起来；最后才 restore settings、绑定 tab、启动 polling 和首次 fetch。调用点通过 ctx.fns.foo() 延迟解析，因此不需要把循环依赖变成 window 全局。设置控件恢复必须继续传 isUserChange=false，并在所有 handler 已注册后才做 restore，避免当前代码注释所记录的 Temporal Dead Zone 问题。

### 构建与加载顺序

这些分片不应作为互相独立的 classic script 直接注入：每个文件会有自己的词法作用域，直接加载只能靠 window 共享 ctx，正好违反 MAIN world 的约束。使用确定性的构建步骤把它们拼成一个 tutor-panel.js，拼接顺序固定为：

1. core prelude（外层 guard、API/TAB_ID、配置、ICON/MARKUP）。
2. helpers。
3. 各 installX 定义，顺序为 settings、chat、pages、subtitles、vocab-highlight、dictionary、loop、vocab、vocab-test、phrases、jellyfin、playback、preview。
4. core boot/init、wireCrossFeatureEvents 和首次启动（必须在所有 installX 定义之后）。
5. marked.min.js 仍是运行时先于 tutor-panel.js 的独立依赖；它不属于 bundle。

两条入口的改法：

- static/standalone.html 第 20 行继续加载 /static/tutor-panel.js；它应指向构建产物，而不是某一个源码分片。inline 设置 __englishTutorApiBase 的 script 必须仍在它之前。这样 inject.ps1、youtube.html 和 Jellyfin 的现有单脚本路径也不需要各自复制一套顺序。
- extension/background.js 的两个 executeScript 调用继续严格先执行 files: ["marked.min.js"]，成功后再执行 files: ["tutor-panel.js"]。setApiBase 和 content bridge 仍先于面板，以便 API、__englishTutorYouTube 和 captions-ready/source-changed 契约已经存在。不要把源码分片逐个塞进 files 数组，除非它们被构建成同一个文件；executeScript 的每个文件不是共享词法闭包。

如果构建产物改名（例如 dist/tutor-panel.js），两个入口必须同时改成同一个发布文件，并把 inject.ps1/服务端静态路径一并纳入发布检查；不能让 standalone 和扩展各自选择不同产物。

### 逐字节一致性清单

保留 static/tutor-panel.js 与 extension/tutor-panel.js 的 byte-for-byte 配对检查，但把它放在构建之后。推荐源码分片只存一份，构建脚本用同一输入生成两个输出；这样不会有“分片同步了、bundle 忘了同步”的人工步骤。若为了扩展打包而复制了分片目录，则在 tools/check_duplicates.py 的 PAIRS 中为每个同名分片增加配对，并额外比较构建 manifest（文件名、顺序、hash）。CI 顺序应是：build 两份 bundle → 检查所有 pair/hash → node --check 两份 bundle。任何手工编辑生成的 tutor-panel.js 都应被 CI 的重建差异检查拒绝。
## 4. 分阶段路径

每一阶段都应是一个单独提交，提交前生成两份 bundle，失败时只回滚该提交即可。CI 现状只有 node --check，所以以下“确认”必须包括浏览器手工 smoke、DevTools Console 和 Network；不能把语法通过当成行为通过。

| 阶段 | 变更范围 | 独立确认（完成后立即做） | 回滚边界 |
|---|---|---|---|
| 0. 可重复构建 | 加入确定性的 fragment manifest/拼接器和 hash/duplicate 检查；先要求新产物与旧 tutor-panel.js 字节相同，不移动逻辑 | 对两份输出算 SHA-256 并与基线比对；运行 node --check static/tutor-panel.js、node --check extension/tutor-panel.js、python tools/check_duplicates.py；打开 standalone 页面确认面板出现、扩展注入确认 console 无异常 | 只撤销构建脚本/manifest，运行时代码未变 |
| 1. 纯模块与壳 | 拆 core prelude、ICONS/MARKUP、helpers、bootstrap；保持 init 行为和 DOM id 不变 | standalone 打开后检查折叠、宽度拖拽、横竖屏；输入框/字幕滚动不触发宿主快捷键；Console 无 Trusted Types、null element 或 boot 异常 | 只回滚 core/helper 分片，功能分节仍来自旧 bundle |
| 2. 低耦合页面 | 拆 pages、phrase collection 及其纯渲染辅助；保留 API URL 和 .vocab-card class | 点击 chat/subs/vocab/phrases/quiz/settings 六个 tab；phrases 请求成功、空态、删除后空态都确认；刷新后 tab 仍可切换 | 回滚页面/短语分片，不影响字幕和播放 |
| 3. 设置与聊天 | 拆 dropdowns、设置渲染、chat history/stream/retry；先实现“两阶段安装”，再移除旧代码 | 在 localStorage 预置 vocabHighlight=on、engine=deepseek/claude、主题/字号；刷新确认没有冻结且设置可见性正确。发送一轮流式回复、thinking、phrase suggestion 接受/拒绝、刷新后未解决卡片按钮仍可用；断网后确认重试按钮 | 回滚 settings/chat 分片；保留 core 和页面分片 |
| 4. 词汇数据流 | 拆 vocab review、词汇本和 vocabulary-size test；明确 vocabQuiz/previewOverlay 的 owner 和切换协议 | 词汇本加载/删除/朗读/跳转；quiz 的范围、批量、known/unknown、mastered/due；进入两阶段词汇量测试并退出回到 quiz；确认 grade 后列表和难度 badge 能更新 | 回滚词汇分片；字幕渲染仍可独立运行 |
| 5. 字幕及单词交互 | 拆 subtitle cards、vocab-highlight、dictionary lookups；引入 subtitle state accessor，不复制数组 | YouTube 和 Jellyfin 各开一个视频；确认 partial/extracting 后增量字幕、虚拟滚动、手动滚动不被抢回；打开单词 popup、define 缓存、朗读 fallback、保存生词、问 AI；打开 vocab highlight/p_known，检查 class 与 popup 数值；切换副字幕/逐词高亮后确认重新请求 | 回滚三块交互分片；保留阶段 4 的词汇 API |
| 6. 播放与高风险异步 | 最后拆 Jellyfin playback tracking、playback source、Line loop、预习卡片；接入 source-changed/captions-ready 取消协议 | YouTube watch/shorts 与 Jellyfin Direct Play/Stream/transcode 各走一次：确认当前句和逐词位置、seek/进度上报、视频切换不会显示旧字幕；循环单句/范围、暂停/拖动逃逸；预习提示的跳过/开始/多批次/字幕就绪重试；Network 中确认旧请求不会覆盖新视频，Console 无未处理 rejection | 回滚最后一个高风险提交即可恢复旧播放/预习整体 |

每阶段固定复跑：构建两份 bundle、duplicate/hash 检查、两份 node --check；并保存一份浏览器 smoke 记录（URL、视频类型、Console/Network 结果）。阶段 5–6 的人工检查不可省略，因为静态语法检查不会发现“卡片仍显示但点击无效”这类静默失效。
## 5. 核对“只抽顶部 1–520 行”的判断

结论：这个判断按字面是错的；按语义把边界修到 522 行后，“顶部声明不依赖 init 内部”才成立。

- 1–520 行在 setPanelWidth 的中间：518 行开始函数，520 行只是 document.documentElement.style.setProperty 调用，521 行 return，522 行才是函数闭合。把 1–520 单独作为文件会留下未闭合的函数/块，node --check 就会失败。最低完整边界是 522 行（或把 setPanelWidth 整个移到 core）。
- 修到 522 行后，顶部代码没有读取 init 的局部变量。API、TAB_ID、PLAYBACK_SESSION_ID、存储 key、OPTIONS/SETTINGS、THINKING_VERBS、ICONS、icon、MARKUP、loadMarked、setPanelWidth 都在外层 IIFE；loadMarked 只闭包 API/document，setPanelWidth 只闭包 MIN_WIDTH/MAX_WIDTH/document，MARKUP 只调用 icon。它们不需要 init 才能定义。
- 但“独立”不等于“可单独运行”：boot（524 行起）要调用 loadMarked/setPanelWidth、用 MARKUP 建 Shadow DOM，再调用 init；顶部如果拆成另一个 classic script，外层 lexical 绑定就不会自动对 init 可见。必须通过同一个 bundle 闭包，或显式传入 ctx，不能靠 window。
- init 对顶部绑定有实质依赖：API（所有 fetch）、TAB_ID（subtitles/context/playback/difficulty）、PLAYBACK_SESSION_ID（playback-state）、HISTORY_KEY（chat history）、COLLAPSE_KEY（方向锁/折叠）、WIDTH_KEY（拖拽保存）、EFFORT_OPTIONS（当前思考程度标签）、SETTINGS_SECTIONS/SETTINGS/ENGINE_OPTIONS 等配置（设置渲染）、THINKING_VERBS（AI thinking 状态）、icon/ICONS（各分片按钮和动态 markup）。init 间接依赖 MARKUP 已先把这些 DOM id 放进 root；boot 依赖 loadMarked、setPanelWidth、MARKUP、DEFAULT_WIDTH/THEME_KEY/COLLAPSE_KEY。
- Trusted Types 的 default policy 和 __englishTutorPanelLoaded guard 还是必须在任何 init sink/重复注入前执行；移动到“顶部模块”但在 init 之后运行会让 YouTube 上的 innerHTML/script sink 被拦截，或让 SPA 重复挂载两个面板。

因此可抽取的是“完整的 prelude + config + markup + bootstrap helper”（至少到 522 行），不是任意的 1–520 行片段；init 也不能原封不动地留在另一个文件而期待共享这些 const。推荐方案中的 panel-core.js + 同 bundle 拼接满足这个依赖方向。
## 6. 静默失效风险清单

以下不是泛化的“可能有 bug”，而是拆分时某个具体契约丢失后可观察到的无报错结果：

| 搬错的 X | 静默失效的 Y |
|---|---|
| marked.min.js 没有在 tutor-panel bundle 前注入，或 bundle 把 loadMarked 的短路条件改掉 | chat/词汇答案仍出现，但 Markdown 变成未格式化纯文本；若把 script.src 的异常漏出 boot，整个面板直接不出现 |
| standalone 的 __englishTutorApiBase 或 background 的 setApiBase 晚于 tutor-panel 执行 | API 常量已经在错误主机上冻结；面板壳可见，但字幕、chat、词汇、context 请求全部打到错误地址而只显示空态/加载失败 |
| 每个分片各自执行 __englishTutorPanelLoaded guard | 第一个分片设置 guard 后，后续分片直接 return；页面看似加载成功，实际 tab 或事件没有实现 |
| DOM 引用没有通过同一个 ShadowRoot 的 $ helper 取得，或 markup 的 id 改名 | 面板静态 HTML 仍显示，具体 tab、发送、预习按钮或循环按钮没有响应；事件绑定可能只在控制台留下一个 null listener 异常 |
| 设置 restore 在 settingValue/所有 handler 注册前运行，或丢掉 isUserChange=false | localStorage 中 vocabHighlight=on 的用户刷新后会在 TDZ 处中止 init，tab 全部冻结；engine 可见性也可能停在旧状态 |
| settingValue 没有成为共享 accessor | UI 显示用户选择的 engine/model/effort，但 streamChat 发送 null/旧值；用户只能看到“设置成功”而回复行为不变 |
| wordHighlightOn 与 subtitle 请求拆开后各有一份 | /api/subtitles 没有 words=1，或轮询仍是 250ms；逐词 spoken class 永远不出现，字幕行高亮仍看起来正常 |
| subtitleCues、cueWordSpans、mountedCueIndices 没有放进同一 state | 字幕文本能渲染，但 vocab-highlight/预习高亮找不到对应 span，单词 popup 读取不到当前行，循环按钮标记不到实际卡片 |
| appendWordSpans 的 token 计数规则被重写为“跳过纯标点” | 从一个标点 token 之后所有 per-word 时间槽错位；错误单词逐个变亮，不抛异常 |
| subtitleGeneration/subtitleRequestSeq 与 AbortController 没有共享 | 切换视频后旧 fetch 晚到，旧字幕覆盖新字幕；或所有响应都被当成 stale 丢弃，页面一直停在加载态 |
| subtitleModelVersion/vocabHighlightSeq 没有共享 | highlight 响应写入上一版 cue，unknown underline/p_known 在当前卡片上缺失或粘错；网络错误也只表现为“没有高亮” |
| 字幕提交时没有按 cueIdentity 恢复 loopStartIdx/loopEndIdx | 增量提取或 polishing 后循环 pill 还显示，但 timer 的边界对应旧索引，结果不再循环目标句或马上被清掉 |
| player adapter 把秒和毫秒混用，或只移动 html5Player 不移动 youtubePlayer | 当前句、seek、A-B loop、位置上报和跳转链接整体偏移 1,000 倍；UI 仍会更新，所以很难从静态页面发现 |
| 忘记保留 window.__englishTutorYouTube 的只读集成以及 MAIN world | YouTube 被误判成没有 video 元素，context/字幕同步/难度 badge/预习提示全部缺失；Jellyfin 路径可能仍正常 |
| findVideo 没有走 open shadow roots 或 lastProbe/currentItemId 没共享 | Jellyfin episode 切换后仍读旧 video，字幕和循环跟错片；找不到播放器时只显示“尚未检测/没有 video”，不报业务错误 |
| lastKnownVideoTitle 在 context、phrase suggestion、difficulty 三处各有副本 | phrase 保存的 video_title 为空或旧片名，Jellyfin difficulty badge 不刷新；单词和字幕本身仍能用 |
| dictionary 的 saveVocabEntry 接口未接回 vocab 模块 | 单词 popup 的“存生词”按钮请求失败或永远停在保存中；define、朗读等同一 popup 功能仍正常 |
| history restore 后没有重新 wirePhraseSuggestionCard | 刷新前的聊天内容都在，未处理的“收藏/不用了”按钮变成死按钮；已处理卡片没有明显区别 |
| youtubeJumpTarget 没在建议/保存时传入 video_url 与 timestamp_seconds | 词汇/短语卡仍显示，点击却无法跳回 YouTube，或跳到用户后来播放的时间点 |
| vocabEntries、gradeEntry 没有与 quiz 共用同一对象 | quiz 显示 known 后返回词汇本仍是旧 streak/due；mastered badge 和下一轮 pool 需要刷新才恢复 |
| vocab 与 vocabulary-size test 没有共享 vocabQuiz/previewOverlay 的 owner 状态 | 词汇量测试的按钮打开空 overlay，或结束后覆盖预习卡片；退出测试不能回到 review 起始页 |
| playback source 没有在 source-changed/captions-ready 时递增 seq、清 overlay、abort controller | SPA 切换视频时旧预习卡/旧 difficulty 结果留在新片上，成员字幕到达后也不会重新预取 |
| ctx 被挂到 window 或使用通用 window 字段名 | YouTube 自己的脚本/其他面板可覆盖状态，出现跨实例串片、重复定时器或第二个面板；这些都可能只表现为偶发空态 |
| 只更新 static 或只更新 extension 的 bundle | standalone/Jellyfin 看似正常而扩展 YouTube 缺功能（或反过来）；没有运行时错误提示，直到用户走到那条路径 |
| fragment manifest 顺序和 files 注入顺序不一致 | standalone 走一条顺序、扩展走另一条顺序，某些 handler 只在其中一条路径注册；需在构建后对两份 bundle 做 hash 和 node --check 才能阻止这种漂移 |

这些风险说明拆分的验收重点是“状态只有一份、所有异步响应有代次校验、所有入口使用同一构建产物”，而不是仅仅让每个新文件通过语法检查。
