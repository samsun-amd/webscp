'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// Optional real-browser check: point these variables at existing browser tools.
test('browser: independent groups, reload safety, and persistent recent paths', {
  skip: !process.env.WEBSCP_BROWSER_MODULE || !process.env.WEBSCP_CHROME,
  timeout: 30000,
}, async (t) => {
  const puppeteer = require(process.env.WEBSCP_BROWSER_MODULE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscp-browser-'));
  let browser;
  let server;
  t.after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.WEBSCP_CONFIG = path.join(dir, 'app.json');
  process.env.SSHM_CONFIG_DIR = dir;
  process.env.WEBSCP_HOST = '127.0.0.1';
  fs.writeFileSync(process.env.WEBSCP_CONFIG, '{}');
  const nodes = [
    { type: 'client', name: 'first', ip: '192.0.2.1', user: 'test' },
    { type: 'client', name: 'second', ip: '192.0.2.2', user: 'test' },
  ];
  const write = (group, number, entries) => fs.writeFileSync(path.join(dir, `ssh_remote_${group}.json`), JSON.stringify({ group_number: number, nodes: entries }));
  write('default', 0, []);
  write('tw', 1, nodes);
  write('us', 2, nodes);
  const { SshPool, RemoteFs } = require('@ssh-manager/core');
  SshPool.prototype.withSession = async (ep, fn) => fn({ endpoint: ep, os: 'posix' });
  RemoteFs.prototype.home = async () => '/home/test';
  RemoteFs.prototype.list = async (cwd) => {
    if (cwd.endsWith('/missing')) throw new Error('not found');
    if (cwd.endsWith('/slow')) await new Promise((resolve) => setTimeout(resolve, 150));
    return [{ name: 'folder', path: `${cwd}/folder`, type: 'dir', size: 0, mtime: null, mode: 0 }];
  };
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
  browser = await puppeteer.launch({ executablePath: process.env.WEBSCP_CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app?.panes.right.listedRef);
  assert.equal(await page.$('#manage-btn'), null);
  await page.select('#pane-left .group-select', 'tw');
  await page.select('#pane-right .group-select', 'us');
  await page.waitForFunction(() => window.app.panes.left.listedRef?.group === 'tw' && window.app.panes.right.listedRef?.group === 'us');
  const second = await page.$eval('#pane-left .endpoint-select', (s) => [...s.options].find((o) => o.textContent.includes('second')).value);
  await page.select('#pane-left .endpoint-select', second);
  await page.waitForFunction(() => window.app.panes.left.listedRef?.selector === '2');

  const navigate = async (target) => {
    await page.$eval('#pane-left .path-input', (input, value) => { input.value = value; }, target);
    await page.click('#pane-left .go-btn');
    await page.waitForFunction((value) => window.app.panes.left.cwd === value && window.app.panes.left.listedRef, {}, target);
  };
  await navigate('/a');
  await navigate('/b');
  await page.select('#pane-left .path-history', '/a');
  await page.waitForFunction(() => window.app.panes.left.cwd === '/a' && window.app.panes.left.listedRef);
  const history = () => page.$$eval('#pane-left .path-history option', (items) => items.slice(1).map((o) => o.value));
  assert.deepEqual((await history()).slice(0, 2), ['/a', '/b']);
  assert.ok(!(await page.$$eval('#pane-right .path-history option', (items) => items.map((o) => o.value))).includes('/a'));

  // Reordering updates the selector while preserving the selected target and path.
  write('tw', 1, [...nodes].reverse());
  await page.click('#reload-btn');
  await page.waitForFunction(() => window.app.panes.left.listedRef?.selector === '1' && window.app.panes.left.cwd === '/a');
  assert.equal(await page.$eval('#pane-left .endpoint-select', (s) => s.value), second);
  assert.equal(await page.$eval('#pane-right .group-select', (s) => s.value), 'us');
  assert.deepEqual((await history()).slice(0, 2), ['/a', '/b']);

  // Invalid paths never enter history; old responses cannot replace a newer listing.
  await page.$eval('#pane-left .path-input', (input) => { input.value = '/missing'; });
  await page.click('#pane-left .go-btn');
  await page.waitForFunction(() => document.querySelector('#pane-left .pane-msg').textContent === 'not found');
  assert.ok(!(await history()).includes('/missing'));
  await page.evaluate(() => {
    const pane = window.app.panes.left;
    pane.pathInput.value = '/slow';
    pane.refresh(true);
    pane.pathInput.value = '/fast';
    return pane.refresh(true);
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await page.evaluate(() => window.app.panes.left.cwd), '/fast');
  assert.ok(!(await history()).includes('/slow'));

  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.listedRef);
  await page.select('#pane-left .group-select', 'tw');
  await page.waitForFunction(() => window.app.panes.left.listedRef?.group === 'tw');
  assert.ok((await history()).includes('/a'));
  await page.select('#pane-left .path-history', '/a');
  await page.waitForFunction(() => window.app.panes.left.cwd === '/a' && window.app.panes.left.listedRef);
  assert.equal((await history())[0], '/a');

  // Auto-discovery preserves the other pane, and deletion clears stale files.
  write('extra', 3, nodes);
  await page.waitForFunction(() => [...document.querySelector('#pane-left .group-select').options].some((o) => o.value === 'extra'), { timeout: 7000 });
  fs.unlinkSync(path.join(dir, 'ssh_remote_tw.json'));
  await page.click('#reload-btn');
  await page.waitForFunction(() => window.app.panes.left.currentRef() === null);
  assert.equal(await page.$$eval('#pane-left .file-list li', (items) => items.length), 0);
  assert.equal(await page.$eval('#pane-left .path-history', (s) => s.disabled), true);
  assert.ok(await page.$('#pane-left .path-input'));
  const visible = await page.$$eval('.pane-head input, .pane-head select, .pane-head button', (items) => items.every((item) => {
    const box = item.getBoundingClientRect();
    const pane = item.closest('.pane').getBoundingClientRect();
    return box.width > 0 && box.left >= pane.left && box.right <= pane.right;
  }));
  assert.ok(visible, 'pane controls must remain visible and inside their pane');
  const fallback = await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    try {
      PathHistory.remember('storage-test', '/first');
      PathHistory.remember('storage-test', '/second');
      return PathHistory.read('storage-test');
    } finally { Storage.prototype.setItem = original; }
  });
  assert.deepEqual(fallback, ['/second', '/first']);
  const secretFree = await page.evaluate(() => Pane.prototype.historyKey.call({
    select: { value: 'adhoc' },
    adhocRef: { adhoc: { host: 'example', user: 'user', password: 'PRIVATE_SENTINEL', jump: { host: 'jump', user: 'root', password: 'JUMP_SENTINEL' } } },
  }));
  assert.doesNotMatch(secretFree, /PRIVATE_SENTINEL|JUMP_SENTINEL/);
  assert.deepEqual(errors, []);
});
