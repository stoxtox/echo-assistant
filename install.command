#!/bin/bash
# Double-click to install Echo on this Mac (or update it; your data is kept).
# Options are passed on to scripts/install.sh; see: ./install.command --help
cd "$(dirname "$0")" || exit 1
/bin/bash scripts/install.sh "$@"
status=$?
if [ -t 0 ]; then
  echo
  read -r -p "Press Return to close this window. " _
fi
exit "$status"
