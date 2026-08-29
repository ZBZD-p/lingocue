#!/usr/bin/env python3
"""
Machine-specific filesystem paths, kept out of the code, plus the one place
that decides where everything this program *writes* ends up.

Separate from the per-service credential files (jellyfin_config.json,
deepseek_config.json): those hold secrets and each belongs to one module,
while these are plain paths that more than one module needs and that nobody
minds being readable. config.example.json is the committed template;
config.json is gitignored, because every machine's answer is different.

Everything here has a working default, so a fresh clone runs without a
config.json at all -- the file only exists to override.

The data-path constants at the bottom used to be declared next to whichever
module happened to touch the file, which meant three modules each spelled
out dictionary.db's location and two each spelled out difficulty.db's and
vocab.json's. Same path written twice is a path that can be changed once, so
they are all resolved here now and imported from here.
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


def data_dir() -> Path:
    """Everything this program generates or that belongs to the person using
    it: the two SQLite databases, the vocabulary/phrase notebooks, playback
    state, the subtitle cache.

    All of it used to sit directly in the project directory, mixed in with
    the source files. Nothing was broken by that -- .gitignore already kept
    every one of them out of the repository -- but a working copy ended up
    showing fifty-odd entries where the checkout only has forty, and the ten
    extra were exactly the ones that grow and change. Separating them also
    means the project directory can be treated as replaceable (delete it,
    re-clone it) without taking someone's vocabulary notebook with it, which
    is what an installed application is expected to allow.

    Overridable for the same reason youtube_cache_dir is: pointing this at
    %LOCALAPPDATA% is the one change needed to make a real installer put
    user data where Windows expects it, and that shouldn't require editing
    code.
    """
    configured = config().get("data_dir")
    path = Path(configured) if configured else ROOT / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def youtube_cache_dir() -> Path:
    """Where the .strm placeholders and .srt sidecars for YouTube videos go.

    Defaults inside the project rather than next to a media library: a fresh
    clone has no idea where anyone keeps their media, and a path that just
    works beats one that has to be configured before anything runs. Point it
    at the media library in config.json if you'd rather keep them together.
    """
    configured = config().get("youtube_cache_dir")
    path = Path(configured) if configured else data_dir() / "youtube"
    # Created here, like data_dir does, rather than at the point something
    # first writes into it. youtube.py's lookup path *reads* the directory
    # (scanning for an already-cached subtitle) before anything ever writes
    # to it, and on a machine where no video has been registered yet that
    # read raised FileNotFoundError -- surfacing as a 400 from
    # /api/youtube/watch and a panel stuck on "还没有播放记录". Invisible to
    # anyone whose directory was created by some earlier run; every fresh
    # install hit it on the very first video.
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"[app_config] 建不了字幕缓存目录 {path}：{e}")
    return path


# ---- Generated / personal data (all inside data_dir) ---------------------
# Resolved once at import, like CACHE_DIR in youtube.py: a change to
# config.json takes effect on the next start, not mid-run.
DATA_DIR = data_dir()

DICT_DB = DATA_DIR / "dictionary.db"        # built by build_dict.py from ECDICT
DIFFICULTY_DB = DATA_DIR / "difficulty.db"  # built by indexer.py from the subtitle cache
VOCAB_FILE = DATA_DIR / "vocab.json"
PHRASES_FILE = DATA_DIR / "phrases.json"
PLAYBACK_STATE_FILE = DATA_DIR / "playback_state.json"
# Regenerated by app.py on every start (write_mcp_config), never hand-edited.
MCP_CONFIG_FILE = DATA_DIR / "mcp_config.json"

# ---- Per-service credentials -------------------------------------------
# Deliberately NOT in data_dir: these are written by a person, each has a
# committed *.example.json template sitting next to it, and README tells
# people to copy the template and drop the suffix. Moving the real file
# somewhere the template isn't would break that instruction for no gain --
# they aren't generated, and they don't grow.
DEEPSEEK_CONFIG_FILE = ROOT / "deepseek_config.json"
JELLYFIN_CONFIG_FILE = ROOT / "jellyfin_config.json"


def port() -> int:
    """Port the backend listens on. Configurable because the launcher offers
    it as a setting, and because 8420 is an arbitrary pick that can collide
    with whatever else a machine happens to be running."""
    try:
        return int(config().get("port") or 8420)
    except (TypeError, ValueError):
        print("[app_config] config.json 里的 port 不是合法数字，本次启动退回 8420")
        return 8420


def model_cache_dir() -> Path:
    """Where FunASR's ct-punc model gets downloaded to (~1.2GB).

    Defaults inside data_dir, like youtube_cache_dir does, rather than the
    ~/.cache/modelscope funasr would otherwise pick on its own: keeping it
    inside the project means deleting the project (but keeping data_dir)
    carries the already-downloaded model along instead of orphaning it
    somewhere in the user's home directory.
    """
    configured = config().get("model_cache_dir")
    path = Path(configured) if configured else data_dir() / "model_cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def punct_model_downloaded() -> bool:
    """Whether the ct-punc checkpoint has actually been fetched already.

    Distinct from funasr being importable: pip installing funasr does not
    fetch it, constructing the model is what does, and there is no
    download-only entry point -- so whoever constructs it first pays for
    that download, wherever they happen to be in the app when it happens.
    Gating on this (see youtube._ct_punc_model) keeps the download itself
    opt-in through the launcher's install button even when funasr is
    already present for some other reason (an old install, manual testing),
    instead of one more thing silently fetching 1.2GB the first time
    someone opens a video with unpunctuated captions.
    """
    models = model_cache_dir() / "models"
    if not models.is_dir():
        return False
    for d in models.glob("*punc_ct-transformer*"):
        size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
        if size > 100e6:      # a partial/aborted download is not "present"
            return True
    return False


def ffmpeg_dirs() -> list[Path]:
    """Extra directories to search for ffmpeg/ffprobe when they aren't on
    PATH. Empty by default -- PATH is where they're supposed to be, and this
    is only here so a portable/unzipped-somewhere build can be pointed at
    without touching the system PATH."""
    configured = config().get("ffmpeg_dir")
    return [Path(configured)] if configured else []
