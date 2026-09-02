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

