# webscp

A two-pane web UI for browsing and copying files between SSH endpoints through
a local hub. Each pane selects its own sshm group and endpoint. Transfers stream
through the hub, so the two endpoints do not need to reach each other.

Built on [`@ssh-manager/core`](../ssh-manager/packages/core) for SSH connections,
SFTP, OS-aware paths, and binary-safe exec streaming on endpoints without SFTP.

## Inventory and groups

Saved endpoints come exclusively from `${SSHM_CONFIG_DIR:-$HOME/sshm_config}`:

```text
sshm_config/
  ssh_remote_default.json   # group 0
  ssh_remote_tw.json        # e.g. group 1
  ssh_remote_us.json        # e.g. group 2
```

Each file uses sshm's group envelope:

```json
{
  "group_number": 1,
  "nodes": [
    { "type": "client", "name": "build-host", "ip": "192.0.2.10", "user": "user" },
    {
      "type": "server",
      "name": "server1",
      "bmc": { "ip": "192.0.2.20", "user": "root" },
      "hosts": [{ "ip": "192.0.2.21", "user": "root" }],
      "smc": { "ip": "192.0.2.22", "user": "root" }
    }
  ]
}
```

Credentials can also contain `pass`, `port` (default 22), and `os` (`posix` or
`windows`). Clients, BMCs, and hosts connect directly. An embedded `server.smc`
connects through that server's BMC.

- Group names come from filenames; groups are sorted by number and name.
- Each pane has independent group and endpoint selectors. Cross-group transfers
  work the same way as transfers within one group.
- Duplicate group numbers produce a warning; selection uses the group name.
  Duplicate node names are distinguished by their original node numbers.
- Invalid files are shown as disabled groups with an error. Valid groups remain
  usable. Empty or missing directories still allow local and ad-hoc connections.
- **Standalone `type: "smc"` nodes are silently skipped.** The CLI's shared
  SMC fallback is not implemented. Embedded `server.smc` continues to work.
- Legacy array files are rejected. Convert them using ssh-manager's
  `convert_legacy_config.sh` or its offline config editor.

webscp never writes inventory. Edit files with ssh-manager's offline config
editor or another editor. There is no node management UI or `/api/nodes` CRUD
API, and ad-hoc connections cannot be saved. Existing `config.json.inventory`,
`config.json.inventoryPath`, `SSH_REMOTE_JSON`, and the CLI-only `SSHM_CONFIG`
do not select webscp inventory; use `SSHM_CONFIG_DIR`.

The browser checks for changes every five seconds while visible, on window
focus, and when **reload inventory** is clicked. Every server operation also
reads the current files. References from an older group revision are rejected
before connecting. Reload preserves an unchanged target and its current path;
removed or changed targets clear the old listing and require a new selection.
Node reordering preserves selection when the target's identity is unchanged.

## Workspace restore

Each pane automatically remembers its group, endpoint, and last successfully
opened path. Reopening a tab or refreshing the page restores both panes and
fetches fresh directory listings. The panes retain independent paths even when
they use the same endpoint. Endpoint selections use stable catalog keys and
current inventory references, so node reordering and server restarts do not
redirect a saved selection to another machine.

Selections are saved immediately; paths are saved after successful navigation.
Unsubmitted edits, failed navigation, and stale responses do not replace the
last successful path. A newly selected endpoint starts at `~` until its first
successful listing. Missing or changed endpoints require a new selection;
unreachable endpoints and missing directories retain the restored selection
and path with an error so you can retry or navigate elsewhere.

Workspace state is stored in browser `localStorage` under `webscp.workspace.v1`,
within the same browser profile and origin (scheme, hostname, and port).
The latest saved user action wins across tabs; existing tabs keep their own
views. Startup, inventory polling, and background refreshes do not overwrite
another tab's workspace or reorder recent paths. Clearing site data removes
the saved workspace. Invalid or unavailable storage does not prevent browsing.

Only Local and inventory endpoints are restored. An ad-hoc pane reopens at
Local home and needs a new connection; passwords and jump credentials are
never saved. Transfer queues, open dialogs, and unsubmitted path input are not
restored.

