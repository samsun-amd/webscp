# webscp

A WinSCP-style two-pane web UI for moving files between Linux/Windows machines
by dragging across panes. It runs on a local **hub** machine that can `ssh` out
to everything (but need not be reachable itself), and is driven from a browser
on `localhost`.

Built on [`@ssh-manager/core`](../ssh-manager/packages/core) for all SSH
inventory parsing, connection pooling, SFTP, and transfer logic.

## The hub model (read this first)

webscp does **not** ask machine A to talk to machine B directly. Instead:

```
   browser ──HTTP/WebSocket──▶  webscp server (the "hub")
                                   │  ssh/SFTP out to each endpoint
                          ┌────────┴────────┐
                          ▼                 ▼
                      endpoint A         endpoint B
```

- The hub is the one machine that can reach every endpoint (directly, or through
  a BMC jump). The browser only ever talks to the hub on `localhost`.
- A drag from pane A to pane B copies a file by **relaying through the hub** over
  SFTP — bytes stream A → hub → B with no spill to local disk. This works no
  matter the OS of either side and even when A and B cannot reach each other.
- Endpoints come from the same `~/note/ssh_remote.json` that `sshm` uses, so
  servers expose their `bmc` / `host<N>` / `smc` sub-targets automatically.

## Features

- Two file panes; each connects to an endpoint from `~/note/ssh_remote.json`
  (or an ad-hoc ip/user/password target).
- Inventory endpoints include servers' BMC / `host<N>` / `smc` sub-targets,
  resolved exactly like `sshm` (single BMC jump where needed).
- Drag a file/dir from one pane to the other to copy it (remote → remote relay).
- Live per-transfer byte progress over WebSocket, with cancel.
- SFTP baseline means Windows endpoints work without special shell handling.

## Requirements

- Node 18+ (developed on Node 22).
- `~/note/ssh_remote.json` present (same file `sshm` uses). Override with the
  `SSH_REMOTE_JSON` environment variable.
- The `ssh-manager` repo checked out so `@ssh-manager/core` can be built and
  linked (see below).

## Layout

webscp expects to sit beside `ssh-manager` under `~/github/`:

```
~/github/
  ssh-manager/packages/core   # the shared library (built + symlinked, not a dep)
  webscp/
    src/server/   index.ts (Express + ws), endpoints.ts (inventory + resolveRef)
    src/shared/   types.ts (wire types shared with the browser)
    public/       index.html, app.js, style.css
    scripts/      deploy.sh, start.sh, stop.sh, status.sh, install-systemd.sh
    systemd/      webscp.service.template
```

## Why `@ssh-manager/core` is a symlink, not a dependency

`@ssh-manager/core` is **not** listed in `package.json`. The reason: npm rewrites
any `file:` dependency path into an ugly normalized relative form (even
`file:$HOME/...` becomes `file:../../home/<user>/...`), so a portable, readable
`~`-anchored path simply cannot be stored there. Instead the deploy keeps core
out of `dependencies` and links it into `node_modules` itself:

```
~/github/webscp/node_modules/@ssh-manager/core  ->  <core dir>
```

The core location has a single source of truth — `$CORE_DIR` in `deploy.sh`:

- **Default:** the sibling of this checkout (`../ssh-manager/packages/core`),
  derived relative to the script, so moving *both* repos together needs no config.
- **Override:** set `SSH_MANAGER_CORE` when ssh-manager lives somewhere
  non-adjacent. The same value is used both to build core and as the symlink
  target, so build and link can never disagree.

> **Critical ordering:** the symlink must be created *after* `npm install`. npm
> prunes pre-existing "extraneous" links during install, so the order is always
> **build core → `npm install` webscp → create symlink → build webscp**.
> `deploy.sh` already does this; only matters if you build by hand.

> The on-disk link target is an absolute path (the shell expands `$CORE_DIR` /
> `$HOME` at deploy time). "Portable" means *our scripts* express the path via
> variables — not that the on-disk link is relative.

## First-time deploy (recommended)

On the target hub machine, after cloning both repos:

```bash
cd ~/github
git clone <ssh-manager-url> ssh-manager
git clone <webscp-url> webscp

# Does everything: checks prereqs + inventory, builds core, links it,
# builds webscp, installs + enables the systemd service.
~/github/webscp/scripts/deploy.sh

#   build/link only, skip the service:   ~/github/webscp/scripts/deploy.sh --no-systemd
#   ssh-manager elsewhere:               SSH_MANAGER_CORE=/path/to/ssh-manager/packages/core ~/github/webscp/scripts/deploy.sh
#   custom inventory (forwarded to the service unit):
#                                        SSH_REMOTE_JSON=~/note/other.json ~/github/webscp/scripts/deploy.sh
```

