#!/bin/bash
# Installs Node.js for Echo without git, nvm, Homebrew or Apple's Command Line Tools.
#
#   scripts/install-node.sh            install (or keep) Node.js in ~/.echo/node, print its path
#   scripts/install-node.sh --check    only say whether a usable Node.js is there (exit 1 if not)
#
# It downloads the official Node.js LTS build for this Mac (arm64 or x64) from nodejs.org,
# checks it against the release's SHASUMS256.txt, and unpacks it into ~/.echo/node. Nothing
# outside that folder changes, and no password is needed. Safe to run again: an installed
# Node.js 20 or newer is kept. Uses only tools every Mac has (curl, shasum, tar, awk).
#
# The last line of output is the path of the node binary. Settings, mostly for tests:
#   ECHO_NODE_DIR      where Node.js goes (default ~/.echo/node)
#   ECHO_NODE_DIST     where to download from (default https://nodejs.org/dist)
#   ECHO_NODE_VERSION  a version like v22.11.0 instead of the latest LTS
#   ECHO_NODE_ARCH     arm64 or x64 instead of this Mac's

set -eo pipefail

NODE_DIR="${ECHO_NODE_DIR:-$HOME/.echo/node}"
DIST="${ECHO_NODE_DIST:-https://nodejs.org/dist}"
DIST="${DIST%/}"
MIN_MAJOR=20
CHECK=0
case "$1" in
  --check) CHECK=1 ;;
  --help|-h) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

die() { echo "$*" >&2; exit 1; }

usable() {
  local major
  [ -x "$1" ] || return 1
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ -n "$major" ] && [ "$major" -ge "$MIN_MAJOR" ] 2>/dev/null
}

if usable "$NODE_DIR/bin/node"; then
  [ "$CHECK" = 1 ] && echo "Node.js $("$NODE_DIR/bin/node" -v) is installed in $NODE_DIR."
  echo "$NODE_DIR/bin/node"
  exit 0
fi
[ "$CHECK" = 1 ] && { echo "Node.js isn't installed in $NODE_DIR." >&2; exit 1; }

# This Mac's processor. `uname -m` says x86_64 under Rosetta, so ask the hardware on Apple silicon.
arch="${ECHO_NODE_ARCH:-}"
if [ -z "$arch" ]; then
  if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || [ "$(uname -m)" = arm64 ]; then arch=arm64; else arch=x64; fi
fi
case "$arch" in arm64|x64) ;; *) die "Unsupported processor: $arch" ;; esac

tmp="$(mktemp -d "${TMPDIR:-/tmp}/echo-node.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
fetch() { curl -fsSL --retry 2 --connect-timeout 20 "$1" -o "$2"; }

version="${ECHO_NODE_VERSION:-}"
if [ -z "$version" ]; then
  echo "Finding the latest long-term-support Node.js…"
  fetch "$DIST/index.tab" "$tmp/index.tab" || die "Couldn't reach nodejs.org. Check your internet connection and try again."
  # Columns: version date files npm v8 uv zlib openssl modules lts security. Newest first.
  version="$(awk -F'\t' -v want="osx-$arch-tar" 'NR > 1 && $10 != "-" && $10 != "" && index("," $3 ",", "," want ",") { print $1; exit }' "$tmp/index.tab")"
  [ -n "$version" ] || die "nodejs.org didn't list a long-term-support Node.js for this Mac."
fi
case "$version" in v*) ;; *) version="v$version" ;; esac
major="${version#v}"; major="${major%%.*}"
[ "$major" -ge "$MIN_MAJOR" ] 2>/dev/null || die "Node.js $version is too old for Echo (it needs $MIN_MAJOR or newer)."

name="node-$version-darwin-$arch"
file="$name.tar.gz"
echo "Downloading Node.js $version for this Mac ($arch)…"
fetch "$DIST/$version/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || die "Couldn't download Node.js's checksum list."
want="$(awk -v f="$file" '$2 == f { print tolower($1); exit }' "$tmp/SHASUMS256.txt")"
[ "${#want}" = 64 ] || die "Node.js's checksum list doesn't mention $file."
curl -fL --retry 2 --connect-timeout 20 --progress-bar "$DIST/$version/$file" -o "$tmp/$file" || die "The Node.js download failed. Check your internet connection and try again."
got="$(shasum -a 256 "$tmp/$file" | awk '{ print tolower($1) }')"
[ "$want" = "$got" ] || die "The Node.js download doesn't match its published checksum (it may be damaged), so it wasn't installed. Please try again."
echo "Download verified (SHA-256 ${got:0:12}…)."

mkdir -p "$tmp/unpacked"
tar -xzf "$tmp/$file" -C "$tmp/unpacked" || die "Couldn't unpack Node.js."
[ -x "$tmp/unpacked/$name/bin/node" ] || die "The Node.js download doesn't contain bin/node."
usable "$tmp/unpacked/$name/bin/node" || die "The downloaded Node.js doesn't run on this Mac."

# Swap it in: the old copy (if any) is only removed once the new one is in place.
mkdir -p "$(dirname "$NODE_DIR")"
rm -rf "$NODE_DIR.old"
[ -e "$NODE_DIR" ] && mv "$NODE_DIR" "$NODE_DIR.old"
mv "$tmp/unpacked/$name" "$NODE_DIR"
rm -rf "$NODE_DIR.old"
/usr/bin/xattr -dr com.apple.quarantine "$NODE_DIR" 2>/dev/null || true
echo "Node.js $("$NODE_DIR/bin/node" -v) is installed in $NODE_DIR."
echo "$NODE_DIR/bin/node"
