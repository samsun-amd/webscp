'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('systemd install preserves the inventory source and restarts existing services', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rendered = path.join(dir, 'rendered.service');
  const restarted = path.join(dir, 'restarted');
  fs.writeFileSync(path.join(dir, 'sudo'), `#!/bin/sh
if [ "$1" = cp ]; then cp "$2" "$WEBSCP_TEST_UNIT"; fi
if [ "$1" = systemctl ] && [ "$2" = restart ]; then
  if [ "$WEBSCP_TEST_RESTART_FAIL" = 1 ]; then exit 1; fi
  touch "$WEBSCP_TEST_RESTARTED"
fi
`, { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    WEBSCP_TEST_UNIT: rendered,
    WEBSCP_TEST_RESTARTED: restarted,
    WEBSCP_CONFIG: '/tmp/50%/app & config.json',
    SSH_REMOTE_JSON: '/tmp/50%/ssh_remote_tw.json',
    SSHM_CONFIG_DIR: '/tmp/groups "quoted"',
  };
  execFileSync('bash', ['scripts/install-systemd.sh'], { cwd: path.join(__dirname, '..'), env });
  const unit = fs.readFileSync(rendered, 'utf8');
  for (const key of ['WEBSCP_CONFIG', 'SSHM_CONFIG_DIR']) {
    assert.ok(unit.includes(`Environment=${JSON.stringify(`${key}=${env[key]}`.replace(/%/g, '%%'))}`));
  }
  assert.doesNotMatch(unit, /__[A-Z_]+__|Environment=.*SSH_REMOTE_JSON/);
  assert.ok(fs.existsSync(restarted), 'an already active service must be restarted');

  for (const [input, expected] of [
    [undefined, path.join(os.homedir(), 'sshm_config')],
    ['~/custom-groups', path.join(os.homedir(), 'custom-groups')],
    ['relative-groups', path.join(__dirname, '..', 'relative-groups')],
  ]) {
    delete env.SSHM_CONFIG_DIR;
    if (input) env.SSHM_CONFIG_DIR = input;
    execFileSync('bash', [path.join(__dirname, '../scripts/install-systemd.sh')], { cwd: dir, env });
    assert.ok(fs.readFileSync(rendered, 'utf8').includes(
      `Environment=${JSON.stringify(`SSHM_CONFIG_DIR=${expected}`.replace(/%/g, '%%'))}`,
    ));
  }

  assert.throws(() => execFileSync('bash', ['scripts/install-systemd.sh'], {
    cwd: path.join(__dirname, '..'), env: { ...env, WEBSCP_TEST_RESTART_FAIL: '1' },
  }), (error) => error.status !== 0 && !error.stdout.toString().includes('Done.'));
});
