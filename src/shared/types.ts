// Wire types shared between the webscp server and browser client.

export interface EndpointRef {
  /**
   * "inventory" => resolve within an sshm group; "adhoc" => explicit creds;
   * "local" => the hub machine itself (Node fs, no SSH).
   */
  source: 'inventory' | 'adhoc' | 'local';
  /** Inventory group name (derived from its filename). */
  group?: string;
  /** Opaque revision; stale references must never resolve to a changed target. */
  revision?: string;
  /** For inventory: selector (name/num/ip). UI refs use 1-based node numbers. */
  selector?: string;
  /** For inventory: optional sub-target (bmc / smc / hostN). */
  sub?: string;
  /** For adhoc: explicit connection fields. */
  adhoc?: {
    host: string;
    port?: number;
    user: string;
    password?: string;
    os?: 'posix' | 'windows';
    jump?: { host: string; port?: number; user: string; password?: string };
  };
}

export interface ListRequest {
  endpoint: EndpointRef;
  path: string; // "" or "~" => remote home
}

export interface ListResponse {
  cwd: string;
  os: 'posix' | 'windows';
  entries: Array<{
    name: string;
    path: string;
    type: 'file' | 'dir' | 'symlink' | 'other';
    size: number;
    mtime: number | null;
  }>;
}

export interface TransferRequest {
  src: { endpoint: EndpointRef; path: string };
  dst: { endpoint: EndpointRef; dir: string; name?: string };
  recursive?: boolean;
}

// ws messages, server -> client.
export type WsServerMessage =
  | { type: 'job'; id: string; mode: 'direct' | 'relay'; label: string }
  | { type: 'progress'; id: string; bytes: number; total: number | null; file: string }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; message: string };

// ws messages, client -> server.
export type WsClientMessage =
  | { type: 'transfer'; reqId: string; payload: TransferRequest }
  | { type: 'cancel'; id: string };

export interface EndpointOption {
  key: string;
  group: string;
  label: string;
  ref: EndpointRef;
}

export interface InventoryCatalog {
  groups: Array<{ name: string; number?: number; error?: string }>;
  options: EndpointOption[];
  warnings: string[];
}
