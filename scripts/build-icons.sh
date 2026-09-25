#!/bin/zsh
# Rasterize the Echo SVG icons into PNGs. Needs rsvg-convert (brew install librsvg).
set -e
cd "${0:A:h}/../public/icons"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found: brew install librsvg"; exit 1; }
rsvg-convert -w 16 -h 16 favicon-16.svg -o favicon-16.png
for s in 32 48; do rsvg-convert -w $s -h $s favicon.svg -o favicon-$s.png; done
rsvg-convert -w 180 -h 180 echo-app-icon.svg -o apple-touch-icon.png
for s in 192 512; do rsvg-convert -w $s -h $s echo-app-icon.svg -o echo-$s.png; done
echo "Icons written to public/icons"

# The Mac app's icon (macos/Echo.icns), every size straight from the SVG.
set_dir="$(mktemp -d)/Echo.iconset"
mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s echo-app-icon.svg -o "$set_dir/icon_${s}x${s}.png"
  rsvg-convert -w $((s * 2)) -h $((s * 2)) echo-app-icon.svg -o "$set_dir/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_dir" -o ../../macos/Echo.icns
rm -rf "${set_dir:h}"
echo "Mac app icon written to macos/Echo.icns"
