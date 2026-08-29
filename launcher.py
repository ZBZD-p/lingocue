#!/usr/bin/env python3
"""
Desktop front end for installing, configuring and running the backend.

Why this exists: everything this project does runs behind `python app.py`,
which means the install instructions bottom out in "open a terminal, keep it
open, and don't close it". That last part isn't documented anywhere and only
bites *after* a successful install -- close the window and the panel stops
working with no visible cause. Dependency problems have the same shape: a
missing package surfaces as a traceback in a console nobody is reading.

Deliberately NOT a frozen copy of the application. PyInstaller-ing app.py
itself would break the way every module resolves its paths (all of them are
`Path(__file__).resolve().parent`-relative, which under a frozen build points
into a temp extraction directory) and would have to solve keeping the
generated databases writable. This process only ever *spawns* app.py as an
ordinary script in an ordinary interpreter, so none of that applies: the
launcher can be frozen while the thing it launches stays exactly as it is.

Toolkit choice is forced, not preferred: this window's job includes running
pip, so it has to work before a single third-party package is installed.
That rules out every good-looking Tk wrapper (customtkinter, ttkbootstrap)
along with anything web-based. So: plain Tkinter, but with the native ttk
theming left switched off and the controls drawn on a Canvas instead, using
the same palette as static/panel.css so the launcher and the panel look like
parts of one product rather than two.
"""

import ctypes
import json
import os
import queue
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import tkinter as tk
import urllib.request
import webbrowser
import winreg
import zipfile
from pathlib import Path
from tkinter import filedialog, messagebox
from tkinter import font as tkfont

def _punct_row(e, action):
    """The 标点优化 row. Split out because it has three states, not two:
    the packages and the 1.2GB model are downloaded by separate steps and
    either can be present without the other. Reporting it as done once the
    packages land -- which is what a single boolean did -- told people the
    feature was ready while the part that actually does the work was still
    missing.
    """
    pkgs, model_mb = e["punct_pkgs"], e["punct_model_mb"]
    done = pkgs and model_mb > 0
    if done:
        detail = f"funasr + torch，模型 {model_mb/1000:.1f}GB 已就位"
        note = "已可用"
    elif pkgs:
        detail = "依赖装好了，但 1.2GB 的模型还没下"
        note = "现在这个状态下，第一次遇到没标点的字幕会临时去下模型（没有进度提示）"
    else:
        detail = "缺：" + "、".join(e["punct_missing"])
        note = ("YouTube 自动字幕完全没标点时才用得上。一次装完约下载 1.4GB、"
                "占用 2.4GB（torch 534MB + funasr 依赖 626MB + 模型 1.2GB）")
    return ("标点优化", detail, done, False, note,
            None if done else ("安装", action))


def _project_root() -> Path:
    """Where app.py lives -- which is NOT where __file__ points once frozen.

    PyInstaller's one-file mode unpacks the bundle into a temporary
    directory and sets __file__ inside it, so the usual
    Path(__file__).parent resolves to something like %TEMP%\_MEI123456: a
    folder holding neither app.py nor config.json, and one that is deleted
    on exit.

    Running from source this is simply this file's own directory. Frozen,
    it is wherever the user chose to install (see install_dir) -- and until
    they have chosen there is no project directory at all, which is what
    the first-run install view exists to resolve.
    """
    if not getattr(sys, "frozen", False):
        return Path(__file__).resolve().parent
    return install_dir() or Path(sys.executable).resolve().parent


# Where an installed copy put itself. Kept in HKCU rather than a file beside
# the exe: the exe is one self-contained file the user may move, rename, or
# run straight out of their downloads folder, and it cannot write to itself
# to remember anything.
APP_KEY = r"Software\LingoCue"


def install_dir() -> Path | None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, APP_KEY) as k:
            path = Path(winreg.QueryValueEx(k, "InstallDir")[0])
    except (OSError, ValueError):
        return None
    # A recorded path whose contents are gone (the folder was deleted) means
    # "not installed", not "installed and broken" -- the first-run view
    # should come back rather than the main window failing in odd ways.
    return path if (path / "app.py").exists() else None


def set_install_dir(path: Path) -> None:
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, APP_KEY) as k:
        winreg.SetValueEx(k, "InstallDir", 0, winreg.REG_SZ, str(path))


def default_install_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "Programs" / "LingoCue"


def payload_dir() -> Path | None:
    """The project files carried inside the exe (see build_launcher.py).

    None when running from source, where the project is already on disk and
    there is nothing to unpack.
    """
    if not getattr(sys, "frozen", False):
        return None
    p = Path(getattr(sys, "_MEIPASS", "")) / "payload"
    return p if p.is_dir() else None


# Never overwritten when refreshing an existing install: these belong to the
# user, not to the build. data/ holds the notebooks and databases, runtime/
# is a 100MB+ interpreter there is no reason to re-extract, and the config
# files hold their keys and paths.
PRESERVE = {"data", "runtime", "ffmpeg", "config.json",
            "jellyfin_config.json", "deepseek_config.json"}


def install_payload(dest: Path, log) -> bool:
    """Unpack the bundled project into dest, leaving user files alone.

    Also used to refresh an existing install when the exe is newer than what
    was unpacked, which is why it copies over the top rather than demanding
    an empty directory.
    """
    payload = payload_dir()
    if payload is None:
        log("从源码运行，没有需要解压的东西。")
        return True
    try:
        dest.mkdir(parents=True, exist_ok=True)
        count = 0
        for item in sorted(payload.iterdir()):
            if item.name in PRESERVE and (dest / item.name).exists():
                log(f"  保留已有的 {item.name}")
                continue
            target = dest / item.name
            if item.is_dir():
                shutil.copytree(item, target, dirs_exist_ok=True)
                count += sum(1 for f in item.rglob("*") if f.is_file())
            else:
                shutil.copy2(item, target)
                count += 1
        # data/ is preserved wholesale above, which would also skip the
        # bundled dictionary for anyone who already has a data directory but
        # no dictionary in it -- an install whose dictionary was deleted, or
        # one created before the exe carried one. Delivered here as a
        # special case: filled in when absent, never overwritten when
        # present, since a rebuilt dictionary is still the user's.
        bundled_db = payload / "data" / "dictionary.db"
        target_db = dest / "data" / "dictionary.db"
        if bundled_db.exists() and not target_db.exists():
            target_db.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(bundled_db, target_db)
            log(f"  补上内置词典 ({target_db.stat().st_size/1e6:.1f}MB)")
            count += 1

        log(f"  已解压 {count} 个文件")
        return True
    except OSError as e:
        log(f"解压失败：{e}")
        return False


def _stamp(folder: Path | None) -> str:
    if folder is None:
        return ""
    try:
        return (folder / "BUILD_STAMP").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def needs_refresh(root: Path) -> bool:
    """Whether the exe carries a newer build than what is unpacked."""
    bundled = _stamp(payload_dir())
    return bool(bundled) and bundled != _stamp(root)


def clear_install_record() -> None:
    """Forget where the install was, and drop the autostart entry with it.

    Leaving a Run entry pointing at a folder that no longer exists would
    make Windows try to launch a missing program on every login.
    """
    for key, value in ((APP_KEY, "InstallDir"), (RUN_KEY, RUN_VALUE)):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0,
                                winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, value)
        except OSError:
            pass
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, APP_KEY)
    except OSError:
        pass


