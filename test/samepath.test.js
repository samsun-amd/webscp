'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { SshPool, RemoteFs, TransferEngine } = require('@ssh-manager/core');

test('HTTP and WebSocket routes reject stale targets and self-copy across groups', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.WEBSCP_CONFIG = path.join(dir, 'app.json');
  process.env.SSHM_CONFIG_DIR = dir;
  process.env.WEBSCP_HOST = '127.0.0.1';
  fs.writeFileSync(process.env.WEBSCP_CONFIG, '{}');
  const node = (ip, remoteOs) => ({ type: 'client', name: 'same', ip, user: 'test', os: remoteOs });
  const write = (name, number, nodes) => fs.writeFileSync(path.join(dir, `ssh_remote_${name}.json`), JSON.stringify({ group_number: number, nodes }));
  write('default', 0, [node('192.0.2.1')]);
  write('alias', 1, [node('192.0.2.1')]);
  write('other', 2, [node('192.0.2.2')]);
  write('windows', 3, [node('192.0.2.3', 'windows')]);
  write('windows_alias', 4, [node('192.0.2.3', 'windows')]);

  // Exercise the actual routes and path guard without opening any SSH sockets.
  let transfers = 0;
  SshPool.prototype.withSession = async (ep, fn) => fn({ endpoint: ep, os: ep.os || 'posix' });
  RemoteFs.prototype.home = async () => '/home/test';
  TransferEngine.prototype.remoteToRemote = async () => { transfers++; };
  let server;
  const createServer = http.createServer;
  http.createServer = (...args) => {
    server = createServer(...args);
    const listen = server.listen;
    server.listen = (_port, host, callback) => listen.call(server, 0, host, callback);
    return server;
  };
  require('../dist/server/index');
  http.createServer = createServer;
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, body, method = 'POST') => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const catalog = await (await request('/api/endpoints', undefined, 'GET')).json();
  const ref = (group) => catalog.options.find((o) => o.group === group).ref;
  const transfer = async (src, dst) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    await once(ws, 'open');
    const messages = [];
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Transfer response timed out')), 3000);
        ws.on('error', reject);
        ws.on('message', (data) => {
          const msg = JSON.parse(data);
          messages.push(msg);
          if (msg.type === 'error' || msg.type === 'done') {
            clearTimeout(timer);
            resolve(messages);
          }
        });
        ws.send(JSON.stringify({ type: 'transfer', reqId: 'test', payload: { src, dst } }));
      });
    } finally { ws.terminate(); }
  };
  const src = { endpoint: ref('default'), path: '/home/test/data/./file' };
  let messages = await transfer(src, { endpoint: ref('alias'), dir: '/home/test/data' });
  assert.ok(messages.some((m) => m.type === 'job'));
  assert.match(messages.at(-1).message, /same path/);
  assert.equal(transfers, 0);
  messages = await transfer({ ...src, path: 'data/../data/file' }, { endpoint: ref('alias'), dir: '/home/test/data' });
  assert.match(messages.at(-1).message, /same path/);
  assert.equal(transfers, 0);
  messages = await transfer(src, { endpoint: ref('other'), dir: '/home/test/data' });
  assert.equal(messages.at(-1).type, 'done');
  assert.equal(transfers, 1, 'same node names on different connections must transfer');
  messages = await transfer({ endpoint: ref('windows'), path: 'C:/Data/Report.txt' }, { endpoint: ref('windows_alias'), dir: 'c:/data' });
  assert.match(messages.at(-1).message, /same path/);
  assert.equal(transfers, 1);

  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    const url = method === 'PUT' || method === 'DELETE' ? '/api/nodes/same' : '/api/nodes';
    assert.equal((await request(url, method === 'GET' ? undefined : {}, method)).status, 404);
  }
  const before = fs.readFileSync(path.join(dir, 'ssh_remote_default.json'), 'utf8');
  await request('/api/reload', {});
  assert.equal(fs.readFileSync(path.join(dir, 'ssh_remote_default.json'), 'utf8'), before);
  write('default', 0, [node('192.0.2.99')]);
  assert.equal((await request('/api/list', { endpoint: src.endpoint, path: '~' })).status, 409);
  messages = await transfer(src, { endpoint: ref('other'), dir: '/home/test/data' });
  assert.match(messages.at(-1).message, /Inventory changed/);
  assert.equal(transfers, 1);
  const payload = path.join(dir, 'payload');
  const destination = path.join(dir, 'copy');
  fs.writeFileSync(payload, 'preserve this payload');
  fs.mkdirSync(destination);
  messages = await transfer({ endpoint: { source: 'local' }, path: payload }, { endpoint: { source: 'local' }, dir: destination });
  assert.equal(messages.at(-1).type, 'done');
  assert.equal(fs.readFileSync(path.join(destination, 'payload'), 'utf8'), 'preserve this payload');
});
