#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$APP_DIR/.webscp.pid"
PORT="${WEBSCP_PORT:-8088}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "webscp running (PID $(cat "$PID_FILE")) on port $PORT"
else
  echo "webscp not running"
fi
