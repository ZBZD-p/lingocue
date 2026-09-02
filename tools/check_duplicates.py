#!/usr/bin/env python3
"""Check files that must stay byte-for-byte identical (ignoring EOL style)."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
PAIRS = [
    ("static/tutor-panel.js", "extension/tutor-panel.js"),
    ("static/marked.min.js", "extension/marked.min.js"),
]


def normalized_bytes(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError, ValueError):
        pass
    for left_name, right_name in PAIRS:
        left = ROOT / left_name
        right = ROOT / right_name
        if not left.exists() or not right.exists():
            print(f"错误：必须同步的文件缺失：{left_name} 或 {right_name}")
            print("请确认文件路径正确后再提交。")
            return 1
        if normalized_bytes(left) != normalized_bytes(right):
            print(f"错误：文件不同步：{left_name} 与 {right_name}")
            print(f"请运行：Copy-Item .\\{left_name} .\\{right_name}")
            return 1
    print("OK：必须同步的文件均一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
