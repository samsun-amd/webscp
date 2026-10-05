import * as fs from 'fs';
import * as path from 'path';
import { createHash, createHmac, randomBytes } from 'crypto';
import { Endpoint, Inventory, SshCredentials, adhocEndpoint } from '@ssh-manager/core';
import { EndpointRef, InventoryCatalog } from '../shared/types';
import { inventorySourceLabel } from './config';

const revisionKey = randomBytes(32);
const GROUP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function validateCredentials(value: unknown): void {
  if (!isRecord(value) || !isNonemptyString(value.host) || !value.host.trim()
    || !isNonemptyString(value.user) || !value.user.trim()) {
    throw new Error('SSH connection requires host and user strings');
  }
  if (value.port !== undefined && (typeof value.port !== 'number' || !Number.isInteger(value.port)
    || value.port < 1 || value.port > 65535)) {
    throw new Error('SSH requires an integer port from 1 to 65535');
  }
  if (value.password !== undefined && typeof value.password !== 'string') {
    throw new Error('SSH password must be a string');
  }
}

/** Validate every browser endpoint before inventory reads or SSH acquisition. */
export function validateRef(ref: unknown): asserts ref is EndpointRef {
  if (!isRecord(ref)) throw new Error('endpoint required');
  if (ref.source === 'local') return;
  if (ref.source === 'adhoc') {
    validateCredentials(ref.adhoc);
    const adhoc = ref.adhoc as Record<string, unknown>;
    if (adhoc.os !== undefined && adhoc.os !== 'posix' && adhoc.os !== 'windows') {
      throw new Error('SSH OS must be posix or windows');
    }
    if (adhoc.jump !== undefined) validateCredentials(adhoc.jump);
    return;
  }
  if (ref.source !== 'inventory' || !isNonemptyString(ref.group)
    || !isNonemptyString(ref.selector) || !isNonemptyString(ref.revision)) {
    throw new Error('inventory endpoint requires group, selector, and revision strings');
  }
  if (ref.sub !== undefined && (typeof ref.sub !== 'string' || !/^(bmc|smc|host[1-9][0-9]*)$/.test(ref.sub))) {
    throw new Error('Inventory sub-target must be bmc, smc, or hostN');
  }
}

interface Group {
  name: string;
  number?: number;
  inventory?: Inventory;
  revision?: string;
  error?: string;
}

export function loadGroups(): Group[] {
  const directory = inventorySourceLabel();
  // ponytail: scan on request; cache by file metadata if inventories become large.
  let files: string[];
  try {
    files = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const groups: Group[] = [];
  for (const file of files.filter((f) => /^ssh_remote_.*\.json$/.test(f))) {
    const name = file.slice('ssh_remote_'.length, -'.json'.length);
    const group: Group = { name };
    try {
      if (!GROUP_NAME.test(name) || /^\d+$/.test(name)) throw new Error('Invalid group name');
      const raw = fs.readFileSync(path.join(directory, file), 'utf8');
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
      // Parse once so metadata, revision, and nodes describe the same file.
      if (!data || Array.isArray(data) || !Number.isSafeInteger(data.group_number)
        || data.group_number < 0 || !Array.isArray(data.nodes)
        || !data.nodes.every((n: unknown) => n !== null && typeof n === 'object' && !Array.isArray(n))) {
        throw new Error('Expected {group_number: integer, nodes: array}; convert legacy arrays with convert_legacy_config.sh');
      }
      if ((name === 'default') !== (data.group_number === 0)) {
        throw new Error('Group 0 is reserved for ssh_remote_default.json');
      }
      group.number = data.group_number;
      group.inventory = new Inventory(data.nodes);
      // Detect edits without exposing a password-verification hash.
      group.revision = createHmac('sha256', revisionKey).update(raw).digest('hex');
    } catch (error) {
      group.error = error instanceof Error ? error.message : String(error);
    }
    groups.push(group);
  }
  return groups.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.name.localeCompare(b.name));
}

