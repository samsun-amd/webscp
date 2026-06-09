import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { SshPool, RemoteFs, TransferEngine } from '@ssh-manager/core';
import {
  EndpointRef,
  ListResponse,
  WsClientMessage,
  WsServerMessage,
} from '../shared/types';
import { getInventory, reloadInventory, resolveRef } from './endpoints';

const LOCAL_OS: 'posix' | 'windows' = process.platform === 'win32' ? 'windows' : 'posix';

function isLocal(ep: EndpointRef | undefined): boolean {
  return !!ep && ep.source === 'local';
}

/** Expand a leading `~` against the hub's own home directory. */
function localExpandHome(p: string): string {
  const home = os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** Directory listing on the hub machine itself, shaped like a remote list. */
function localList(reqPath: string): ListResponse {
  const cwd = path.resolve(localExpandHome(reqPath || '~'));
  const dirents = fs.readdirSync(cwd, { withFileTypes: true });
  const entries = dirents
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => {
      const full = path.join(cwd, d.name);
      let type: 'file' | 'dir' | 'symlink' | 'other' = 'other';
      let size = 0;
      let mtime: number | null = null;
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) type = 'dir';
        else if (st.isFile()) type = 'file';
        else if (st.isSymbolicLink()) type = 'symlink';
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        if (d.isDirectory()) type = 'dir';
        else if (d.isFile()) type = 'file';
        else if (d.isSymbolicLink()) type = 'symlink';
      }
      return { name: d.name, path: full, type, size, mtime };
    });
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { cwd, os: LOCAL_OS, entries };
}

const PORT = Number(process.env.WEBSCP_PORT) || 8088;
const HOST = process.env.WEBSCP_HOST || '127.0.0.1';

const pool = new SshPool({ readyTimeoutMs: 15000, idleTimeoutMs: 60000, maxPerKey: 4 });
const engine = new TransferEngine();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../../public')));

function errStatus(e: unknown): number {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found|no inventory|ENOENT/i.test(msg)) return 404;
  if (/authentication/i.test(msg)) return 401;
  if (/connection failed|timed out|unreachable|refused/i.test(msg)) return 503;
  return 500;
}

