#!/usr/bin/env python3
"""
Freeze launcher.py into LingoCue.exe.

The point of freezing is that the launcher has to run on a machine with no
Python at all -- it is the thing that installs Python (see
launcher.bootstrap_runtime). A .py file cannot do that; a .exe can.

Only the launcher is frozen, never app.py. Every backend module locates its
files with `Path(__file__).resolve().parent`, which under a frozen build
points into a temporary extraction directory rather than the project, and
the databases it writes have to stay writable and stay put. The launcher
sidesteps all of it by spawning app.py as an ordinary script in an ordinary
interpreter -- so the backend keeps working exactly as it does today, and
the packaging problem shrinks to one self-contained window.

One-file rather than one-directory: one-directory would drop ~40 DLLs beside
app.py, which is the opposite of what the project directory needs. The cost
is roughly a second of extraction on each launch, which is invisible next to
the several seconds the backend itself takes to bind its port.

    python build_launcher.py

Needs pyinstaller (a build-time tool only -- deliberately not in
requirements.txt, since nobody running the app needs it).
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
BUILD = ROOT / "build"

# Nothing here is imported by launcher.py, but PyInstaller's dependency
# scanner pulls some of it in anyway through stdlib re-exports. Excluding
# them keeps the exe from carrying a test framework and a plotting stack it
# will never touch.
EXCLUDES = ["numpy", "scipy", "PIL", "matplotlib", "pytest", "setuptools",
            "pip", "unittest", "pydoc", "doctest", "test"]


def main() -> int:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("没装 pyinstaller。先跑：pip install pyinstaller")
        return 1

    try:
        import certifi  # noqa: F401
    except ImportError:
        print("没装 certifi。先跑：pip install certifi")
        print("（启动器靠它自带一份根证书；见 launcher.ssl_context 的说明）")
        return 1

    argv = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--windowed",              # no console window behind the GUI
        "--name", "LingoCue",
        "--distpath", str(DIST),
        "--workpath", str(BUILD),
        "--specpath", str(BUILD),
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

    print("$ " + " ".join(argv))
    code = subprocess.call(argv, cwd=str(ROOT))
    if code != 0:
        return code

    exe = DIST / "LingoCue.exe"
    if not exe.exists():
        print("打包命令成功了但没找到产物，检查上面的输出")
        return 1

    # Next to app.py, because ROOT is resolved from sys.executable's own
    # directory when frozen -- the exe has to sit beside the project it
    # launches, not in dist/.
    target = ROOT / "LingoCue.exe"
    shutil.copy2(exe, target)
    print(f"\n完成：{target}  ({target.stat().st_size/1e6:.1f}MB)")
    print("dist/ 和 build/ 是 PyInstaller 的中间产物，可以删。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
