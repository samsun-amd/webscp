'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ssh-manager', 'shared', 'inventory-conformance.json'))).inventory;

test('groups remain independent, reflect external edits, and reject stale references', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-groups-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.SSHM_CONFIG_DIR = dir;
  const { inventoryCatalog, resolveRef, connectionIdentity } = require('../dist/server/endpoints');
  const write = (name, number, nodes) => fs.writeFileSync(path.join(dir, `ssh_remote_${name}.json`), JSON.stringify({ group_number: number, nodes }));
  const client = (ip) => ({ type: 'client', name: 'same', ip, user: 'test', pass: 'PRIVATE_SENTINEL' });
  write('default', 0, fixture);
  write('tw', 1, [client('192.0.2.1'), client('192.0.2.2'), client('192.0.2.2')]);
  write('us', 1, [client('192.0.2.3')]);
  write('empty', 3, []);
  write('badzero', 0, []);
  write('smc', 4, [
    { type: 'smc', name: 'smc', ip: '192.0.2.4', user: 'test' },
    { type: 'unknown', name: 'unsupported' },
  ]);
  fs.writeFileSync(path.join(dir, 'ssh_remote_broken.json'), '{"pass":"PRIVATE_SENTINEL"');
  fs.writeFileSync(path.join(dir, 'ssh_remote_legacy.json'), JSON.stringify(fixture));
  fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');

  const catalog = inventoryCatalog();
  assert.equal(catalog.groups.length, 8);
  assert.ok(catalog.groups.find((g) => g.name === 'badzero').error);
  assert.ok(catalog.groups.find((g) => g.name === 'broken').error);
  assert.match(catalog.groups.find((g) => g.name === 'legacy').error, /convert legacy/);
  assert.ok(catalog.warnings.some((w) => /Duplicate group number/.test(w)));
  assert.ok(!catalog.warnings.some((w) => /smc \/ node 1:/.test(w)));
  assert.ok(catalog.warnings.some((w) => /smc \/ node 2: unsupported node type/.test(w)));
  assert.equal(catalog.options.filter((o) => o.group === 'smc').length, 0);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_SENTINEL|"password"|"pass"/);
  const tw = catalog.options.filter((o) => o.group === 'tw');
  assert.equal(new Set(tw.map((o) => o.key)).size, 3);
  const us = catalog.options.find((o) => o.group === 'us');
  assert.notEqual(tw[0].key, tw[1].key);
  assert.notEqual(tw[0].key, us.key);
  assert.equal(resolveRef(tw[1].ref).conn.host, '192.0.2.2');
  assert.equal(resolveRef(us.ref).conn.host, '192.0.2.3');
  assert.equal(resolveRef(us.ref).id, 'us/same');
  const smc = catalog.options.find((o) => o.group === 'default' && o.ref.sub === 'smc');
  assert.ok(resolveRef(smc.ref).jump);
  const host = catalog.options.find((o) => o.group === 'default' && o.ref.sub === 'host1');
  assert.equal(resolveRef(host.ref).jump, undefined);

  write('tw', 1, [client('192.0.2.2'), client('192.0.2.1')]);
  assert.throws(() => resolveRef(tw[0].ref), /Inventory changed/);
  const refreshed = inventoryCatalog().options.find((o) => o.key === tw[0].key);
  assert.equal(refreshed.ref.selector, '2');
  assert.equal(resolveRef(refreshed.ref).conn.host, '192.0.2.1');
  write('tw', 1, []);
  assert.equal(inventoryCatalog().options.filter((o) => o.group === 'tw').length, 0);
  fs.unlinkSync(path.join(dir, 'ssh_remote_us.json'));
  assert.throws(() => resolveRef(us.ref), /unavailable/);
  assert.throws(() => resolveRef({ ...tw[0].ref, group: '../outside' }), /unavailable/);
  assert.throws(() => resolveRef({ source: 'inventory', selector: '1' }), /group, selector, and revision/);

  const direct = resolveRef({ source: 'adhoc', adhoc: { host: '192.0.2.1', user: 'test' } });
  assert.equal(connectionIdentity(direct), connectionIdentity({ ...direct, id: 'other/group' }));
  const jumped = resolveRef({ source: 'adhoc', adhoc: { host: '192.0.2.1', user: 'test', jump: { host: '192.0.2.9', user: 'root' } } });
  assert.notEqual(connectionIdentity(direct), connectionIdentity(jumped));
  assert.throws(() => resolveRef({ source: 'adhoc', adhoc: { host: '', user: '' } }), /requires host and user/);
  for (const port of [0, -1, 1.5, 65536, '22']) {
    assert.throws(() => resolveRef({ source: 'adhoc', adhoc: { host: 'example', user: 'test', port } }), /integer port/);
  }
});
