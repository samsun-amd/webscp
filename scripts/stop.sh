#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$APP_DIR/.webscp.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "webscp not running (no PID file)"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "webscp stopped (PID $PID)"
else
  echo "webscp process $PID not found; cleaning up PID file"
fi
rm -f "$PID_FILE"
