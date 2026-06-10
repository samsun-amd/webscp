import * as fs from 'fs';
import { CredBlock, Inventory, InventoryNode } from '@ssh-manager/core';
import {
  WebscpConfig,
  expandHome,
  getConfig,
  loadInventory,
  reloadConfig,
  resolveConfigPath,
} from './config';

/**
 * Persisting layer for config.json node CRUD.
 *
 * Two invariants drive this module:
 *  - Passwords are never sent to the browser, so an edit that omits a password
 *    must KEEP the stored one. We merge incoming nodes against current storage
 *    per credential block.
 *  - We must never silently diverge from a legacy ~/note/ssh_remote.json: the
 *    first write seeds a fresh config.json from the currently-resolved
 *    inventory so config.json becomes the single source of truth from then on.
 */

const CRED_KEYS: Array<'ip' | 'user' | 'pass' | 'port' | 'os'> = ['ip', 'user', 'pass', 'port', 'os'];

/** A node shape as it travels to/from the browser: passwords are stripped. */
export interface RedactedCred {
  ip?: string;
  user?: string;
  port?: number;
  os?: string;
  hasPass: boolean;
}
export interface RedactedNode {
  type: 'client' | 'server';
  name: string;
  note?: string;
  // client creds live at top level
  ip?: string;
  user?: string;
  port?: number;
  os?: string;
  hasPass?: boolean;
  bmc?: RedactedCred;
  smc?: RedactedCred;
  hosts?: RedactedCred[];
}

function redactCred(c: CredBlock | undefined): RedactedCred | undefined {
  if (!c) return undefined;
  return { ip: c.ip, user: c.user, port: c.port, os: c.os, hasPass: !!c.pass };
}

/** Strip every password from a node, replacing it with a hasPass flag. */
export function redactNode(n: InventoryNode): RedactedNode {
  const out: RedactedNode = { type: n.type, name: n.name, note: n.note };
  if (n.type === 'client') {
    out.ip = n.ip;
    out.user = n.user;
    out.port = n.port;
    out.os = n.os;
    out.hasPass = !!n.pass;
  } else {
    out.bmc = redactCred(n.bmc);
    out.smc = redactCred(n.smc);
    out.hosts = (n.hosts || []).map((h) => redactCred(h)!);
  }
  return out;
}

/**
 * The inventory nodes config.json should operate on. If config.json already has
 * inline nodes, use them; otherwise seed from the currently-resolved inventory
 * (env / legacy file) so the first write captures the real state.
 */
function currentNodes(): InventoryNode[] {
  const cfg = getConfig();
  if (cfg.inventory && cfg.inventory.length > 0) return cfg.inventory;
  const inv: Inventory = loadInventory();
  return inv.raw();
}

/** Return all nodes with passwords stripped, for the management UI. */
export function listNodesRedacted(): RedactedNode[] {
  return currentNodes().map(redactNode);
}

function cleanCred(incoming: RawCredInput | undefined, existing: CredBlock | undefined): CredBlock | undefined {
  if (!incoming) return undefined;
  const ip = (incoming.ip || '').trim();
  const user = (incoming.user || '').trim();
  if (!ip || !user) throw httpErr(400, 'each connection needs an ip and a user');
  const out: CredBlock = { ip, user };
  if (incoming.port && Number(incoming.port) > 0) out.port = Number(incoming.port);
  if (incoming.os === 'posix' || incoming.os === 'windows') out.os = incoming.os;
  // Password preservation: empty/omitted keeps the existing secret.
  const pass = typeof incoming.pass === 'string' ? incoming.pass : '';
  if (pass) out.pass = pass;
  else if (existing && existing.pass) out.pass = existing.pass;
  return out;
}

/** Build a storable node from an incoming (possibly password-less) payload. */
function normalizeNode(incoming: RawNodeInput, existing: InventoryNode | undefined): InventoryNode {
  const name = (incoming.name || '').trim();
  if (!name) throw httpErr(400, 'node name is required');
  const type = incoming.type;
  if (type !== 'client' && type !== 'server') throw httpErr(400, 'type must be "client" or "server"');

  const node: InventoryNode = { type, name };
  if (incoming.note && incoming.note.trim()) node.note = incoming.note.trim();

  if (type === 'client') {
    const existingClientCred: CredBlock | undefined =
      existing && existing.ip && existing.user
        ? { ip: existing.ip, user: existing.user, pass: existing.pass, port: existing.port, os: existing.os }
        : undefined;
    const cred = cleanCred(
      { ip: incoming.ip, user: incoming.user, pass: incoming.pass, port: incoming.port, os: incoming.os },
      existingClientCred,
    );
    if (!cred) throw httpErr(400, 'client needs ip and user');
    node.ip = cred.ip;
    node.user = cred.user;
    if (cred.port) node.port = cred.port;
    if (cred.os) node.os = cred.os;
    if (cred.pass) node.pass = cred.pass;
    return node;
  }

  // server
  const bmc = cleanCred(incoming.bmc, existing?.bmc);
  if (!bmc) throw httpErr(400, 'server needs a BMC ip and user');
  node.bmc = bmc;
  if (incoming.smc && (incoming.smc.ip || incoming.smc.user)) {
    node.smc = cleanCred(incoming.smc, existing?.smc);
  }
  if (Array.isArray(incoming.hosts) && incoming.hosts.length) {
    node.hosts = incoming.hosts.map((h, i) => cleanCred(h, existing?.hosts?.[i])!);
  }
  return node;
}

export interface RawCredInput {
  ip?: string;
  user?: string;
  pass?: string;
  port?: number;
  os?: string;
}
export interface RawNodeInput extends RawCredInput {
  type: 'client' | 'server';
  name: string;
  note?: string;
  bmc?: RawCredInput;
  smc?: RawCredInput;
  hosts?: RawCredInput[];
}

interface HttpError extends Error {
  status: number;
}
function httpErr(status: number, message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.status = status;
  return e;
}

/** Atomically persist the inventory back to config.json (preserving server cfg). */
function persist(nodes: InventoryNode[]): void {
  const file = resolveConfigPath();
  const cfg: WebscpConfig = { ...getConfig() };
  // config.json becomes the source of truth: store inline, drop any path indirection.
  cfg.inventory = nodes;
  delete cfg.inventoryPath;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  reloadConfig();
}

function findIndex(nodes: InventoryNode[], name: string): number {
  return nodes.findIndex((n) => n.name === name);
}

/** Create a new node. Fails if the name already exists. */
export function createNode(input: RawNodeInput): void {
  const nodes = currentNodes().slice();
  const node = normalizeNode(input, undefined);
  if (findIndex(nodes, node.name) >= 0) throw httpErr(409, `a node named '${node.name}' already exists`);
  nodes.push(node);
  persist(nodes);
}

/** Update an existing node (by current name). May rename via input.name. */
export function updateNode(currentName: string, input: RawNodeInput): void {
  const nodes = currentNodes().slice();
  const idx = findIndex(nodes, currentName);
  if (idx < 0) throw httpErr(404, `node '${currentName}' not found`);
  const node = normalizeNode(input, nodes[idx]);
  if (node.name !== currentName && findIndex(nodes, node.name) >= 0) {
    throw httpErr(409, `a node named '${node.name}' already exists`);
  }
  nodes[idx] = node;
  persist(nodes);
}

/** Delete a node by name. */
export function deleteNode(name: string): void {
  const nodes = currentNodes().slice();
  const idx = findIndex(nodes, name);
  if (idx < 0) throw httpErr(404, `node '${name}' not found`);
  nodes.splice(idx, 1);
  persist(nodes);
}