def uninstall(root: Path, data: Path, keep_data: bool, log) -> bool:
    """Remove an install, optionally sparing the user's own files.

    The data directory is handled separately rather than as a subtree of
    root, because config.json can point it somewhere else entirely -- in
    which case deleting root would miss it, and "keep my data" would be
    silently wrong in the other direction too.
    """
    running_exe = Path(sys.executable).resolve() if getattr(sys, "frozen", False) else None
    data = data.resolve()
    keep = data if keep_data else None

    def onerror(func, path, exc):
        log(f"  删不掉 {path}（{exc[1]}）")

    deleted = 0
    for item in sorted(root.iterdir()) if root.is_dir() else []:
        target = item.resolve()
        if keep and (target == keep or keep.is_relative_to(target)):
            log(f"  保留 {item.name}")
            continue
        # The exe can sit inside the folder it installed to, and Windows
        # will not let a running program delete itself.
        if running_exe and (target == running_exe or running_exe.is_relative_to(target)):
            log(f"  跳过 {item.name}（这个程序自己正在运行）")
            continue
        try:
            if item.is_dir():
                shutil.rmtree(item, onerror=onerror)
            else:
                item.unlink()
            deleted += 1
        except OSError as e:
            log(f"  删不掉 {item.name}（{e}）")

    if not keep_data and data.exists() and not data.is_relative_to(root.resolve()):
        try:
            shutil.rmtree(data, onerror=onerror)
            log(f"  已删除数据目录 {data}")
        except OSError as e:
            log(f"  删不掉 {data}（{e}）")

    clear_install_record()
    log(f"  已清除注册表记录（安装位置、开机自启）")

    try:
        if root.is_dir() and not any(root.iterdir()):
            root.rmdir()
    except OSError:
        pass
    log(f"卸载完成，处理了 {deleted} 项。")
    return True


def set_root(path: Path) -> None:
    """Point every path the launcher uses at a project directory.

    Settled once at startup and again after a first-run install, so these
    are recomputed rather than staying constants derived from a ROOT that no
    longer holds.
    """
    global ROOT, CONFIG_FILE, RUNTIME_DIR
    ROOT = path
    CONFIG_FILE = ROOT / "config.json"
    RUNTIME_DIR = ROOT / "runtime"


ROOT = _project_root()
CONFIG_FILE = ROOT / "config.json"

DEFAULT_PORT = 8420
STARTUP_TIMEOUT_S = 30

# Mirrors setup.ps1's source for the same download, so the two paths can't
# drift to different builds of ffmpeg.
FFMPEG_URL = ("https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/"
              "ffmpeg-master-latest-win64-gpl.zip")
TORCH_INDEX = "https://download.pytorch.org/whl/cpu"

# Python's own embeddable distribution: a zip that unpacks into a working
# interpreter with no installer, no registry entries, no PATH changes and no
# administrator rights. That is the whole reason the launcher can claim to
# work on a machine with no Python -- pointing people at python.org means
# an installer, a checkbox they have to notice ("Add python.exe to PATH"),
# and a terminal restart, and getting any of it wrong produces a "Python not
# found" that looks identical to not having installed it at all.
# Pinned rather than "latest": there is no stable URL for latest, and a
# silent version bump is not something a launcher should do by itself.
PYTHON_VERSION = "3.12.10"
PYTHON_EMBED_URL = (f"https://www.python.org/ftp/python/{PYTHON_VERSION}/"
                    f"python-{PYTHON_VERSION}-embed-amd64.zip")
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"
RUNTIME_DIR = ROOT / "runtime"

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "LingoCue"

_CREATE_NO_WINDOW = 0x08000000
_CREATE_NEW_PROCESS_GROUP = 0x00000200

# ---- palette (static/panel.css, dark theme) -----------------------------
BG = "#14110f"
SURFACE = "#221d19"
SURFACE_HI = "#2b2521"
LINE = "#312a24"
INK = "#f9f4ed"
MUTED = "#82796a"
DIM = "#645c50"
ACCENT = "#f6a06b"
ACCENT_INK = "#14110f"
ACCENT_SOFT = "#2f241c"
OK = "#6fbf8f"
WARN = "#d9ac62"
BAD = "#e0897a"


# ======================================================================
# high-DPI
# ======================================================================

# Set from the real screen DPI once the root window exists; every hardcoded
# pixel measurement below goes through px() so the layout keeps its physical
# proportions instead of shrinking as the display scaling goes up.
SCALE = 1.0


def enable_dpi() -> None:
    """Declare DPI awareness before Tk creates its first window.

    Without this Windows renders the window at 96 DPI and then bitmap-scales
    the result up to whatever the display is set to -- 125% on the machine
    this was written on, which is exactly why the first version looked
    blurry, like a low-resolution image stretched to fit. Declaring
    awareness makes Tk draw at the real pixel density instead, and Tk then
    picks up the correct font scaling on its own (measured: `tk scaling`
    goes from 1.333 to 1.666 the moment this is called first).

    Must happen before Tk() -- the awareness of a process is latched the
    first time it creates a window, and cannot be changed afterwards.
    """
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
        return
    except (AttributeError, OSError):
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()  # pre-8.1 fallback
    except (AttributeError, OSError):
        pass


def px(n: float) -> int:
    return round(n * SCALE)


# ======================================================================
# environment probing
# ======================================================================

# Runs inside the interpreter that will actually run app.py -- not this one.
# When the launcher is frozen it carries none of these packages itself, so
# asking its own importlib would report everything as missing.
PROBE_SRC = r"""
import json, sys, importlib.util
mods = ["fastapi","uvicorn","pydantic","requests","youtube_transcript_api",
        "mcp","funasr","torch","torchaudio"]
found = {}
for m in mods:
    try:
        found[m] = importlib.util.find_spec(m) is not None
    except Exception:
        found[m] = False
print(json.dumps({"version": list(sys.version_info[:3]),
                  "executable": sys.executable, "modules": found}))
"""

CORE_MODULES = ["fastapi", "uvicorn", "pydantic", "requests", "youtube_transcript_api"]
PUNCT_MODULES = ["funasr", "torch", "torchaudio"]


def find_python() -> str | None:
    """The interpreter to run app.py with.

    Checked in the order that stays right after this file is frozen: a
    runtime/ directory beside the launcher wins, because a packaged build
    ships its own interpreter and must not silently fall back to whatever
    unrelated Python is on PATH. sys.executable is skipped when frozen --
    there it is the launcher's own exe, which cannot run a script.
    """
    bundled = ROOT / "runtime" / "python.exe"
    if bundled.exists():
        return str(bundled)
    if not getattr(sys, "frozen", False):
        return sys.executable
    for name in ("python", "py"):
        hit = shutil.which(name)
        if hit and not _is_store_stub(hit):
            return hit
    return None


def _is_store_stub(path: str) -> bool:
    """Whether this is Microsoft's app-execution-alias placeholder rather
    than a real interpreter.

    Windows ships C:\\...\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe
    on every installation, including ones with no Python at all. It is a
    zero-byte reparse point whose only behaviour is to print "Python was not
    found but can be installed from the Microsoft Store" and exit 9009.
    shutil.which() finds it and reports success, so without this check the
    launcher hands that path to pip and the user watches a 9009 scroll past
    -- seen exactly that way on a clean VM.
    """
    return "\\windowsapps\\" in path.lower()


def read_config() -> dict:
    """Read config.json directly rather than importing app_config.

    app_config would work today (it needs only json and pathlib), but the
    launcher has to keep working when the project's own modules aren't
    importable -- which is exactly the situation on a machine where setup
    hasn't run yet, and the situation inside a frozen build.
    """
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_config(updates: dict) -> None:
    cfg = read_config()
    cfg.update(updates)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def data_dir() -> Path:
    configured = read_config().get("data_dir")
    return Path(configured) if configured else ROOT / "data"


def model_cache_dir() -> Path:
    configured = read_config().get("model_cache_dir")
    return Path(configured) if configured else data_dir() / "model_cache"


def configured_port() -> int:
    try:
        return int(read_config().get("port") or DEFAULT_PORT)
    except (TypeError, ValueError):
        return DEFAULT_PORT


def ffmpeg_present() -> str | None:
    hit = shutil.which("ffmpeg")
    if hit:
        return hit
    for candidate in (read_config().get("ffmpeg_dir"), ROOT / "ffmpeg" / "bin"):
        if candidate and (Path(candidate) / "ffmpeg.exe").exists():
            return str(Path(candidate) / "ffmpeg.exe")
    return None


