#!/bin/bash
# Builds Echo.app, the native Mac app (Swift sources in macos/), signs it and installs it.
#
#   scripts/build-app.sh                 build and put Echo.app in ~/Applications   (npm run build-app)
#   scripts/build-app.sh --dist          build a universal Echo.app into dist/ (for packaging)
#   scripts/build-app.sh --out DIR       build into DIR instead (tests use a temp folder)
#   scripts/build-app.sh --echo-dir DIR  the Echo folder the app starts (default: this one)
#   scripts/build-app.sh --check         only check for Apple's Swift build tools (exit 1 if missing)
#   scripts/build-app.sh --identity      only print which identity the app would be signed with
#
# Signing: macOS remembers Screen Recording, Accessibility, Microphone and Input Monitoring per app signature,
# so every build is signed with the SAME identity and the bundle id never changes (local.echo.app):
# a "Developer ID Application" or "Apple Development" certificate from your keychain if you have
# one, otherwise a local self-signed "Echo Local Signing" certificate that this script makes once
# in your login keychain. (macOS may ask once to let codesign use it: click Always Allow.)
# A --dist build stays ad hoc, so no personal certificate goes into a shared app.
# ECHO_SIGN_IDENTITY overrides the choice (a name or SHA-1, "-" for ad hoc, or "local" for the
# self-signed Echo Local Signing identity, made once if missing); ECHO_SIGN_KEYCHAIN
# (with ECHO_SIGN_KEYCHAIN_PASSWORD) uses another keychain instead of the login one, for tests.
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
SHOW_IDENTITY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ -n "$2" ] || { echo "--out needs a folder" >&2; exit 2; }; OUT="$2"; shift ;;
    --dist) OUT="$ROOT/dist"; UNIVERSAL=1; BAKE_DIR=0 ;;
    --echo-dir) [ -n "$2" ] || { echo "--echo-dir needs a folder" >&2; exit 2; }; ECHO_DIR="$2"; shift ;;
    --universal) UNIVERSAL=1 ;;
    --check) CHECK=1 ;;
    --identity) SHOW_IDENTITY=1 ;;
    --help|-h) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# --- signing identity ---
LOCAL_IDENTITY="Echo Local Signing"
KEYCHAIN="${ECHO_SIGN_KEYCHAIN:-}"

# "SHA1 name" for each code-signing identity (valid only with -v; the local one is self-signed,
# so it's untrusted, which is fine for codesign and for macOS's permission records).
identities() {
  if [ -n "$KEYCHAIN" ]; then /usr/bin/security find-identity -p codesigning $1 "$KEYCHAIN" 2>/dev/null
  else /usr/bin/security find-identity -p codesigning $1 2>/dev/null; fi |
    sed -n 's/^ *[0-9][0-9]*) \([0-9A-F]\{40\}\) "\([^"]*\)".*/\1 \2/p' | awk '!seen[$0]++'
}

# Prints the SHA-1 of the first identity whose name starts with $1 (valid ones only unless $2=any).
find_identity() {
  local flag="-v"
  [ "${2:-}" = any ] && flag=""
  identities "$flag" | while read -r hash name; do
    case "$name" in "$1"*) echo "$hash"; break ;; esac
  done
}

