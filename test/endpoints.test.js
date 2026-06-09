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

const { resolveRef } = require('../dist/server/endpoints.js');

test('resolveRef maps an inventory ref (selector + sub) to an Endpoint', () => {
  const ep = resolveRef({ source: 'inventory', selector: 'server1', sub: 'host1' });
  assert.strictEqual(ep.id, 'server1/host1');
  assert.strictEqual(ep.conn.host, '10.0.0.11');
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
