#!/usr/bin/env python3
"""
Current playback state -- what's playing and where -- shared between the two
processes that need it.

The panel script injected into Jellyfin's page (or running as the YouTube
extension's panel) is the only thing that knows the live position (it reads
the <video> element directly), and it reports that to app.py over HTTP. But
mcp_server.py runs as a *separate* subprocess, spawned fresh by the `claude`
CLI for each chat turn, so it has no way into app.py's memory. A small JSON
file is the shared channel: app.py writes, both read.

Keyed by tab_id -- a browser tab watching YouTube and another watching
Jellyfin (or two YouTube tabs) are different videos, and used to collide on
a single record, whichever tab reported last winning for every reader.
mcp_server.py has no browser tab to name (see above), so it calls read()/
current_video() with no id and gets whichever tab was most recently active --
the same "one video at a time" behavior this module had before tabs were
tracked separately.

Function shapes here match what the subtitle/chat code already expected from
the earlier PotPlayer and mpv versions of this module, so callers didn't
change when playback moved to Jellyfin.
"""

import json
import threading
import time
from pathlib import Path

import app_config

STATE_FILE = app_config.PLAYBACK_STATE_FILE

# Playback reports arrive every couple of seconds while a video is open. If
# they stop for this long the tab was closed or navigated away, and serving
# the last known position would be worse than admitting we don't know.
STALE_AFTER_SECONDS = 30.0

# Closed tabs stop reporting but their bucket otherwise sits in the file
# forever. Not a correctness issue -- stale entries are already skipped by
# _entry() -- just tidied up opportunistically so the file doesn't grow
# without bound over weeks of use.
TAB_RETENTION_SECONDS = 6 * 3600.0
_WRITE_LOCK = threading.Lock()


def _load() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    # A "path" key at the top level means this is the old single-record
    # shape from before tabs were tracked separately. Nothing usable in it --
    # the next write() replaces it with the new shape.
    if not isinstance(data, dict) or "path" in data:
        return {}
    return data


def write(tab_id: str, path: str, position_ms: int, duration_ms: int, status: str,
          client_session: str | None = None, client_seq: int | None = None) -> bool:
    """Persist a playback sample, rejecting an older sample from this panel.

    HTTP requests can complete out of order on a busy local server. A session
    id resets the sequence after a page reload, while the monotonically
    increasing sequence prevents a delayed request from moving a tab backward.
    """
    with _WRITE_LOCK:
        tabs = _load()
        previous = tabs.get(tab_id)
        if (client_session is not None and client_seq is not None and previous and
                previous.get("client_session") == client_session and
                isinstance(previous.get("client_seq"), int) and
                client_seq < previous["client_seq"]):
            return False
        now = time.time()
        tabs[tab_id] = {
            "path": path,
            "position_ms": position_ms,
            "duration_ms": duration_ms,
            "status": status,
            "updated_at": now,
            "client_session": client_session,
            "client_seq": client_seq,
        }
        tabs = {t: e for t, e in tabs.items() if now - e["updated_at"] < TAB_RETENTION_SECONDS}
        tmp = STATE_FILE.with_name(f"{STATE_FILE.name}.tmp")
        tmp.write_text(json.dumps(tabs), encoding="utf-8")
        tmp.replace(STATE_FILE)
        return True


def _entry(tab_id: str | None) -> dict:
    tabs = _load()
    if tab_id is not None:
        entry = tabs.get(tab_id)
        if entry is None:
            raise RuntimeError("还没有播放记录（这个标签页还没开始播放）")
    else:
        # No tab to name (the MCP tools) -- answer for whichever tab was
        # most recently active.
        candidates = sorted(tabs.values(), key=lambda e: e["updated_at"], reverse=True)
        if not candidates:
            raise RuntimeError("还没有播放记录")
        entry = candidates[0]

    if time.time() - entry["updated_at"] > STALE_AFTER_SECONDS:
        raise RuntimeError("播放状态已过期（页面可能已关闭）")
    return entry


def read(tab_id: str | None = None) -> dict:
    entry = _entry(tab_id)
    return {
        "available": True,
        "title": Path(entry["path"]).name,
        "path": entry["path"],
        "position_ms": entry["position_ms"],
        "duration_ms": entry["duration_ms"],
        "status": entry["status"],
    }


def current_video(tab_id: str | None = None) -> Path:
    path = Path(_entry(tab_id)["path"])
    if not path.exists():
        raise FileNotFoundError(f"记录的当前视频文件不存在：{path}")
    return path


def fmt_ms(ms: int) -> str:
    if ms < 0:
        return "?"
    total_seconds = ms // 1000
    h, rem = divmod(total_seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
