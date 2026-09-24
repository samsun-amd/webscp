'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('deployment validates sshm groups and forwards their directory to systemd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-deploy-'));
  const app = path.join(dir, 'webscp');
  const core = path.join(dir, 'core');
  const configs = path.join(dir, 'configs');
  const bin = path.join(dir, 'bin');
  const inventory = path.join(configs, 'ssh_remote_default.json');
  const unit = path.join(dir, 'webscp.service');
  try {
    for (const folder of [app, core, configs, bin, path.join(core, 'dist'), path.join(app, 'dist/server')]) {
      fs.mkdirSync(folder, { recursive: true });
    }
    for (const folder of ['scripts', 'systemd']) {
      fs.cpSync(path.join(__dirname, '..', folder), path.join(app, folder), { recursive: true });
    }
    // Use the real inventory loader; mock package installs, builds, and services.
    fs.writeFileSync(path.join(core, 'package.json'), '{"main":"dist/index.js"}');
    fs.writeFileSync(path.join(core, 'dist/index.js'), `module.exports = require(${JSON.stringify(require.resolve('@ssh-manager/core'))});`);
    fs.writeFileSync(path.join(app, 'dist/server/index.js'), '');
    for (const file of ['config.js', 'endpoints.js']) {
      fs.copyFileSync(path.join(__dirname, '../dist/server', file), path.join(app, 'dist/server', file));
    }
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "mock npm\\n"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh
case "$1" in
  cp) cp -- "$2" "$UNIT_CAPTURE" ;;
  systemctl) exit 0 ;;
  *) exit 97 ;;
esac
`, { mode: 0o755 });
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      SSH_MANAGER_CORE: core, SSHM_CONFIG_DIR: configs, SSH_REMOTE_JSON: '',
      WEBSCP_CONFIG: path.join(dir, 'app-config.json'), UNIT_CAPTURE: unit,
    };
    const run = (expected, overrides = {}, args = ['--no-systemd']) => {
      const result = spawnSync('bash', [path.join(app, 'scripts/deploy.sh'), ...args], {
        env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.status, expected, result.error?.message || result.stdout + result.stderr);
      return result.stdout + result.stderr;
    };
    fs.writeFileSync(inventory, JSON.stringify({ group_number: 0, nodes: [] }));
    fs.writeFileSync(path.join(configs, 'ssh_remote_tw.json'), JSON.stringify({ group_number: 1, nodes: [] }));
    assert.ok(run(0).includes(`Inventory: ${configs} (2 groups)`));
    assert.ok(!fs.existsSync(unit), '--no-systemd must not install a service');
    for (const [invalid, warning] of [
      [[], /convert legacy arrays/],
      [{ group_number: 0, nodes: [null] }, /nodes: array/],
      [{ group_number: 1, nodes: [] }, /Group 0 is reserved/],
    ]) {
      fs.writeFileSync(inventory, JSON.stringify(invalid));
      const output = run(0);
      assert.match(output, warning);
      assert.ok(output.includes(`Inventory: ${configs} (2 groups)`));
    }
    fs.writeFileSync(inventory, JSON.stringify({ group_number: 0, nodes: [] }));
    const explicit = path.join(dir, 'ssh_remote_tw.json');
    fs.writeFileSync(explicit, 'invalid legacy inventory');
    fs.writeFileSync(env.WEBSCP_CONFIG, JSON.stringify({ inventory: [{}], inventoryPath: explicit }));
    assert.ok(run(0, { SSH_REMOTE_JSON: explicit }).includes(`Inventory: ${configs} (2 groups)`));

    const missing = path.join(dir, 'missing');
    const empty = run(0, { SSHM_CONFIG_DIR: missing, SSH_REMOTE_JSON: explicit });
    assert.ok(empty.includes(`Inventory: ${missing} (0 groups)`));
    assert.match(empty, /No sshm groups found/);
    assert.match(run(1, { SSHM_CONFIG_DIR: inventory }, []), /Inventory validation failed/);
    assert.ok(!fs.existsSync(unit), 'an unreadable group directory must stop service installation');

    run(0, { SSH_REMOTE_JSON: explicit }, []);
    const installed = fs.readFileSync(unit, 'utf8');
    assert.ok(installed.includes(`Environment=${JSON.stringify(`SSHM_CONFIG_DIR=${configs}`)}\n`));
    assert.doesNotMatch(installed, /Environment=.*SSH_REMOTE_JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
