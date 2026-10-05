'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Server response timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function start(t, settings = {}, host = '127.0.0.1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-boundary-'));
  const config = path.join(dir, 'app.json');
  fs.writeFileSync(config, JSON.stringify({ server: settings }));
  fs.writeFileSync(path.join(dir, 'ssh_remote_default.json'), JSON.stringify({
    group_number: 0, nodes: [{ type: 'client', name: 'synthetic', ip: '192.0.2.1', user: 'test' }],
  }));
  fs.writeFileSync(path.join(dir, 'source.txt'), 'isolated transfer contents');
  fs.mkdirSync(path.join(dir, 'destination'));
  // Run real callbacks in a child; observe jobs and stub SSH only in the test process.
  const child = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const { SshPool, RemoteFs, TransferEngine } = require('@ssh-manager/core');
    let poolCalls = 0, allocations = 0, jobMap;
    const set = Map.prototype.set;
    Map.prototype.set = function(key, value) {
      if (typeof key === 'string' && key.startsWith('job-') && value instanceof AbortController) {
        jobMap = this; allocations++;
      }
      return set.call(this, key, value);
    };
    SshPool.prototype.withSession = async (ep, fn) => {
      poolCalls++;
      return fn({ endpoint: ep, os: 'posix' });
    };
    RemoteFs.prototype.home = async () => '/home/test';
    TransferEngine.prototype.remoteToHub = async (_session, source, _dest, opts) => {
      if (source.endsWith('/wait')) return new Promise((_, reject) => {
        const cancel = () => reject(new Error('Transfer cancelled'));
        if (opts.signal.aborted) cancel();
        else opts.signal.addEventListener('abort', cancel, { once: true });
        process.send({ waiting: true });
      });
      throw new Error('Synthetic transfer failure');
    };
    process.on('message', () => process.send({ poolCalls, allocations, jobs: jobMap?.size || 0 }));
    const createServer = http.createServer;
    http.createServer = (...args) => {
      const server = createServer(...args), listen = server.listen;
      server.listen = (_port, host, callback) => listen.call(server, 0, host, () => {
        callback(); process.send({ port: server.address().port });
      });
      return server;
    };
    require('./dist/server/index');
  `], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, WEBSCP_CONFIG: config, SSHM_CONFIG_DIR: dir, WEBSCP_HOST: host, WEBSCP_PORT: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
      try { await exited; } finally { clearTimeout(timer); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ready = await bounded(Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(([code]) => ({ exitCode: code })),
  ]));
  const base = `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${ready.port}`;
  const connect = async (headers = { Origin: base }) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers });
    sockets.push(ws);
    ws.on('error', () => {});
    const result = await bounded(new Promise(resolve => {
      ws.once('open', () => resolve(101));
      ws.once('unexpected-response', (_req, response) => {
        response.resume(); ws.terminate(); resolve(response.statusCode);
      });
      ws.once('error', error => resolve(error.message));
    }));
    return { ws, status: result };
  };
  return {
    dir, config, base, child, ready, connect, stderr: () => stderr,
    stats: async () => {
      const response = once(child, 'message'); child.send('stats');
      return (await bounded(response))[0];
    },
    transfer: (extra = {}) => ({ type: 'transfer', reqId: 'test', payload: {
      src: { endpoint: { source: 'local' }, path: path.join(dir, 'source.txt') },
      dst: { endpoint: { source: 'local' }, dir: path.join(dir, 'destination') },
    }, ...extra }),
  };
}

function exchange(ws, input, stop = msg => msg.type === 'done' || msg.type === 'error') {
  const messages = [];
  let listener;
  const response = new Promise(resolve => {
    listener = data => {
      const msg = JSON.parse(data); messages.push(msg);
      if (stop(msg)) resolve(messages);
    };
    ws.on('message', listener);
    ws.send(typeof input === 'string' ? input : JSON.stringify(input));
  });
  return bounded(response).finally(() => ws.off('message', listener));
}

test('Origin and Host policy protects WebSocket upgrades and HTTP POST handlers', async t => {
  const server = await start(t);
  for (const origin of [server.base, server.base.replace('127.0.0.1', 'localhost')]) {
    const { ws, status } = await server.connect({ Origin: origin });
    assert.equal(status, 101); ws.terminate();
  }
  const denied = [
    {}, { Origin: 'null' }, { Origin: 'not-an-origin' },
    { Origin: 'https://untrusted.example.invalid' },
    { Origin: server.base.replace('http:', 'https:') },
    { Origin: 'http://127.0.0.1:1' },
    { Origin: server.base + '/' }, { Origin: server.base + '?query' },
    { Origin: server.base, Host: 'untrusted.example.invalid' },
    { Origin: 'http://untrusted.example.invalid', Host: 'untrusted.example.invalid' },
    { Origin: 'https://untrusted.example.invalid', 'X-Forwarded-Host': '127.0.0.1', 'X-Forwarded-Proto': 'http' },
  ];
  for (const headers of denied) assert.equal((await server.connect(headers)).status, 403, JSON.stringify(headers));
  const target = path.join(server.dir, 'must-not-exist');
  for (const route of ['reload', 'connect-test', 'list', 'mkdir', 'delete']) {
    const response = await fetch(server.base + '/api/' + route, {
      method: 'POST', headers: { Origin: 'https://untrusted.example.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: { source: 'local' }, path: target }),
    });
    assert.equal(response.status, 403, route);
  }
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://untrusted.example.invalid' }]) {
    const response = await fetch(server.base + '/api/reload', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
    });
    assert.equal(response.status, 403);
  }
  assert.equal(fs.existsSync(target), false);
  assert.equal((await server.stats()).poolCalls, 0);
  const allowed = await fetch(server.base + '/api/mkdir', {
    method: 'POST', headers: { Origin: server.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: { source: 'local' }, path: target }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test('explicit origins replace defaults and support a Host-preserving proxy', async t => {
  const server = await start(t, { allowedOrigins: ['https://files.example.invalid'] }, '0.0.0.0');
  assert.equal((await server.connect()).status, 403);
  const headers = { Origin: 'https://files.example.invalid', Host: 'files.example.invalid' };
  // Native HTTP preserves an explicit Host; Node fetch replaces it with the URL authority.
  const reload = () => bounded(new Promise((resolve, reject) => {
    const req = http.request(server.base + '/api/reload', { method: 'POST', headers }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject); req.end();
  }));
  assert.equal((await server.connect(headers)).status, 101);
  assert.equal((await server.connect({ ...headers, Host: '127.0.0.1', 'X-Forwarded-Host': headers.Host })).status, 403);
  assert.equal((await server.connect({ ...headers, Origin: 'http://files.example.invalid' })).status, 403);
  assert.equal(await reload(), 200);
  // Origin policy is fixed at startup, like the bind settings.
  fs.writeFileSync(server.config, JSON.stringify({ server: { allowedOrigins: ['https://changed.example.invalid'] } }));
  assert.equal(await reload(), 200);
  assert.equal((await server.connect(headers)).status, 101);
  assert.equal((await server.connect({ Origin: 'https://changed.example.invalid', Host: 'changed.example.invalid' })).status, 403);
});

test('IPv6 loopback uses its listening authority and an empty allowlist denies access', async t => {
  const ipv6 = await start(t, {}, '::1');
  assert.equal((await ipv6.connect()).status, 101);
  assert.equal((await ipv6.connect({ Origin: 'http://[::1]:1' })).status, 403);
  const empty = await start(t, { allowedOrigins: [] });
  assert.equal((await empty.connect()).status, 403);
  assert.equal((await fetch(empty.base + '/api/reload', { method: 'POST', headers: { Origin: empty.base } })).status, 403);
});

test('invalid Origin configuration prevents startup', async t => {
  for (const allowedOrigins of [null, '*', [1], ['*'], ['https://*.example.invalid'],
    ['https://example.invalid/'], ['https://user@example.invalid'], ['https://example.invalid?q'],
    ['https://example.invalid#'], ['file:///tmp'], ['null'], [' https://example.invalid']]) {
    await t.test(JSON.stringify(allowedOrigins), async sub => {
      const server = await start(sub, { allowedOrigins });
      assert.equal(server.ready.exitCode, 1);
      assert.match(server.stderr(), /allowedOrigins/);
    });
  }
});

test('malformed requests allocate no jobs or SSH sessions; valid requests recover', async t => {
  const server = await start(t);
  const { ws, status } = await server.connect();
  assert.equal(status, 101);
  const catalog = await (await fetch(server.base + '/api/endpoints')).json();
  const inventory = catalog.options.find(option => option.group === 'default').ref;
  const bad = ['{', 'null', '[]', '42', 'true', '"text"', '{}', '{"type":"unknown"}',
    { type: 'cancel' }, { type: 'cancel', id: {} }, { type: 'cancel', id: '' },
    { type: 'transfer' }, { type: 'transfer', payload: null }, server.transfer({ reqId: undefined }),
    server.transfer({ reqId: 1 }), server.transfer({ payload: [] })];
  for (const [field, values] of [['recursive', [null, 'false', 0]], ['src', [null, [], {}]], ['dst', [null, [], {}]]]) {
    for (const value of values) { const msg = server.transfer(); msg.payload[field] = value; bad.push(msg); }
  }
  for (const name of ['', '.', '..', '../escape', 'nested/file', 'nested\\file', 'file\0', 1, null]) {
    const msg = server.transfer(); msg.payload.dst.name = name; bad.push(msg);
  }
  for (const [side, field] of [['src', 'path'], ['dst', 'dir']]) {
    for (const value of ['', null, 7, '/path\0suffix']) {
      const msg = server.transfer(); msg.payload[side][field] = value; bad.push(msg);
    }
  }
  const adhoc = { source: 'adhoc', adhoc: { host: '192.0.2.1', user: 'test' } };
  const endpoints = [null, [], {}, 'local', { source: 'unknown' },
    { source: 'inventory', selector: '1' }, { ...inventory, selector: 1 },
    { ...inventory, sub: false }, { ...inventory, sub: 'host0' }, { ...inventory, revision: 'stale' },
    ...[null, [], {}, { host: 1, user: 'test' }, { host: 'host', user: '' }].map(value => ({ source: 'adhoc', adhoc: value }))];
  for (const [field, value] of [['password', {}], ['os', 'unknown'], ['port', 0], ['port', '22'],
    ['port', 1.5], ['port', 65536], ['jump', false], ['jump', null], ['jump', {}],
    ['jump', { host: 'jump', user: 'test', password: [] }], ['host', 'host\0'], ['user', 'user\0']]) {
    endpoints.push({ ...adhoc, adhoc: { ...adhoc.adhoc, [field]: value } });
  }
  for (const endpoint of endpoints) {
    for (const side of ['src', 'dst']) {
      const msg = server.transfer(); msg.payload[side].endpoint = endpoint; bad.push(msg);
    }
  }
  for (const input of bad) {
    const messages = await exchange(ws, input);
    assert.deepEqual(messages.map(msg => [msg.type, msg.id]), [['error', '']], JSON.stringify(input));
  }
  assert.deepEqual(await server.stats(), { poolCalls: 0, allocations: 0, jobs: 0 });
  assert.deepEqual(fs.readdirSync(path.join(server.dir, 'destination')), []);
  const messages = await exchange(ws, server.transfer());
  assert.equal(messages.at(-1).type, 'done');
  assert.equal(fs.readFileSync(path.join(server.dir, 'destination/source.txt'), 'utf8'), 'isolated transfer contents');
  assert.deepEqual(await server.stats(), { poolCalls: 0, allocations: 1, jobs: 0 });
  const failure = server.transfer(); failure.payload.src.path = path.join(server.dir, 'missing');
  assert.match((await exchange(ws, failure)).at(-1).message, /ENOENT/);
  assert.equal((await server.stats()).jobs, 0);
  const remote = server.transfer(); remote.payload.src = { endpoint: inventory, path: '/wait' };
  const waiting = once(server.child, 'message');
  const job = (await exchange(ws, remote, msg => msg.type === 'job')).at(-1);
  assert.equal((await bounded(waiting))[0].waiting, true);
  assert.equal((await server.stats()).jobs, 1);
  assert.match((await exchange(ws, { type: 'cancel', id: job.id })).at(-1).message, /cancelled/);
  assert.equal((await server.stats()).jobs, 0);
  remote.payload.src.path = '/fail';
  assert.match((await exchange(ws, remote)).at(-1).message, /Synthetic transfer failure/);
  assert.equal((await server.stats()).jobs, 0);
});

test('invalid UTF-8 and oversized frame headers close only the offending connection', async t => {
  const server = await start(t);
  const survivor = (await server.connect()).ws;
  for (const kind of ['utf8', 'size']) {
    const { ws } = await server.connect();
    const closed = once(ws, 'close');
    if (kind === 'utf8') ws.send(Buffer.from([0xff]), { binary: false });
    else {
      const header = Buffer.alloc(14); header[0] = 0x81; header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2);
      ws._socket.write(header);
    }
    const [code] = await bounded(closed);
    assert.equal(code, kind === 'utf8' ? 1007 : 1009);
    assert.equal(server.child.exitCode, null, server.stderr());
    assert.equal((await exchange(survivor, server.transfer())).at(-1).type, 'done');
    const replacement = await server.connect();
    assert.equal(replacement.status, 101);
    assert.equal((await exchange(replacement.ws, server.transfer())).at(-1).type, 'done');
    replacement.ws.terminate();
  }
});
