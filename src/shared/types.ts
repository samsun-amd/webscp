// Wire types shared between the webscp server and browser client.

export interface EndpointRef {
  /** "inventory" => resolve via ssh_remote.json; "adhoc" => explicit creds. */
  source: 'inventory' | 'adhoc';
  /** For inventory: selector (name/num/ip). */
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
  dst: { endpoint: EndpointRef; dir: string };
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
