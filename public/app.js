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

// A labelled credential sub-form (ip / port / user / password). When `cred`
// has hasPass, the password field shows an "unchanged" placeholder and an empty
// submit preserves the stored secret server-side.
function credFields(cred) {
  const c = cred || {};
  const ip = el('input', { type: 'text', value: c.ip || '', placeholder: 'ip / host' });
  const port = el('input', { type: 'number', value: c.port || '', placeholder: '22', min: '1' });
  const user = el('input', { type: 'text', value: c.user || '', placeholder: 'user' });
  const pass = el('input', { type: 'password', value: '', placeholder: c.hasPass ? 'unchanged' : 'password' });
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
    hasAny() { return ip.value.trim() || user.value.trim(); },
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
    this.pathInput = root.querySelector('.path-input');
    this.list = root.querySelector('.file-list');
    this.crumb = root.querySelector('.breadcrumb');
    this.msg = root.querySelector('.pane-msg');
    this.options = [];
    this.cwd = '~';
    this.os = 'posix';
    this.entries = [];
    this.refreshSeq = 0;

    this.adhocRef = null; // transient ad-hoc endpoint, if active

    root.querySelector('.go-btn').addEventListener('click', () => this.refresh());
    this.pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.refresh(); });
    // refresh re-lists the current directory, ignoring any unsubmitted edits in
    // the path box (go navigates to the typed path; refresh reloads where we are).
    root.querySelector('.refresh-btn').addEventListener('click', () => {
      this.pathInput.value = this.cwd;
      this.refresh();
    });
    root.querySelector('.mkdir-btn').addEventListener('click', () => this.mkdir());
    root.querySelector('.adhoc-btn').addEventListener('click', () => Adhoc.open(this));
    this.select.addEventListener('change', () => {
      // Leaving the ad-hoc slot for a saved endpoint clears the transient ref.
      if (this.select.value !== 'adhoc') this.adhocRef = null;
      this.pathInput.value = '~';
      this.refresh();
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
    const idx = this.select.value;
    return this.options[idx] ? this.options[idx].ref : null;
  }

  setOptions(options) {
    this.options = options;
    // Build via DOM (not innerHTML) so an inventory label containing HTML/quotes
    // cannot inject markup into the page.
    const opts = options.map((o, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = o.label;
      return opt;
    });
    // Persist the ad-hoc slot at the end if one is active.
    if (this.adhocRef) {
      const ao = document.createElement('option');
      ao.value = 'adhoc';
      ao.textContent = this.adhocLabel || 'ad-hoc connection';
      opts.push(ao);
    }
    this.select.replaceChildren(...opts);
    if (this.adhocRef) this.select.value = 'adhoc';
  }

  // Adopt a transient ad-hoc endpoint, add it as the selected option, and list.
  useAdhoc(ref, label) {
    this.adhocRef = ref;
    this.adhocLabel = label;
    this.setOptions(this.options);
    this.select.value = 'adhoc';
    this.pathInput.value = '~';
    this.refresh();
  }

  setMsg(text, isError) {
    this.msg.textContent = text || '';
    this.msg.style.color = isError ? '#cf222e' : '#57606a';
  }

  async refresh() {
    const ref = this.currentRef();
    if (!ref) return;
    const path = this.pathInput.value || '~';
    const seq = ++this.refreshSeq;
    this.setMsg('loading…');
    try {
      const data = await postJSON('/api/list', { endpoint: ref, path });
      // Ignore a stale response if a newer refresh started meanwhile.
      if (seq !== this.refreshSeq) return;
      this.cwd = data.cwd;
      this.os = data.os;
      this.pathInput.value = data.cwd;
      this.crumb.textContent = `${data.os} : ${data.cwd}`;
      this.render(data.entries);
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
      this.refresh();
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
          this.refresh();
        });
      }

      // Draggable source descriptor.
      li.draggable = true;
      li.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/json', JSON.stringify({
          endpoint: this.currentRef(),
          path: e.path,
          name: e.name,
          isDir: e.type === 'dir',
        }));
      });
      this.list.appendChild(li);
    }
  }

  async mkdir() {
    const ref = this.currentRef();
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

// ---- node manager (config.json CRUD) ----
const NodeManager = {
  async openList() {
    let nodes = [];
    try {
      const r = await reqJSON('GET', '/api/nodes');
      nodes = r.nodes || [];
    } catch (e) {
      Modal.open(el('div', null, [
        el('div', { class: 'modal-head' }, [el('h2', { text: 'Manage nodes' }), el('button', { class: 'close-x', text: '×', onclick: () => Modal.close() })]),
        el('div', { class: 'modal-err', text: e.message }),
      ]));
      return;
    }
    const rows = el('ul', { class: 'node-rows' }, nodes.map((n) => {
      const ep = n.type === 'client'
        ? `${n.user || ''}@${n.ip || ''}`
        : `bmc ${n.bmc ? n.bmc.ip : '?'}` + (n.smc ? `, smc ${n.smc.ip}` : '') + (n.hosts && n.hosts.length ? `, ${n.hosts.length} host(s)` : '');
      return el('li', null, [
        el('span', { class: 'node-type', text: n.type }),
        el('span', { class: 'node-name', text: n.name }),
        el('span', { class: 'node-ep', text: ep }),
        el('button', { text: 'edit', onclick: () => this.openForm(n) }),
        el('button', { class: 'danger', text: 'delete', onclick: () => this.del(n.name) }),
      ]);
    }));
    Modal.open(el('div', null, [
      el('div', { class: 'modal-head' }, [
        el('h2', { text: 'Manage nodes' }),
        el('button', { class: 'close-x', text: '×', onclick: () => Modal.close() }),
      ]),
      rows,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'primary', text: '+ new node', onclick: () => this.openForm(null) }),
      ]),
    ]));
  },

  async del(name) {
    if (!confirm(`Delete node "${name}"?`)) return;
    try {
      await reqJSON('DELETE', `/api/nodes/${encodeURIComponent(name)}`);
      window.app.loadEndpoints();
      this.openList();
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  },

  // Build the create/edit form. `existing` is a redacted node or null.
  openForm(existing) {
    const isEdit = !!existing;
    const nameInput = el('input', { type: 'text', value: existing ? existing.name : '', placeholder: 'unique name' });
    const noteInput = el('input', { type: 'text', value: (existing && existing.note) || '', placeholder: 'optional note' });
    const typeSelect = el('select', null, [
      el('option', { value: 'client', text: 'client' }),
      el('option', { value: 'server', text: 'server (bmc / hosts / smc)' }),
    ]);
    typeSelect.value = existing ? existing.type : 'client';

    // client section
    const clientCred = credFields(existing && existing.type === 'client' ? {
      ip: existing.ip, user: existing.user, port: existing.port, hasPass: existing.hasPass,
    } : null);
    const clientSection = el('fieldset', null, [el('legend', { text: 'connection' }), clientCred.wrap]);

    // server section: bmc + hosts + optional smc
    const bmcCred = credFields(existing && existing.bmc);
    const bmcSection = el('fieldset', null, [el('legend', { text: 'BMC' }), bmcCred.wrap]);

    const hostsBox = el('div');
    const hostCreds = [];
    const addHost = (cred) => {
      const hc = credFields(cred);
      const row = el('div', { class: 'host-row' }, [
        hc.wrap,
        el('button', { class: 'rm-host', text: '✕', title: 'remove host', onclick: () => { row.remove(); hc._removed = true; } }),
      ]);
      hc._row = row;
      hostCreds.push(hc);
      hostsBox.appendChild(row);
    };
    ((existing && existing.hosts) || []).forEach((h) => addHost(h));
    const hostsSection = el('fieldset', null, [
      el('legend', { text: 'hosts (via BMC jump)' }),
      hostsBox,
      el('button', { class: 'add-host', text: '+ add host', onclick: () => addHost(null) }),
    ]);

    const smcEnable = el('input', { type: 'checkbox' });
    smcEnable.checked = !!(existing && existing.smc);
    const smcCred = credFields(existing && existing.smc);
    const smcBody = el('div', { class: existing && existing.smc ? '' : 'hidden' }, [smcCred.wrap]);
    smcEnable.addEventListener('change', () => smcBody.classList.toggle('hidden', !smcEnable.checked));
    const smcSection = el('fieldset', null, [
      el('legend', { text: 'SMC (via BMC jump)' }),
      el('div', { class: 'toggle-line' }, [smcEnable, el('label', { text: 'this server has an SMC' })]),
      smcBody,
    ]);

    const serverWrap = el('div', null, [bmcSection, hostsSection, smcSection]);

    const applyType = () => {
      const isClient = typeSelect.value === 'client';
      clientSection.classList.toggle('hidden', !isClient);
      serverWrap.classList.toggle('hidden', isClient);
    };
    typeSelect.addEventListener('change', applyType);
    applyType();

    const errBox = el('div', { class: 'modal-err' });

    const save = async () => {
      errBox.textContent = '';
      const payload = {
        type: typeSelect.value,
        name: nameInput.value.trim(),
        note: noteInput.value.trim() || undefined,
      };
      if (typeSelect.value === 'client') {
        Object.assign(payload, clientCred.read());
      } else {
        payload.bmc = bmcCred.read();
        if (smcEnable.checked && smcCred.hasAny()) payload.smc = smcCred.read();
        payload.hosts = hostCreds.filter((h) => !h._removed && h.hasAny()).map((h) => h.read());
      }
      try {
        if (isEdit) await reqJSON('PUT', `/api/nodes/${encodeURIComponent(existing.name)}`, payload);
        else await reqJSON('POST', '/api/nodes', payload);
        window.app.loadEndpoints();
        this.openList();
      } catch (e) {
        errBox.textContent = e.message;
      }
    };

    Modal.open(el('div', null, [
      el('div', { class: 'modal-head' }, [
        el('h2', { text: isEdit ? `Edit "${existing.name}"` : 'New node' }),
        el('button', { class: 'close-x', text: '×', onclick: () => Modal.close() }),
      ]),
      el('label', { text: 'name' }), nameInput,
      el('label', { text: 'type' }), typeSelect,
      el('label', { text: 'note' }), noteInput,
      clientSection,
      serverWrap,
      errBox,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'secondary', text: 'back', onclick: () => this.openList() }),
        el('button', { class: 'primary', text: isEdit ? 'save' : 'create', onclick: save }),
      ]),
    ]));
  },
};