## Browsing and transfers

- **Local** exposes the hub's own filesystem.
- **Ad-hoc** connects with transient host/user/password and optional jump
  credentials, held in browser memory for the current page only.
- Enter a path and click **go**, press Enter, or double-click a directory.
- **Recent paths** opens a native popover beside the path input. Successful
  navigation moves that path to the top without duplicates. Failed paths and
  background refreshes do not change the ordering. Click **×** beside a path
  to remove it from history without navigating or deleting any files. Use Tab
  to reach the path and remove buttons, or Escape to close the dropdown.
- Path history is stored per endpoint in browser `localStorage`, shared between
  panes using that endpoint, and survives page reloads. Passwords are never
  stored there. If browser storage is unavailable, history lasts for the page
  session. Removing a history entry also persists across reloads; visiting that
  path again adds it back. Clearing site data removes all saved history.
- Drag files or directories between panes. Name conflicts offer replace or
  keep both. Same-connection, same-path copies are rejected even across groups;
  connection identity includes the destination and jump host, not node labels.
- Transfers support byte progress and cancellation. SFTP and no-SFTP endpoints
  can be mixed; no-SFTP endpoints use exec streams through core.

### Windows paths from File Explorer

Copy a directory path from File Explorer's address bar, paste it directly into
either pane's path input, then press Enter or click **go**. Do not add quotes,
even when the path contains spaces.

On POSIX endpoints (including Local under WSL), paths beginning with a drive
letter and `:\` or `:/` are converted to WSL's default `/mnt/<drive>/...` format:

| Pasted Windows path | Converted WSL path |
|---|---|
| `C:\html` | `/mnt/c/html` |
| `C:\Users\chisun\OneDrive - Advanced Micro Devices Inc\Documents\Custom Office Templates` | `/mnt/c/Users/chisun/OneDrive - Advanced Micro Devices Inc/Documents/Custom Office Templates` |

Drive letters become lowercase; folder names and spaces are preserved. Forward
slashes are also accepted. Successful navigation displays the converted path
and saves it in recent paths and workspace state. Windows endpoints retain
Windows paths; existing POSIX paths and `~` keep their usual behavior.

The drive must already be mounted at the corresponding path on the selected
endpoint. Custom WSL mount roots are not detected automatically.

## Build and run

Requires Node 18+ and the sibling ssh-manager checkout:

```text
~/github/
  ssh-manager/packages/core/
  webscp/
```

Use a browser with native Popover API support (Chrome/Edge 114+, Firefox 125+,
or Safari 17+) for the recent-path dropdown.

The recommended deploy builds core, installs webscp dependencies, links core,
builds webscp, validates group discovery, then installs, enables, and restarts
the systemd service. Run it as the intended service user; only installation
and systemd commands use sudo:

```bash
~/github/webscp/scripts/deploy.sh

# Build and link without installing a service:
~/github/webscp/scripts/deploy.sh --no-systemd

# A custom group directory, also forwarded into the service:
SSHM_CONFIG_DIR=~/work/sshm_config ~/github/webscp/scripts/deploy.sh

# A non-adjacent core checkout:
SSH_MANAGER_CORE=~/shared/ssh-manager/packages/core ~/github/webscp/scripts/deploy.sh
```

Manual build:

```bash
cd ~/github/ssh-manager/packages/core
npm install
npm run build

cd ~/github/webscp
npm install
mkdir -p node_modules/@ssh-manager
ln -sfn "$HOME/github/ssh-manager/packages/core" node_modules/@ssh-manager/core
npm run build
./scripts/start.sh
```

Open `http://127.0.0.1:8088`. `scripts/status.sh` and `scripts/stop.sh` manage a
manually started process; logs go to `webscp.log`.

Core is linked instead of listed as an npm dependency. Always create the link
**after** `npm install`, which can prune it. Build core after pulling changes;
restart webscp to load the new build. Deploy derives paths from the checkout,
and `SSH_MANAGER_CORE` controls both the core build location and link target.

## Updating an existing installation

After updating the checkout, rebuild and restart the existing systemd service
without replacing its unit or changing its service account:

