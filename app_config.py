#!/usr/bin/env python3
"""
Machine-specific filesystem paths, kept out of the code.

Separate from the per-service credential files (jellyfin_config.json,
deepseek_config.json): those hold secrets and each belongs to one module,
while these are plain paths that more than one module needs and that nobody
minds being readable. config.example.json is the committed template;
config.json is gitignored, because every machine's answer is different.

Everything here has a working default, so a fresh clone runs without a
config.json at all -- the file only exists to override.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "config.json"

_config = None


def config() -> dict:
    """Missing file is normal, not an error -- the defaults below stand in.

    A file that exists but fails to *parse* is a different story: falling
    back to defaults just as quietly there once sent every YouTube path
    lookup silently looking in the wrong directory (the default youtube/
    instead of whatever real path config.json actually named) with nothing
    printed anywhere to explain why -- the same failure mode as a missing
    file, but caused by a typo instead of an absent one, so it deserves a
    loud warning instead of the same silent shrug.
    """
    global _config
    if _config is None:
        try:
            _config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except OSError:
            _config = {}
        except json.JSONDecodeError as e:
            print(f"[app_config] {CONFIG_FILE.name} 存在但不是合法 JSON，本次启动按空配置处理"
                  f"（所有值退回默认）：{e}")
            _config = {}
    return _config


def youtube_cache_dir() -> Path:
    """Where the .strm placeholders and .srt sidecars for YouTube videos go.

    Defaults inside the project rather than next to a media library: a fresh
    clone has no idea where anyone keeps their media, and a path that just
    works beats one that has to be configured before anything runs. Point it
    at the media library in config.json if you'd rather keep them together.
    """
    configured = config().get("youtube_cache_dir")
    return Path(configured) if configured else ROOT / "youtube"


def ffmpeg_dirs() -> list[Path]:
    """Extra directories to search for ffmpeg/ffprobe when they aren't on
    PATH. Empty by default -- PATH is where they're supposed to be, and this
    is only here so a portable/unzipped-somewhere build can be pointed at
    without touching the system PATH."""
    configured = config().get("ffmpeg_dir")
    return [Path(configured)] if configured else []
