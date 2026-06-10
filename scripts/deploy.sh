#!/bin/bash
#
# webscp first-time deploy (run on the target machine, after git clone).
#
# Does everything except `git clone`:
#   - verifies layout, node/npm, and ssh_remote.json
#   - builds @ssh-manager/core
#   - links core into webscp via a $HOME-anchored symlink (see note below)
#   - builds webscp
#   - installs + enables the systemd service
#
# Why a symlink instead of a package.json dependency:
#   npm rewrites any `file:` dependency path into an ugly normalized relative
#   path (even `file:$HOME/...` becomes `file:../../home/<user>/...`), so a
#   "~"-anchored path cannot be stored in package.json. Instead we keep core out
#   of webscp's dependencies and create the link here, anchored on $HOME, so the
#   path stays portable and readable.
#
# Prerequisite layout (clone both as siblings under ~/github):
#   ~/github/ssh-manager
#   ~/github/webscp
#
# Usage:
#   ~/github/webscp/scripts/deploy.sh            # full deploy incl. systemd
#   ~/github/webscp/scripts/deploy.sh --no-systemd   # build/link only, no service
#
set -euo pipefail

# --- resolve paths relative to this script (portable, no hardcoding) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSCP_DIR="$(dirname "$SCRIPT_DIR")"
GITHUB_DIR="$(dirname "$WEBSCP_DIR")"

# Single source of truth for the @ssh-manager/core location. Defaults to the
# sibling of this webscp checkout, so moving both repos together needs no config.
# Override SSH_MANAGER_CORE when ssh-manager lives somewhere non-adjacent, e.g.
#   SSH_MANAGER_CORE=$HOME/shared/ssh-manager/packages/core ./scripts/deploy.sh
# The same value is used both to build core and as the symlink target, so the
# two can never disagree.
CORE_DIR="${SSH_MANAGER_CORE:-$GITHUB_DIR/ssh-manager/packages/core}"
CORE_DIR="$(cd "$CORE_DIR" 2>/dev/null && pwd || echo "$CORE_DIR")"

# Inventory sources, in precedence order:
#   1. webscp's own config.json (preferred; holds inline inventory + server cfg)
#   2. legacy fallback: $SSH_REMOTE_JSON, else ~/note/ssh_remote.json
CONFIG_JSON="${WEBSCP_CONFIG:-$WEBSCP_DIR/config.json}"
INVENTORY="${SSH_REMOTE_JSON:-$HOME/note/ssh_remote.json}"

INSTALL_SYSTEMD=1
[[ "${1:-}" == "--no-systemd" ]] && INSTALL_SYSTEMD=0

RED='\033[1;31m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}!!${NC} $*"; }
die()   { echo -e "${RED}Error:${NC} $*" >&2; exit 1; }

# --- 1. prerequisite checks ---
info "Checking prerequisites…"

command -v node >/dev/null 2>&1 || die "node is not installed."
command -v npm  >/dev/null 2>&1 || die "npm is not installed."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "node >= 18 required (found $(node -v))."
info "node $(node -v), npm $(npm -v)"

[[ -d "$CORE_DIR" ]] || die "Cannot find @ssh-manager/core at:
    $CORE_DIR
  Either clone ssh-manager as a sibling of webscp:
    git clone <ssh-manager-url> $GITHUB_DIR/ssh-manager
  or point at an existing checkout:
    SSH_MANAGER_CORE=/path/to/ssh-manager/packages/core $0"

# --- 2. inventory check (config.json preferred, ssh_remote.json fallback) ---
if [[ -r "$CONFIG_JSON" ]]; then
  COUNT="$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if (Array.isArray(c.inventory)) { console.log(c.inventory.length); }
    else if (c.inventoryPath) { console.log("via inventoryPath"); }
    else { console.log("0"); }
  ' "$CONFIG_JSON" 2>/dev/null)" || die "config.json exists but is not valid JSON: $CONFIG_JSON"
  info "Config OK: $CONFIG_JSON (inventory: $COUNT)"
elif [[ -r "$INVENTORY" ]]; then
  if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$INVENTORY" 2>/dev/null; then
    COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$INVENTORY" 2>/dev/null || echo '?')"
    info "Inventory OK (fallback): $INVENTORY ($COUNT nodes)"
    warn "No config.json found; using legacy $INVENTORY."
    warn "Consider: cp $WEBSCP_DIR/config.example.json $CONFIG_JSON"
  else
    die "Inventory exists but is not valid JSON: $INVENTORY"
  fi
else
  warn "No inventory source found."
  warn "Create $CONFIG_JSON (copy config.example.json) with your nodes,"
  warn "or provide the legacy $INVENTORY. Continuing the build anyway…"
fi

# --- 3. build @ssh-manager/core ---
info "Building @ssh-manager/core…"
( cd "$CORE_DIR" && npm install --no-audit --no-fund && npm run build )
[[ -f "$CORE_DIR/dist/index.js" ]] || die "core build produced no dist/index.js"

# --- 4. install webscp deps, then link core ($HOME-anchored), then build ---
info "Installing webscp dependencies…"
( cd "$WEBSCP_DIR" && npm install --no-audit --no-fund )

# Create the symlink AFTER npm install (npm would prune it as extraneous if it
# ran afterward). Target is $CORE_DIR — the same path used to build core above —
# so build and link can never point at different places.
info "Linking @ssh-manager/core -> $CORE_DIR"
mkdir -p "$WEBSCP_DIR/node_modules/@ssh-manager"
ln -sfn "$CORE_DIR" "$WEBSCP_DIR/node_modules/@ssh-manager/core"
( cd "$WEBSCP_DIR" && node -e 'require("@ssh-manager/core"); console.log("  link resolves OK")' ) \
  || die "core symlink does not resolve from webscp"

info "Building webscp…"
( cd "$WEBSCP_DIR" && npm run build )
[[ -f "$WEBSCP_DIR/dist/server/index.js" ]] || die "webscp build produced no dist/server/index.js"

# --- 5. systemd service ---
if (( INSTALL_SYSTEMD )); then
  info "Installing systemd service (sudo required)…"
  "$SCRIPT_DIR/install-systemd.sh"
else
  warn "Skipping systemd (--no-systemd). Start manually with: $SCRIPT_DIR/start.sh"
fi

echo
info "Deploy complete."
echo "  Web UI:   http://127.0.0.1:${WEBSCP_PORT:-8088}"
if (( INSTALL_SYSTEMD )); then
  echo "  Service:  systemctl status webscp"
  echo "  Logs:     journalctl -u webscp -f"
else
  echo "  Start:    $SCRIPT_DIR/start.sh   (logs: $WEBSCP_DIR/webscp.log)"
fi
