#!/bin/bash
# Start webscp in the background, writing a PID file. Paths are derived relative
# to this script so the repo stays portable (~/github/webscp or anywhere).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$APP_DIR/.webscp.pid"
LOG_FILE="$APP_DIR/webscp.log"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "webscp already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

if [[ ! -d "$APP_DIR/dist" ]]; then
  echo "dist/ missing; building…"
  (cd "$APP_DIR" && npm run build)
fi

cd "$APP_DIR"
nohup node dist/server/index.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "webscp started (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
