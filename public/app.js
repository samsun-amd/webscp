'use strict';

// ---- helpers ----
function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)}${u[i]}`;
}

function dirname(p) {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return norm.slice(0, idx + 1) || '/';
  return norm.slice(0, idx);
}

function basename(p) {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

// Insert " (n)" before the extension: report.txt -> report (1).txt.
function bumpName(name, taken) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 1;
  let candidate = `${stem} (${n})${ext}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

async function reqJSON(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function postJSON(url, body) { return reqJSON('POST', url, body); }

const PathHistory = {
  memory: new Map(),
  read(key) {
    if (!key) return [];
    if (this.memory.has(key)) return this.memory.get(key);
    try {
      const saved = JSON.parse(localStorage.getItem(`webscp.paths:${key}`) || '[]');
      if (Array.isArray(saved) && saved.every((p) => typeof p === 'string')) {
        this.memory.set(key, saved);
      }
    } catch { /* Storage may be unavailable; keep this session's history. */ }
    return this.memory.get(key) || [];
  },
  remember(key, path) {
    this.write(key, [path, ...this.read(key).filter((p) => p !== path)]);
  },
  remove(key, path) {
    this.write(key, this.read(key).filter((p) => p !== path));
  },
  write(key, paths) {
    if (!key) return;
    this.memory.set(key, paths);
    try { localStorage.setItem(`webscp.paths:${key}`, JSON.stringify(paths)); } catch { /* Session-only history. */ }
  },
};

// Tiny DOM builder: el('input', {type:'text', class:'x'}, [children]).
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children || []) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// A labelled form for transient ad-hoc credentials.
function credFields() {
  const ip = el('input', { type: 'text', value: '', placeholder: 'ip / host' });
  const port = el('input', { type: 'number', value: '', placeholder: '22', min: '1', max: '65535' });
  const user = el('input', { type: 'text', value: '', placeholder: 'user' });
  const pass = el('input', { type: 'password', value: '', placeholder: 'password' });
  const wrap = el('div', null, [
    el('div', { class: 'field-row' }, [
      el('div', null, [el('label', { text: 'ip / host' }), ip]),
      el('div', null, [el('label', { text: 'port' }), port]),
    ]),
    el('div', { class: 'field-row' }, [
      el('div', null, [el('label', { text: 'user' }), user]),
      el('div', null, [el('label', { text: 'password' }), pass]),
    ]),
  ]);
  return {
    wrap,
    read() {
      const out = { ip: ip.value.trim(), user: user.value.trim() };
      if (port.value) out.port = Number(port.value);
      if (pass.value) out.pass = pass.value;
      return out;
    },
  };
}

// Modal controller around #modal-overlay / #modal.
const Modal = {
  overlay: null,
  box: null,
  init() {
    this.overlay = document.getElementById('modal-overlay');
    this.box = document.getElementById('modal');
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });
  },
  open(contentNode) {
    this.box.replaceChildren(contentNode);
    this.overlay.classList.remove('hidden');
  },
  close() { this.overlay.classList.add('hidden'); this.box.replaceChildren(); },
  // Name-conflict dialog. Resolves 'replace' | 'keep-both' | null (cancelled).
  conflict(name, renamedTo) {
    return new Promise((resolve) => {
      const done = (v) => { this.close(); resolve(v); };
      this.open(el('div', null, [
        el('div', { class: 'modal-head' }, [
          el('h2', { text: 'Name already exists' }),
          el('button', { class: 'close-x', text: '×', onclick: () => done(null) }),
        ]),
        el('p', { text: `"${name}" already exists in the destination folder.` }),
        el('p', { class: 'modal-sub', text: `Keep both saves the new file as "${renamedTo}".` }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'secondary', text: 'cancel', onclick: () => done(null) }),
          el('button', { class: 'danger', text: 'replace', onclick: () => done('replace') }),
          el('button', { class: 'primary', text: 'keep both', onclick: () => done('keep-both') }),
        ]),
      ]));
    });
  },
};

