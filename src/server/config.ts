import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Local HTTP settings. SSH inventory is read only from SSHM_CONFIG_DIR. */
export interface ServerConfig {
  /**
   * Allow connections from other machines.
   *   false (default) -> bind 127.0.0.1, loopback only (production)
   *   true            -> bind 0.0.0.0, reachable from the network (testing)
   * Ignored when an explicit `host` (or $WEBSCP_HOST) is set.
   * NOTE: there is no authentication — only enable on a trusted network.
   */
  allowRemoteAccess?: boolean;
  /**
   * Explicit bind address. Overrides `allowRemoteAccess` when set. Leave unset
   * and use `allowRemoteAccess` for the common loopback/network toggle.
   */
  host?: string;
  /** Listen port. Default 8088. */
  port?: number;
}

export interface WebscpConfig {
  server?: ServerConfig;
}

const LOOPBACK_HOST = '127.0.0.1';
const ALL_INTERFACES_HOST = '0.0.0.0';
const DEFAULT_PORT = 8088;

/** Expand a leading "~" against the current user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the config.json location:
 *   $WEBSCP_CONFIG  >  <app-root>/config.json
 * The app root is the directory that contains dist/ and package.json, derived
 * from this module's location so the repo stays relocatable.
 */
export function resolveConfigPath(explicit?: string): string {
  if (explicit) return expandHome(explicit);
  if (process.env.WEBSCP_CONFIG) return expandHome(process.env.WEBSCP_CONFIG);
  // __dirname is <app-root>/dist/server at runtime; climb to <app-root>.
  return path.join(__dirname, '..', '..', 'config.json');
}

function readConfigFile(explicit?: string): WebscpConfig {
  const file = resolveConfigPath(explicit);
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config.json must be a JSON object: ${file}`);
  }
  return parsed as WebscpConfig;
}

let cachedConfig: WebscpConfig | null = null;

export function getConfig(explicit?: string): WebscpConfig {
  if (!cachedConfig) cachedConfig = readConfigFile(explicit);
  return cachedConfig;
}

export function reloadConfig(explicit?: string): WebscpConfig {
  cachedConfig = readConfigFile(explicit);
  return cachedConfig;
}

/** The same group directory used by sshm; app-local inventory is ignored. */
export function inventorySourceLabel(): string {
  return path.resolve(expandHome(process.env.SSHM_CONFIG_DIR || '~/sshm_config'));
}

/**
 * Server bind settings. Host precedence:
 *   1. $WEBSCP_HOST                       (explicit override)
 *   2. config.server.host                 (explicit override)
 *   3. config.server.allowRemoteAccess    -> 0.0.0.0 (true) / 127.0.0.1 (false)
 *   4. 127.0.0.1                          (safe default: loopback only)
 * `remote` reports whether the resulting bind is reachable off-box.
 */
export function serverSettings(
  explicitConfigPath?: string,
): { host: string; port: number; remote: boolean } {
  const cfg = getConfig(explicitConfigPath);
  let host = process.env.WEBSCP_HOST || cfg.server?.host;
  if (!host) {
    host = cfg.server?.allowRemoteAccess ? ALL_INTERFACES_HOST : LOOPBACK_HOST;
  }
  const port = Number(process.env.WEBSCP_PORT) || cfg.server?.port || DEFAULT_PORT;
  const remote = host !== LOOPBACK_HOST && host !== 'localhost';
  return { host, port, remote };
}
