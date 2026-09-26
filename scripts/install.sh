#!/bin/bash
# Echo installer for macOS. Double-click install.command (which runs this), or:
#
#   scripts/install.sh [options]
#
# Safe to run again at any time: it updates Echo's files and skips whatever is already done.
# It never deletes your data/ folder.

set -Eeo pipefail

# ---------------------------------------------------------------- options

usage() {
  cat <<'EOF'
Installs Echo, the voice assistant, on this Mac.

Usage: install.command [options]     (or: scripts/install.sh [options])

  --dir PATH      Install Echo into PATH (default: ~/Applications/Echo,
                  or $ECHO_INSTALL_DIR if set)
  --port N        Run Echo on port N (default 4777; saved in .echo-port)
  --yes, -y       Answer "yes" to every question, except steps turned off below
  --auto          Don't ask questions: take the recommended answer for each step (Node.js,
                  Claude Code, the voice, and Whisper speech recognition if Homebrew is
                  there; no Dock icon). Still asks before installing Apple's Command Line
                  Tools, and still opens the Claude sign-in when there's someone to do it.
                  install-remote.sh (the one-line install) uses this.
  --skip-node     Don't install Node.js; stop with a message if it's missing
  --skip-claude   Don't install Claude Code or sign in to it
  --skip-whisper  Don't set up local Whisper speech recognition
  --skip-voice    Don't pre-download the Kokoro voice (it downloads on first launch)
  --no-dock       Don't offer to add Echo to the Dock
  --no-app        Don't create the Echo app in ~/Applications
  --browser-app   Make the simple Echo app that opens Echo in the browser, instead of
                  building the Mac app (which needs Apple's Command Line Tools)
  --help, -h      Show this help

Without a terminal to answer questions (e.g. input from /dev/null), each question
takes its default answer, shown in capitals: [Y/n] means yes, [y/N] means no.
EOF
}

ASSUME_YES=0 AUTO=0 SKIP_NODE=0 SKIP_CLAUDE=0 SKIP_WHISPER=0 SKIP_VOICE=0 NO_DOCK=0 NO_APP=0 BROWSER_APP=0
DEST="${ECHO_INSTALL_DIR:-$HOME/Applications/Echo}"
PORT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --auto) AUTO=1 ;;
    --dir) [ -n "$2" ] || { echo "--dir needs a folder, e.g. --dir ~/Applications/Echo" >&2; exit 2; }; DEST="$2"; shift ;;
    --dir=*) DEST="${1#--dir=}" ;;
    --port) [ -n "$2" ] || { echo "--port needs a number, e.g. --port 4777" >&2; exit 2; }; PORT_ARG="$2"; shift ;;
    --port=*) PORT_ARG="${1#--port=}" ;;
    --skip-node) SKIP_NODE=1 ;;
    --skip-claude) SKIP_CLAUDE=1 ;;
    --skip-whisper) SKIP_WHISPER=1 ;;
    --skip-voice) SKIP_VOICE=1 ;;
    --no-dock) NO_DOCK=1 ;;
    --no-app) NO_APP=1 ;;
    --browser-app) BROWSER_APP=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$PORT_ARG" ]; then
  case "$PORT_ARG" in *[!0-9]*) PORT_ARG="bad" ;; esac
  if [ "$PORT_ARG" = bad ] || [ "$PORT_ARG" -lt 1024 ] || [ "$PORT_ARG" -gt 65534 ]; then
    echo "--port must be a number between 1024 and 65534" >&2; exit 2
  fi
fi

# ---------------------------------------------------------------- looks

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' ORANGE=$'\033[38;5;209m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" ORANGE="" RESET=""
fi
STEP_NO=0
STEP_NAME="getting started"
step() {
  STEP_NO=$((STEP_NO + 1))
  STEP_NAME="$1"
  printf '\n%s%s━━ Step %s: %s%s\n' "$BOLD" "$ORANGE" "$STEP_NO" "$1" "$RESET"
}
say()  { printf '%s\n' "$*"; }
info() { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }
ok()   { printf '%s✓ %s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s! %s%s\n' "$YELLOW" "$*" "$RESET"; }
bad()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; }

