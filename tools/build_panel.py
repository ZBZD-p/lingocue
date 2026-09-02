#!/usr/bin/env python3
"""Build the tutor panel bundles from the ordered source fragment manifest."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "panel-src" / "manifest.json"
OUTPUTS = (
    ROOT / "static" / "tutor-panel.js",
    ROOT / "extension" / "tutor-panel.js",
)


def load_bundle(manifest_path: Path) -> bytes:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    fragments = data.get("fragments")
    if not isinstance(fragments, list) or not fragments:
        raise ValueError("manifest must contain a non-empty 'fragments' list")
    if any(not isinstance(fragment, str) for fragment in fragments):
        raise ValueError("manifest fragments must be strings")

    fragment_dir = manifest_path.parent
    return b"".join((fragment_dir / fragment).read_bytes() for fragment in fragments)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help="path to the ordered fragment manifest (default: panel-src/manifest.json)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify existing bundles without writing them",
    )
    args = parser.parse_args()

    manifest_path = args.manifest
    if not manifest_path.is_absolute():
        manifest_path = Path.cwd() / manifest_path
    manifest_path = manifest_path.resolve()

    try:
        bundle = load_bundle(manifest_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.check:
        mismatches = [str(path.relative_to(ROOT)) for path in OUTPUTS if not path.exists() or path.read_bytes() != bundle]
        if mismatches:
            print("generated bundle mismatch: " + ", ".join(mismatches), file=sys.stderr)
            return 1
        print("OK: generated tutor-panel bundles match the manifest")
        return 0

    for output in OUTPUTS:
        output.write_bytes(bundle)
        print(f"wrote {output.relative_to(ROOT)} ({len(bundle)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
