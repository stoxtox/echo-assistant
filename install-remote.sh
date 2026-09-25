#!/bin/bash
# Installs Echo on a Mac with one line:
#
#   curl -fsSL https://raw.githubusercontent.com/stoxtox/echo-assistant/main/install-remote.sh | bash
#
# Options go after "bash -s --", for example:
#
#   curl -fsSL …/install-remote.sh | bash -s -- --dir ~/Echo --skip-whisper
#
#   --dir PATH       install into PATH (default ~/Applications/Echo)
#   --version X.Y.Z  install that release instead of the latest
#   --no-launch      don't open Echo at the end
#   anything else is passed to Echo's installer (scripts/install.sh --help lists them)
#
# It downloads the latest release from GitHub, checks its SHA-256 checksum, unpacks it and runs
# Echo's own installer, which sets up Node.js (in your home folder, no password), Echo's
# packages, Claude Code, the voice, Whisper speech recognition and the Echo app. Safe to run
# again: your data folder is never touched. Nothing here needs sudo.
#
# Everything runs inside main(), so a download cut off halfway can't run half a script.

ECHO_REPO="${ECHO_REPO:-stoxtox/echo-assistant}" # owner/repo; `npm run release` fills this in from echo-release.json
ECHO_GITHUB_API="${ECHO_GITHUB_API:-https://api.github.com}"

say_help() {
  cat <<'EOF'
Installs Echo, the voice assistant, on this Mac.

  curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install-remote.sh | bash -s -- [options]

  --dir PATH       install into PATH (default ~/Applications/Echo)
  --version X.Y.Z  install that release instead of the latest
  --no-launch      don't open Echo at the end
  Other options go to Echo's installer, e.g. --skip-whisper, --skip-voice, --browser-app, --port N.
EOF
}

