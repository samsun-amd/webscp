#!/bin/bash
# Render the systemd unit template with this checkout's path and the current
# user, then install, enable, and restart it.
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

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
node - "$TEMPLATE" "$APP_DIR" "$(id -un)" > "$TMP" <<'JS'
const fs = require('node:fs');
const [template, appDir, user] = process.argv.slice(2);
const { inventorySourceLabel } = require(`${appDir}/dist/server/config`);
// Match deploy validation and the service's WorkingDirectory for relative paths.
process.chdir(appDir);
// Quote systemd values and escape specifiers, including literal percent signs.
const quote = (value) => JSON.stringify(value.replace(/%/g, '%%'));
const overrides = {
  WEBSCP_CONFIG: process.env.WEBSCP_CONFIG,
  SSHM_CONFIG_DIR: inventorySourceLabel(),
};
const replacements = {
  __APP_DIR__: quote(appDir),
  __ENTRY_POINT__: quote(`${appDir}/dist/server/index.js`),
  __USER__: quote(user),
  __CONFIG_ENV__: Object.entries(overrides).filter(([, value]) => value)
    .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n'),
};
process.stdout.write(fs.readFileSync(template, 'utf8').replace(
  /__APP_DIR__|__ENTRY_POINT__|__USER__|__CONFIG_ENV__/g,
  (key) => replacements[key],
));
JS

echo "Installing $DEST (sudo required)…"
sudo cp "$TMP" "$DEST"
rm -f "$TMP"
sudo systemctl daemon-reload
sudo systemctl enable "$UNIT_NAME"
sudo systemctl restart "$UNIT_NAME"
echo "Done. Check: systemctl status $UNIT_NAME"
