'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('systemd install preserves config overrides with systemd quoting', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rendered = path.join(dir, 'rendered.service');
  fs.writeFileSync(path.join(dir, 'sudo'), '#!/bin/sh\nif [ "$1" = cp ]; then cp "$2" "$WEBSCP_TEST_UNIT"; fi\n', { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    WEBSCP_TEST_UNIT: rendered,
    WEBSCP_CONFIG: '/tmp/app & config.json',
    SSH_REMOTE_JSON: '/tmp/50%/ssh_remote_tw.json',
    SSHM_CONFIG_DIR: '/tmp/groups "quoted"',
  };
  execFileSync('bash', ['scripts/install-systemd.sh'], { cwd: path.join(__dirname, '..'), env });
  const unit = fs.readFileSync(rendered, 'utf8');
  for (const key of ['WEBSCP_CONFIG', 'SSHM_CONFIG_DIR']) {
    assert.ok(unit.includes(`Environment=${JSON.stringify(`${key}=${env[key]}`.replace(/%/g, '%%'))}`));
  }
  assert.doesNotMatch(unit, /__[A-Z_]+__|Environment=.*SSH_REMOTE_JSON/);
});