# Makes the local self-signed code-signing certificate once, in the login keychain.
make_local_identity() {
  local tmp kc pass
  tmp="$(mktemp -d)"
  kc="$KEYCHAIN"
  [ -n "$kc" ] || kc="$(/usr/bin/security login-keychain 2>/dev/null | sed 's/^ *"//; s/" *$//')"
  [ -n "$kc" ] || { rm -rf "$tmp"; return 1; }
  cat > "$tmp/cert.cnf" <<CNF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = $LOCAL_IDENTITY
[ ext ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
  pass="$(/usr/bin/od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  # /usr/bin/openssl is LibreSSL: its .p12 files are the kind the keychain can import.
  if /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$tmp/cert.cnf" \
       -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1 &&
     /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$LOCAL_IDENTITY" \
       -out "$tmp/id.p12" -passout "pass:$pass" >/dev/null 2>&1 &&
     /usr/bin/security import "$tmp/id.p12" -k "$kc" -P "$pass" -f pkcs12 -T /usr/bin/codesign >/dev/null 2>&1; then
    # Lets codesign use the key without asking (needs the keychain's password; only for test keychains).
    if [ -n "${ECHO_SIGN_KEYCHAIN_PASSWORD:-}" ]; then
      /usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$ECHO_SIGN_KEYCHAIN_PASSWORD" "$kc" >/dev/null 2>&1 || true
    fi
    rm -rf "$tmp"
    echo "Made the \"$LOCAL_IDENTITY\" certificate in $(basename "$kc"); every Echo.app build is signed with it from now on." >&2
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

# Which identity to sign with: prints a SHA-1, or "-" for ad hoc.
pick_identity() {
  local id want="${ECHO_SIGN_IDENTITY:-}"
  if [ -n "$want" ] && [ "$want" != local ]; then echo "$want"; return; fi
  if [ "$BAKE_DIR" = 0 ] && [ "$want" != local ]; then echo "-"; return; fi   # --dist: shared builds stay ad hoc
  # ECHO_SIGN_IDENTITY=local: always the self-signed local identity, even with an Apple certificate.
  if [ "$want" != local ]; then
    for prefix in "Developer ID Application" "Apple Development"; do
      id="$(find_identity "$prefix")"
      [ -n "$id" ] && { echo "$id"; return; }
    done
  fi
  id="$(find_identity "$LOCAL_IDENTITY" any)"
  if [ -z "$id" ] && [ "${NO_CREATE:-0}" != 1 ] && make_local_identity; then id="$(find_identity "$LOCAL_IDENTITY" any)"; fi
  echo "${id:--}"
}

identity_name() {
  [ "$1" = "-" ] && { echo "ad hoc"; return; }
  identities "" | awk -v h="$1" '$1 == h { $1 = ""; sub(/^ /, ""); print; exit }' | grep . || echo "$1"
}

if [ "$SHOW_IDENTITY" = 1 ]; then
  id="$(NO_CREATE=1 pick_identity)"
  echo "$(identity_name "$id") ($id)"
  exit 0
fi

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
  # Foundation Models (macOS 26+, LocalModel.swift) is linked weakly, so the app still opens on older macOS.
  /usr/bin/xcrun --sdk macosx swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" \
    -Xlinker -weak_framework -Xlinker FoundationModels \
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

# The icon: rendered fresh from scripts/render-icon.swift (same Swift tools as the app, plus
# iconutil), else the committed macos/Echo.icns (npm run icons makes it), else made from the PNG.
icon_built=0
if [ -f "$ROOT/scripts/render-icon.swift" ] && [ -x /usr/bin/iconutil ] && [ "${ECHO_SKIP_ICON_RENDER:-}" != 1 ]; then
  echo "Rendering the app icon…"
  if /usr/bin/xcrun --sdk macosx swiftc -O "$ROOT/scripts/render-icon.swift" -o "$WORK/render-icon" 2>/dev/null &&
     "$WORK/render-icon" --iconset "$WORK/Echo.iconset" &&
     /usr/bin/iconutil -c icns "$WORK/Echo.iconset" -o "$BUILD/Contents/Resources/Echo.icns"; then
    icon_built=1
  else
    echo "Couldn't render the icon; using the prebuilt one." >&2
  fi
  rm -rf "$WORK/Echo.iconset" "$WORK/render-icon"
fi
if [ "$icon_built" = 1 ]; then
  :
elif [ -f "$ROOT/macos/Echo.icns" ]; then
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

# A stable identity keeps the Mac permissions across rebuilds and updates (see the top of this file).
SIGN_ID="$(pick_identity)"
signed=0
if [ "$SIGN_ID" != "-" ]; then
  old_kcs=()
  if [ -n "$KEYCHAIN" ]; then
    # codesign only finds identities in the search list: add the test keychain for a moment.
    while IFS= read -r kc; do [ -n "$kc" ] && old_kcs+=("$kc"); done < <(/usr/bin/security list-keychains -d user | sed 's/^ *"//; s/" *$//')
    /usr/bin/security list-keychains -d user -s "$KEYCHAIN" "${old_kcs[@]}"
  fi
  if /usr/bin/codesign --force --sign "$SIGN_ID" --timestamp=none "$BUILD" >/dev/null 2>&1; then
    signed=1
    echo "Signed with $(identity_name "$SIGN_ID")."
  else
    echo "Couldn't sign with $(identity_name "$SIGN_ID"); signing ad hoc instead (macOS will ask for Echo's permissions again)." >&2
  fi
  if [ -n "$KEYCHAIN" ] && [ "${#old_kcs[@]}" -gt 0 ]; then /usr/bin/security list-keychains -d user -s "${old_kcs[@]}"; fi
fi
if [ "$signed" = 0 ]; then
  /usr/bin/codesign --force --sign - --timestamp=none "$BUILD" >/dev/null 2>&1 || /usr/bin/codesign --force --sign - "$BUILD"
fi
/usr/bin/codesign --verify "$BUILD"

rm -rf "$APP"
mv "$BUILD" "$APP"
touch "$APP"
# Tell Finder and Spotlight about it right away (only for a real install, not test builds).
[ "$OUT" = "$(cd "$HOME/Applications" 2>/dev/null && pwd -P)" ] &&
  { /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true; }
echo "Built $APP"