// ---- ad-hoc connect ----
const Adhoc = {
  // Open the form; on success sets the pane's transient endpoint and lists it.
  // Ad-hoc endpoints are transient by default — they are only written to
  // config.json when the user ticks "save to config" and supplies a name.
  open(pane) {
    const target = credFields(null);
    const jumpEnable = el('input', { type: 'checkbox' });
    const jumpCred = credFields(null);
    const jumpBody = el('div', { class: 'hidden' }, [jumpCred.wrap]);
    jumpEnable.addEventListener('change', () => jumpBody.classList.toggle('hidden', !jumpEnable.checked));

    const saveEnable = el('input', { type: 'checkbox' });
    const saveName = el('input', { type: 'text', placeholder: 'node name' });
    const saveBody = el('div', { class: 'hidden' }, [
      el('label', { text: 'name to save as' }),
      saveName,
    ]);
    saveEnable.addEventListener('change', () => saveBody.classList.toggle('hidden', !saveEnable.checked));

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
      // Validate the save fields up front so a connect+save is atomic from the
      // user's view (no "connected but failed to save name" surprise).
      const wantSave = saveEnable.checked;
      const name = saveName.value.trim();
      if (wantSave && !name) { errBox.textContent = 'enter a name to save, or untick "save to config"'; return; }

      const ref = { source: 'adhoc', adhoc };
      try {
        await postJSON('/api/connect-test', { endpoint: ref });
      } catch (e) {
        errBox.textContent = `connect failed: ${e.message}`;
        return;
      }

      if (wantSave) {
        try {
          await postJSON('/api/nodes', adhocToNode(name, adhoc));
          await window.app.loadEndpoints();
        } catch (e) {
          errBox.textContent = `connected, but save failed: ${e.message}`;
          return;
        }
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
      el('fieldset', null, [
        el('legend', { text: 'save' }),
        el('div', { class: 'toggle-line' }, [saveEnable, el('label', { text: 'save to config (otherwise this connection is temporary)' })]),
        saveBody,
      ]),
      errBox,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'secondary', text: 'cancel', onclick: () => Modal.close() }),
        el('button', { class: 'primary', text: 'connect', onclick: connect }),
      ]),
    ]));
  },
};

