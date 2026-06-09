import { Endpoint, Inventory, adhocEndpoint } from '@ssh-manager/core';
import { EndpointRef } from '../shared/types';

let cached: Inventory | null = null;

export function getInventory(): Inventory {
  if (!cached) cached = Inventory.load();
  return cached;
}

export function reloadInventory(): Inventory {
  cached = Inventory.load();
  return cached;
}

/** Turn a wire EndpointRef into a resolved core Endpoint. */
export function resolveRef(ref: EndpointRef): Endpoint {
  if (ref.source === 'adhoc') {
    if (!ref.adhoc) throw new Error('adhoc endpoint requires connection fields');
    const a = ref.adhoc;
    if (!a.host || !a.user) throw new Error('adhoc endpoint requires host and user');
    return adhocEndpoint(a);
  }
  if (!ref.selector) throw new Error('inventory endpoint requires a selector');
  return getInventory().resolve(ref.selector, ref.sub);
}