```bash
cd ~/github/webscp
./scripts/deploy.sh --no-systemd
sudo systemctl restart webscp
systemctl status webscp --no-pager
```

Use the same `SSHM_CONFIG_DIR` and `SSH_MANAGER_CORE` overrides as the original
deployment when running the build. `--no-systemd` does not change a running
service or its environment. For a manually started process, run
`./scripts/stop.sh` followed by `./scripts/start.sh` with the intended environment
instead. Refresh the browser to load updated HTML, JavaScript, and CSS.

When upgrading from a version without workspace restore, the first browser
refresh resets the current group, endpoint, and path because the old page did
not save them. Select your endpoints and open the desired paths once after
loading the new version; subsequent refreshes and reopened tabs restore them
automatically. Existing recent-path history remains available.

To regenerate the service for the current checkout and user, run
`./scripts/deploy.sh` without `--no-systemd`. This replaces the base unit and
restarts the service; existing systemd drop-ins still apply. Sudo may prompt
for a password. A failed sudo or systemd command stops deployment before it
reports completion.

## HTTP configuration and systemd

`config.json` is optional and git-ignored. It contains HTTP settings only;
`config.example.json` is the template:

```json
{ "server": { "allowRemoteAccess": false, "port": 8088 } }
```

| Variable | Default | Meaning |
|---|---|---|
| `SSHM_CONFIG_DIR` | `~/sshm_config` | Shared group directory; leading `~` is expanded |
| `WEBSCP_CONFIG` | `<checkout>/config.json` | HTTP configuration file |
| `WEBSCP_HOST` | `127.0.0.1` | Overrides `server.host` and `allowRemoteAccess` |
| `WEBSCP_PORT` | `8088` | Overrides `server.port` |
| `SSH_MANAGER_CORE` | `../ssh-manager/packages/core` | Core location for deploy |

`server.host` overrides `allowRemoteAccess`; setting `allowRemoteAccess: true`
binds all interfaces. The app has no authentication: keep it on loopback, or
put authentication and TLS in front of any remote exposure.

```bash
SSHM_CONFIG_DIR=~/sshm_config ~/github/webscp/scripts/install-systemd.sh
systemctl status webscp
sudo systemctl restart webscp
journalctl -u webscp -f
```

The installer renders `systemd/webscp.service.template` using the checkout path
and current user. It forwards `WEBSCP_CONFIG` and always records the resolved
absolute `SSHM_CONFIG_DIR` (default: the installing user's `~/sshm_config`),
quoting systemd values. Relative group paths resolve from the webscp checkout,
matching the service's working directory. It runs daemon-reload, enables the unit, and restarts
it so an already running service loads the new build and settings.
The template sets `WEBSCP_HOST=127.0.0.1` and `WEBSCP_PORT=8088`,
which take precedence over JSON settings. Use `systemctl edit --full webscp`
to change these, then run `systemctl daemon-reload` and restart. Reinstall the
service after moving the checkout or changing its configuration environment.
The default group directory belongs to the service account's home directory.
When running as a different user (including root), set `SSHM_CONFIG_DIR` to the
absolute path of the intended shared directory before installing the service.

## Validation

Build core and webscp before testing; tests execute compiled output:

```bash
cd ~/github/webscp
npm run build
npm test
```

Tests cover group discovery, stale refs, configuration precedence, read-only
inventory APIs, Windows-to-WSL path conversion, transfer identity, and systemd
rendering and restart dispatch without real SSH or service installation.
The optional browser check uses an existing `puppeteer-core` installation and
Chrome executable:

```bash
WEBSCP_BROWSER_MODULE=/path/to/node_modules/puppeteer-core \
WEBSCP_CHROME=/path/to/chrome npm test
```

It verifies independent panes, workspace restore after closing tabs and restarting
the server, selection after reordering, missing or changed endpoints, unavailable
storage, multi-tab behavior, recent-path ordering, removal and persistence,
keyboard access and dropdown dismissal, stale responses, and discovery of
added/removed groups. SSH
sessions are mocked; it does not connect to inventory machines.
