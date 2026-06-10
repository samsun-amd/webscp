'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the inventory loader at a temp fixture BEFORE requiring the module
// (getInventory caches on first use).
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'ssh-manager', 'shared', 'inventory-conformance.json'),
    'utf8',
  ),
).inventory;

const invFile = path.join(os.tmpdir(), `webscp-inv-${process.pid}.json`);
fs.writeFileSync(invFile, JSON.stringify(FIXTURE), 'utf8');
process.env.SSH_REMOTE_JSON = invFile;
// Point config.json at a path that does not exist so the loader falls back to
// SSH_REMOTE_JSON (the repo's real config.json must not leak into this test).
process.env.WEBSCP_CONFIG = path.join(os.tmpdir(), `webscp-noconfig-${process.pid}.json`);

const { resolveRef } = require('../dist/server/endpoints.js');

test('resolveRef maps an inventory ref (selector + sub) to an Endpoint', () => {
  // host targets connect directly; only smc carries the BMC jump.
  const ep = resolveRef({ source: 'inventory', selector: 'server1', sub: 'smc' });
  assert.strictEqual(ep.id, 'server1/smc');
  assert.strictEqual(ep.conn.host, '10.0.0.60');
  assert.ok(ep.jump);
  assert.strictEqual(ep.jump.host, '10.0.0.1');
});

test('resolveRef maps a bare inventory selector', () => {
  const ep = resolveRef({ source: 'inventory', selector: 'client' });
  assert.strictEqual(ep.id, 'client');
  assert.strictEqual(ep.conn.user, 'alice');
});

test('resolveRef maps an adhoc ref with jump', () => {
  const ep = resolveRef({
    source: 'adhoc',
    adhoc: { host: '9.9.9.9', user: 'me', password: 'pw', jump: { host: '8.8.8.8', user: 'gw' } },
  });
  assert.strictEqual(ep.conn.host, '9.9.9.9');
  assert.strictEqual(ep.conn.port, 22);
  assert.ok(ep.jump);
  assert.strictEqual(ep.jump.host, '8.8.8.8');
});

test('resolveRef rejects adhoc without host/user', () => {
  assert.throws(
    () => resolveRef({ source: 'adhoc', adhoc: { host: '', user: '' } }),
    /requires host and user/,
  );
});

test('resolveRef rejects inventory ref without selector', () => {
  assert.throws(() => resolveRef({ source: 'inventory' }), /requires a selector/);
});

test('cleanup', () => {
  fs.rmSync(invFile, { force: true });
});
