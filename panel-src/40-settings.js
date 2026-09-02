    function installSettings(ctx) {
    const settingRestores = [];
    let settingsReady = false;
    const settingControls = new Map();
    const settingRows = new Map();
    const settingSections = new Map();
    function settingValue(key) {
      const control = settingControls.get(key);
      return control ? control.value : null;
    }

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
      if (settingsReady) select(initial, false);
      else settingRestores.push(() => select(initial, false));
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
      if (isUserChange && typeof ctx.fns.invalidateVirtualMeasurements === "function") {
        ctx.fns.invalidateVirtualMeasurements();
      }
    }

    function applySubWeightAndInvalidate(value, isUserChange) {
      applySubWeight(value);
      if (isUserChange && typeof ctx.fns.invalidateVirtualMeasurements === "function") {
        ctx.fns.invalidateVirtualMeasurements();
      }
    }

    /** Turning the second language on or off changes what the backend has to
     *  merge, so the cue list has to be refetched. Only on a real change --
     *  at boot the cards load lazily when the subtitle tab is first opened,
     *  and half the state this touches hasn't been declared yet. */
    function reloadForSecondary(value, isUserChange) {
      if (!isUserChange) return;
      ctx.fns.resetSubtitleSession();
      subsNote.hidden = true;
      if (ctx.state.currentPage === "subs") ctx.fns.loadSubtitleCues();
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
      ctx.fns.startPositionPolling();
      ctx.fns.resetSubtitleSession();
      if (ctx.state.currentPage === "subs") ctx.fns.loadSubtitleCues();
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
          ctx.fns.updateWordPopupPKnown();
        }
      }
    }

    function toggleDeveloperDiagnostics(value, isUserChange) {
      if (!isUserChange) return;
      if (showPKnownOn()) {
        ctx.fns.refreshVocabHighlight();
      } else {
        ctx.state.cueWordScores = [];
        ctx.fns.updateWordPopupPKnown();
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

    // Restore only after every control and handler is registered. Passing
    // false preserves the boot-time path and keeps handlers from treating a
    // saved value as a user change.
    settingRestores.forEach((restore) => restore());
    settingsReady = true;
    updateSettingVisibility(); // initial pass -- covers a saved engine choice from a previous visit; needs settingValue, so after its declaration

    root.addEventListener("click", (e) => {
      if (!e.target.closest(".dropdown")) {
        root.querySelectorAll(".dropdown.open").forEach((el) => {
          el.classList.remove("open");
          el.setAttribute("aria-expanded", "false");
        });
      }
    });
    ctx.fns.settingValue = settingValue;
    ctx.fns.populateSelect = populateSelect;
    ctx.fns.wordHighlightOn = wordHighlightOn;
    ctx.fns.vocabHighlightOn = vocabHighlightOn;
    ctx.fns.showPKnownOn = showPKnownOn;
    ctx.fns.updateSettingVisibility = updateSettingVisibility;
    ctx.fns.applySubSize = applySubSize;
    ctx.fns.applySubWeight = applySubWeight;
    }
    installSettings(ctx);
