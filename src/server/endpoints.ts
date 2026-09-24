import * as fs from 'fs';
import * as path from 'path';
import { createHash, createHmac, randomBytes } from 'crypto';
import { Endpoint, Inventory, SshCredentials, adhocEndpoint } from '@ssh-manager/core';
import { EndpointRef, InventoryCatalog } from '../shared/types';
import { inventorySourceLabel } from './config';

const revisionKey = randomBytes(32);
const GROUP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

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
    if (typeof c.host !== 'string' || !c.host.trim() || typeof c.user !== 'string' || !c.user.trim()
      || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) {
      throw new Error('Each SSH connection requires a host, user, and integer port from 1 to 65535');
    }
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
export function resolveRef(ref: EndpointRef): Endpoint {
  if (!ref || typeof ref !== 'object') throw new Error('endpoint required');
  if (ref.source === 'adhoc') {
    if (!ref.adhoc?.host || !ref.adhoc.user) throw new Error('adhoc endpoint requires host and user');
    for (const c of [ref.adhoc, ref.adhoc.jump]) {
      if (c?.port !== undefined && (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)) {
        throw new Error('SSH requires an integer port from 1 to 65535');
      }
    }
    return validateEndpoint(adhocEndpoint(ref.adhoc));
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