// ---- pane model ----
class Pane {
  constructor(root, side) {
    this.root = root;
    this.side = side;
    this.select = root.querySelector('.endpoint-select');
    this.groupSelect = root.querySelector('.group-select');
    this.pathInput = root.querySelector('.path-input');
    this.pathHistory = root.querySelector('.path-history');
    this.historyToggle = root.querySelector('.path-history-toggle');
    this.list = root.querySelector('.file-list');
    this.crumb = root.querySelector('.breadcrumb');
    this.msg = root.querySelector('.pane-msg');
    this.options = [];
    this.cwd = '~';
    this.os = 'posix';
    this.entries = [];
    this.refreshSeq = 0;
    this.listedRef = null;
    this.initialized = false;

    this.adhocRef = null; // transient ad-hoc endpoint, if active

    root.querySelector('.go-btn').addEventListener('click', () => this.refresh(true));
    this.pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.refresh(true); });
    this.pathHistory.addEventListener('beforetoggle', (e) => {
      if (e.newState !== 'open') return;
      const box = this.historyToggle.getBoundingClientRect();
      const width = Math.min(420, window.innerWidth - 16);
      Object.assign(this.pathHistory.style, {
        width: `${width}px`,
        left: `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`,
        top: `${box.bottom + 4}px`,
        maxHeight: `${Math.min(320, window.innerHeight - box.bottom - 12)}px`,
      });
    });
    window.addEventListener('resize', () => this.pathHistory.hidePopover());
    // refresh re-lists the current directory, ignoring any unsubmitted edits in
    // the path box (go navigates to the typed path; refresh reloads where we are).
    root.querySelector('.refresh-btn').addEventListener('click', () => {
      this.pathInput.value = this.cwd;
      this.refresh();
    });
    root.querySelector('.mkdir-btn').addEventListener('click', () => this.mkdir());
    root.querySelector('.adhoc-btn').addEventListener('click', () => Adhoc.open(this));
    this.select.addEventListener('change', () => {
      this.pathInput.value = '~';
      this.renderHistory();
      this.refresh(true);
    });
    this.groupSelect.addEventListener('change', () => {
      this.renderEndpoints();
      this.select.value = this.select.options[1]?.value || '';
      this.pathInput.value = '~';
      this.renderHistory();
      this.refresh(true);
    });

    // Drop target.
    root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('drag-over'); });
    root.addEventListener('dragleave', () => root.classList.remove('drag-over'));
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('drag-over');
      const payload = e.dataTransfer.getData('application/json');
      if (!payload) return;
      let dragged;
      try {
        dragged = JSON.parse(payload);
      } catch {
        return; // foreign / malformed drop content
      }
      if (dragged && dragged.endpoint && dragged.path) window.app.onDrop(dragged, this);
    });
  }

  currentRef() {
    if (this.select.value === 'adhoc') return this.adhocRef;
    return this.options.find((o) => o.key === this.select.value)?.ref || null;
  }

  renderEndpoints() {
    const options = this.options.filter((o) => o.group === this.groupSelect.value);
    this.select.replaceChildren(
      el('option', { value: '', text: 'Select an endpoint' }),
      ...options.map((o) => el('option', { value: o.key, text: o.label })),
    );
    if (this.groupSelect.value === '@adhoc' && this.adhocRef) {
      this.select.appendChild(el('option', { value: 'adhoc', text: this.adhocLabel }));
    }
  }

  setOptions(catalog, recover = false) {
    const oldRef = JSON.stringify(this.currentRef());
    const selected = this.select.value;
    const group = this.groupSelect.value;
    this.options = catalog.options;
    this.groupSelect.replaceChildren(
      el('option', { value: '', text: 'Local' }),
      ...catalog.groups.map((g) => el('option', {
        value: g.name, text: `${g.name} (#${g.number ?? '?'})${g.error ? ' — invalid' : ''}`, disabled: !!g.error,
      })),
    );
    if (this.adhocRef) this.groupSelect.appendChild(el('option', { value: '@adhoc', text: 'Ad-hoc' }));
    this.groupSelect.value = this.initialized ? group : '';
    this.renderEndpoints();
    this.select.value = this.initialized ? selected : 'local';
    const changed = oldRef !== JSON.stringify(this.currentRef());
    if (!this.initialized || changed || recover) {
      this.invalidate();
      if (this.currentRef()) {
        this.pathInput.value = this.initialized ? this.cwd : '~';
        this.refresh(!this.initialized);
      } else {
        this.select.value = '';
        this.pathInput.value = '';
        this.setMsg('Endpoint is no longer available. Select an endpoint.', true);
      }
    }
    this.initialized = true;
    this.renderHistory();
  }

  historyKey() {
    if (this.select.value !== 'adhoc') return this.currentRef() ? this.select.value : '';
    const a = this.adhocRef.adhoc;
    // Never persist passwords, including the jump password.
    return JSON.stringify(['adhoc', a.host, a.port || 22, a.user,
      a.jump ? [a.jump.host, a.jump.port || 22, a.jump.user] : null]);
  }

  renderHistory() {
    const key = this.historyKey();
    const paths = PathHistory.read(key);
    const signature = JSON.stringify([key, paths]);
    if (signature === this.renderedHistory) return;
    this.renderedHistory = signature;
    this.pathHistory.replaceChildren(
      ...paths.map((p, index) => el('li', null, [
        el('button', {
          class: 'path-choice', type: 'button', value: p, text: p, title: p,
          onclick: () => {
            this.pathHistory.hidePopover();
            this.pathInput.value = p;
            this.refresh(true);
          },
        }),
        el('button', {
          class: 'path-remove', type: 'button', text: '×',
          'aria-label': `Remove ${p} from recent paths`, title: 'Remove from recent paths',
          onclick: () => {
            PathHistory.remove(key, p);
            window.app.refreshHistories();
            const remaining = this.pathHistory.querySelectorAll('.path-remove');
            (remaining[Math.min(index, remaining.length - 1)] || this.pathInput).focus();
          },
        }),
      ])),
    );
    this.historyToggle.disabled = !paths.length;
    if (!paths.length) this.pathHistory.hidePopover();
  }

  invalidate() {
    this.refreshSeq += 1;
    this.listedRef = null;
    this.entries = [];
    this.list.replaceChildren();
    this.crumb.textContent = '';
  }

  // Adopt a transient ad-hoc endpoint, add it as the selected option, and list.
  useAdhoc(ref, label) {
    this.adhocRef = ref;
    this.adhocLabel = label;
    if (![...this.groupSelect.options].some((o) => o.value === '@adhoc')) {
      this.groupSelect.appendChild(el('option', { value: '@adhoc', text: 'Ad-hoc' }));
    }
    this.groupSelect.value = '@adhoc';
    this.renderEndpoints();
    this.select.value = 'adhoc';
    this.pathInput.value = '~';
    this.renderHistory();
    this.refresh(true);
  }

  setMsg(text, isError) {
    this.msg.textContent = text || '';
    this.msg.style.color = isError ? '#cf222e' : '#57606a';
  }

  async refresh(remember = false) {
    const ref = this.currentRef();
    this.invalidate();
    if (!ref) return;
    const path = this.pathInput.value || '~';
    const seq = this.refreshSeq;
    const historyKey = this.historyKey();
    this.setMsg('loading…');
    try {
      const data = await postJSON('/api/list', { endpoint: ref, path });
      // Ignore a stale response if a newer refresh started meanwhile.
      if (seq !== this.refreshSeq) return;
      this.cwd = data.cwd;
      this.listedRef = ref;
      this.os = data.os;
      this.pathInput.value = data.cwd;
      this.crumb.textContent = `${data.os} : ${data.cwd}`;
      this.render(data.entries);
      if (remember) PathHistory.remember(historyKey, data.cwd);
      window.app?.refreshHistories();
      this.setMsg('');
    } catch (e) {
      if (seq !== this.refreshSeq) return;
      this.setMsg(e.message, true);
      this.list.innerHTML = '';
    }
  }

  render(entries) {
    this.entries = entries; // kept for drop-time conflict checks
    this.list.innerHTML = '';
    // Parent dir nav.
    const up = document.createElement('li');
    up.className = 'dir';
    up.innerHTML = '<span class="icon">📁</span><span class="name">..</span><span class="size"></span>';
    up.addEventListener('dblclick', () => {
      this.pathInput.value = dirname(this.cwd);
      this.refresh(true);
    });
    this.list.appendChild(up);

    for (const e of entries) {
      const li = document.createElement('li');
      li.className = e.type === 'dir' ? 'dir' : 'file';
      const icon = e.type === 'dir' ? '📁' : '📄';
      li.innerHTML =
        `<span class="icon">${icon}</span>` +
        `<span class="name"></span>` +
        `<span class="size">${e.type === 'file' ? fmtSize(e.size) : ''}</span>`;
      li.querySelector('.name').textContent = e.name;

      if (e.type === 'dir') {
        li.addEventListener('dblclick', () => {
          this.pathInput.value = e.path;
          this.refresh(true);
        });
      }

      // Draggable source descriptor.
      li.draggable = true;
      const listedRef = this.listedRef;
      li.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/json', JSON.stringify({
          endpoint: listedRef,
          path: e.path,
          name: e.name,
          isDir: e.type === 'dir',
        }));
      });
      this.list.appendChild(li);
    }
  }

  async mkdir() {
    const ref = this.listedRef;
    if (!ref) return;
    const name = prompt('New folder name:');
    if (!name) return;
    const sep = this.cwd.endsWith('/') ? '' : '/';
    try {
      await postJSON('/api/mkdir', { endpoint: ref, path: `${this.cwd}${sep}${name}` });
      this.refresh();
    } catch (e) {
      this.setMsg(e.message, true);
    }
  }
}

