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
- Endpoints come from webscp's own `config.json` (copy `config.example.json` to
  start). Servers expose their `bmc` / `host<N>` / `smc` sub-targets
  automatically. If no `config.json` exists, webscp falls back to the same
  `~/note/ssh_remote.json` that `sshm` uses.

## Features

- Two file panes; each connects to an endpoint from `config.json`
  (or an ad-hoc ip/user/password target).
- **Manage nodes in the browser.** The `manage nodes` button opens a form-based
  editor to create / edit / delete saved machines — no hand-editing JSON.
  Passwords can be set but are never displayed (editing shows `unchanged`; an
  empty password field keeps the stored secret).
- **Ad-hoc connect.** The per-pane `ad-hoc` button connects by typing
  host / user / password directly (with an optional jump host for BMC-style
  two-stage hops). After a successful connect you're asked whether to save it
  into `config.json`.
- **`localhost (this machine)`** is always offered as an endpoint: the hub's own
  filesystem can be a drag source or destination (local→remote upload,
  remote→local download, local→local copy).
- Inventory endpoints include servers' BMC / `host<N>` / `smc` sub-targets,
  resolved exactly like `sshm` (single BMC jump where needed). A server's SMC is
  declared inline as a `smc` block on the server node (see Configuration).
- **No-SFTP endpoints work too.** Embedded sshds without an SFTP subsystem
  (e.g. a BusyBox SMC) are detected automatically and fall back to binary-safe
  `exec` streaming (`cat` / `cat > file`), so listing and transfers still work —
  no `base64`, no truncation. SFTP endpoints keep using SFTP unchanged.
- Drag a file/dir from one pane to the other to copy it (relayed through the
  hub; any mix of SFTP and no-SFTP ends works).
- Live per-transfer byte progress over WebSocket, with cancel.
- SFTP baseline means Windows endpoints work without special shell handling.

## Requirements

- Node 18+ (developed on Node 22).
- A `config.json` (copy from `config.example.json`). If absent, webscp falls
  back to `$SSH_REMOTE_JSON` or `~/note/ssh_remote.json`. See **Configuration**.
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
./scripts/start.sh           # background; prints the URL, logs to webscp.log
#   or: npm start            # foreground
./scripts/status.sh          # running? which PID / port?
./scripts/stop.sh
```

`start.sh` waits for the server to bind and then prints the address, e.g.:

```
webscp started (PID 12345)
  URL:  http://127.0.0.1:8088
  Logs: /home/you/github/webscp/webscp.log
```

If it fails to bind, the script prints the tail of `webscp.log` and exits
non-zero instead of leaving a dead PID file behind.

## Configuration

### `config.json` (remote info + server binding)

webscp keeps all connection details and server settings in its own
`config.json` at the repo root. **It holds private credentials and is
git-ignored** — commit `config.example.json` instead and copy it to start:

```bash
cp config.example.json config.json
# then edit config.json with your real nodes
```

Structure:

```jsonc
{
  "server": {
    "allowRemoteAccess": false,  // false = loopback only (prod); true = reachable from other machines (testing)
    "port": 8088
  },
  "inventory": [
    { "type": "client", "name": "...", "ip": "...", "user": "...", "pass": "..." },
    {
      "type": "server", "name": "...",
      "bmc":   { "ip": "...", "user": "...", "pass": "..." },
      "smc":   { "ip": "...", "user": "...", "pass": "..." },   // optional, reached via the BMC jump
      "hosts": [ { "ip": "...", "user": "...", "pass": "..." } ] // reachable directly (no jump)
    }
  ]
}
```

A node is either a `client` (direct SSH) or a `server`. A server bundles its
`bmc`, an optional `smc`, and any `hosts`. The BMC and hosts are reached
directly; only the SMC sits on an internal network and is reached through a BMC
jump — which is why the SMC lives inside the server node rather than as a
separate entry. The SMC sub-target only appears in the UI when the server has an
`smc` block. (This differs slightly from `sshm`'s standalone `smc` entry; the
embedded form is what webscp uses.)

You normally won't edit this file by hand — use the **manage nodes** button in
the UI, which fills in the right shape and keeps passwords out of the browser.

**Opening the service to other machines.** By default webscp binds to
`127.0.0.1` and is reachable only from the hub itself. To test from another
machine, set `"allowRemoteAccess": true` in `server` — it then binds `0.0.0.0`
(all interfaces). Leave it `false` for production. The server prints a warning at
startup whenever remote access is on, because **there is no authentication**
(see Security). For finer control you can instead set `server.host` to a specific
address, which overrides `allowRemoteAccess`.

**Inventory resolution precedence:**

1. `config.json` → `inventory` (inline nodes) — preferred
2. `config.json` → `inventoryPath` (path to an external JSON array, `~` allowed)
3. `$SSH_REMOTE_JSON` environment variable
4. `~/note/ssh_remote.json` (legacy default)

This keeps backward compatibility: with no `config.json`, webscp behaves exactly
as before.

### Environment variables (override config.json)

| Variable | Default | Meaning |
|---|---|---|
| `WEBSCP_HOST` | from `config.server` (see below) | Explicit bind address; overrides `allowRemoteAccess` |
| `WEBSCP_PORT` | `config.server.port` → `8088` | Port |
| `WEBSCP_CONFIG` | `<repo>/config.json` | Config file location |
| `SSH_REMOTE_JSON` | `~/note/ssh_remote.json` | Fallback inventory file (only used when config.json has no inventory) |
| `SSH_MANAGER_CORE` | `../ssh-manager/packages/core` | core location (deploy.sh only) |

Host resolution precedence: `WEBSCP_HOST` > `config.server.host` >
`config.server.allowRemoteAccess` (`true`→`0.0.0.0`, `false`→`127.0.0.1`) >
`127.0.0.1`. Port: `WEBSCP_PORT` > `config.server.port` > `8088`. When run as a
service, `WEBSCP_HOST`/`WEBSCP_PORT` are set in the unit file and therefore take
precedence over `config.json`.

## Run as a service (systemd)

`deploy.sh` installs and enables the unit for you, so most people never touch
this section. Read it if you want to understand or hand-edit the unit — in
particular **how the paths get set**, since systemd needs absolute paths and
cannot expand `~`.

### How the unit file is generated (paths explained)

The repo ships a **template**, not a ready unit:
`systemd/webscp.service.template`. It contains placeholders that
`scripts/install-systemd.sh` fills in at install time:

| Placeholder | Replaced with | How it's derived |
|---|---|---|
| `__APP_DIR__` | absolute path to this checkout (e.g. `/home/you/github/webscp`) | computed from the script's own location — no hardcoding |
| `__USER__` | the user who ran the installer | `id -un` |
| `__SSH_REMOTE_JSON_ENV__` | an `Environment=SSH_REMOTE_JSON=…` line, or removed | added only if `SSH_REMOTE_JSON` was set when you ran the installer |

`__APP_DIR__` becomes both `WorkingDirectory` and the path in
`ExecStart=/usr/bin/env node __APP_DIR__/dist/server/index.js`. **This is why the
service must be (re)installed if you move or rename the checkout** — the absolute
path is baked into the installed unit at `/etc/systemd/system/webscp.service`.

The rendered unit also sets `Environment=WEBSCP_HOST=127.0.0.1` and
`Environment=WEBSCP_PORT=8088`. Change those lines (see below) to bind elsewhere.

### Install / reinstall by hand

```bash
# default inventory (~/note/ssh_remote.json):
~/github/webscp/scripts/install-systemd.sh

