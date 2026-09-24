'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('only SSHM_CONFIG_DIR supplies inventory; app config retains HTTP settings', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.WEBSCP_CONFIG = path.join(dir, 'config.json');
  process.env.SSHM_CONFIG_DIR = dir;
  process.env.SSH_REMOTE_JSON = '/ignored/legacy.json';
  delete process.env.WEBSCP_HOST;
  delete process.env.WEBSCP_PORT;
  fs.writeFileSync(process.env.WEBSCP_CONFIG, JSON.stringify({
    server: { port: 8181 }, inventory: [{ name: 'ignored' }], inventoryPath: '/ignored/file.json',
  }));
  const cfg = require('../dist/server/config');
  assert.equal(cfg.inventorySourceLabel(), dir);
  assert.deepEqual(cfg.serverSettings(), { host: '127.0.0.1', port: 8181, remote: false });
  delete process.env.SSHM_CONFIG_DIR;
  assert.equal(cfg.inventorySourceLabel(), path.join(os.homedir(), 'sshm_config'));
  process.env.SSHM_CONFIG_DIR = '~/test-groups';
  assert.equal(cfg.inventorySourceLabel(), path.join(os.homedir(), 'test-groups'));
});