main() {
  set -Eeuo pipefail

  local dest="${ECHO_INSTALL_DIR:-$HOME/Applications/Echo}" version="" launch=1
  local pass=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dest="${2:?--dir needs a folder}"; shift ;;
      --dir=*) dest="${1#--dir=}" ;;
      --version) version="${2:?--version needs a number like 1.2.0}"; shift ;;
      --version=*) version="${1#--version=}" ;;
      --no-launch) launch=0 ;;
      -h|--help) say_help; return 0 ;;
      *) pass+=("$1") ;;
    esac
    shift
  done
  [ "${ECHO_NO_LAUNCH:-0}" = 1 ] && launch=0
  case "$dest" in "~"/*) dest="$HOME/${dest#\~/}" ;; esac

  local bold="" dim="" red="" green="" orange="" reset=""
  if [ -t 1 ]; then bold=$'\033[1m' dim=$'\033[2m' red=$'\033[31m' green=$'\033[32m' orange=$'\033[38;5;209m' reset=$'\033[0m'; fi
  say() { printf '%s\n' "$*"; }
  ok() { printf '%s✓ %s%s\n' "$green" "$*" "$reset"; }
  die() { printf '%s✗ %s%s\n' "$red" "$*" "$reset" >&2; exit 1; }

  printf '\n%s%sInstalling Echo%s\n' "$bold" "$orange" "$reset"
  [ "$(uname -s)" = Darwin ] || die "Echo runs on macOS, and this computer isn't a Mac."
  case "$ECHO_REPO" in YOUR-GITHUB-USERNAME/*) die "This copy of install-remote.sh doesn't say where Echo is published yet (ECHO_REPO)." ;; esac
  say "${dim}From github.com/$ECHO_REPO into $dest${reset}"
  say ""
  say "${bold}Before you start:${reset} Echo needs ${bold}your own Claude subscription${reset} (Pro or Max, from claude.ai)."
  say "Near the end, a browser window opens so you can sign in to Claude with that account."
  say "Come back to this window afterwards; it carries on by itself."
  say ""

  ECHO_TMP="$(mktemp -d "${TMPDIR:-/tmp}/echo-install.XXXXXX")"
  trap 'rm -rf "$ECHO_TMP"' EXIT
  local tmp="$ECHO_TMP"

  # 1. Which release?
  local api="$ECHO_GITHUB_API/repos/$ECHO_REPO/releases/latest"
  [ -n "$version" ] && api="$ECHO_GITHUB_API/repos/$ECHO_REPO/releases/tags/v${version#v}"
  curl -fsSL -H 'Accept: application/vnd.github+json' "$api" -o "$tmp/release.json" \
    || die "Couldn't reach GitHub to find Echo's latest release. Check your internet connection and try again."
  # No jq on a fresh Mac: split the JSON at commas and pick out the two fields we need.
  local tag
  tag="$(tr ',{}' '\n\n\n' <"$tmp/release.json" | sed -n 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || die "GitHub didn't say which version is the latest. Try again in a minute."
  local v="${tag#v}" zip="Echo-${tag#v}.zip"
  url_of() { tr ',{}' '\n\n\n' <"$tmp/release.json" | sed -n 's/^[[:space:]]*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | grep -F "/$1" | head -n 1; }
  local zip_url sum_url
  zip_url="$(url_of "$zip")"
  sum_url="$(url_of "$zip.sha256")"
  [ -n "$zip_url" ] && [ -n "$sum_url" ] || die "The $tag release is missing $zip or its checksum file."

  local installed=""
  [ -f "$dest/package.json" ] && installed="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dest/package.json" | head -n 1)"
  local src
  if [ "$installed" = "$v" ] && [ -f "$dest/scripts/install.sh" ]; then
    ok "Echo $v is already installed; checking the rest of the setup."
    src="$dest"
  else
    # 2. Download and check it.
    say "Downloading Echo ${v}…"
    curl -fL --progress-bar "$zip_url" -o "$tmp/$zip" || die "The download failed. Check your internet connection and run the same command again."
    curl -fsSL "$sum_url" -o "$tmp/$zip.sha256" || die "Couldn't download the checksum file."
    local want got
    want="$(awk '{print tolower($1); exit}' "$tmp/$zip.sha256")"
    got="$(shasum -a 256 "$tmp/$zip" | awk '{print tolower($1)}')"
    [ "${#want}" = 64 ] || die "The checksum file doesn't look right, so nothing was installed."
    [ "$want" = "$got" ] || die "The download doesn't match its checksum (it may be damaged or changed), so nothing was installed. Please try again."
    ok "Download verified (SHA-256 ${got:0:12}…)."

    # 3. Unpack it.
    /usr/bin/ditto -x -k "$tmp/$zip" "$tmp/unpacked" 2>/dev/null || unzip -q "$tmp/$zip" -d "$tmp/unpacked" || die "Couldn't unpack the download."
    src="$tmp/unpacked/Echo"
    [ -f "$src/scripts/install.sh" ] || die "The download doesn't contain Echo's installer."
    grep -q "\"version\": *\"$v\"" "$src/package.json" || die "The download isn't Echo $v, so nothing was installed."
    /usr/bin/xattr -dr com.apple.quarantine "$src" 2>/dev/null || true
  fi

  # 4. Echo's own installer does the rest (it keeps data/ and skips what's already done).
  local input=/dev/null
  if [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then input=/dev/tty; fi
  bash "$src/scripts/install.sh" --auto --dir "$dest" ${pass[@]+"${pass[@]}"} <"$input"

  # 5. Open Echo; the first launch starts the setup wizard.
  if [ "$launch" = 1 ]; then
    if [ -d "$HOME/Applications/Echo.app" ]; then
      open "$HOME/Applications/Echo.app"
    else
      ECHO_NO_BROWSER="${ECHO_NO_BROWSER:-}" bash "$dest/scripts/launcher.sh" "$dest" >/dev/null 2>&1 &
    fi
    ok "Opening Echo. The first time, a short setup walks you through everything."
  fi
  say ""
  say "To update Echo later: Settings → Updates in Echo (or run this same command again)."
}

main "$@"
