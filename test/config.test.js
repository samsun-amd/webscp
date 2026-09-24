'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('config precedence, group files, and deleting the last inline node', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.WEBSCP_CONFIG = path.join(dir, 'config.json');
  process.env.SSHM_CONFIG_DIR = dir;
  delete process.env.SSH_REMOTE_JSON;
  const cfg = require('../dist/server/config');
  const store = require('../dist/server/configstore');
  const node = { type: 'client', name: 'example', ip: '192.0.2.1', user: 'test' };
  const external = path.join(dir, 'ssh_remote_default.json');
  fs.writeFileSync(external, JSON.stringify({ group_number: 0, nodes: [node] }));
  const configure = (value) => {
    fs.writeFileSync(process.env.WEBSCP_CONFIG, JSON.stringify(value));
    cfg.reloadConfig();
  };

  configure({});
  assert.equal(cfg.inventorySourceLabel(), external);
  assert.deepEqual(cfg.loadInventory().raw(), [node]);
  configure({ inventoryPath: external });
  assert.deepEqual(cfg.loadInventory().raw(), [node]);
  configure({ inventory: [], inventoryPath: '/missing.json' });
  assert.deepEqual(cfg.loadInventory().raw(), []);
  assert.match(cfg.inventorySourceLabel(), /\(inline\)$/);
  configure({ inventory: [node] });
  store.deleteNode(node.name);
  assert.deepEqual(store.listNodesRedacted(), []);
  assert.deepEqual(cfg.loadInventory().raw(), []);

  configure({});
  fs.writeFileSync(external, JSON.stringify([node]));
  assert.throws(() => cfg.loadInventory(), /convert legacy arrays/);
  assert.throws(() => configure({ inventory: {} }), /inventory must be an array/);
});
