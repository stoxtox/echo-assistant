#!/bin/zsh
# Makes Echo's icons (npm run icons).
#
#   scripts/build-icons.sh [--preview FILE]
#
# The app icon (macos/Echo.icns, public/icons/echo-512.png, echo-192.png, apple-touch-icon.png) is
# rendered by scripts/render-icon.swift: the sunset drop from public/voiceviz.js on the macOS icon
# grid. It needs only Apple's Command Line Tools (swiftc, iconutil), and the output is reproducible.
# --preview also writes a contact sheet of every size (keep it outside the repo, e.g. /tmp).
# The favicons come from their SVGs and need rsvg-convert (brew install librsvg); they're skipped
# with a note if it's missing.
set -e
ROOT="${0:A:h:h}"
preview=()
[[ "$1" == --preview && -n "$2" ]] && preview=(--preview "$2")

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
/usr/bin/xcrun --sdk macosx swiftc -O "$ROOT/scripts/render-icon.swift" -o "$work/render-icon"
"$work/render-icon" --iconset "$work/Echo.iconset" --web "$ROOT/public/icons" $preview
/usr/bin/iconutil -c icns "$work/Echo.iconset" -o "$ROOT/macos/Echo.icns"
echo "App icon written to macos/Echo.icns and public/icons (echo-512, echo-192, apple-touch-icon)"

cd "$ROOT/public/icons"
if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 16 -h 16 favicon-16.svg -o favicon-16.png
  for s in 32 48; do rsvg-convert -w $s -h $s favicon.svg -o favicon-$s.png; done
  echo "Favicons written to public/icons"
else
  echo "rsvg-convert not found (brew install librsvg): favicons left as they are"
fi