on_error() {
  local code=$? line=$1
  trap - ERR
  printf '\n' >&2
  bad "Sorry, something went wrong while $STEP_NAME (install.sh line $line, exit code $code)."
  say "   Your data is safe. The messages just above usually say what the problem was;" >&2
  say "   a dropped internet connection is the most common cause." >&2
  say "   It's safe to run the installer again: it skips whatever already worked." >&2
  say "   If it keeps failing, send a screenshot of this window to whoever shared Echo with you." >&2
  exit "$code"
}
trap 'on_error $LINENO' ERR
trap 'printf "\n"; warn "Installation cancelled. Nothing is broken; you can run the installer again any time."; exit 130' INT

INTERACTIVE=0
[ -t 0 ] && INTERACTIVE=1

# ask "Question?" Y|N [AUTO]  -> returns 0 for yes
# AUTO is the answer --auto takes (Y, N, or "ask" to still ask someone who's there); default: Y|N.
ask() {
  local q="$1" def="$2" auto="${3:-$2}" hint ans
  if [ "$def" = Y ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ "$ASSUME_YES" = 1 ]; then say "${BOLD}$q${RESET} $hint yes (--yes)"; return 0; fi
  if [ "$AUTO" = 1 ] && [ "$auto" != ask ]; then
    say "${BOLD}$q${RESET} $( [ "$auto" = Y ] && echo yes || echo no ) (automatic)"
    [ "$auto" = Y ]; return
  fi
  if [ "$INTERACTIVE" = 0 ]; then
    say "${BOLD}$q${RESET} $hint $( [ "$def" = Y ] && echo yes || echo no ) (default, no one to ask)"
    [ "$def" = Y ]; return
  fi
  while true; do
    printf '%s%s%s %s ' "$BOLD" "$q" "$RESET" "$hint"
    IFS= read -r ans || ans=""
    case "$ans" in
      "") [ "$def" = Y ]; return ;;
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
      *) say "Please type y for yes or n for no, then press Return." ;;
    esac
  done
}

pause() {
  [ "$INTERACTIVE" = 1 ] && [ "$ASSUME_YES" = 0 ] && [ "$AUTO" = 0 ] || return 0
  printf '%s%s%s' "$DIM" "${1:-Press Return to continue…}" "$RESET"
  IFS= read -r _ || true
}

# ---------------------------------------------------------------- helpers

SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
export npm_config_update_notifier=false
export PATH="$HOME/.local/bin:$PATH"

ECHO_NODE_DIR="${ECHO_NODE_DIR:-$HOME/.echo/node}"

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  set +eE
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use default >/dev/null 2>&1
  set -eE
  return 0
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 20 ] 2>/dev/null; }

# Echo's own Node.js (~/.echo/node, from scripts/install-node.sh) first, then whatever else is there.
find_node() {
  if [ -x "$ECHO_NODE_DIR/bin/node" ]; then
    export PATH="$ECHO_NODE_DIR/bin:$PATH"
    node_ok && return 0
  fi
  node_ok && return 0
  load_nvm && node_ok && return 0
  local d
  # ECHO_NODE_SEARCH lets tests hide this Mac's Homebrew Node.js.
  for d in ${ECHO_NODE_SEARCH-/opt/homebrew/bin /usr/local/bin}; do
    if [ -x "$d/node" ]; then
      export PATH="$d:$PATH"
      node_ok && return 0
    fi
  done
  return 1
}

# Apple's Command Line Tools (for building the Mac app with swiftc). `xcode-select -p` alone
# can point at a removed folder, so build-app.sh --check also looks for swiftc and the SDK.
clt_ready() { /usr/bin/xcode-select -p >/dev/null 2>&1 && /bin/bash scripts/build-app.sh --check >/dev/null 2>&1; }
# Apple's "Install Command Line Developer Tools" window is open (or installing).
clt_installer_open() { /usr/bin/pgrep -f 'Install Command Line Developer Tools' >/dev/null 2>&1; }

find_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  local b
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then export PATH="$(dirname "$b"):$PATH"; return 0; fi
  done
  return 1
}

find_claude() {
  command -v claude >/dev/null 2>&1 && return 0
  if [ -x "$HOME/.local/bin/claude" ]; then export PATH="$HOME/.local/bin:$PATH"; return 0; fi
  return 1
}

