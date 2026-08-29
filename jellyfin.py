#!/usr/bin/env python3
"""
Minimal Jellyfin API client -- just enough to turn the item id the injected
panel reports into the real file path on disk.

That mapping is the only thing the tutor backend needs from Jellyfin. The
panel script runs inside Jellyfin's own page, so it already knows the
playback position and the item id straight from the DOM; what it can't know
is where the file actually lives, and the subtitle pipeline (subs_now /
extract_subs) works on real paths.

Uses urllib rather than requests/httpx to keep the dependency list at
fastapi + uvicorn -- this is two GETs against localhost, not worth a
third-party HTTP client.
"""

import json
import urllib.parse
import urllib.request

import app_config

CONFIG_FILE = app_config.JELLYFIN_CONFIG_FILE

_config = None


def config() -> dict:
    global _config
    if _config is None:
        _config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    return _config


def _get(path: str, params: dict | None = None):
    cfg = config()
    url = f"{cfg['base_url'].rstrip('/')}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={"Authorization": f'MediaBrowser Token="{cfg["api_key"]}"'},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def now_playing() -> dict | None:
    """What Jellyfin thinks is playing right now, or None if nothing is.

    The panel can't work this out on its own: Jellyfin feeds the <video>
    element through Media Source Extensions, so its src is an opaque
    blob: URL with no item id in it, and the route is a bare "#/video"
    with no query string either. The server, on the other hand, always
    knows -- its own web client reports playback progress to it.
    """
    for session in _get("/Sessions"):
        item = session.get("NowPlayingItem")
        if not item:
            continue
        state = session.get("PlayState") or {}
        return {
            "item_id": item.get("Id"),
            "path": item.get("Path"),
            # Jellyfin counts in 100-nanosecond ticks.
            "position_ms": (state.get("PositionTicks") or 0) // 10_000,
            "duration_ms": (item.get("RunTimeTicks") or 0) // 10_000,
            "paused": bool(state.get("IsPaused")),
            "play_method": state.get("PlayMethod"),
        }
    return None