# Where ModelScope caches what it downloads. Matched by glob rather than by
# the exact directory name (iic--punc_ct-transformer_cn-en-common-vocab471067-large)
# because that name is funasr's choice of model, not ours, and a funasr
# upgrade that points "ct-punc" at a different checkpoint would otherwise
# make an installed model look missing forever.
def punct_model_size() -> int:
    """Bytes of the downloaded punctuation model, 0 if it isn't there.

    Checked separately from the funasr/torch packages because installing
    those does NOT fetch it: funasr downloads the checkpoint the first time
    a model is actually constructed. Left to happen on its own, that is a
    1.2GB download starting silently while someone waits for subtitles, with
    no progress anywhere and no explanation if it fails.
    """
    models = model_cache_dir() / "models"
    if not models.is_dir():
        return 0
    for d in models.glob("*punc_ct-transformer*"):
        size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
        if size > 100e6:      # a partial/aborted download is not "present"
            return size
    return 0


def probe() -> dict:
    """Everything the 环境 view shows, gathered in one pass."""
    python = find_python()
    info: dict = {"python": python, "version": None, "modules": {}}
    if python:
        try:
            out = subprocess.run([python, "-c", PROBE_SRC], capture_output=True,
                                 text=True, timeout=30,
                                 creationflags=_CREATE_NO_WINDOW)
            if out.returncode == 0:
                info.update(json.loads(out.stdout.strip().splitlines()[-1]))
        except (OSError, ValueError, subprocess.SubprocessError):
            pass

    mods = info.get("modules", {})
    ver = info.get("version")
    dict_db = data_dir() / "dictionary.db"
    deepseek_cfg = ROOT / "deepseek_config.json"
    try:
        has_key = bool(json.loads(deepseek_cfg.read_text(encoding="utf-8")).get("api_key"))
    except (OSError, json.JSONDecodeError):
        has_key = False

    return {
        "python_path": python,
        "python_version": ver,
        "python_ok": bool(ver) and tuple(ver) >= (3, 10),
        "core_ok": all(mods.get(m) for m in CORE_MODULES),
        "core_missing": [m for m in CORE_MODULES if not mods.get(m)],
        "mcp": bool(mods.get("mcp")),
        "punct_pkgs": all(mods.get(m) for m in PUNCT_MODULES),
        "punct_missing": [m for m in PUNCT_MODULES if not mods.get(m)],
        "punct_model_mb": punct_model_size() / 1e6,
        "ffmpeg": ffmpeg_present(),
        "dict_db": dict_db if dict_db.exists() else None,
        "dict_size_mb": round(dict_db.stat().st_size / 1e6, 1) if dict_db.exists() else 0,
        "claude": shutil.which("claude"),
        "deepseek_key": has_key,
        "jellyfin": (ROOT / "jellyfin_config.json").exists(),
    }