// ---- ad-hoc connect ----
const Adhoc = {
  // Open the form; on success sets the pane's transient endpoint and lists it.
  // Ad-hoc credentials stay in memory; inventory is managed by sshm.
  open(pane) {
    const target = credFields();
    const jumpEnable = el('input', { type: 'checkbox' });
    const jumpCred = credFields();
    const jumpBody = el('div', { class: 'hidden' }, [jumpCred.wrap]);
    jumpEnable.addEventListener('change', () => jumpBody.classList.toggle('hidden', !jumpEnable.checked));

    const errBox = el('div', { class: 'modal-err' });

    const connect = async () => {
      errBox.textContent = '';
      const t = target.read();
      if (!t.ip || !t.user) { errBox.textContent = 'host and user are required'; return; }
      const adhoc = { host: t.ip, port: t.port, user: t.user, password: t.pass };
      if (jumpEnable.checked) {
        const j = jumpCred.read();
        if (!j.ip || !j.user) { errBox.textContent = 'jump needs host and user'; return; }
        adhoc.jump = { host: j.ip, port: j.port, user: j.user, password: j.pass };
      }
      const ref = { source: 'adhoc', adhoc };
      try {
        await postJSON('/api/connect-test', { endpoint: ref });
      } catch (e) {
        errBox.textContent = `connect failed: ${e.message}`;
        return;
      }

      Modal.close();
      pane.useAdhoc(ref, `ad-hoc: ${adhoc.user}@${adhoc.host}`);
    };

    Modal.open(el('div', null, [
      el('div', { class: 'modal-head' }, [
        el('h2', { text: 'Ad-hoc connection' }),
        el('button', { class: 'close-x', text: '×', onclick: () => Modal.close() }),
      ]),
      el('fieldset', null, [el('legend', { text: 'target' }), target.wrap]),
      el('fieldset', null, [
        el('legend', { text: 'jump (optional, e.g. BMC)' }),
        el('div', { class: 'toggle-line' }, [jumpEnable, el('label', { text: 'connect via a jump host' })]),
        jumpBody,
      ]),
      errBox,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'secondary', text: 'cancel', onclick: () => Modal.close() }),
        el('button', { class: 'primary', text: 'connect', onclick: connect }),
      ]),
    ]));
  },
};

