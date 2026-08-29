#!/usr/bin/env python3
"""
Freeze launcher.py into LingoCue.exe, with the whole project inside it.

The point of freezing is that the launcher has to run on a machine with no
Python at all -- it is the thing that installs Python (see
launcher.bootstrap_runtime). A .py file cannot do that; a .exe can.

The exe also carries the project itself as a payload: every backend module,
static/, extension/, and the prebuilt dictionary. On first run the launcher
unpacks that into the directory the user picks, and from then on nothing
needs to be downloaded from GitHub -- which matters because
raw.githubusercontent.com is unreachable from some networks, and the 63MB
word list was the last thing still coming from there.

Carrying the source is not the same as freezing it. app.py is never frozen:
every backend module locates its files with `Path(__file__).resolve().parent`,
which under a frozen build points into a temporary extraction directory
rather than the install, and the databases it writes have to stay writable
and stay put. Unpacking to a real directory and running it there as an
ordinary script keeps all of that working exactly as it does from a git
clone -- the packaging problem stays confined to one self-contained window.

One-file rather than one-directory: one-directory would drop ~40 DLLs beside
the exe. The cost is roughly a second of extraction on each launch, which is
invisible next to the several seconds the backend itself takes to bind its
port.

    python build_launcher.py

Needs pyinstaller and certifi (build-time tools only -- deliberately not in
requirements.txt, since nobody running the app needs them).
"""

import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
BUILD = ROOT / "build"
STAGE = BUILD / "payload"

# Nothing here is imported by launcher.py, but PyInstaller's dependency
# scanner pulls some of it in anyway through stdlib re-exports. Excluding
# them keeps the exe from carrying a test framework and a plotting stack it
# will never touch.
EXCLUDES = ["numpy", "scipy", "PIL", "matplotlib", "pytest", "setuptools",
            "pip", "unittest", "pydoc", "doctest", "test"]

# The launcher itself is not in the payload: the exe *is* the launcher, and
# shipping a second copy as a script would just be one more thing that can
# drift out of sync with it.
SKIP_PY = {"launcher.py", "build_launcher.py"}


def stage_payload() -> None:
    """Collect everything the installed copy needs into one directory.

    Assembled here rather than passed to PyInstaller as twenty --add-data
    flags so that what ships is described in one readable place, and so a
    file added to the project later is picked up by the glob instead of
    needing a new flag nobody remembers to add.
    """
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)

    for py in sorted(ROOT.glob("*.py")):
        if py.name not in SKIP_PY:
            shutil.copy2(py, STAGE / py.name)

    for folder in ("static", "extension"):
        shutil.copytree(ROOT / folder, STAGE / folder,
                        ignore=shutil.ignore_patterns("__pycache__"))

    for extra in ("requirements.txt", "README.md", "LICENSE"):
        if (ROOT / extra).exists():
            shutil.copy2(ROOT / extra, STAGE / extra)
    for example in ROOT.glob("*.example.json"):
        shutil.copy2(example, STAGE / example.name)

    # The prebuilt dictionary, so a fresh install never has to fetch the
    # 63MB ECDICT csv. ECDICT is MIT licensed and README credits it; this
    # is a derived database of the same data.
    dict_db = ROOT / "data" / "dictionary.db"
    if dict_db.exists():
        (STAGE / "data").mkdir()
        shutil.copy2(dict_db, STAGE / "data" / "dictionary.db")
        print(f"    词典 {dict_db.stat().st_size/1e6:.1f}MB 已打包")
    else:
        print("    !! data/dictionary.db 不存在，这次打出来的 exe 不含词典。")
        print("       先跑 python build_dict.py 再打包。")

    # Compared against the same file in an existing install to decide whether
    # the code needs refreshing. A build stamp rather than a version number:
    # there is no release process here that would keep a number honest.
    (STAGE / "BUILD_STAMP").write_text(
        time.strftime("%Y-%m-%dT%H:%M:%S"), encoding="utf-8")

    total = sum(f.stat().st_size for f in STAGE.rglob("*") if f.is_file())
    n = sum(1 for f in STAGE.rglob("*") if f.is_file())
    print(f"    负载：{n} 个文件，{total/1e6:.1f}MB")


def main() -> int:
    for mod in ("PyInstaller", "certifi"):
        try:
            __import__(mod)
        except ImportError:
            print(f"没装 {mod}。先跑：pip install pyinstaller certifi")
            return 1

    print("==> 准备负载")
    stage_payload()

    print("==> 打包")
    argv = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--windowed",              # no console window behind the GUI
        "--name", "LingoCue",
        "--distpath", str(DIST),
        "--workpath", str(BUILD / "work"),
        "--specpath", str(BUILD),
        f"--add-data={STAGE}{os_sep()}payload",
        # Explicit, not left to the dependency scanner: launcher.ssl_context
        # imports certifi inside a try/except, and every HTTPS download the
        # launcher makes on a fresh Windows depends on the bundle coming
        # along. A silent miss here only shows up on a machine whose own
        # certificate store is empty -- i.e. never on the build machine.
        "--hidden-import", "certifi",
        "--collect-data", "certifi",
    ]
    for mod in EXCLUDES:
        argv += ["--exclude-module", mod]
    argv.append(str(ROOT / "launcher.py"))

    code = subprocess.call(argv, cwd=str(ROOT))
    if code != 0:
        return code

    exe = DIST / "LingoCue.exe"
    if not exe.exists():
        print("打包命令成功了但没找到产物，检查上面的输出")
        return 1

    target = ROOT / "LingoCue.exe"
    shutil.copy2(exe, target)
    print(f"\n完成：{target}  ({target.stat().st_size/1e6:.1f}MB)")
    print("dist/ 和 build/ 是 PyInstaller 的中间产物，可以删。")
    return 0


def os_sep() -> str:
    """--add-data's src/dest separator: ';' on Windows, ':' elsewhere."""
    return ";" if sys.platform == "win32" else ":"


if __name__ == "__main__":
    raise SystemExit(main())
