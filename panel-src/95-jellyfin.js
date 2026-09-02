    // ---- Jellyfin playback tracking ----
    // The whole reason for injecting into Jellyfin's page instead of framing
    // it: the real <video> element is reachable, so position is read straight
    // off it rather than polled out of an API.

    let currentItemId = null;
    // What the last detection attempt actually saw. Surfaced in the context
    // bar when there's no playback record, so a failure to find the player
    // reads as a specific reason instead of a blank "还没开始播放".
    let lastProbe = "尚未检测";

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