// ---- app ----
class App {
  constructor() {
    this.panes = {
      left: new Pane(document.getElementById('pane-left'), 'left'),
      right: new Pane(document.getElementById('pane-right'), 'right'),
    };
    this.queue = document.getElementById('queue-list');
    this.ws = null;
    this.connectWs();
    Modal.init();
    document.getElementById('reload-btn').addEventListener('click', () => this.reload());
    document.getElementById('clear-queue-btn').addEventListener('click', () => this.clearQueue());
    this.loadSeq = 0;
    this.loadEndpoints();
    setInterval(() => { if (!document.hidden) this.loadEndpoints(); }, 5000);
    window.addEventListener('focus', () => this.loadEndpoints());
    window.addEventListener('storage', () => { PathHistory.memory.clear(); this.refreshHistories(); });
  }

  // Remove finished transfers (done/error) from the list; keep active ones.
  clearQueue() {
    this.queue.querySelectorAll('li.job-done, li.job-error').forEach((li) => li.remove());
  }

  async loadEndpoints() {
    const seq = ++this.loadSeq;
    try {
      const data = await reqJSON('GET', '/api/endpoints');
      if (seq !== this.loadSeq) return;
      this.applyCatalog(data);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      for (const pane of Object.values(this.panes)) pane.invalidate();
      document.getElementById('inventory-status').textContent = `Inventory: ${e.message}`;
      this.lastCatalog = null;
    }
  }

  applyCatalog(data) {
    const signature = JSON.stringify(data);
    if (signature === this.lastCatalog) return;
    const recover = this.lastCatalog === null;
    this.lastCatalog = signature;
    for (const pane of Object.values(this.panes)) pane.setOptions(data, recover);
    const warnings = [...data.warnings, ...data.groups.filter((g) => g.error).map((g) => `${g.name}: ${g.error}`)];
    document.getElementById('inventory-status').textContent = warnings.join(' ');
  }

  refreshHistories() {
    for (const pane of Object.values(this.panes)) pane.renderHistory();
  }