# Only checks that a sign-in exists; never reads or prints the secret itself.
claude_signed_in() {
  [ -n "$ANTHROPIC_API_KEY" ] && return 0
  if find_claude && claude auth status --json 2>/dev/null | grep -Eq '"loggedIn": *true'; then return 0; fi
  /usr/bin/security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 && return 0
  [ -s "$HOME/.claude/.credentials.json" ] && return 0
  return 1
}

is_echo_folder() { [ -f "$1/supervisor.js" ] && grep -q '"name": *"echo"' "$1/package.json" 2>/dev/null; }

# ---------------------------------------------------------------- welcome

printf '\n%s%s  Welcome to Echo%s\n' "$BOLD" "$ORANGE" "$RESET"
say "  Echo is a voice assistant for your Mac: you talk, it answers out loud, and it can"
say "  do research, run errands and work on projects for you in the background."

if [ "$(uname -s)" != Darwin ]; then
  bad "This installer is for Macs only, and this computer isn't running macOS."
  exit 1
fi

say ""
say "${BOLD}Here's what will happen${RESET} (takes about 5 minutes, and it's safe to run again later):"
say "  1. Copy Echo into ${BOLD}$DEST${RESET}"
say "  2. Check for Apple's Command Line Tools (for the Mac app) and make sure Node.js is"
say "     installed (the engine Echo runs on; no developer tools needed for it)"
say "  3. Download the building blocks Echo needs"
say "  4. Set up Claude Code (Echo's brain) and sign you in"
say "  5. Offer a couple of optional extras (better speech recognition, a pre-downloaded voice)"
say "  6. Put an ${BOLD}Echo${RESET} app in your Applications folder so you can open it like any other app"
say ""
say "${BOLD}You'll need your own Claude subscription${RESET} (Claude Pro or Max, from https://claude.ai)."
say "Echo runs on Claude Code, which uses that subscription. Nothing is charged by this installer."
say "Your Mac may ask for your password or permission along the way; that's normal."
pause "Press Return to begin (or close this window to cancel)… "

# ---------------------------------------------------------------- 1. files

