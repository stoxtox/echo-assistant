#!/bin/bash
# Renders the Mac app's pearl, island and permissions checklist to PNGs with the app's own drawing code
# (macos/Tests/Render/main.swift), for looking at them against the approved design.
#   scripts/render-companion.sh OUT_DIR
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -eq 1 ] || { echo "usage: $0 OUT_DIR" >&2; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
/usr/bin/xcrun --sdk macosx swiftc -swift-version 5 -o "$WORK/render" \
  "$ROOT/macos/Sources/PointMath.swift" "$ROOT/macos/Sources/Companion.swift" "$ROOT/macos/Sources/PillArt.swift" "$ROOT/macos/Sources/Permissions.swift" \
  "$ROOT/macos/Tests/Render/main.swift"
"$WORK/render" "$@"