  async reload() {
    const seq = ++this.loadSeq;
    try {
      const data = await postJSON('/api/reload', {});
      if (seq !== this.loadSeq) return;
      this.applyCatalog(data);
      this.refreshAll();
    } catch (e) {
      if (seq !== this.loadSeq) return;
      document.getElementById('inventory-status').textContent = `Reload failed: ${e.message}`;
    }
  }

  connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    const status = document.getElementById('conn-status');
    this.ws.onopen = () => { status.textContent = 'ws: connected'; };
    this.ws.onclose = () => {
      status.textContent = 'ws: disconnected (retrying)';
      setTimeout(() => this.connectWs(), 2000);
    };
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onWsMessage(msg);
    };
  }

  onWsMessage(msg) {
    if (msg.type === 'job') {
      const existing = document.getElementById(msg.id);
      if (existing) { existing.querySelector('.job-label').textContent = msg.label; return; }
      const li = document.createElement('li');
      li.id = msg.id;
      li.innerHTML =
        `<span class="job-label"></span>` +
        `<span class="job-mode">[${msg.mode}]</span>` +
        `<div class="bar"><div></div></div>` +
        `<span class="job-pct">0%</span>` +
        `<button class="job-cancel">cancel</button>`;
      li.querySelector('.job-label').textContent = msg.label;
      li.querySelector('.job-cancel').addEventListener('click', () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'cancel', id: msg.id }));
        }
      });
      this.queue.prepend(li);
    } else if (msg.type === 'progress') {
      const li = document.getElementById(msg.id);
      if (!li) return;
      const pct = msg.total ? Math.min(100, Math.round((msg.bytes / msg.total) * 100)) : null;
      li.querySelector('.bar > div').style.width = pct != null ? `${pct}%` : '100%';
      li.querySelector('.job-pct').textContent =
        pct != null ? `${pct}%` : fmtSize(msg.bytes);
    } else if (msg.type === 'done') {
      const li = document.getElementById(msg.id);
      if (!li) return;
      li.classList.add('job-done');
      li.querySelector('.bar > div').style.width = '100%';
      li.querySelector('.job-pct').textContent = 'done';
      li.querySelector('.job-cancel').remove();
      this.refreshAll();
    } else if (msg.type === 'error') {
      const li = document.getElementById(msg.id);
      if (!li) return;
      li.classList.add('job-error');
      li.querySelector('.job-pct').textContent = `error: ${msg.message}`;
      const c = li.querySelector('.job-cancel');
      if (c) c.remove();
    }
  }

  refreshAll() {
    for (const pane of Object.values(this.panes)) {
      if (!pane.currentRef()) continue;
      pane.pathInput.value = pane.cwd;
      pane.refresh();
    }
  }

  async onDrop(dragged, destPane) {
    const destRef = destPane.listedRef;
    if (!destRef) return;
    const destDir = destPane.cwd;
    const stillSelected = () => JSON.stringify(destRef) === JSON.stringify(destPane.listedRef) && destDir === destPane.cwd;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      destPane.setMsg('not connected — transfer aborted (ws reconnecting)', true);
      return;
    }
    // Dropping an item back into the folder it already lives in (same endpoint,
    // same parent dir) is a no-op — silently ignore instead of prompting to
    // rename or letting the server reject it as a same-path transfer.
    const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    const sameEndpoint = JSON.stringify(dragged.endpoint) === JSON.stringify(destRef);
    if (sameEndpoint && norm(dirname(dragged.path)) === norm(destPane.cwd)) return;

    const srcName = basename(dragged.path);
    // Re-list the destination now so the conflict check uses live remote state,
    // not whatever the pane happened to show earlier.
    let taken;
    try {
      const live = await postJSON('/api/list', { endpoint: destRef, path: destDir });
      if (!stillSelected()) return;
      taken = new Set(live.entries.map((e) => e.name));
    } catch (e) {
      destPane.setMsg(`could not check destination: ${e.message}`, true);
      return;
    }
    let name = srcName;
    if (taken.has(srcName)) {
      const renamed = bumpName(srcName, taken);
      const choice = await Modal.conflict(srcName, renamed);
      if (choice === null) return; // cancelled
      if (!stillSelected()) return;
      name = choice === 'replace' ? srcName : renamed;
    }

    const reqId = `req-${Date.now()}`;
    this.ws.send(JSON.stringify({
      type: 'transfer',
      reqId,
      payload: {
        src: { endpoint: dragged.endpoint, path: dragged.path },
        dst: { endpoint: destRef, dir: destDir, name },
        recursive: true,
      },
    }));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
