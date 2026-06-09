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
PID=$!
echo "$PID" > "$PID_FILE"

# Surface the listening URL the same way the server resolves it, so the user
# gets a clickable address instead of having to dig through the log file.
HOST="${WEBSCP_HOST:-127.0.0.1}"
PORT="${WEBSCP_PORT:-8088}"

# Give the server a moment to bind, and confirm it actually came up.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "webscp failed to start. Last log lines:" >&2
    tail -n 20 "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  if grep -q "webscp running on" "$LOG_FILE" 2>/dev/null; then
    break
  fi
  sleep 0.3
done

echo "webscp started (PID $PID)"
echo "  URL:  http://${HOST}:${PORT}"
echo "  Logs: $LOG_FILE"