# custom inventory path — export it FIRST so it gets baked into the unit:
SSH_REMOTE_JSON=~/note/other.json ~/github/webscp/scripts/install-systemd.sh
```

The installer runs `npm run build` if `dist/` is missing, renders the template,
copies it to `/etc/systemd/system/webscp.service` (needs `sudo`), then
`daemon-reload` + `enable --now`.

### Operate it

```bash
systemctl status webscp
sudo systemctl restart webscp        # after pulling new code + npm run build
sudo systemctl stop webscp
sudo systemctl disable webscp        # stop it starting at boot
```

### Editing the installed unit directly

To tweak port/host/inventory without reinstalling:

```bash
sudo systemctl edit --full webscp     # opens the installed unit in your editor
# change e.g. Environment=WEBSCP_PORT=9090, save, then:
sudo systemctl daemon-reload
sudo systemctl restart webscp
```

> If you change `WEBSCP_PORT` here, also update any `ssh -L` tunnel and the URL
> you open in the browser.

### After moving the checkout

The unit holds an absolute `__APP_DIR__`. If you `mv` the repo, just re-run the
installer — it re-derives the path and overwrites the unit:

```bash
~/github/webscp/scripts/install-systemd.sh
sudo systemctl restart webscp
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

- **Inventory edits not showing up.** The server caches `config.json` (and any
  fallback inventory file). Click **reload inventory** in the header (or
  `POST /api/reload`) to re-read it.

- **An SMC / embedded endpoint lists but feels slower.** Endpoints whose sshd has
  no SFTP subsystem use the `exec` fallback (`cat`-based streaming over a shell
  channel) instead of SFTP. This is expected and still binary-safe. If such an
  endpoint *fails* to list, confirm it has the basic tools the fallback needs on
  `PATH` (`ls`/`stat`/`find`/`cat`); a stripped BusyBox usually has them.

- **`localhost (this machine)` is missing from the dropdown.** It's injected by
  the server, not read from inventory — if it's absent you're running an old
  build. Rebuild (`npm run build`) and restart the service/process.

## Security note

The MVP has **no authentication**. It is meant to run on a local hub that no one
else can reach, bound to `127.0.0.1` by default. SSH passwords are read from
`config.json` (or the fallback inventory file) into memory only and are never
written to logs or error messages. `config.json` itself is git-ignored so
credentials never reach the repo. Before exposing the port to anything beyond
`localhost`:

- Do **not** set `server.allowRemoteAccess: true` (or `WEBSCP_HOST=0.0.0.0`)
  without putting authentication (and ideally TLS) in front of it — anyone who
  can reach the port gets full, unauthenticated SFTP access to every endpoint in
  your inventory. The flag exists for testing from another machine on a trusted
  network; keep it `false` in production.
- Prefer an SSH tunnel (`ssh -L 8088:127.0.0.1:8088 hub`) over binding publicly.
