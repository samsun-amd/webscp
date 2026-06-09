#!/bin/bash
# Render the systemd unit template with this checkout's path and the current
# user, then install + enable it. No hardcoded paths (CLAUDE.md portability).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE="$APP_DIR/systemd/webscp.service.template"
UNIT_NAME="webscp.service"
DEST="/etc/systemd/system/$UNIT_NAME"

if [[ ! -d "$APP_DIR/dist" ]]; then
  echo "Building first…"
  (cd "$APP_DIR" && npm run build)
fi

# Forward a custom inventory path into the unit only when one is set at install
# time; otherwise drop the placeholder line so core uses its ~/note default.
if [[ -n "${SSH_REMOTE_JSON:-}" ]]; then
  SSH_REMOTE_JSON_ENV="Environment=SSH_REMOTE_JSON=${SSH_REMOTE_JSON}"
else
  SSH_REMOTE_JSON_ENV=""
fi

TMP="$(mktemp)"
sed -e "s#__APP_DIR__#${APP_DIR}#g" \
    -e "s#__USER__#$(id -un)#g" \
    -e "s#__SSH_REMOTE_JSON_ENV__#${SSH_REMOTE_JSON_ENV}#g" \
    "$TEMPLATE" > "$TMP"

echo "Installing $DEST (sudo required)…"
sudo cp "$TMP" "$DEST"
rm -f "$TMP"
sudo systemctl daemon-reload
sudo systemctl enable --now "$UNIT_NAME"
echo "Done. Check: systemctl status $UNIT_NAME"
