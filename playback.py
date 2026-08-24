#!/usr/bin/env python3
"""
Current playback state -- what's playing and where -- shared between the two
processes that need it.

The panel script injected into Jellyfin's page is the only thing that knows
the live position (it reads the <video> element directly), and it reports
that to app.py over HTTP. But mcp_server.py runs as a *separate* subprocess,
spawned fresh by the `claude` CLI for each chat turn, so it has no way into
app.py's memory. A small JSON file is the shared channel: app.py writes,
both read.

Function shapes here match what the subtitle/chat code already expected from
the earlier PotPlayer and mpv versions of this module, so callers didn't
change when playback moved to Jellyfin.
"""

import json
import time
from pathlib import Path

STATE_FILE = Path(__file__).resolve().parent / "playback_state.json"

# Playback reports arrive every couple of seconds while a video is open. If
# they stop for this long the tab was closed or navigated away, and serving
# the last known position would be worse than admitting we don't know.
STALE_AFTER_SECONDS = 30.0


def write(path: str, position_ms: int, duration_ms: int, status: str) -> None:
    STATE_FILE.write_text(
        json.dumps({
            "path": path,
            "position_ms": position_ms,
            "duration_ms": duration_ms,
            "status": status,
            "updated_at": time.time(),
        }),
        encoding="utf-8",
    )


def read() -> dict:
    if not STATE_FILE.exists():
        raise RuntimeError("还没有播放记录（Jellyfin 里还没开始播放）")
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        raise RuntimeError(f"读取播放状态失败：{e}")

    if time.time() - state.get("updated_at", 0) > STALE_AFTER_SECONDS:
        raise RuntimeError("播放状态已过期（Jellyfin 页面可能已关闭）")

    return {
        "available": True,
        "title": Path(state["path"]).name,
        "path": state["path"],
        "position_ms": state["position_ms"],
        "duration_ms": state["duration_ms"],
        "status": state["status"],
    }


def current_video() -> Path:
    path = Path(read()["path"])
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