step "copying Echo's files"
is_echo_folder "$SRC" || { bad "The installer isn't inside an Echo folder ($SRC). Please unzip Echo again and run install.command from inside it."; exit 1; }
case "$DEST" in "~"/*) DEST="$HOME/${DEST#\~/}" ;; esac
case "$DEST" in /*) ;; *) DEST="$PWD/$DEST" ;; esac
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd -P)"

if [ "$DEST" = "$SRC" ]; then
  ok "Echo is already in $DEST, so it will be set up right here."
else
  if [ -n "$(ls -A "$DEST" 2>/dev/null)" ] && ! is_echo_folder "$DEST"; then
    bad "The folder $DEST already has other things in it, and it isn't an Echo folder."
    say "   To be safe, nothing was copied. Pick an empty folder with --dir, or move those files away."
    exit 1
  fi
  if is_echo_folder "$DEST"; then
    say "Echo is already installed in $DEST. Updating its files; your conversations, settings"
    say "and other personal data (the data folder) are kept exactly as they are."
  else
    say "Copying Echo into $DEST so it has a permanent home (you can delete the download afterwards)."
  fi
  # No --delete: nothing already in the destination is ever removed, and data/ is never touched.
  rsync -a \
    --exclude '/node_modules' --exclude '/data' --exclude '/logs' --exclude '/models' \
    --exclude '/.git' --exclude '/dist' --exclude '/.env' --exclude '/.echo-port' --exclude '/.echo-update' \
    --exclude '/.echo-node' --exclude '.DS_Store' \
    "$SRC/" "$DEST/"
  ok "Files copied to $DEST"
fi
cd "$DEST"
# Files that came from a download carry a quarantine flag; Echo's own copy doesn't need it.
/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
chmod +x "$DEST"/*.command "$DEST"/scripts/*.sh 2>/dev/null || true
# Marks this as an installed (shareable) copy: its projects live in ~/Echo Projects,
# not in the folder around Echo.
[ -f .echo-package ] || : > .echo-package
mkdir -p logs
if [ -n "$PORT_ARG" ]; then
  echo "$PORT_ARG" > .echo-port
  ok "Echo will use port $PORT_ARG (saved in .echo-port)."
fi
PORT="${VOICEOPS_PORT:-$(tr -dc '0-9' 2>/dev/null <.echo-port || true)}"
PORT="${PORT:-4777}"

# ---------------------------------------------------------------- 1b. Apple's Command Line Tools

# Checked early, so Apple's installer can run while the other steps carry on. Only the native Mac
# app needs them (it's compiled here with swiftc); Node.js and everything else don't.
CLT_STATE=none   # ready | started (Apple's installer was opened) | declined | none
if [ "$NO_APP" = 1 ] || [ "$BROWSER_APP" = 1 ]; then
  CLT_STATE=declined
else
  step "checking Apple's Command Line Tools"
  if clt_ready; then
    CLT_STATE=ready
    ok "Apple's Command Line Tools are installed ($(/usr/bin/xcode-select -p 2>/dev/null))."
  else
    say "Echo's Mac app (its own window, a menu bar icon and the Option-Space shortcut) is built"
    say "right here on your Mac with Apple's free ${BOLD}Command Line Tools${RESET}, which aren't installed yet."
    say "Apple installs them for you: about 5 to 10 minutes, no Apple ID needed. Without them,"
    say "Echo opens in your web browser instead, which works just as well."
    if [ "$INTERACTIVE" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
      info "No one here to click Apple's installer, so Echo will open in the browser. Run the installer again later for the Mac app."
      CLT_STATE=declined
    elif ask "Install Apple's Command Line Tools now?" Y ask; then
      /usr/bin/xcode-select --install >/dev/null 2>&1 || true
      CLT_STATE=started
      say "A window from Apple should appear: click ${BOLD}Install${RESET}, then ${BOLD}Agree${RESET}."
      say "You don't need to wait for it: the installer carries on with the other steps now, and"
      say "checks back before it builds the Echo app."
    else
      CLT_STATE=declined
      info "No problem: Echo will open in your browser. Run the installer again any time for the Mac app."
    fi
  fi
fi

# Waits for Apple's installer (started above) to finish. Gives up after ECHO_CLT_WAIT seconds
# (30 minutes), when Apple's window is closed without installing, or when someone presses Return.
wait_for_clt() {
  local limit="${ECHO_CLT_WAIT:-1800}" waited=0 gone=0
  clt_ready && return 0
  say "Waiting for Apple's Command Line Tools to finish installing (up to $((limit / 60)) minutes)."
  if [ "$INTERACTIVE" = 1 ]; then
    say "If you'd rather not wait, press Return and Echo will open in your browser instead."
  fi
  while [ "$waited" -lt "$limit" ]; do
    if [ "$INTERACTIVE" = 1 ]; then
      if IFS= read -r -t 5 _; then info "Not waiting. Echo will open in your browser for now."; return 1; fi
    else
      sleep 5
    fi
    waited=$((waited + 5))
    clt_ready && { ok "Command Line Tools installed."; return 0; }
    # Apple's window closed without installing (the person clicked "Not Now" or "Cancel").
    if [ "$waited" -ge 20 ] && ! clt_installer_open; then
      gone=$((gone + 1))
      if [ "$gone" -ge 3 ]; then
        clt_ready && { ok "Command Line Tools installed."; return 0; }
        warn "Apple's installer was closed before it finished, so Echo will open in your browser for now."
        return 1
      fi
    else
      gone=0
    fi
    [ $((waited % 60)) = 0 ] && info "  Still installing… ($((waited / 60)) min so far; it usually takes 5 to 10)"
  done
  warn "The Command Line Tools aren't ready after $((limit / 60)) minutes, so Echo will open in your browser for now."
  say "   When Apple's installer finishes, run this installer again to get the Mac app."
  return 1
}

# ---------------------------------------------------------------- 2. node

step "checking for Node.js"
info "Node.js is the free engine that runs Echo's code. Echo needs version 20 or newer."
if find_node; then
  ok "Node.js $(node -v) is ready ($(command -v node))."
else
  if command -v node >/dev/null 2>&1; then
    warn "Node.js $(node -v) is installed, but it's too old for Echo."
  else
    say "Node.js isn't installed yet."
  fi
  if [ "$SKIP_NODE" = 1 ]; then
    bad "Node.js 20 or newer is needed, and --skip-node was given, so the installer stops here."
    say "   Install it from https://nodejs.org (the LTS button), then run the installer again."
    exit 1
  fi
  say "The installer can download the official Node.js from nodejs.org, check that the download"
  say "is genuine, and keep it in Echo's own folder in your home (${ECHO_NODE_DIR/#$HOME/~})."
  say "No password needed, nothing else on your Mac changes, and it takes about a minute."
  if ask "Install Node.js now?" Y; then
    STEP_NAME="installing Node.js"
    set +eE
    ECHO_NODE_DIR="$ECHO_NODE_DIR" /bin/bash scripts/install-node.sh
    rc=$?
    set -eE
    [ "$rc" = 0 ] || { bad "Installing Node.js didn't work (see the message just above)."; say "   Check your internet connection and run the installer again."; exit 1; }
    STEP_NAME="checking for Node.js"
    find_node || { bad "Node.js was installed but can't be found. Please close this window and run the installer again."; exit 1; }
    ok "Node.js $(node -v) is installed."
  else
    say "No problem. You can install it yourself from https://nodejs.org (click the LTS button),"
    say "then run this installer again."
    exit 1
  fi
fi
# The Echo app starts with this exact Node.js, so it works even when opened from Finder.
command -v node > .echo-node

# ---------------------------------------------------------------- 3. dependencies

step "downloading Echo's building blocks"
say "Echo uses a few open-source libraries (including the one that talks to Claude)."
say "This can take a couple of minutes the first time. Lots of text scrolling by is normal."
LOCK_HASH=""
[ -f package-lock.json ] && LOCK_HASH="$(shasum < package-lock.json | cut -c1-40)-node$(node_major)"
if [ -n "$LOCK_HASH" ] && [ -d node_modules ] && [ "$(cat node_modules/.echo-installed 2>/dev/null)" = "$LOCK_HASH" ]; then
  ok "Already up to date."
else
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  [ -z "$LOCK_HASH" ] || echo "$LOCK_HASH" > node_modules/.echo-installed
  ok "Building blocks installed."
fi

# ---------------------------------------------------------------- 4. claude code

if [ "$SKIP_CLAUDE" = 1 ]; then
  step "Claude Code (skipped)"
  info "Skipped because of --skip-claude."
else
  step "setting up Claude Code"
  info "Claude Code is Anthropic's assistant engine. Echo uses it to think, research and get things done."
  if find_claude; then
    ok "Claude Code is installed ($(command -v claude))."
  else
    say "Installing Claude Code with Anthropic's official installer (claude.ai/install.sh)."
    say "It goes into your home folder; no password needed. (Use --skip-claude to leave it out.)"
    STEP_NAME="installing Claude Code"
    if ! curl -fsSL https://claude.ai/install.sh | bash; then
      warn "The official installer didn't work; trying the npm package instead."
      npm install -g @anthropic-ai/claude-code
    fi
    find_claude || { bad "Claude Code was installed but can't be found. Please close this window and run the installer again."; exit 1; }
    ok "Claude Code is installed."
  fi

  if find_claude || [ -n "$ANTHROPIC_API_KEY" ]; then
    STEP_NAME="signing in to Claude"
    if claude_signed_in; then
      ok "You're signed in to Claude."
    elif [ "$INTERACTIVE" = 0 ]; then
      info "You're not signed in to Claude yet. That's fine: Echo's setup has a \"Sign in to Claude\""
      info "step the first time you open it (or type ${BOLD}claude auth login${RESET} in Terminal)."
    else
      say ""
      say "${BOLD}Now let's sign you in to Claude.${RESET}"
      say "  • A browser window will open on claude.ai."
      say "  • Sign in with the Claude account that has your Pro or Max subscription, and click Authorize."
      say "  • If the page shows a code instead, copy it, come back here, paste it and press Return."
      say "  • When the browser says you're signed in, come back to this window."
      AUTO=0 pause "Press Return to open the sign-in page… "
      if claude auth --help >/dev/null 2>&1; then
        claude auth login --claudeai || true
      else
        say "Claude Code will open. Type ${BOLD}/login${RESET} and press Return, follow the steps,"
        say "then type ${BOLD}/exit${RESET} and press Return to come back here."
        claude || true
      fi
      if claude_signed_in; then
        ok "Signed in to Claude."
      else
        warn "It doesn't look like the sign-in finished. You can finish it any time:"
        say "   open Terminal, type ${BOLD}claude${RESET}, press Return, then type ${BOLD}/login${RESET}."
        say "   When you're done, type ${BOLD}/exit${RESET} to leave. Echo works as soon as you're signed in."
        say "   (Echo's setup also has a \"Sign in to Claude\" step that can do this for you.)"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- 5. extras

step "optional extras"
if [ "$SKIP_WHISPER" = 1 ]; then
  info "Local speech recognition: skipped (--skip-whisper)."
elif [ -x "$(command -v whisper-server 2>/dev/null)" ] && [ -f models/ggml-large-v3-turbo-q5_0.bin ]; then
  ok "Local speech recognition (Whisper) is already set up."
else
  say "${BOLD}Better speech recognition (recommended if you have the space)${RESET}"
  say "  Whisper understands speech more accurately than the browser, works offline and keeps"
  say "  your voice on this Mac. It's a ~550 MB download and takes a few minutes. Echo works"
  say "  without it (it uses Chrome's built-in speech recognition instead)."
  if ! find_brew; then
    warn "Whisper needs Homebrew (a free tool for installing Mac software), which isn't installed."
    say "   Skipping it for now. To add it later: install Homebrew from https://brew.sh, then"
    say "   run this installer again."
  elif ask "Set up local Whisper speech recognition?" N Y; then
    STEP_NAME="setting up Whisper speech recognition"
    zsh scripts/setup-whisper.sh
    ok "Whisper is ready."
    STEP_NAME="optional extras"
  else
    info "Skipped. You can run this installer again any time to add it."
  fi
fi

say ""
if [ "$SKIP_VOICE" = 1 ]; then
  info "Natural voice download: skipped (--skip-voice). It downloads the first time Echo starts."
else
  say "${BOLD}Echo's natural voice${RESET}"
  say "  Echo speaks with Kokoro, a natural-sounding voice that runs on this Mac (~90 MB)."
  say "  Downloading it now means Echo can talk right away the first time you open it;"
  say "  otherwise it downloads by itself on first launch."
  if ask "Download the voice now?" Y; then
    STEP_NAME="downloading the voice"
    if node scripts/prefetch-voice.js; then
      ok "Voice downloaded."
    else
      warn "The voice didn't download this time. That's fine: Echo will get it on first launch."
    fi
    STEP_NAME="optional extras"
  fi
fi

# ---------------------------------------------------------------- 6. app

APP="$HOME/Applications/Echo.app"
NATIVE=0
build_tools() { clt_ready; }
if [ "$NO_APP" = 1 ]; then
  step "the Echo app (skipped)"
  info "Skipped because of --no-app. Start Echo by double-clicking start.command in $DEST."
else
  step "creating the Echo app"
  say "This puts an ${BOLD}Echo${RESET} app in your Applications folder: a real Mac app with its own"
  say "window, a menu bar icon and a shortcut (Option-Space) to bring it up. Opening it starts Echo"
  say "in the background."
  mkdir -p "$HOME/Applications"
  if [ "$BROWSER_APP" = 0 ] && [ "$CLT_STATE" = started ]; then
    STEP_NAME="waiting for Apple's Command Line Tools"
    wait_for_clt || BROWSER_APP=1
    STEP_NAME="creating the Echo app"
  fi
  if [ "$BROWSER_APP" = 0 ] && build_tools; then
    say "Building the Echo app for this Mac (about a minute)…"
    if /bin/bash scripts/build-app.sh --out "$HOME/Applications" --echo-dir "$DEST"; then
      NATIVE=1
      ok "Created $APP"
    else
      warn "The Mac app didn't build, so Echo will open in your browser instead."
    fi
  fi
  if [ "$NATIVE" = 0 ]; then
    say "The Echo app opens Echo in your browser (Google Chrome if you have it; it handles the"
    say "microphone best)."
  fi
  if [ "$NATIVE" = 0 ] && [ -d "$APP" ]; then
    old_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true)"
    if [ "$old_id" != "local.echo.launcher" ] && [ "$old_id" != "local.echo.app" ]; then
      bad "There's already a different app called Echo at $APP; leaving it alone."
      say "   Move or rename that app, then run the installer again. For now, start Echo with start.command in $DEST."
      APP=""
    else
      rm -rf "$APP"
    fi
  fi
  if [ "$NATIVE" = 0 ] && [ -n "$APP" ]; then
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    VERSION="$(node -p 'require("./package.json").version' 2>/dev/null || echo 1.0.0)"
    cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Echo</string>
  <key>CFBundleDisplayName</key><string>Echo</string>
  <key>CFBundleIdentifier</key><string>local.echo.launcher</string>
  <key>CFBundleExecutable</key><string>Echo</string>
  <key>CFBundleIconFile</key><string>Echo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Echo sends messages, adds calendar events and looks up contacts when you ask it to.</string>
</dict>
</plist>
EOF
    # The app remembers where Echo lives; the real work is in scripts/launcher.sh there.
    q_dest="$(printf '%q' "$DEST")"
    cat > "$APP/Contents/MacOS/Echo" <<EOF
#!/bin/bash
# Opens Echo (installed in $DEST). Made by Echo's installer.
if [ ! -f $q_dest/scripts/launcher.sh ]; then
  /usr/bin/osascript -e 'display alert "Echo couldn'"'"'t start" message "Echo'"'"'s folder has moved or been deleted. Run install.command again to fix it." as critical' >/dev/null 2>&1
  exit 1
fi
exec /bin/bash $q_dest/scripts/launcher.sh $q_dest
EOF
    chmod +x "$APP/Contents/MacOS/Echo"
    ICON_SRC="$DEST/public/icons/echo-512.png"
    if [ -f "$ICON_SRC" ] && [ -x /usr/bin/sips ] && [ -x /usr/bin/iconutil ]; then
      ICONSET="$(mktemp -d)/Echo.iconset"
      mkdir -p "$ICONSET"
      icon_ok=1
      for s in 16 32 128 256 512; do
        /usr/bin/sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || icon_ok=0
        d=$((s * 2))
        [ "$d" -le 512 ] && { /usr/bin/sips -z "$d" "$d" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || icon_ok=0; }
      done
      if [ "$icon_ok" = 1 ] && /usr/bin/iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Echo.icns" 2>/dev/null; then
        ok "App icon added."
      else
        warn "Couldn't make the app icon; the app will use a plain icon (it still works)."
      fi
      rm -rf "$(dirname "$ICONSET")"
    fi
    touch "$APP"
    ok "Created $APP"
  fi
  if [ -n "$APP" ] && [ -d "$APP" ]; then
    if [ "$NO_DOCK" = 0 ]; then
      if /usr/bin/defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "Applications/Echo.app"; then
        ok "Echo is already in your Dock."
      else
        say ""
        say "You can also keep Echo in your Dock for one-click access. (The Dock will blink"
        say "for a moment while it updates; that's normal.)"
        if ask "Add Echo to the Dock?" N N; then
          /usr/bin/defaults write com.apple.dock persistent-apps -array-add \
            "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$APP</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
          /usr/bin/killall Dock 2>/dev/null || true
          ok "Added Echo to the Dock."
        fi
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- done

STEP_NAME="finishing up"
printf '\n%s%s━━ All set!%s\n' "$BOLD" "$GREEN" "$RESET"
if [ "$NO_APP" = 0 ] && [ -n "$APP" ]; then
  say "To open Echo: find ${BOLD}Echo${RESET} in your Applications folder or Launchpad (or search for it"
  say "with Spotlight: press Command-Space and type Echo)$( [ "$NO_DOCK" = 0 ] && /usr/bin/defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q 'Applications/Echo.app' && echo ', or click it in your Dock')."
else
  say "To open Echo: double-click ${BOLD}start.command${RESET} in $DEST."
fi
if [ "$NATIVE" = 1 ]; then
  say "It opens in its own window, and its icon sits in the menu bar (press ${BOLD}Option-Space${RESET} to bring"
  say "it up from anywhere). The first time, you'll see a short setup screen; after that, just hold"
  say "the Space bar and talk. Allow the microphone when your Mac asks (once)."
else
  say "It opens in your browser at ${BOLD}http://localhost:$PORT${RESET}. The first time, you'll see a short"
  say "setup screen; after that, just hold the Space bar and talk. Allow the microphone when asked."
fi
if [ -f "$DEST/GETTING_STARTED.md" ]; then
  say "A friendly guide is in ${BOLD}$DEST/GETTING_STARTED.md${RESET}."
fi
say "Echo keeps its files in $DEST (your personal data is in its data folder)."
say "Echo checks for updates by itself (Settings → Updates); your data is always kept."
