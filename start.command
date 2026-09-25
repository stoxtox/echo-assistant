#!/bin/zsh
# Double-click to start Echo in this window and open it in the browser (Chrome if installed).
# Close the window (or press Control-C) to stop Echo.
# Port: VOICEOPS_PORT, else the number in .echo-port, else 4777.
# ECHO_NO_BROWSER=1 starts Echo without opening a browser.
cd "$(dirname "$0")" || exit 1
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"

PORT="${VOICEOPS_PORT:-$(tr -dc '0-9' 2>/dev/null <.echo-port)}"
export VOICEOPS_PORT="${PORT:-4777}"
URL="http://localhost:$VOICEOPS_PORT"

# Open the browser once Echo answers (up to a minute), not before.
(
  for i in {1..120}; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$VOICEOPS_PORT/api/health" 2>/dev/null | grep -Eq '"ok": ?true'; then
      [ -n "$ECHO_NO_BROWSER" ] && { echo "Echo is ready at $URL"; exit 0; }
      open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
      exit 0
    fi
    sleep 0.5
  done
  echo "Echo hasn't answered after a minute; check the messages above."
) &
waiter=$!

node supervisor.js
status=$?
kill $waiter 2>/dev/null
exit $status