Then open `http://127.0.0.1:8088`.

## Manual build & run

```bash
# 1. Build the shared core
cd ~/github/ssh-manager/packages/core && npm install && npm run build

# 2. Install webscp deps, THEN link core (npm prunes pre-existing links during
#    install), then build
cd ~/github/webscp && npm install
ln -sfn "$HOME/github/ssh-manager/packages/core" node_modules/@ssh-manager/core
npm run build

# 3. Run
./scripts/start.sh           # background, logs to ~/github/webscp/webscp.log
#   or: npm start            # foreground
./scripts/status.sh
./scripts/stop.sh
```

## Configuration (env vars, no hardcoding)

| Variable | Default | Meaning |
|---|---|---|
| `WEBSCP_HOST` | `127.0.0.1` | Bind address (keep it loopback — see Security) |
| `WEBSCP_PORT` | `8088` | Port |
| `SSH_REMOTE_JSON` | `~/note/ssh_remote.json` | Inventory file (runtime) |
| `SSH_MANAGER_CORE` | `../ssh-manager/packages/core` | core location (deploy.sh only) |

When run as a service, `WEBSCP_HOST`/`WEBSCP_PORT` are set in the unit file.
`SSH_REMOTE_JSON` is forwarded into the unit **only** if it was set when you ran
`install-systemd.sh` / `deploy.sh`; otherwise the service uses the `~/note`
default.

## Run as a service (systemd)

`deploy.sh` installs and enables the unit for you. To (re)install by hand:

```bash
~/github/webscp/scripts/install-systemd.sh   # renders the template with this path + your user
```

Operate it:

```bash
systemctl status webscp
sudo systemctl restart webscp        # after pulling new code + npm run build
sudo systemctl stop webscp
sudo systemctl disable webscp
```

## Reading logs

- **systemd:** `journalctl -u webscp -f` (live), or `journalctl -u webscp -n 100`.
- **manual / `start.sh`:** `tail -f ~/github/webscp/webscp.log`.

On startup the server prints `webscp running on http://<host>:<port>`. Transfer
errors and SSH connection failures surface both in the browser (pane message /
transfer row) and in the log.

## Troubleshooting

- **An endpoint shows a red error / "connection failed".** The hub could not SSH
  to that target. Confirm the host is up and reachable *from the hub*, that the
  creds in `ssh_remote.json` are correct, and that BMC-jumped targets (`host<N>`,
  `smc`) have a valid `bmc` block. A dead remote fails fast (15 s handshake
  timeout) rather than hanging; the REST call returns `503`.

- **Port already in use (`EADDRINUSE`).** Something else holds `8088`. Find it
  with `ss -ltnp 'sport = :8088'`, then either stop it or run webscp on another
  port: `WEBSCP_PORT=9090 ./scripts/start.sh` (or edit the systemd unit).

- **`Cannot find module '@ssh-manager/core'` after `npm install`.** npm pruned
  the symlink (it's "extraneous" since core isn't in `package.json`). Recreate it
  *after* the install completes:
  ```bash
  cd ~/github/webscp
  ln -sfn "$HOME/github/ssh-manager/packages/core" node_modules/@ssh-manager/core
  npm run build
  ```

- **`core build produced no dist/index.js` during deploy.** core failed to build.
  Build it directly to see the error:
  `cd ~/github/ssh-manager/packages/core && npm install && npm run build`.

- **Browser says "ws: disconnected (retrying)".** The WebSocket dropped (server
  restart, network blip). The UI auto-reconnects every 2 s; just wait. Drops
  during a transfer abort that transfer — drag the file again once it shows
  "ws: connected". An in-flight drag attempted while disconnected is refused
  with a pane message instead of failing silently.

- **Inventory edits not showing up.** The server caches `ssh_remote.json`. Click
  **reload inventory** in the header (or `POST /api/reload`) to re-read the file.

## Security note

The MVP has **no authentication**. It is meant to run on a local hub that no one
else can reach, bound to `127.0.0.1` by default. SSH passwords are read from
`ssh_remote.json` into memory only and are never written to logs or error
messages. Before exposing the port to anything beyond `localhost`:

- Do **not** change `WEBSCP_HOST` to `0.0.0.0` without putting authentication
  (and ideally TLS) in front of it — anyone who can reach the port gets full,
  unauthenticated SFTP access to every endpoint in your inventory.
- Prefer an SSH tunnel (`ssh -L 8088:127.0.0.1:8088 hub`) over binding publicly.
</content>
</invoke>
