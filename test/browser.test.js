'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// Optional real-browser check: point these variables at existing browser tools.
test('browser: SCP tabs, workspace restore, independent groups, and persistent recent paths', {
  skip: !process.env.WEBSCP_BROWSER_MODULE || !process.env.WEBSCP_CHROME,
  timeout: 60000,
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
  let unavailableHost;
  SshPool.prototype.withSession = async (ep, fn) => {
    if (ep.conn.host === unavailableHost) throw new Error('connection refused');
    return fn({ endpoint: ep, os: 'posix' });
  };
  RemoteFs.prototype.home = async () => '/home/test';
  let listCalls = 0;
  RemoteFs.prototype.list = async (cwd) => {
    listCalls += 1;
    if (cwd.endsWith('/missing')) throw new Error('not found');
    if (cwd.endsWith('/slow')) await new Promise((resolve) => setTimeout(resolve, 150));
    return [{ name: 'folder', path: `${cwd}/folder`, type: 'dir', size: 0, mtime: null, mode: 0 }];
  };
  const startServer = async (port = 0) => {
    const createServer = http.createServer;
    http.createServer = (...args) => {
      server = createServer(...args);
      const listen = server.listen;
      server.listen = (_port, host, callback) => listen.call(server, port, host, callback);
      return server;
    };
    try { require('../dist/server/index'); } finally { http.createServer = createServer; }
    await once(server, 'listening');
  };
  await startServer();
  const launch = () => puppeteer.launch({ executablePath: process.env.WEBSCP_CHROME,
    userDataDir: path.join(dir, 'browser-profile'), headless: true, args: ['--no-sandbox'] });
  browser = await launch();
  const errors = [];
  const requests = [];
  const url = `http://127.0.0.1:${server.address().port}`;
  const openPage = async () => {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1280, height: 900 });
    tab.on('pageerror', (e) => errors.push(e.message));
    tab.on('request', (req) => {
      if (req.url() === `${url}/api/list`) requests.push(JSON.parse(req.postData()));
    });
    await tab.goto(url);
    return tab;
  };
  let page = await openPage();
  const savedTabs = () => page.evaluate(() => JSON.parse(localStorage.getItem('webscp.workspace.v2')));
  const workspace = async () => {
    const saved = await savedTabs();
    const { left, right } = saved.tabs.find((tab) => tab.id === saved.activeTabId);
    return { left, right };
  };
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app?.panes.right.listedRef);
  const tabLabel = (id = 1) => page.$eval(`#workspace-tab-${id}`, (tab) => tab.textContent);
  assert.equal(await tabLabel(), `localhost:${path.basename(os.homedir())} <-> localhost:${path.basename(os.homedir())}`);
  assert.equal(await page.$('#manage-btn'), null);
  await page.select('#pane-left .group-select', 'tw');
  await page.select('#pane-right .group-select', 'us');
  await page.waitForFunction(() => window.app.panes.left.listedRef?.group === 'tw' && window.app.panes.right.listedRef?.group === 'us');
  const second = await page.$eval('#pane-left .endpoint-select', (s) => [...s.options].find((o) => o.textContent.includes('second')).value);
  await page.select('#pane-left .endpoint-select', second);
  await page.waitForFunction(() => window.app.panes.left.listedRef?.selector === '2');

  const navigate = async (target, side = 'left') => {
    await page.$eval(`#pane-${side} .path-input`, (input, value) => { input.value = value; }, target);
    await page.click(`#pane-${side} .go-btn`);
    await page.waitForFunction((value, name) => window.app.panes[name].cwd === value && window.app.panes[name].listedRef, {}, target, side);
  };
  const originalTab = await page.$('#workspace-tab-1');
  await navigate('/');
  assert.ok(await originalTab.evaluate((tab) => tab.isConnected), 'Updating a label must preserve the tab button');
  await originalTab.dispose();
  assert.equal(await tabLabel(), 'second:/ <-> first:test');
  await navigate('/build/output files');
  assert.equal(await tabLabel(), 'second:output files <-> first:test');
  assert.equal(await page.$eval('#workspace-tab-1', (tab) => tab.title), 'second:/build/output files <-> first:/home/test');
  await navigate('/a');
  await navigate('/b');
  const choosePath = async (value) => {
    await page.click('#pane-left .path-history-toggle');
    await page.click(`#pane-left .path-choice[value="${value}"]`);
  };
  await choosePath('/a');
  await page.waitForFunction(() => window.app.panes.left.cwd === '/a' && window.app.panes.left.listedRef);
  const history = (side = 'left') => page.$$eval(`#pane-${side} .path-choice`, (items) => items.map((o) => o.value));
  assert.deepEqual((await history()).slice(0, 2), ['/a', '/b']);
  assert.ok(!(await history('right')).includes('/a'));

  // A new browser tab restores each pane before making any default Local request.
  await navigate('/right', 'right');
  assert.equal(await tabLabel(), 'second:a <-> first:right');
  const initialWorkspace = await workspace();
  assert.deepEqual(Object.keys(initialWorkspace.left).sort(), ['cwd', 'endpointKey', 'group']);
  await page.close();
  requests.length = 0;
  page = await openPage();
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app.panes.right.listedRef);
  assert.deepEqual(await workspace(), initialWorkspace);
  assert.deepEqual(requests.map((r) => [r.endpoint.group, r.path]), [['tw', '/a'], ['us', '/right']]);
  assert.equal(await page.$eval('#pane-left .endpoint-select', (s) => s.value), second);
  assert.equal(await page.evaluate(() => window.app.panes.right.cwd), '/right');
  assert.equal(await tabLabel(), 'second:a <-> first:right');

  // Each SCP tab owns both panes; inactive responses save only their own paths.
  await page.click('#new-tab-btn');
  await page.waitForFunction(() => window.app.panes.left.listedRef?.source === 'local' && window.app.panes.right.listedRef);
  await page.select('#pane-left .group-select', 'us');
  await page.waitForFunction(() => window.app.panes.left.listedRef?.group === 'us');
  await navigate('/tab-two-left');
  await navigate(dir, 'right');
  await page.evaluate(async () => {
    const pane = window.app.panes.left;
    pane.pathInput.value = '/slow';
    const pending = pane.refresh(true);
    window.app.activateTab(1, true);
    await pending;
  });
  assert.equal((await savedTabs()).tabs[1].left.cwd, '/slow');
  assert.deepEqual(await workspace(), initialWorkspace);
  await page.click('#workspace-tab-2');
  await page.waitForFunction(() => window.app.panes.left.listedRef && window.app.panes.left.cwd === '/slow');
  await navigate('/tab-two-left');
  const twoTabs = await savedTabs();
  assert.equal(twoTabs.activeTabId, 2);
  assert.equal(twoTabs.tabs.length, 2);

  // Closing the browser tab or the entire browser restores the same tab set.
  await page.close();
  page = await openPage();
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app.panes.right.listedRef);
  assert.deepEqual(await savedTabs(), twoTabs);
  assert.equal(await page.evaluate(() => window.app.activeTabId), 2);
  await browser.close();
  browser = await launch();
  // Chrome may reopen old pages from the profile; close them before the new page.
  await Promise.all((await browser.pages()).map((tab) => tab.close()));
  requests.length = 0;
  page = await openPage();
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app.panes.right.listedRef);
  assert.deepEqual(await savedTabs(), twoTabs);
  assert.deepEqual(requests.map((r) => r.path), ['/tab-two-left', dir]);
  assert.equal(await page.$$eval('[role="tab"]', (tabs) => tabs.length), 2);
  assert.equal(await page.$eval('[role="tab"][aria-selected="true"]', (tab) => tab.id), 'workspace-tab-2');
  assert.equal(await tabLabel(), 'second:a <-> first:right');
  assert.equal(await tabLabel(2), `first:tab-two-left <-> localhost:${path.basename(dir)}`);

  // Keyboard switching restores the inactive tab; popovers and DOM IDs stay unique.
  await page.focus('#workspace-tab-2');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => window.app.panes.left.listedRef && window.app.panes.left.cwd === '/a');
  assert.deepEqual(await workspace(), initialWorkspace);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'workspace-tab-1');
  await page.click('#pane-left .path-history-toggle');
  await page.click('#workspace-tab-2');
  assert.equal(await page.$(':popover-open'), null);
  assert.equal(await page.$$eval('#pane-left', (panes) => panes.length), 1);
  await page.keyboard.press('Home');
  await page.waitForFunction(() => window.app.panes.left.listedRef && window.app.panes.right.listedRef);

  // Transfers retain their original destination and shared queue when switching.
  const transfer = await page.evaluate(async () => {
    const app = window.app;
    const sent = [];
    const send = app.ws.send;
    app.ws.send = (data) => sent.push(JSON.parse(data));
    try {
      const source = { endpoint: app.panes.left.listedRef, path: '/a/item.txt' };
      const pending = app.onDrop(source, app.panes.right);
      app.onWsMessage({ type: 'job', id: 'tab-transfer', label: 'Tab transfer', mode: 'relay' });
      app.activateTab(2, true);
      await pending;
      return sent;
    } finally { app.ws.send = send; }
  });
  assert.equal(transfer.length, 1);
  assert.equal(transfer[0].payload.dst.dir, '/right');
  assert.equal(transfer[0].payload.dst.endpoint.group, 'us');
  assert.ok(await page.$('#tab-transfer .job-cancel'));
  await page.waitForFunction(() => window.app.panes.left.listedRef && window.app.panes.right.listedRef);

  // Closing an inactive tab must not cancel navigation in the active tab.
  await page.click('#new-tab-btn');
  await page.click('#workspace-tab-2');
  await page.waitForFunction(() => window.app.panes.left.listedRef);
  await page.evaluate(async () => {
    const pane = window.app.panes.left;
    pane.pathInput.value = '/slow';
    const pending = pane.refresh(true);
    window.app.closeTab(3);
    await pending;
  });
  assert.equal((await savedTabs()).activeTabId, 2);
  assert.equal((await savedTabs()).tabs.length, 2);
  assert.equal((await workspace()).left.cwd, '/slow');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'workspace-tab-2');

  // Closing a tab invalidates pending responses without cancelling queued transfers.
  await page.evaluate(async () => {
    const pane = window.app.panes.left;
    pane.pathInput.value = '/slow';
    const pending = pane.refresh(true);
    window.app.closeTab(2);
    await pending;
  });
  assert.equal((await savedTabs()).tabs.length, 1);
  assert.deepEqual(await workspace(), initialWorkspace);
  assert.ok(await page.$('#tab-transfer .job-cancel'));
  await page.evaluate(() => window.app.onWsMessage({ type: 'done', id: 'tab-transfer' }));
  assert.ok(await page.$('#tab-transfer.job-done'));
  assert.equal(await page.$eval('.tab-close', (button) => button.disabled), true);
  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app.panes.right.listedRef);
  assert.equal(await page.$$eval('[role="tab"]', (tabs) => tabs.length), 1);

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
  assert.equal((await workspace()).left.cwd, '/a');
  assert.equal(await tabLabel(), 'second:a <-> first:right');
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
  assert.equal((await workspace()).left.cwd, '/fast');
  assert.equal(await tabLabel(), 'second:fast <-> first:right');

  // Native popover supports keyboard access, Escape, and outside dismissal.
  await page.focus('#pane-left .path-history-toggle');
  await page.keyboard.press('Enter');
  assert.ok(await page.$('#left-path-history:popover-open'));
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'path-choice');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'path-remove');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('#left-path-history:popover-open'), null);
  assert.equal(await page.evaluate(() => document.activeElement.className), 'path-history-toggle');
  await page.click('#pane-left .path-history-toggle');
  await page.click('#pane-left .path-input');
  assert.equal(await page.$('#left-path-history:popover-open'), null);

  // Removing a path syncs both panes without navigating or changing other entries.
  await page.select('#pane-right .group-select', 'tw');
  await page.waitForFunction(() => window.app.panes.right.listedRef?.group === 'tw');
  assert.deepEqual(await history('right'), await history());
  const beforeRemoval = await history();
  const beforeListCalls = listCalls;
  await page.click('#pane-left .path-history-toggle');
  await page.click('#pane-left .path-remove[aria-label="Remove /b from recent paths"]');
  assert.deepEqual(await history(), beforeRemoval.filter((p) => p !== '/b'));
  assert.deepEqual(await history('right'), await history());
  assert.equal(listCalls, beforeListCalls);
  assert.equal(await page.evaluate(() => window.app.panes.left.cwd), '/fast');
  assert.equal(await page.evaluate(() => window.app.panes.right.cwd), '/home/test');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'path-remove');

  // Restart the server and reorder inventory while the tab is closed. The two
  // panes use one endpoint but must retain independent paths and fresh refs.
  const beforeRestart = await workspace();
  const historyBeforeRestart = await history();
  const oldRevision = await page.evaluate(() => window.app.panes.left.listedRef.revision);
  await page.$eval('#pane-left .path-input', (input) => { input.value = '/unsubmitted'; });
  await page.close();
  const port = server.address().port;
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  delete require.cache[require.resolve('../dist/server/index')];
  delete require.cache[require.resolve('../dist/server/endpoints')];
  write('tw', 1, nodes);
  await startServer(port);
  requests.length = 0;
  page = await openPage();
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app.panes.right.listedRef);
  assert.deepEqual(await workspace(), beforeRestart);
  assert.deepEqual(await history(), historyBeforeRestart);
  assert.deepEqual(requests.map((r) => [r.endpoint.selector, r.path]), [['2', '/fast'], ['2', '/home/test']]);
  assert.notEqual(await page.evaluate(() => window.app.panes.left.listedRef.revision), oldRevision);
  assert.equal(await page.$eval('#pane-left .endpoint-select', (s) => s.value), second);
  assert.equal(await page.evaluate(() => window.app.panes.right.cwd), '/home/test');
  assert.ok((await history()).includes('/a'));
  assert.ok(!(await history()).includes('/b'), 'history removal must survive page reload');
  await choosePath('/a');
  await page.waitForFunction(() => window.app.panes.left.cwd === '/a' && window.app.panes.left.listedRef);
  assert.equal((await history())[0], '/a');

  // Removing the current path or the last entry leaves the listing intact.
  const beforeClearCalls = listCalls;
  await page.click('#pane-left .path-history-toggle');
  while ((await history()).length) await page.click('#pane-left .path-remove');
  assert.equal(listCalls, beforeClearCalls);
  assert.equal(await page.evaluate(() => window.app.panes.left.cwd), '/a');
  assert.ok(await page.$('#pane-left .file-list li'));
  assert.equal(await page.$('#left-path-history:popover-open'), null);
  assert.equal(await page.$eval('#pane-left .path-history-toggle', (s) => s.disabled), true);
  assert.equal(await page.evaluate(() => document.activeElement.className), 'path-input');
  await navigate('/again');
  assert.deepEqual(await history(), ['/again']);
  assert.equal(await page.$eval('#pane-left .path-history-toggle', (s) => s.disabled), false);

  // Auto-discovery preserves the other pane, and deletion clears stale files.
  write('extra', 3, nodes);
  await page.waitForFunction(() => [...document.querySelector('#pane-left .group-select').options].some((o) => o.value === 'extra'), { timeout: 7000 });
  fs.unlinkSync(path.join(dir, 'ssh_remote_tw.json'));
  await page.click('#reload-btn');
  await page.waitForFunction(() => window.app.panes.left.currentRef() === null);
  assert.equal(await page.$$eval('#pane-left .file-list li', (items) => items.length), 0);
  assert.equal(await page.$eval('#pane-left .path-history-toggle', (s) => s.disabled), true);
  assert.ok(await page.$('#pane-left .path-input'));
  const visible = await page.$$eval('.pane-head input, .pane-head select, .pane-head button', (items) => items.every((item) => {
    const box = item.getBoundingClientRect();
    const pane = item.closest('.pane').getBoundingClientRect();
    return box.width > 0 && box.left >= pane.left && box.right <= pane.right;
  }));
  assert.ok(visible, 'pane controls must remain visible and inside their pane');

  // Missing, changed, and invalid inventory must never pick a replacement.
  const unavailableWorkspace = await workspace();
  const reopenUnavailable = async () => {
    requests.length = 0;
    await page.reload();
    await page.waitForFunction(() => window.app?.panes.left.initialized && window.app.panes.right.initialized);
    assert.equal(await page.evaluate(() => window.app.panes.left.currentRef()), null);
    assert.match(await page.$eval('#pane-left .pane-msg', (e) => e.textContent), /no longer available/);
    assert.deepEqual(requests, []);
    assert.deepEqual(await workspace(), unavailableWorkspace);
  };
  await reopenUnavailable();
  write('tw', 1, [nodes[0], { ...nodes[1], ip: '192.0.2.99' }]);
  await reopenUnavailable();
  fs.writeFileSync(path.join(dir, 'ssh_remote_tw.json'), '{');
  await reopenUnavailable();
  write('tw', 1, nodes);

  // A directory removed while closed stays visible as an error; the other pane restores.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('webscp.workspace.v2'));
    saved.tabs.find((tab) => tab.id === saved.activeTabId).left.cwd = '/missing';
    localStorage.setItem('webscp.workspace.v2', JSON.stringify(saved));
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#pane-left .pane-msg').textContent === 'not found' && window.app.panes.right.listedRef);
  assert.equal(await page.$eval('#pane-left .path-input', (e) => e.value), '/missing');
  assert.equal((await workspace()).left.cwd, '/missing');

  // A failed endpoint switch saves its selection immediately, never the old cwd.
  unavailableHost = nodes[0].ip;
  const first = await page.$eval('#pane-left .endpoint-select', (s) => [...s.options].find((o) => o.textContent.includes('first')).value);
  await page.select('#pane-left .endpoint-select', first);
  await page.waitForFunction(() => document.querySelector('#pane-left .pane-msg').textContent === 'connection refused');
  assert.deepEqual((await workspace()).left, { group: 'tw', endpointKey: first, cwd: '~' });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#pane-left .pane-msg').textContent === 'connection refused' && window.app.panes.right.listedRef);
  assert.equal(await page.$eval('#pane-left .endpoint-select', (s) => s.value), first);
  assert.equal(await page.$eval('#pane-left .path-input', (e) => e.value), '~');
  unavailableHost = undefined;
  await navigate('/recovered');

  // A late response from the old endpoint cannot overwrite a new selection.
  await page.evaluate((key) => {
    const pane = window.app.panes.left;
    pane.pathInput.value = '/slow';
    pane.refresh(true);
    pane.select.value = key;
    pane.select.dispatchEvent(new Event('change'));
  }, second);
  await page.waitForFunction(() => window.app.panes.left.listedRef?.selector === '2');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual((await workspace()).left, { group: 'tw', endpointKey: second, cwd: '/home/test' });

  // Another tab may save a workspace without moving this tab. Background work
  // and startup never overwrite that newer snapshot or reorder recent paths.
  const other = await openPage();
  await other.waitForFunction(() => window.app?.panes.left.listedRef && window.app.panes.right.listedRef);
  await other.evaluate(async () => {
    const pane = window.app.panes.left;
    pane.pathInput.value = '/other-tab';
    await pane.refresh(true);
  });
  const otherWorkspace = await workspace();
  assert.equal(otherWorkspace.left.cwd, '/other-tab');
  assert.equal(await page.evaluate(() => window.app.panes.left.cwd), '/home/test');
  await page.evaluate(async () => {
    await window.app.loadEndpoints();
    await Promise.all(Object.values(window.app.panes).map((pane) => pane.refresh()));
  });
  assert.deepEqual(await workspace(), otherWorkspace);
  await other.close();

  // Ad-hoc use replaces the saved pane with Local home, without any credentials.
  await page.evaluate(() => window.app.panes.left.useAdhoc({ source: 'adhoc', adhoc: {
    host: 'example', user: 'user', password: 'PRIVATE_SENTINEL',
    jump: { host: 'jump', user: 'root', password: 'JUMP_SENTINEL' },
  } }, 'ad-hoc test'));
  await page.waitForFunction(() => window.app.panes.left.listedRef?.source === 'adhoc');
  assert.equal(await tabLabel(), 'example:test <-> second:test');
  assert.deepEqual((await workspace()).left, { group: '', endpointKey: 'local', cwd: '~' });
  await page.click('#new-tab-btn');
  await page.click('#workspace-tab-1');
  await page.waitForFunction(() => window.app.panes.left.listedRef?.source === 'adhoc');
  assert.equal(await page.evaluate(() => window.app.panes.left.adhocRef.adhoc.password), 'PRIVATE_SENTINEL');
  await page.click('#workspace-close-2');
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /PRIVATE_SENTINEL|JUMP_SENTINEL/);
  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.listedRef?.source === 'local' && window.app.panes.right.listedRef);

  // Local paths use the same persistence rules as inventory endpoints.
  await navigate(dir);
  await page.reload();
  await page.waitForFunction((cwd) => window.app?.panes.left.listedRef?.source === 'local'
    && window.app.panes.left.cwd === cwd && window.app.panes.right.listedRef, {}, dir);
  assert.deepEqual((await workspace()).left, { group: '', endpointKey: 'local', cwd: dir });

  // Empty selections are intentional, and one malformed pane does not lose the other.
  await page.select('#pane-left .group-select', 'default');
  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.initialized && window.app.panes.right.listedRef);
  assert.equal(await page.$eval('#pane-left .group-select', (e) => e.value), 'default');
  assert.equal(await page.evaluate(() => window.app.panes.left.currentRef()), null);
  const validRight = (await workspace()).right;
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('webscp.workspace.v2'));
    saved.tabs.find((tab) => tab.id === saved.activeTabId).left = { group: 'tw', endpointKey: 123, cwd: ['/bad'] };
    localStorage.setItem('webscp.workspace.v2', JSON.stringify(saved));
  });
  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.listedRef?.source === 'local' && window.app.panes.right.listedRef);
  assert.equal(await page.$eval('#pane-right .endpoint-select', (e) => e.value), validRight.endpointKey);
  for (const invalid of ['{', 'null', '[]', '{"tabs":[]}', '{"tabs":[null,{"id":-1}]}']) {
    await page.evaluate((value) => localStorage.setItem('webscp.workspace.v2', value), invalid);
    await page.reload();
    await page.waitForFunction(() => window.app?.panes.left.listedRef?.source === 'local' && window.app.panes.right.listedRef?.source === 'local');
  }

  // Upgrade the original one-workspace format without losing either pane.
  await page.evaluate((saved) => {
    localStorage.removeItem('webscp.workspace.v2');
    localStorage.setItem('webscp.workspace.v1', JSON.stringify(saved));
  }, initialWorkspace);
  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.cwd === '/a' && window.app.panes.left.listedRef && window.app.panes.right.listedRef);
  await page.click('#new-tab-btn');
  const migrated = await savedTabs();
  assert.deepEqual(migrated.tabs[0], { id: 1, ...initialWorkspace });
  assert.equal(migrated.tabs.length, 2);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('webscp.workspace.v2'));
    saved.tabs.push(saved.tabs[0], null, { id: 'bad' });
    saved.activeTabId = 999;
    localStorage.setItem('webscp.workspace.v2', JSON.stringify(saved));
  });
  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app.panes.right.listedRef);
  assert.equal(await page.evaluate(() => window.app.tabs.length), 2);
  assert.equal(await page.evaluate(() => window.app.activeTabId), 1);

  // Browsing still works when both reads and writes to storage are denied.
  const blockedStorage = await page.evaluateOnNewDocument(() => {
    Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
  });
  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.listedRef?.source === 'local' && window.app.panes.right.listedRef?.source === 'local');
  await page.select('#pane-left .group-select', 'us');
  await page.waitForFunction(() => window.app.panes.left.listedRef?.group === 'us');
  await navigate('/without-storage');
  await page.click('#new-tab-btn');
  await page.click('#workspace-tab-1');
  await page.waitForFunction(() => window.app.panes.left.cwd === '/without-storage' && window.app.panes.left.listedRef);
  await page.click('#workspace-close-2');
  await page.removeScriptToEvaluateOnNewDocument(blockedStorage.identifier);
  await page.reload();
  await page.waitForFunction(() => window.app?.panes.left.listedRef && window.app.panes.right.listedRef);
  const fallback = await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    try {
      PathHistory.remember('storage-test', '/first');
      PathHistory.remember('storage-test', '/second');
      PathHistory.remove('storage-test', '/first');
      return PathHistory.read('storage-test');
    } finally { Storage.prototype.setItem = original; }
  });
  assert.deepEqual(fallback, ['/second']);
  const secretFree = await page.evaluate(() => Pane.prototype.historyKey.call({
    select: { value: 'adhoc' },
    adhocRef: { adhoc: { host: 'example', user: 'user', password: 'PRIVATE_SENTINEL', jump: { host: 'jump', user: 'root', password: 'JUMP_SENTINEL' } } },
  }));
  assert.doesNotMatch(secretFree, /PRIVATE_SENTINEL|JUMP_SENTINEL/);
  assert.deepEqual(errors, []);
});