def ssl_context() -> ssl.SSLContext:
    """A TLS context that works on a machine that has never been online.

    Python's ssl module trusts whatever is currently in the Windows root
    store and nothing else. Windows fills that store lazily over time
    through automatic root updates, and unlike browsers, Python does not
    chase down a missing issuer via AIA. So on a freshly installed Windows
    -- which is precisely who this launcher is for -- the store is nearly
    empty and every HTTPS download dies with "unable to get local issuer
    certificate". Confirmed exactly that way on a clean VM, while the same
    binary worked on a machine whose store had accumulated 84 roots.

    certifi ships Mozilla's root bundle as a file, so carrying it removes
    the dependency on the machine's own store entirely. It is bundled into
    the frozen build (see build_launcher.py). Falling back to the default
    context if it somehow isn't there is better than failing outright --
    but verification is never disabled: this downloads an interpreter that
    then executes, and an unverified download of that is not worth any
    amount of convenience.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def download_to(url: str, dest: Path, label: str, log) -> None:
    """Fetch a file, reporting progress through `log` about every 5%.

    Progress matters more than it looks: the two things this downloads are
    11MB and 100MB, and a launcher that sits silent for a minute during a
    fresh install is indistinguishable from one that has hung.
    """
    log(f"下载 {label}...")
    with urllib.request.urlopen(url, context=ssl_context()) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got, step = 0, max(int(total * 0.05), 1)
        nxt = step
        while chunk := r.read(262144):
            f.write(chunk)
            got += len(chunk)
            if got >= nxt:
                pct = f" ({got*100//total}%)" if total else ""
                log(f"  {got/1e6:.0f}MB / {total/1e6:.0f}MB{pct}")
                nxt += step
    log(f"  下载完成：{dest.name}")


def run_streamed(argv, log, cwd=None) -> bool:
    """Run one command with its output going to `log`. Returns success."""
    log("$ " + " ".join(str(a) for a in argv))
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    try:
        p = subprocess.Popen(argv, cwd=str(cwd or ROOT), env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding="utf-8", errors="replace",
                             creationflags=_CREATE_NO_WINDOW)
        for line in p.stdout:
            log(line.rstrip())
        if p.wait() != 0:
            log(f"[失败，返回码 {p.returncode}]")
            return False
        return True
    except OSError as exc:
        log(f"[启动失败：{exc}]")
        return False


def bootstrap_runtime(runtime_dir: Path, project_root: Path, log,
                      workdir: Path | None = None) -> bool:
    """Unpack a private Python into `runtime_dir` and make it usable.

    Module-level, and taking its logging as a callback, so this can be
    exercised by a test against a scratch directory rather than re-typed
    there: a test that replays the steps instead of calling them drifts out
    of date the moment the real one is fixed, which is exactly what happened
    while this was being written.

    Three steps, and the middle one is the part that isn't obvious.
    """
    workdir = workdir or project_root
    zip_path = workdir / "python-embed.zip"
    get_pip = workdir / "get-pip.py"
    try:
        download_to(PYTHON_EMBED_URL, zip_path, f"Python {PYTHON_VERSION} (11MB)", log)
        log(f"解压到 {runtime_dir.name}/ ...")
        runtime_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(runtime_dir)

        # The ._pth file REPLACES sys.path entirely -- it disables site,
        # drops the script/current directory, and makes PYTHONPATH be
        # ignored. Confirmed for real: without the edits below pip reports a
        # successful install and then nothing can be imported, and
        # `runtime\python.exe build_dict.py` dies on `import app_config`
        # even when run from the project directory.
        pth = next(runtime_dir.glob("python*._pth"), None)
        if not pth:
            raise RuntimeError("解压后找不到 ._pth 文件，压缩包结构和预期不符")
        text = pth.read_text(encoding="utf-8")
        text = text.replace("#import site", "import site")
        if "Lib\\site-packages" not in text:
            text = text.rstrip() + "\nLib\\site-packages\n"
        if str(project_root) not in text:
            text = text.rstrip() + f"\n{project_root}\n"
        pth.write_text(text, encoding="utf-8")
        log(f"  已启用 site、site-packages 和项目根目录（{pth.name}）")

        python = runtime_dir / "python.exe"
        download_to(GET_PIP_URL, get_pip, "get-pip.py", log)
        # --retries on every pip call below, not just the big one: a mirror
        # that returns a truncated response is the single most common way
        # this fails on a real machine (hit repeatedly against a configured
        # Aliyun mirror while testing), and it can strike the two-package
        # steps just as easily as the long one.
        if not run_streamed([str(python), str(get_pip), "--no-warn-script-location",
                             "--retries", "5", "--no-cache-dir"],
                            log, cwd=project_root):
            raise RuntimeError("装 pip 失败")
        # setuptools before the requirements: the embeddable build ships
        # without it, and any dependency that still builds through the PEP
        # 517 backend fails with a bare "Cannot import 'setuptools.build_meta'"
        # that says nothing about what is actually missing.
        if not run_streamed([str(python), "-m", "pip", "install", "setuptools", "wheel",
                             "--no-warn-script-location", "--retries", "5",
                             "--no-cache-dir"], log, cwd=project_root):
            raise RuntimeError("装 setuptools 失败")
        # --no-cache-dir: pip's cache is shared with every other Python on
        # the machine, and one truncated wheel in it makes every retry fail
        # identically (hit for real while testing -- the same package failed
        # three times running until the cache was bypassed).
        if not run_streamed([str(python), "-m", "pip", "install", "-r", "requirements.txt",
                             "--no-cache-dir", "--retries", "5",
                             "--no-warn-script-location"], log, cwd=project_root):
            raise RuntimeError("装依赖失败")
        log(f"── 完成，后端以后会用 {python} ──")
        return True
    except Exception as exc:
        log(f"── 失败：{exc} ──")
        return False
    finally:
        zip_path.unlink(missing_ok=True)
        get_pip.unlink(missing_ok=True)


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


# ======================================================================
# hand-drawn widgets
# ======================================================================

def _round_rect(canvas: tk.Canvas, x1, y1, x2, y2, r, **kw):
    """Rounded rectangle as a smoothed polygon. Tk has no rounded frame and
    no border-radius; without this every control is a hard-cornered box and
    the window looks like it was built in 1998."""
    pts = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2,
           x2 - r, y2, x1 + r, y2, x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]
    return canvas.create_polygon(pts, smooth=True, **kw)


class Button(tk.Canvas):
    """Flat rounded button with hover and disabled states.

    A tk.Button cannot be given a flat look on Windows (the native border is
    drawn by the OS), and ttk.Button's background follows the system theme
    rather than the colour asked for, so both would stand out against this
    palette instead of belonging to it.
    """

    def __init__(self, parent, text, command=None, variant="ghost", width=None, **kw):
        self.variant = variant
        self.enabled = True
        self._text = text
        f = tkfont.nametofont("TkDefaultFont").copy()
        f.configure(size=10, weight="bold" if variant == "accent" else "normal")
        self._font = f
        # f.measure() is already in real pixels (the font scaled itself), so
        # only the padding around the text needs px().
        h = px(34)
        w = px(width) if width else (f.measure(text) + px(34))
        super().__init__(parent, width=w, height=h, bg=parent["bg"],
                         highlightthickness=0, bd=0, **kw)
        self.command = command
        self._shape = _round_rect(self, 1, 1, w - 1, h - 1, px(9), fill="", outline="")
        self._label = self.create_text(w / 2, h / 2, text=text, font=f)
        self.bind("<Enter>", lambda e: self._paint(hover=True))
        self.bind("<Leave>", lambda e: self._paint())
        self.bind("<Button-1>", self._click)
        self._paint()

    def _colors(self, hover):
        if not self.enabled:
            return SURFACE, DIM, LINE
        if self.variant == "accent":
            return (ACCENT if not hover else "#ffb27d"), ACCENT_INK, ""
        if self.variant == "danger":
            return (SURFACE_HI if hover else SURFACE), BAD, LINE
        return (SURFACE_HI if hover else SURFACE), INK, LINE

    def _paint(self, hover=False):
        fill, ink, outline = self._colors(hover)
        self.itemconfigure(self._shape, fill=fill, outline=outline)
        self.itemconfigure(self._label, fill=ink)
        self.configure(cursor="hand2" if self.enabled else "")

    def _click(self, _e):
        if self.enabled and self.command:
            self.command()

    def set_text(self, text):
        self._text = text
        self.itemconfigure(self._label, text=text)

    def set_enabled(self, on: bool):
        self.enabled = on
        self._paint()


class Dot(tk.Canvas):
    """Status dot. Colour is the whole message, so it gets to be a real
    filled circle rather than a coloured character that renders differently
    on every machine."""

    def __init__(self, parent, color=DIM, size=10):
        s = px(size)
        super().__init__(parent, width=s, height=s, bg=parent["bg"],
                         highlightthickness=0, bd=0)
        self._id = self.create_oval(1, 1, s - 1, s - 1, fill=color, outline="")

    def set(self, color):
        self.itemconfigure(self._id, fill=color)


class Scroll(tk.Frame):
    """Vertically scrollable container.

    The environment list is taller than the window's default height and the
    settings form grows with every field added, so both need somewhere to
    overflow to. Locking the window size instead would have been simpler but
    doesn't survive contact with other machines: the geometry is computed
    from the display's DPI, so the same layout that fits at 125% is 1140x840
    at 150% and stops fitting on a small laptop screen -- a window that can
    scroll works at every size, a fixed one only works at the size it was
    measured on.

    The scrollbar hides itself when everything already fits, so the common
    case doesn't show a permanently full-height scrollbar that does nothing.
    """

    def __init__(self, parent, bg=BG):
        super().__init__(parent, bg=bg)
        self.canvas = tk.Canvas(self, bg=bg, highlightthickness=0, bd=0)
        self.bar = tk.Scrollbar(self, orient="vertical", command=self.canvas.yview,
                                bg=bg, troughcolor=bg, bd=0, relief="flat", width=px(10))
        self.canvas.configure(yscrollcommand=self._on_scroll)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.inner = tk.Frame(self.canvas, bg=bg)
        self._win = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.inner.bind("<Configure>", lambda e: self.canvas.configure(
            scrollregion=self.canvas.bbox("all")))
        # Keep the inner frame exactly as wide as the viewport, or its
        # children would size to their own content and the right-aligned
        # install buttons would sit at the text's width instead of the
        # card's edge.
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(
            self._win, width=e.width))

        # bind_all rather than a per-widget bind: the wheel event goes to the
        # specific label or button under the pointer, not to the canvas, so
        # binding only the canvas would make the wheel work everywhere except
        # over the actual content. Only one Scroll is ever on screen at a
        # time, and the binding is dropped again on leave.
        self.canvas.bind("<Enter>", lambda e: self.canvas.bind_all("<MouseWheel>", self._wheel))
        self.canvas.bind("<Leave>", lambda e: self.canvas.unbind_all("<MouseWheel>"))

    def _wheel(self, event):
        self.canvas.yview_scroll(-event.delta // 120, "units")

    def _on_scroll(self, first, last):
        fits = float(first) <= 0.0 and float(last) >= 1.0
        if fits and self.bar.winfo_ismapped():
            self.bar.pack_forget()
        elif not fits and not self.bar.winfo_ismapped():
            self.bar.pack(side=tk.RIGHT, fill=tk.Y)
        self.bar.set(first, last)


def card(parent) -> tk.Frame:
    return tk.Frame(parent, bg=SURFACE, highlightbackground=LINE,
                    highlightthickness=1, bd=0)


def label(parent, text, size=10, color=INK, bold=False, bg=None):
    f = tkfont.nametofont("TkDefaultFont").copy()
    f.configure(size=size, weight="bold" if bold else "normal")
    return tk.Label(parent, text=text, font=f, fg=color, bg=bg or parent["bg"],
                    justify="left", anchor="w")


# ======================================================================
# the window
# ======================================================================

class Installer:
    """First-run window: pick a folder, unpack the project into it.

    Separate from App rather than a fourth view inside it, because until
    this finishes there is no project directory for any of App's views to
    describe -- no config to read, no app.py to start, no dependency tree to
    check. Once it succeeds it hands off to App in the same window.
    """

    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("LingoCue 安装")
        root.geometry(f"{px(620)}x{px(400)}")
        root.minsize(px(560), px(360))
        root.configure(bg=BG)

        wrap = tk.Frame(root, bg=BG)
        wrap.pack(fill=tk.BOTH, expand=True, padx=px(24), pady=px(22))

        label(wrap, "LingoCue", size=18, bold=True).pack(anchor="w")
        label(wrap, "看剧、看 YouTube 学英语的辅助面板",
              size=10, color=MUTED).pack(anchor="w", pady=(px(2), px(18)))

        label(wrap, "安装到", bold=True).pack(anchor="w")
        label(wrap, "程序文件、Python 运行时和你的学习数据都会放在这里",
              size=8, color=DIM).pack(anchor="w", pady=(0, px(6)))

        row = tk.Frame(wrap, bg=BG)
        row.pack(fill=tk.X)
        self.entry = tk.Entry(row, bg=SURFACE, fg=INK, insertbackground=ACCENT,
                              relief="flat", bd=0, font=("Consolas", 10),
                              highlightthickness=1, highlightbackground=LINE,
                              highlightcolor=ACCENT)
        self.entry.insert(0, str(default_install_dir()))
        self.entry.pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=px(7), ipadx=px(8))
        Button(row, "浏览", command=self.browse, width=74).pack(side=tk.LEFT, padx=(px(8), 0))

        payload = payload_dir()
        size = sum(f.stat().st_size for f in payload.rglob("*") if f.is_file()) if payload else 0
        label(wrap, f"需要约 {size/1e6:.0f}MB，装依赖后共约 400MB。"
                    "已经内置了词典，不用再下 63MB 的词表。",
              size=8, color=DIM).pack(anchor="w", pady=(px(10), px(16)))

        actions = tk.Frame(wrap, bg=BG)
        actions.pack(fill=tk.X)
        self.go = Button(actions, "安装", command=self.install, variant="accent", width=110)
        self.go.pack(side=tk.LEFT)
        self.hint = label(actions, "", size=9, color=MUTED)
        self.hint.pack(side=tk.LEFT, padx=(px(12), 0))

        box = card(wrap)
        box.pack(fill=tk.BOTH, expand=True, pady=(px(16), 0))
        self.log = tk.Text(box, bg=SURFACE, fg=MUTED, font=("Consolas", 9),
                           relief="flat", bd=0, wrap="word", padx=px(12), pady=px(10),
                           state=tk.DISABLED)
        self.log.pack(fill=tk.BOTH, expand=True)

    def write(self, line):
        self.log.configure(state=tk.NORMAL)
        self.log.insert(tk.END, line.rstrip() + "\n")
        self.log.see(tk.END)
        self.log.configure(state=tk.DISABLED)
        self.root.update_idletasks()

    def browse(self):
        picked = filedialog.askdirectory(title="选择安装位置")
        if picked:
            self.entry.delete(0, tk.END)
            self.entry.insert(0, str(Path(picked) / "LingoCue"))

    def install(self):
        dest = Path(self.entry.get().strip())
        if not dest.is_absolute():
            self.hint.configure(text="请填一个完整路径", fg=BAD)
            return
        # Refuse a directory that already holds unrelated files: this copies
        # a whole project tree in, and doing that into someone's Documents
        # folder because they picked one level too high is not recoverable
        # by them.
        if dest.exists() and any(dest.iterdir()) and not (dest / "app.py").exists():
            self.hint.configure(text="这个文件夹非空且不像已有安装，换一个", fg=BAD)
            return

        self.go.set_enabled(False)
        self.hint.configure(text="")
        self.write(f"安装到 {dest}")
        if not install_payload(dest, self.write):
            self.go.set_enabled(True)
            self.hint.configure(text="安装失败，看下面的日志", fg=BAD)
            return
        try:
            set_install_dir(dest)
        except OSError as e:
            self.write(f"（记不住安装位置：{e}）")
        set_root(dest)
        self.write("完成，正在打开主界面...")

        for child in self.root.winfo_children():
            child.destroy()
        App(self.root)


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.proc: subprocess.Popen | None = None
        self.log_queue: queue.Queue[str] = queue.Queue()
        self.ready = False
        self.busy = False          # a pip/build task is running
        self.env: dict = {}
        self.port = configured_port()

        root.title("LingoCue")
        # Tall enough for the environment list (measured: 757px of rows at
        # 125%, plus ~208px of header/nav/buttons) but clamped to the screen,
        # because that ideal height is computed from the display's DPI and at
        # 150% would exceed the usable height of a 1080p laptop. Whatever
        # doesn't fit scrolls -- see Scroll.
        want_h = px(786)
        root.geometry(f"{px(760)}x{min(want_h, int(root.winfo_screenheight() * 0.85))}")
        root.minsize(px(620), px(420))
        root.configure(bg=BG)

        self._build_header()
        self._build_nav()
        self.body = tk.Frame(root, bg=BG)
        self.body.pack(fill=tk.BOTH, expand=True, padx=px(18), pady=(0, px(16)))

        # Before the first show(): building a view calls refresh(), which
        # reads self.external to decide what the status line says.
        self.external = port_open(self.port)
        if self.external:
            self.ready = True

        self.show("状态")

        if self.external:
            self.write(f"检测到 {self.port} 端口已经有后端在跑（不是这个窗口启动的）。")
            self.write("这个窗口只能管自己启动的进程，要接管的话先把那边停掉再点启动。")

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        # An exe newer than what is unpacked refreshes the code in place. Only
        # the code: PRESERVE keeps the notebooks, databases, interpreter and
        # config files untouched, so updating is dropping in a new exe and
        # reopening it.
        if needs_refresh(ROOT):
            self.write("检测到新版本，正在更新程序文件（不动你的数据）...")
            install_payload(ROOT, self.write)
            self.write("更新完成。")

        self.refresh()
        self.root.after(100, self._drain_log)
        self.refresh_env(quiet=True)

    # ---- chrome --------------------------------------------------------

    def _build_header(self):
        head = tk.Frame(self.root, bg=BG)
        head.pack(fill=tk.X, padx=px(18), pady=(px(16), px(10)))
        label(head, "LingoCue", size=17, bold=True).pack(side=tk.LEFT)

        right = tk.Frame(head, bg=BG)
        right.pack(side=tk.RIGHT)
        self.dot = Dot(right)
        self.dot.pack(side=tk.LEFT, padx=(0, px(7)), pady=px(4))
        self.status_label = label(right, "", color=MUTED)
        self.status_label.pack(side=tk.LEFT)

    def _build_nav(self):
        nav = tk.Frame(self.root, bg=BG)
        nav.pack(fill=tk.X, padx=px(18), pady=(0, px(14)))
        self.tabs = {}
        for name in ("状态", "环境", "设置"):
            b = Button(nav, name, command=lambda n=name: self.show(n), width=76)
            b.pack(side=tk.LEFT, padx=(0, px(8)))
            self.tabs[name] = b

    def show(self, name):
        for child in self.body.winfo_children():
            child.destroy()
        for tab_name, b in getattr(self, "tabs", {}).items():
            b.variant = "accent" if tab_name == name else "ghost"
            b._paint()
        self.current = name
        {"状态": self._view_status, "环境": self._view_env, "设置": self._view_settings}[name]()

    # ---- 状态 ----------------------------------------------------------

    def _view_status(self):
        bar = tk.Frame(self.body, bg=BG)
        bar.pack(fill=tk.X, pady=(0, px(12)))
        self.toggle_btn = Button(bar, "启动", command=self.toggle, variant="accent", width=110)
        self.toggle_btn.pack(side=tk.LEFT)
        self.panel_btn = Button(bar, "打开面板", command=self.open_panel, width=110)
        self.panel_btn.pack(side=tk.LEFT, padx=(px(8), 0))

        wrap = card(self.body)
        wrap.pack(fill=tk.BOTH, expand=True)
        self.log = tk.Text(wrap, bg=SURFACE, fg=MUTED, insertbackground=INK,
                           font=("Consolas", 9), relief="flat", bd=0, wrap="word",
                           padx=px(14), pady=px(12), state=tk.DISABLED,
                           selectbackground=ACCENT_SOFT)
        sb = tk.Scrollbar(wrap, command=self.log.yview, bg=SURFACE,
                          troughcolor=SURFACE, bd=0, relief="flat", width=px(10))
        self.log.configure(yscrollcommand=sb.set)
        sb.pack(side=tk.RIGHT, fill=tk.Y)
        self.log.pack(fill=tk.BOTH, expand=True)
        self.log.tag_configure("ink", foreground=INK)
        self._replay_log()
        self.refresh()

    # ---- 环境 ----------------------------------------------------------

    def _view_env(self):
        top = tk.Frame(self.body, bg=BG)
        top.pack(fill=tk.X, pady=(0, px(12)))
        self.recheck_btn = Button(top, "重新检测", command=self.refresh_env, width=104)
        self.recheck_btn.pack(side=tk.LEFT)
        self.fixall_btn = Button(top, "安装缺少的必需项", command=self.install_required,
                                 variant="accent", width=160)
        self.fixall_btn.pack(side=tk.LEFT, padx=(px(8), 0))

        outer = card(self.body)
        outer.pack(fill=tk.BOTH, expand=True)
        scroll = Scroll(outer, bg=SURFACE)
        scroll.pack(fill=tk.BOTH, expand=True)
        # _render_env packs its rows into whatever this points at, so making
        # it the scrollable inner frame needs no change there.
        self.env_box = scroll.inner
        self._render_env()

    def _render_env(self):
        if not hasattr(self, "env_box") or not self.env_box.winfo_exists():
            return
        for child in self.env_box.winfo_children():
            child.destroy()
        e = self.env
        if not e:
            label(self.env_box, "检测中...", color=MUTED, bg=SURFACE).pack(
                anchor="w", padx=px(16), pady=px(14))
            return

        ver = ".".join(map(str, e["python_version"])) if e["python_version"] else "找不到"
        rows = [
            ("Python", ver, e["python_ok"], True,
             e["python_path"] or f"没有的话点右边，会下一份 {PYTHON_VERSION} 装进 runtime/，"
                                 f"不碰系统环境",
             ("安装", self.install_runtime) if not e["python_ok"] else None),
            ("核心依赖", "fastapi / uvicorn / pydantic / requests / youtube-transcript-api",
             e["core_ok"], True,
             "缺：" + "、".join(e["core_missing"]) if e["core_missing"] else "都在",
             ("安装", self.install_core) if not e["core_ok"] else None),
            ("本地词典", f"data/dictionary.db（{e['dict_size_mb']}MB）" if e["dict_db"]
             else "还没生成", bool(e["dict_db"]), True,
             "悬停查词、难度评分都要它。词表从 GitHub 下载，"
             "连不上就用「选文件」指向已有的 ecdict.csv" if not e["dict_db"] else "已生成",
             [("生成", self.build_dict), ("选文件", self.pick_dict_csv)]
             if not e["dict_db"] else None),
            ("对话引擎", "Claude Code CLI" if e["claude"] else
             ("DeepSeek（已配 key）" if e["deepseek_key"] else "两个都没配"),
             bool(e["claude"] or e["deepseek_key"]), False,
             "不配也能用：字幕、查词、生词本、难度徽章都不依赖它", None),
            ("mcp", "Claude Code CLI 那条路要它", e["mcp"], False,
             "只用 DeepSeek 的话用不到", None),
            ("ffmpeg", e["ffmpeg"] or "没找到", bool(e["ffmpeg"]), False,
             "只有看本地媒体库才需要；只用 YouTube 可以不装（约 100MB）",
             ("下载", self.install_ffmpeg) if not e["ffmpeg"] else None),
            _punct_row(e, self.install_punct),
            ("Jellyfin", "已配置" if e["jellyfin"] else "没配置", e["jellyfin"], False,
             "只有看本地媒体库才需要", None),
        ]

        for i, (name, detail, ok, required, note, action) in enumerate(rows):
            row = tk.Frame(self.env_box, bg=SURFACE)
            row.pack(fill=tk.X, padx=px(16), pady=(px(12 if i == 0 else 9), 0))
            Dot(row, OK if ok else (BAD if required else WARN)).pack(
                side=tk.LEFT, padx=(0, px(10)), pady=px(5))
            texts = tk.Frame(row, bg=SURFACE)
            texts.pack(side=tk.LEFT, fill=tk.X, expand=True)
            head = tk.Frame(texts, bg=SURFACE)
            head.pack(fill=tk.X, anchor="w")
            label(head, name, bold=True, bg=SURFACE).pack(side=tk.LEFT)
            if not required:
                label(head, "  可选", size=8, color=DIM, bg=SURFACE).pack(side=tk.LEFT)
            label(texts, detail, size=9, color=INK if ok else MUTED, bg=SURFACE).pack(anchor="w")
            label(texts, note, size=8, color=DIM, bg=SURFACE).pack(anchor="w")
            # A row may offer more than one way out (the dictionary can be
            # downloaded or built from a file you already have), so `action`
            # is either one (label, command) pair or a list of them.
            actions = [] if not action else (
                [action] if isinstance(action[0], str) else list(action))
            for label_text, command in reversed(actions):
                b = Button(row, label_text, command=command, width=76)
                b.pack(side=tk.RIGHT, padx=(px(8), 0))
                b.set_enabled(not self.busy)
        tk.Frame(self.env_box, bg=SURFACE, height=px(14)).pack()

    # ---- 设置 ----------------------------------------------------------

    def _view_settings(self):
        outer = card(self.body)
        outer.pack(fill=tk.BOTH, expand=True)
        scroll = Scroll(outer, bg=SURFACE)
        scroll.pack(fill=tk.BOTH, expand=True)
        box = scroll.inner
        cfg = read_config()
        self.fields = {}

        specs = [
            ("port", "端口", str(configured_port()), "后端监听哪个端口，改完要重启后端"),
            ("data_dir", "数据目录", cfg.get("data_dir", ""),
             "词典、生词本、难度库存哪。留空 = 项目下的 data/"),
            ("youtube_cache_dir", "YouTube 字幕缓存", cfg.get("youtube_cache_dir", ""),
             "留空 = 数据目录下的 youtube/"),
            ("ffmpeg_dir", "ffmpeg 目录", cfg.get("ffmpeg_dir", ""),
             "ffmpeg 不在 PATH 时的兜底目录。留空 = 只找 PATH"),
            ("model_cache_dir", "标点模型目录", cfg.get("model_cache_dir", ""),
             "标点优化的 ct-punc 模型（约 1.2GB）下载到哪。留空 = 数据目录下的 model_cache/"),
        ]
        for i, (key, name, value, note) in enumerate(specs):
            row = tk.Frame(box, bg=SURFACE)
            row.pack(fill=tk.X, padx=px(16), pady=(px(14 if i == 0 else 10), 0))
            label(row, name, bold=True, bg=SURFACE).pack(anchor="w")
            label(row, note, size=8, color=DIM, bg=SURFACE).pack(anchor="w", pady=(0, px(4)))
            entry = tk.Entry(row, bg=BG, fg=INK, insertbackground=ACCENT,
                             relief="flat", bd=0, font=("Consolas", 10),
                             highlightthickness=1, highlightbackground=LINE,
                             highlightcolor=ACCENT)
            entry.insert(0, value)
            entry.pack(fill=tk.X, ipady=px(6), ipadx=px(8))
            self.fields[key] = entry

        auto = tk.Frame(box, bg=SURFACE)
        auto.pack(fill=tk.X, padx=px(16), pady=(px(16), 0))
        self.autostart = tk.BooleanVar(value=autostart_enabled())
        cb = tk.Checkbutton(auto, text="  开机自启（登录后自动打开这个窗口）",
                            variable=self.autostart, bg=SURFACE, fg=INK,
                            selectcolor=BG, activebackground=SURFACE,
                            activeforeground=INK, relief="flat", bd=0,
                            highlightthickness=0, anchor="w")
        cb.pack(anchor="w")

        actions = tk.Frame(box, bg=SURFACE)
        actions.pack(fill=tk.X, padx=px(16), pady=(px(18), px(16)))
        Button(actions, "保存", command=self.save_settings, variant="accent",
               width=100).pack(side=tk.LEFT)
        self.save_hint = label(actions, "", size=9, color=MUTED, bg=SURFACE)
        self.save_hint.pack(side=tk.LEFT, padx=(px(12), 0))

        tk.Frame(box, bg=LINE, height=1).pack(fill=tk.X, padx=px(16), pady=(px(6), 0))
        where = tk.Frame(box, bg=SURFACE)
        where.pack(fill=tk.X, padx=px(16), pady=(px(16), px(18)))
        label(where, "安装位置", bold=True, bg=SURFACE).pack(anchor="w")
        label(where, str(ROOT), size=9, color=MUTED, bg=SURFACE).pack(anchor="w")
        label(where, "Chrome 加载扩展时要选这个目录下的 extension 文件夹",
              size=8, color=DIM, bg=SURFACE).pack(anchor="w", pady=(0, px(8)))
        wrow = tk.Frame(where, bg=SURFACE)
        wrow.pack(fill=tk.X)
        Button(wrow, "打开文件夹", command=self.open_folder, width=110).pack(side=tk.LEFT)
        Button(wrow, "打开扩展文件夹", command=self.open_extension,
               width=130).pack(side=tk.LEFT, padx=(px(8), 0))
        # Only offered for a real install. Running from a git clone, "卸载"
        # would mean deleting the working copy, which is not what anyone
        # pressing this button in a checkout could possibly want.
        if getattr(sys, "frozen", False) and install_dir() is not None:
            Button(wrow, "卸载", command=self.do_uninstall, variant="danger",
                   width=90).pack(side=tk.RIGHT)

    def open_folder(self):
        os.startfile(ROOT)

    def open_extension(self):
        target = ROOT / "extension"
        os.startfile(target if target.is_dir() else ROOT)

    def do_uninstall(self):
        data = data_dir()
        msg = (f"将删除：\n{ROOT}\n\n"
               "包括程序文件、内置的 Python 运行时和依赖。\n\n确定继续吗？")
        if not messagebox.askyesno("卸载 LingoCue", msg,
                                   icon="warning", default="no",
                                   parent=self.root):
            return
        # Asked separately and defaulted to keeping: the vocabulary notebook
        # is the one thing here that took real time to accumulate and cannot
        # be regenerated by reinstalling.
        keep = messagebox.askyesno(
            "保留学习数据？",
            f"要保留生词本、短语本、词汇量测试结果和字幕缓存吗？\n\n"
            f"它们在：\n{data}\n\n"
            "选「是」= 保留（重装后还在）\n选「否」= 一并删除",
            default="yes", parent=self.root)

        self.show("状态")
        self.write("── 卸载 ──")
        if self.proc and self.proc.poll() is None:
            self.stop()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        uninstall(ROOT, data, keep, self.write)
        if keep:
            self.write(f"学习数据保留在 {data}")
        self.write("可以关掉这个窗口了。")
        if keep:
            done = f"已卸载。学习数据保留在：\n{data}"
        else:
            done = "已卸载，全部文件都删掉了。"
        messagebox.showinfo("卸载完成", done, parent=self.root)

    def save_settings(self):
        updates = {}
        raw_port = self.fields["port"].get().strip()
        try:
            p = int(raw_port)
            if not (1 <= p <= 65535):
                raise ValueError
        except ValueError:
            self.save_hint.configure(text="端口要是 1-65535 的整数", fg=BAD)
            return
        updates["port"] = p
        for key in ("data_dir", "youtube_cache_dir", "ffmpeg_dir", "model_cache_dir"):
            updates[key] = self.fields[key].get().strip()
        write_config(updates)
        set_autostart(self.autostart.get())
        self.port = p
        self.save_hint.configure(text="已保存，重启后端生效", fg=OK)
        self.write(f"设置已写入 {CONFIG_FILE.name}")
        self.refresh_env(quiet=True)

    # ---- install tasks -------------------------------------------------

    def _run_task(self, title, argv_list, done=None):
        """Run a sequence of commands, streaming into the log.

        On a worker thread because pip installing torch takes minutes, and
        the window has to keep drawing (and its log keep scrolling) the whole
        time -- a frozen window during a 5.7GB download is indistinguishable
        from a crashed one.
        """
        if self.busy:
            self.write("已经有一个安装任务在跑了，等它结束。")
            return
        self.busy = True
        self.show("状态")
        self.write(f"── {title} ──")

        def work():
            ok = True
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONUNBUFFERED"] = "1"
            env["MODELSCOPE_CACHE"] = str(model_cache_dir())
            for argv in argv_list:
                self.write("$ " + " ".join(str(a) for a in argv))
                try:
                    p = subprocess.Popen(argv, cwd=str(ROOT), env=env,
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         text=True, encoding="utf-8", errors="replace",
                                         creationflags=_CREATE_NO_WINDOW)
                    for line in p.stdout:
                        self.write(line)
                    if p.wait() != 0:
                        ok = False
                        self.write(f"[失败，返回码 {p.returncode}]")
                        break
                except OSError as exc:
                    ok = False
                    self.write(f"[启动失败：{exc}]")
                    break
            self.write("── 完成 ──" if ok else "── 中断 ──")
            self.root.after(0, lambda: self._task_done(done, ok))

        threading.Thread(target=work, daemon=True).start()

    def _task_done(self, done, ok):
        self.busy = False
        if done and ok:
            done()
        self.refresh_env(quiet=True)
        self.refresh()

    def install_runtime(self):
        if self.busy:
            self.write("已经有一个安装任务在跑了，等它结束。")
            return
        self.busy = True
        self.show("状态")
        self.write(f"── 安装内置 Python {PYTHON_VERSION} ──")
        self.refresh()

        def work():
            ok = bootstrap_runtime(RUNTIME_DIR, ROOT, self.write)
            self.root.after(0, lambda: self._task_done(None, ok))

        threading.Thread(target=work, daemon=True).start()

    def install_core(self):
        py = find_python()
        if not py:
            self.write("找不到 Python，先装 3.10+。")
            return
        self._run_task("安装核心依赖", [[py, "-m", "pip", "install", "-r", "requirements.txt"]])

    # Constructing the model is what makes funasr fetch it; there is no
    # "download only" entry point. Done here, as the last step of the same
    # button, so the whole 1.4GB happens once, deliberately, with the log
    # visible -- rather than starting itself later while someone waits for
    # subtitles to appear.
    _FETCH_MODEL = ("from funasr import AutoModel; AutoModel(model='ct-punc'); "
                    "print('模型就绪')")

    def install_punct(self):
        py = find_python()
        if not py:
            return
        self.write("这一步要下约 1.4GB（依赖 240MB + 模型 1.2GB），装完占 2.4GB。")
        self.write("模型那段下载没有逐行进度，看起来会像卡住，耐心等几分钟。")
        self._run_task("安装标点优化", [
            [py, "-m", "pip", "install", "torch", "torchaudio", "--index-url", TORCH_INDEX],
            [py, "-m", "pip", "install", "funasr"],
            [py, "-c", self._FETCH_MODEL],
        ])

    def build_dict(self):
        py = find_python()
        if not py:
            return
        self._run_task("生成本地词典（要下 63MB 的 ECDICT 词表）",
                       [[py, "build_dict.py"]])

    def pick_dict_csv(self):
        """Build the dictionary from a CSV the user already has.

        The download goes straight to raw.githubusercontent.com, which is
        simply unreachable from some networks -- reported from a VM where it
        timed out at the TCP level while pip (pointed at a domestic mirror)
        worked fine. Nothing in the launcher can fix that route, but it can
        stop the file being impossible to supply by hand.
        """
        path = filedialog.askopenfilename(
            title="选择 ecdict.csv",
            filetypes=[("ECDICT 词表", "ecdict.csv"), ("CSV", "*.csv"), ("所有文件", "*.*")])
        if not path:
            return
        py = find_python()
        if not py:
            return
        self._run_task(f"从本地词表生成词典（{Path(path).name}）",
                       [[py, "build_dict.py", "--csv", path]])

    def install_required(self):
        py = find_python()
        if not py or not self.env.get("python_ok"):
            # No usable interpreter is the one case that can't be a step in
            # the batch below -- every other step needs an interpreter to run
            # in. So it runs alone, and installing it also installs the
            # requirements, leaving only the dictionary for a second pass.
            self.install_runtime()
            return
        steps = []
        if not self.env.get("core_ok"):
            steps.append([py, "-m", "pip", "install", "-r", "requirements.txt"])
        if not self.env.get("dict_db"):
            steps.append([py, "build_dict.py"])
        if not steps:
            self.write("必需项都齐了，没什么要装的。")
            return
        self._run_task("安装缺少的必需项", steps)

    def install_ffmpeg(self):
        """Downloaded here rather than shelling out to setup.ps1: the same
        few lines, but the progress lands in this window's log instead of a
        console the user can't see."""
        if self.busy:
            return
        self.busy = True
        self.show("状态")
        self.write("── 下载 ffmpeg（约 100MB）──")

        def work():
            dest = ROOT / "ffmpeg"
            tmp = ROOT / "ffmpeg-download.zip"
            try:
                download_to(FFMPEG_URL, tmp, "ffmpeg (100MB)", self.write)
                self.write("解压中...")
                with zipfile.ZipFile(tmp) as z:
                    for member in z.namelist():
                        if "/bin/" in member and member.endswith((".exe", ".dll")):
                            target = dest / "bin" / Path(member).name
                            target.parent.mkdir(parents=True, exist_ok=True)
                            with z.open(member) as src, open(target, "wb") as out:
                                shutil.copyfileobj(src, out)
                tmp.unlink(missing_ok=True)
                write_config({"ffmpeg_dir": str(dest / "bin").replace("\\", "/")})
                self.write(f"── 完成，已写入 config.json：{dest / 'bin'} ──")
            except Exception as exc:
                self.write(f"── 失败：{exc} ──")
                tmp.unlink(missing_ok=True)
            self.root.after(0, lambda: self._task_done(None, True))

        threading.Thread(target=work, daemon=True).start()

    def refresh_env(self, quiet=False):
        if not quiet:
            self.write("重新检测环境...")

        def work():
            result = probe()
            self.root.after(0, lambda: self._env_done(result, quiet))

        threading.Thread(target=work, daemon=True).start()

    def _env_done(self, result, quiet):
        self.env = result
        self._render_env()
        if not quiet:
            missing = []
            if not result["python_ok"]:
                missing.append("Python 3.10+")
            if not result["core_ok"]:
                missing.append("核心依赖")
            if not result["dict_db"]:
                missing.append("本地词典")
            self.write("必需项齐了。" if not missing else "还缺：" + "、".join(missing))

    # ---- backend lifecycle ---------------------------------------------

    def toggle(self):
        if self.proc and self.proc.poll() is None:
            self.stop()
        else:
            self.start()

    def start(self):
        python = find_python()
        if not python:
            self.write("找不到 Python。去「环境」页看看。")
            return
        if not self.env.get("core_ok", True):
            self.write("核心依赖还没装齐，先去「环境」页装上，否则后端起不来。")
        if port_open(self.port):
            self.write(f"端口 {self.port} 已经被占用了，先停掉那个再启动。")
            return

        self.write(f"启动中：{python} app.py（端口 {self.port}）")
        env = dict(os.environ)
        # app.py prints Chinese diagnostics. Through a pipe, Python defaults
        # to the console codepage (cp936 here), which arrives as mojibake in
        # the log view; forcing UTF-8 on both sides is the whole fix.
        env["PYTHONIOENCODING"] = "utf-8"
        # Unbuffered, or the child's stdout sits in an 8KB block and the log
        # stays empty until something finally flushes it.
        env["PYTHONUNBUFFERED"] = "1"
        try:
            self.proc = subprocess.Popen(
                [python, "app.py"], cwd=str(ROOT), env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
                creationflags=_CREATE_NO_WINDOW | _CREATE_NEW_PROCESS_GROUP)
        except OSError as e:
            self.write(f"启动失败：{e}")
            return

        self.ready = False
        threading.Thread(target=self._read_output, args=(self.proc,), daemon=True).start()
        self.refresh()
        self._poll_ready(STARTUP_TIMEOUT_S * 10)

    def _poll_ready(self, left):
        if not self.proc or self.proc.poll() is not None:
            return
        if port_open(self.port):
            self.ready = True
            self.write(f"就绪：http://127.0.0.1:{self.port}")
            self.refresh()
            return
        if left <= 0:
            self.write(f"等了 {STARTUP_TIMEOUT_S} 秒端口还没起来，看看上面的日志。")
            return
        self.root.after(100, lambda: self._poll_ready(left - 1))

    def stop(self):
        if not self.proc or self.proc.poll() is not None:
            return
        self.write("正在停止...")
        # taskkill /T rather than Popen.terminate(): terminate() signals only
        # the direct child, and anything app.py spawned (the Claude CLI for a
        # chat turn, ffmpeg for a subtitle extraction) would be orphaned with
        # nothing left to reap it.
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.proc.pid)],
                       capture_output=True, creationflags=_CREATE_NO_WINDOW)

    def _read_output(self, proc):
        for line in proc.stdout:
            self.write(line)
        self.write(f"[后端已退出，返回码 {proc.wait()}]")
        self.root.after(0, self._on_exit)

    def _on_exit(self):
        self.proc = None
        self.ready = False
        self.refresh()

    def open_panel(self):
        webbrowser.open(f"http://127.0.0.1:{self.port}")

    # ---- shared UI state -----------------------------------------------

    def refresh(self):
        running = self.proc is not None and self.proc.poll() is None
        if self.external and not running:
            text, color, toggle, panel = f"运行中（外部进程） · {self.port}", OK, False, True
            toggle_text = "启动"
        elif running and self.ready:
            text, color, toggle, panel = f"运行中 · 127.0.0.1:{self.port}", OK, True, True
            toggle_text = "停止"
        elif running:
            text, color, toggle, panel = "启动中...", WARN, True, False
            toggle_text = "停止"
        else:
            text, color, toggle, panel = "已停止", DIM, True, False
            toggle_text = "启动"
        self.dot.set(color)
        self.status_label.configure(text=text)
        if hasattr(self, "toggle_btn") and self.toggle_btn.winfo_exists():
            self.toggle_btn.set_text(toggle_text)
            self.toggle_btn.set_enabled(toggle and not self.busy)
            self.panel_btn.set_enabled(panel)

    def write(self, line):
        self.log_queue.put(line.rstrip("\n"))

    def _replay_log(self):
        for line in getattr(self, "_history", []):
            self._append(line)

    def _append(self, line):
        self.log.configure(state=tk.NORMAL)
        self.log.insert(tk.END, line + "\n", "ink" if line.startswith("──") else "")
        self.log.see(tk.END)
        self.log.configure(state=tk.DISABLED)

    def _drain_log(self):
        """Batched on a timer rather than one widget update per line: a
        backend that logs a burst (every subtitle fetch does) would otherwise
        post hundreds of separate Tk events."""
        lines = []
        try:
            while True:
                lines.append(self.log_queue.get_nowait())
        except queue.Empty:
            pass
        if lines:
            # Kept so switching tabs and coming back doesn't lose the log --
            # the Text widget is destroyed and rebuilt with the view.
            self._history = (getattr(self, "_history", []) + lines)[-500:]
            if hasattr(self, "log") and self.log.winfo_exists():
                for line in lines:
                    self._append(line)
        self.root.after(100, self._drain_log)

    def on_close(self):
        # Stops the backend rather than leaving it orphaned: there is no tray
        # icon yet, so a backend left running would have no window left to
        # stop it from -- exactly the "invisible process" problem this exists
        # to remove.
        if self.proc and self.proc.poll() is None:
            self.stop()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        self.root.destroy()