/** Connection identity excludes labels, group membership, and passwords. */
export function connectionIdentity(endpoint: Endpoint): string {
  const tuple = (c: SshCredentials) => [c.host.toLowerCase(), c.port, c.user];
  return createHash('sha256').update(JSON.stringify([
    tuple(endpoint.conn), endpoint.jump ? tuple(endpoint.jump) : null,
  ])).digest('hex');
}

function validateEndpoint(endpoint: Endpoint): Endpoint {
  for (const c of [endpoint.conn, ...(endpoint.jump ? [endpoint.jump] : [])]) {
    validateCredentials(c);
  }
  return endpoint;
}

export function inventoryCatalog(): InventoryCatalog {
  const groups = loadGroups();
  const result: InventoryCatalog = {
    groups: groups.map(({ name, number, error }) => ({ name, number, error })),
    options: [{ key: 'local', group: '', label: 'localhost (this machine)', ref: { source: 'local' } }],
    warnings: [],
  };
  if (!groups.length) result.warnings.push('No sshm groups found. Local and ad-hoc connections are available.');
  const numbers = new Map<number, string>();
  const occurrences = new Map<string, number>();
  for (const group of groups) {
    if (!group.inventory) continue;
    if (numbers.has(group.number!)) {
      result.warnings.push(`Duplicate group number ${group.number}: ${numbers.get(group.number!)} and ${group.name}. Groups are selected by name.`);
    }
    numbers.set(group.number!, group.name);
    group.inventory.raw().forEach((node, index) => {
      if (node.type !== 'client' && node.type !== 'server') {
        if (node.type !== 'smc') result.warnings.push(`${group.name} / node ${index + 1}: unsupported node type is skipped.`);
        return;
      }
      const subs: Array<string | undefined> = node.type === 'client' ? [undefined] : ['bmc'];
      if (node.type === 'server') {
        if (node.hosts && !Array.isArray(node.hosts)) {
          result.warnings.push(`${group.name} / node ${index + 1}: hosts must be an array.`);
        } else {
          (node.hosts || []).forEach((_host, i) => subs.push(`host${i + 1}`));
        }
        if (node.smc) subs.push('smc');
      }
      for (const sub of subs) {
        try {
          const ep = validateEndpoint(group.inventory!.resolve(String(index + 1), sub));
          const identity = JSON.stringify([group.name, node.name, sub ?? '', connectionIdentity(ep), ep.os ?? '']);
          const occurrence = occurrences.get(identity) || 0;
          occurrences.set(identity, occurrence + 1);
          result.options.push({
            key: `${identity}:${occurrence}`,
            group: group.name,
            label: `#${index + 1} ${node.name}${sub ? ` / ${sub}` : ' (client)'}`,
            ref: { source: 'inventory', group: group.name, selector: String(index + 1), sub, revision: group.revision },
          });
        } catch {
          result.warnings.push(`${group.name} / node ${index + 1}${sub ? ` / ${sub}` : ''}: invalid connection configuration.`);
        }
      }
    });
  }
  return result;
}

/** Always check current inventory before using a browser reference. */
export function resolveRef(ref: unknown): Endpoint {
  validateRef(ref);
  if (ref.source === 'adhoc') {
    return validateEndpoint(adhocEndpoint(ref.adhoc!));
  }
  if (ref.source !== 'inventory' || !ref.group || !ref.selector || !ref.revision) {
    throw new Error('inventory endpoint requires group, selector, and revision');
  }
  const group = loadGroups().find((g) => g.name === ref.group);
  if (!group?.inventory) throw new Error('Inventory group is unavailable; reload inventory');
  if (group.revision !== ref.revision) throw new Error('Inventory changed; reload inventory before continuing');
  const ep = validateEndpoint(group.inventory.resolve(ref.selector, ref.sub));
  return { ...ep, id: `${group.name}/${ep.id}` };
}
