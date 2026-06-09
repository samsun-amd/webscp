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

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

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
    this.refreshSeq = 0;

    root.querySelector('.go-btn').addEventListener('click', () => this.refresh());
    this.pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.refresh(); });
    root.querySelector('.mkdir-btn').addEventListener('click', () => this.mkdir());
    this.select.addEventListener('change', () => { this.pathInput.value = '~'; this.refresh(); });

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
    const idx = this.select.value;
    return this.options[idx] ? this.options[idx].ref : null;
  }

  setOptions(options) {
    this.options = options;
    // Build via DOM (not innerHTML) so an inventory label containing HTML/quotes
    // cannot inject markup into the page.
    this.select.replaceChildren(...options.map((o, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = o.label;
      return opt;
    }));
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
    document.getElementById('reload-btn').addEventListener('click', () => this.reload());
    this.loadEndpoints();
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

  onDrop(dragged, destPane) {
    const destRef = destPane.currentRef();
    if (!destRef) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      destPane.setMsg('not connected — transfer aborted (ws reconnecting)', true);
      return;
    }
    const reqId = `req-${Date.now()}`;
    this.ws.send(JSON.stringify({
      type: 'transfer',
      reqId,
      payload: {
        src: { endpoint: dragged.endpoint, path: dragged.path },
        dst: { endpoint: destRef, dir: destPane.cwd },
        recursive: true,
      },
    }));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