// Map an ad-hoc connection to a config node payload: a jumped target becomes a
// server (bmc = jump, single host = target); a direct one becomes a client.
function adhocToNode(name, adhoc) {
  if (adhoc.jump) {
    return {
      type: 'server',
      name,
      bmc: { ip: adhoc.jump.host, port: adhoc.jump.port, user: adhoc.jump.user, pass: adhoc.jump.password },
      hosts: [{ ip: adhoc.host, port: adhoc.port, user: adhoc.user, pass: adhoc.password }],
    };
  }
  return { type: 'client', name, ip: adhoc.host, port: adhoc.port, user: adhoc.user, pass: adhoc.password };
}

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
    document.getElementById('manage-btn').addEventListener('click', () => NodeManager.openList());
    document.getElementById('clear-queue-btn').addEventListener('click', () => this.clearQueue());
    this.loadEndpoints();
  }

  // Remove finished transfers (done/error) from the list; keep active ones.
  clearQueue() {
    this.queue.querySelectorAll('li.job-done, li.job-error').forEach((li) => li.remove());
  }

  async loadEndpoints() {
    try {
      const r = await fetch('/api/endpoints');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      this.panes.left.setOptions(data.options);
      this.panes.right.setOptions(data.options);
    } catch (e) {
      this.panes.left.setMsg(`endpoints: ${e.message}`, true);
    }
  }

  async reload() {
    await postJSON('/api/reload', {}).catch(() => {});
    this.loadEndpoints();
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
    this.panes.left.refresh();
    this.panes.right.refresh();
  }

  async onDrop(dragged, destPane) {
    const destRef = destPane.currentRef();
    if (!destRef) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      destPane.setMsg('not connected — transfer aborted (ws reconnecting)', true);
      return;
    }
    const srcName = basename(dragged.path);
    // Re-list the destination now so the conflict check uses live remote state,
    // not whatever the pane happened to show earlier.
    let taken;
    try {
      const live = await postJSON('/api/list', { endpoint: destRef, path: destPane.cwd });
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
      name = choice === 'replace' ? srcName : renamed;
    }

    const reqId = `req-${Date.now()}`;
    this.ws.send(JSON.stringify({
      type: 'transfer',
      reqId,
      payload: {
        src: { endpoint: dragged.endpoint, path: dragged.path },
        dst: { endpoint: destRef, dir: destPane.cwd, name },
        recursive: true,
      },
    }));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