// List inventory endpoints for the pane dropdowns.
app.get('/api/endpoints', (_req, res) => {
  try {
    const inv = getInventory();
    const summaries = inv.list();
    // Expand server nodes into selectable sub-targets (bmc / hosts / smc).
    const options: Array<{ label: string; ref: EndpointRef }> = [];
    // The hub machine itself is always available as a source/destination.
    options.push({ label: 'localhost (this machine)', ref: { source: 'local' } });
    for (const node of inv.raw()) {
      if (node.type === 'client') {
        options.push({ label: `${node.name} (client)`, ref: { source: 'inventory', selector: node.name } });
      } else if (node.type === 'smc') {
        options.push({ label: `${node.name} (smc, standalone)`, ref: { source: 'inventory', selector: node.name } });
      } else if (node.type === 'server') {
        options.push({ label: `${node.name} / bmc`, ref: { source: 'inventory', selector: node.name, sub: 'bmc' } });
        (node.hosts || []).forEach((_h, i) => {
          options.push({
            label: `${node.name} / host${i + 1}`,
            ref: { source: 'inventory', selector: node.name, sub: `host${i + 1}` },
          });
        });
        options.push({ label: `${node.name} / smc (via bmc)`, ref: { source: 'inventory', selector: node.name, sub: 'smc' } });
      }
    }
    res.json({ summaries, options });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/reload', (_req, res) => {
  try {
    reloadInventory();
    res.json({ ok: true });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Test a connection without listing.
app.post('/api/connect-test', async (req, res) => {
  try {
    const ep = resolveRef(req.body.endpoint as EndpointRef);
    await pool.withSession(ep, async (s) => s.detectOs());
    res.json({ ok: true });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Directory listing.
app.post('/api/list', async (req, res) => {
  try {
    if (isLocal(req.body.endpoint as EndpointRef)) {
      return res.json(localList(req.body.path || '~'));
    }
    const ep = resolveRef(req.body.endpoint as EndpointRef);
    const reqPath: string = req.body.path || '~';
    const out = await pool.withSession(ep, async (session) => {
      const rfs = new RemoteFs(session);
      const cwd = await rfs.expandHome(reqPath || '~');
      const entries = await rfs.list(cwd, { includeHidden: false });
      const response: ListResponse = {
        cwd,
        os: session.os || 'posix',
        entries: entries.map((e) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          size: e.size,
          mtime: e.mtime,
        })),
      };
      return response;
    });
    res.json(out);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/mkdir', async (req, res) => {
  try {
    const dir: string = req.body.path;
    if (!dir) return res.status(400).json({ error: 'path required' });
    if (isLocal(req.body.endpoint as EndpointRef)) {
      fs.mkdirSync(localExpandHome(dir), { recursive: true });
      return res.json({ ok: true });
    }
    const ep = resolveRef(req.body.endpoint as EndpointRef);
    await pool.withSession(ep, async (s) => new RemoteFs(s).mkdirp(dir));
    res.json({ ok: true });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const target: string = req.body.path;
    if (!target) return res.status(400).json({ error: 'path required' });
    if (isLocal(req.body.endpoint as EndpointRef)) {
      fs.rmSync(localExpandHome(target), { recursive: true, force: true });
      return res.json({ ok: true });
    }
    const ep = resolveRef(req.body.endpoint as EndpointRef);
    await pool.withSession(ep, async (s) => new RemoteFs(s).remove(target));
    res.json({ ok: true });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let jobCounter = 0;
const activeJobs = new Map<string, AbortController>();

function send(ws: WebSocket, msg: WsServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket may flip to closing between the readyState check and send(); a
    // throw here originates from a stream 'data' event (onProgress) and would
    // otherwise crash the process. Swallow it — the job's catch reports errors.
  }
}

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'cancel') {
      activeJobs.get(msg.id)?.abort();
      return;
    }

    if (msg.type === 'transfer') {
      jobCounter += 1;
      const id = `job-${jobCounter}`;
      const ctrl = new AbortController();
      activeJobs.set(id, ctrl);
      const { src, dst } = msg.payload;
      const recursive = msg.payload.recursive ?? true;
      const srcLocal = isLocal(src.endpoint);
      const dstLocal = isLocal(dst.endpoint);
      const onProgress = (p: { bytes: number; total: number | null; file: string }) =>
        send(ws, { type: 'progress', id, bytes: p.bytes, total: p.total, file: p.file });

      try {
        const mode: 'direct' | 'relay' = 'relay';

        if (srcLocal && dstLocal) {
          // Both ends are the hub: a plain local filesystem copy.
          const srcResolved = path.resolve(localExpandHome(src.path));
          const base = path.basename(srcResolved);
          const dstPath = path.join(path.resolve(localExpandHome(dst.dir)), base);
          send(ws, { type: 'job', id, mode, label: `local:${base} -> local` });
          fs.cpSync(srcResolved, dstPath, { recursive });
        } else if (srcLocal) {
          // Local -> remote: upload from the hub.
          const dstEp = resolveRef(dst.endpoint);
          const srcResolved = path.resolve(localExpandHome(src.path));
          const base = path.basename(srcResolved);
          send(ws, { type: 'job', id, mode, label: `local:${base} -> ${dstEp.id}` });
          await pool.withSession(dstEp, async (dstSession) => {
            const dstFs = new RemoteFs(dstSession);
            const dstDir = await dstFs.expandHome(dst.dir);
            const dstPath = dstFs.path.join(dstDir, base);
            await engine.hubToRemote(srcResolved, dstSession, dstPath, {
              recursive,
              signal: ctrl.signal,
              onProgress,
            });
          });
        } else if (dstLocal) {
          // Remote -> local: download to the hub.
          const srcEp = resolveRef(src.endpoint);
          send(ws, { type: 'job', id, mode, label: `${srcEp.id}:${basenameLoose(src.path)} -> local` });
          await pool.withSession(srcEp, async (srcSession) => {
            const srcFs = new RemoteFs(srcSession);
            const srcResolved = await srcFs.expandHome(src.path);
            const base = srcFs.path.basename(srcResolved);
            const dstPath = path.join(path.resolve(localExpandHome(dst.dir)), base);
            await engine.remoteToHub(srcSession, srcResolved, dstPath, {
              recursive,
              signal: ctrl.signal,
              onProgress,
            });
          });
        } else {
          // Remote -> remote: relay through the hub.
          const srcEp = resolveRef(src.endpoint);
          const dstEp = resolveRef(dst.endpoint);
          const label = `${srcEp.id}:${basenameLoose(src.path)} -> ${dstEp.id}`;
          send(ws, { type: 'job', id, mode, label });
          await pool.withSession(srcEp, async (srcSession) =>
            pool.withSession(dstEp, async (dstSession) => {
              const srcFs = new RemoteFs(srcSession);
              const srcResolved = await srcFs.expandHome(src.path);
              const base = srcFs.path.basename(srcResolved);
              const dstFs = new RemoteFs(dstSession);
              const dstDir = await dstFs.expandHome(dst.dir);
              const dstPath = dstFs.path.join(dstDir, base);
              await engine.remoteToRemote(srcSession, srcResolved, dstSession, dstPath, {
                recursive,
                signal: ctrl.signal,
                onProgress,
              });
            }),
          );
        }
        send(ws, { type: 'done', id });
      } catch (e) {
        send(ws, { type: 'error', id, message: e instanceof Error ? e.message : String(e) });
      } finally {
        activeJobs.delete(id);
      }
    }
  });
});

function basenameLoose(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`webscp running on http://${HOST}:${PORT}`);
});

function shutdown(): void {
  pool.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
