#!/bin/bash
# Opens Echo. Used by ~/Applications/Echo.app (made by scripts/install.sh).
#
# If Echo is already running, it just opens it in the browser. Otherwise it starts
# `node supervisor.js` in the background (logs go to logs/echo-launcher.log), waits until
# Echo answers on /api/health, then opens it: in Google Chrome if installed (it handles the
# microphone best), otherwise in the default browser.
#
#   scripts/launcher.sh [ECHO_FOLDER]      start (or just open) Echo
#   scripts/launcher.sh --stop [FOLDER]    stop the copy this launcher started
#
# Port: VOICEOPS_PORT, else the number in ECHO_FOLDER/.echo-port, else 4777.
# ECHO_NO_BROWSER=1 skips opening the browser and shows errors in the terminal instead of
# a dialog (the Mac app and tests use it). ECHO_START_WAIT is how many seconds to wait for
# Echo to answer (default 60).
#
# It never starts a second Echo: not when one already answers, not while the copy it started
# is starting up, not while another supervisor runs from this folder (it may be restarting),
# and not when something else holds the port. It waits for those instead.

ACTION=start
if [ "$1" = "--stop" ]; then ACTION=stop; shift; fi
APP_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

# Apps opened from Finder get a bare PATH, so add the usual places Node and Claude live.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -n "$LANG" ] || export LANG=en_US.UTF-8

fail() {
  echo "Echo: $1" >&2
  if [ -z "$ECHO_NO_BROWSER" ]; then
    /usr/bin/osascript - "$1" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  display alert "Echo couldn't start" message (item 1 of argv) as critical buttons {"OK"} default button "OK"
end run
APPLESCRIPT
  fi
  exit 1
}

[ -f "$APP_DIR/supervisor.js" ] || fail "Echo's files aren't in $APP_DIR any more. Run install.command again to put them back."
cd "$APP_DIR" || fail "Couldn't open the folder $APP_DIR."

PORT="$VOICEOPS_PORT"
[ -n "$PORT" ] || PORT="$(tr -dc '0-9' 2>/dev/null <"$APP_DIR/.echo-port")"
[ -n "$PORT" ] || PORT=4777
export VOICEOPS_PORT="$PORT"
URL="http://localhost:$PORT"
LOG_DIR="$APP_DIR/logs"
PID_FILE="$LOG_DIR/echo-launcher.pid"
LOG_FILE="$LOG_DIR/echo-launcher.log"
WAIT_STEPS=$(( ${ECHO_START_WAIT:-60} * 2 ))
mkdir -p "$LOG_DIR"

healthy() {
  /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -Eq '"ok": ?true'
}

# The supervisor this launcher started, if it's still running.
our_pid() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q 'supervisor.js' && echo "$pid"
}

if [ "$ACTION" = stop ]; then
  pid="$(our_pid)"
  if [ -z "$pid" ]; then echo "Echo isn't running from this launcher."; exit 0; fi
  kill -TERM "$pid"
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  rm -f "$PID_FILE"
  echo "Echo stopped."
  exit 0
fi

open_browser() {
  [ -n "$ECHO_NO_BROWSER" ] && { echo "Echo is ready at $URL"; return 0; }
  if /usr/bin/open -Ra "Google Chrome" 2>/dev/null; then
    /usr/bin/open -a "Google Chrome" "$URL" && return 0
  fi
  /usr/bin/open "$URL"
}

if healthy; then open_browser; exit 0; fi

# Find Node.js 20 or newer: the one the installer used, then Echo's own (~/.echo/node), then nvm,
# then Homebrew.
node_ok() {
  local major
  major="$("${1:-node}" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null
}
NODE=""
saved="$(cat "$APP_DIR/.echo-node" 2>/dev/null)"
if [ -n "$saved" ] && [ -x "$saved" ] && node_ok "$saved"; then
  NODE="$saved"
  export PATH="$(dirname "$saved"):$PATH"
elif node_ok "${ECHO_NODE_DIR:-$HOME/.echo/node}/bin/node"; then
  NODE="${ECHO_NODE_DIR:-$HOME/.echo/node}/bin/node"
  export PATH="$(dirname "$NODE"):$PATH"
else
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  node_ok node && NODE="$(command -v node)"
fi
[ -n "$NODE" ] || fail "Echo needs Node.js 20 or newer, and it isn't installed. Double-click install.command in the Echo folder to set it up."

# Another supervisor running from this folder (started from Terminal, say). It may be between
# restarts, so wait for it rather than starting a second copy on the same data.
other_supervisor() {
  local p cwd here
  here="$(pwd -P)"
  for p in $(/usr/bin/pgrep -f 'supervisor\.js' 2>/dev/null); do
    cwd="$(/usr/sbin/lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ "$cwd" = "$here" ] && { echo "$p"; return 0; }
  done
  return 1
}
port_taken() { /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; }

wait_for_echo() {
  for _ in $(seq 1 "$WAIT_STEPS"); do
    if healthy; then open_browser; exit 0; fi
    sleep 0.5
  done
}

pid="$(our_pid)"
if [ -z "$pid" ] && other="$(other_supervisor)"; then
  echo "Echo is already running from this folder (process $other); waiting for it to answer."
  wait_for_echo
  fail "Echo is running from this folder but hasn't answered on port $PORT. It may be using another port, or still restarting; try again in a moment."
fi
if [ -z "$pid" ] && port_taken; then
  wait_for_echo
  fail "Something else is using port $PORT, so Echo can't start there. Quit that program, or install Echo with a different port (install.command --port 4778)."
fi

# Only start one copy: if ours is already starting up (or restarting), just wait for it.
if [ -z "$pid" ]; then
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting Echo on port $PORT with $NODE ===" >> "$LOG_FILE"
  nohup "$NODE" supervisor.js >> "$LOG_FILE" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$PID_FILE"
  disown "$pid" 2>/dev/null || true
fi

for _ in $(seq 1 "$WAIT_STEPS"); do
  if healthy; then open_browser; exit 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    if healthy; then open_browser; exit 0; fi
    fail "Echo stopped while starting up. Details are in $LOG_FILE (the last lines usually say why)."
  fi
  sleep 0.5
done
fail "Echo is taking longer than ${ECHO_START_WAIT:-60} seconds to start. Try opening it again in a moment. Details are in $LOG_FILE."