# ---- autostart (HKCU Run, no admin rights and nothing to clean up) ------

def _autostart_command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    pyw = Path(sys.executable).with_name("pythonw.exe")
    runner = pyw if pyw.exists() else Path(sys.executable)
    return f'"{runner}" "{ROOT / "launcher.py"}"'


def autostart_enabled() -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            return bool(winreg.QueryValueEx(k, RUN_VALUE)[0])
    except OSError:
        return False


def set_autostart(on: bool) -> None:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            winreg.SetValueEx(k, RUN_VALUE, 0, winreg.REG_SZ, _autostart_command())
        else:
            try:
                winreg.DeleteValue(k, RUN_VALUE)
            except OSError:
                pass


def main():
    global SCALE
    enable_dpi()          # before Tk(): awareness is latched at first window
    root = tk.Tk()
    # Measured from the window rather than assumed: this is the actual pixels
    # per inch Tk is drawing at, which is only correct because enable_dpi()
    # already ran. Tk scales point-sized fonts by itself once aware, so this
    # factor is applied to pixel measurements only.
    SCALE = root.winfo_fpixels("1i") / 96.0

    if getattr(sys, "frozen", False) and install_dir() is None:
        # Nothing is installed yet, so there is no project directory for the
        # main window's views to describe. Ask where it should go first.
        Installer(root)
    else:
        App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
