#!/bin/bash
# Builds Echo.app, the native Mac app (Swift sources in macos/), ad-hoc signs it and installs it.
#
#   scripts/build-app.sh                 build and put Echo.app in ~/Applications   (npm run build-app)
#   scripts/build-app.sh --dist          build a universal Echo.app into dist/ (for packaging)
#   scripts/build-app.sh --out DIR       build into DIR instead (tests use a temp folder)
#   scripts/build-app.sh --echo-dir DIR  the Echo folder the app starts (default: this one)
#   scripts/build-app.sh --check         only check for Apple's Swift build tools (exit 1 if missing)
#
# Needs Apple's Command Line Tools (xcode-select --install) or Xcode; no Xcode project.
# An existing Echo.app is only replaced if it's Echo's (the native app or the older launcher app).

set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT="$HOME/Applications"
ECHO_DIR="$ROOT"
BAKE_DIR=1
UNIVERSAL=0
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ -n "$2" ] || { echo "--out needs a folder" >&2; exit 2; }; OUT="$2"; shift ;;
    --dist) OUT="$ROOT/dist"; UNIVERSAL=1; BAKE_DIR=0 ;;
    --echo-dir) [ -n "$2" ] || { echo "--echo-dir needs a folder" >&2; exit 2; }; ECHO_DIR="$2"; shift ;;
    --universal) UNIVERSAL=1 ;;
    --check) CHECK=1 ;;
    --help|-h) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# Looks for swiftc without running /usr/bin/swiftc, which would pop up Apple's install dialog.
swift_tools() {
  local dev
  dev="$(/usr/bin/xcode-select -p 2>/dev/null)" || return 1
  [ -x "$dev/usr/bin/swiftc" ] || [ -x "$dev/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc" ] || return 1
  /usr/bin/xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1
}

if ! swift_tools; then
  echo "Apple's Swift build tools aren't installed. Install them with: xcode-select --install" >&2
  exit 1
fi
[ "$CHECK" = 1 ] && { echo "Swift build tools are ready."; exit 0; }

case "$OUT" in "~"/*) OUT="$HOME/${OUT#\~/}" ;; esac
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
APP="$OUT/Echo.app"

if [ -d "$APP" ]; then
  old_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true)"
  case "$old_id" in
    local.echo.app|local.echo.launcher) ;;
    *) echo "There's already a different app called Echo at $APP; leaving it alone." >&2; exit 1 ;;
  esac
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BUILD="$WORK/Echo.app"
mkdir -p "$BUILD/Contents/MacOS" "$BUILD/Contents/Resources"

if [ "$UNIVERSAL" = 1 ]; then ARCHS="arm64 x86_64"; else ARCHS="$(uname -m)"; fi
echo "Building Echo.app ($ARCHS)…"
bins=()
for arch in $ARCHS; do
  /usr/bin/xcrun --sdk macosx swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" \
    -o "$WORK/Echo-$arch" "$ROOT"/macos/Sources/*.swift
  bins+=("$WORK/Echo-$arch")
done
if [ "${#bins[@]}" -gt 1 ]; then
  /usr/bin/lipo -create "${bins[@]}" -output "$BUILD/Contents/MacOS/Echo"
else
  mv "${bins[0]}" "$BUILD/Contents/MacOS/Echo"
fi

VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
sed "s/__VERSION__/${VERSION:-1.0.0}/g" "$ROOT/macos/Info.plist" > "$BUILD/Contents/Info.plist"
printf 'APPL????' > "$BUILD/Contents/PkgInfo"

# The icon: the prebuilt one (npm run icons makes it from the SVG), else made here from the PNG.
if [ -f "$ROOT/macos/Echo.icns" ]; then
  cp "$ROOT/macos/Echo.icns" "$BUILD/Contents/Resources/Echo.icns"
elif [ -f "$ROOT/public/icons/echo-512.png" ]; then
  set_dir="$WORK/Echo.iconset"
  mkdir -p "$set_dir"
  for s in 16 32 128 256 512; do
    /usr/bin/sips -z "$s" "$s" "$ROOT/public/icons/echo-512.png" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); [ "$d" -le 512 ] && /usr/bin/sips -z "$d" "$d" "$ROOT/public/icons/echo-512.png" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
  done
  /usr/bin/iconutil -c icns "$set_dir" -o "$BUILD/Contents/Resources/Echo.icns"
fi

# Where Echo lives, so the app can start it. A --dist build leaves it out: the installer sets it.
if [ "$BAKE_DIR" = 1 ]; then
  (cd "$ECHO_DIR" && pwd -P) > "$BUILD/Contents/Resources/echo-folder"
fi

/usr/bin/codesign --force --sign - --timestamp=none "$BUILD" >/dev/null 2>&1 || /usr/bin/codesign --force --sign - "$BUILD"
/usr/bin/codesign --verify "$BUILD"

rm -rf "$APP"
mv "$BUILD" "$APP"
touch "$APP"
# Tell Finder and Spotlight about it right away (only for a real install, not test builds).
[ "$OUT" = "$(cd "$HOME/Applications" 2>/dev/null && pwd -P)" ] &&
  { /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true; }
echo "Built $APP"
