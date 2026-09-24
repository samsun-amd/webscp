'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('deployment scripts accept group configs and preserve inventory precedence', () => {
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
    // Only test script orchestration: no package installs, builds, or real services.
    fs.writeFileSync(path.join(core, 'package.json'), '{"main":"dist/index.js"}');
    fs.writeFileSync(path.join(core, 'dist/index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(app, 'dist/server/index.js'), '');
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
    const run = (script, expected, overrides = {}) => {
      const result = spawnSync('bash', [path.join(app, 'scripts', script), '--no-systemd'], {
        env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.status, expected, result.error?.message || result.stdout + result.stderr);
      return result.stdout + result.stderr;
    };
    fs.writeFileSync(inventory, JSON.stringify({ group_number: 0, nodes: [{}] }));
    assert.match(run('deploy.sh', 0), /Inventory OK \(fallback\):.*ssh_remote_default\.json \(1 nodes\)/);
    for (const invalid of [[], { group_number: 0, nodes: [null] }, { group_number: 1, nodes: [] }]) {
      fs.writeFileSync(inventory, JSON.stringify(invalid));
      assert.match(run('deploy.sh', 1), /Convert legacy arrays/);
    }
    const explicit = path.join(dir, 'ssh_remote_tw.json');
    fs.writeFileSync(explicit, JSON.stringify({ group_number: 1, nodes: [] }));
    assert.match(run('deploy.sh', 0, { SSH_REMOTE_JSON: explicit }), /ssh_remote_tw\.json \(0 nodes\)/);
    fs.writeFileSync(env.WEBSCP_CONFIG, JSON.stringify({ inventory: [{}] }));
    assert.match(run('deploy.sh', 0), /Config OK:.*inventory: 1/);

    run('install-systemd.sh', 0);
    assert.ok(fs.readFileSync(unit, 'utf8').includes(`Environment=SSH_REMOTE_JSON=${inventory}\n`));
    run('install-systemd.sh', 0, { SSH_REMOTE_JSON: explicit });
    assert.ok(fs.readFileSync(unit, 'utf8').includes(`Environment=SSH_REMOTE_JSON=${explicit}\n`));
    run('install-systemd.sh', 0, { SSHM_CONFIG_DIR: '' });
    assert.doesNotMatch(fs.readFileSync(unit, 'utf8'), /^Environment=SSH_REMOTE_JSON=/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
