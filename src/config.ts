import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';

export const DEFAULT_HOST = 'us.agent.workday.com';
export const DEFAULT_PROFILE = 'default';

/** Controls which credential, if any, is sent to an agent's own A2A endpoint. */
export type AgentAuthMode = 'none' | 'workday' | 'bearer';

/** A saved profile holds one tenant login. Every field can be overridden by an ASOR_* environment variable. */
export interface Profile {
  /** Workday agent host, e.g. `us.agent.workday.com`. A scheme is optional; https is assumed. */
  host?: string;
  /** Tenant alias, sent as `wd-agent-tenant-alias` and used in the token URL. */
  tenant?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** Override for the OAuth token endpoint. Defaults to `https://{host}/auth/oauth2/{tenant}/token`. */
  tokenUrl?: string;
  /** Override for the ASOR API base. Defaults to `https://{host}/asor/v1`. */
  asorBaseUrl?: string;
  agentAuth?: AgentAuthMode;
  /** How the refresh token was obtained: pasted in, or via `asor login --authorize` (Authorization Code grant). */
  authMode?: 'refresh_token' | 'authorization_code';
  /** Authorization Code settings, kept so re-authorizing needs no flags. */
  authorizeUrl?: string;
  redirectUri?: string;
  /** ISO time of the last successful `--authorize`. */
  authorizedAt?: string;
  /** Refresh token lifetime in days, from Workday's response or `--refresh-ttl-days`. Informational. */
  refreshTokenTtlDays?: number;
  /** Token-endpoint client authentication: `post` (default; form body) or `basic` (HTTP Basic header). */
  clientAuth?: 'post' | 'basic';
}

export interface ConfigFile {
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

/** The fully resolved settings a command runs with. */
export interface ResolvedConfig {
  profileName: string;
  host: string;
  tenant: string;
  tokenUrl: string;
  asorBaseUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  refreshToken: string | undefined;
  /** A pre-minted access token (ASOR_ACCESS_TOKEN). When set, the refresh-token exchange is skipped. */
  accessToken: string | undefined;
  agentAuth: AgentAuthMode;
  /** A static bearer token for agent endpoints (ASOR_AGENT_TOKEN), used when agentAuth is `bearer`. */
  agentToken: string | undefined;
  /** Where the refresh token came from, so rotation knows where (and whether) it can persist the new one. */
  refreshTokenSource: 'env' | 'tokenFile' | 'file' | 'none';
  /** ASOR_REFRESH_TOKEN_FILE: a writable file holding the refresh token, rewritten on rotation. For bot hosts. */
  refreshTokenFile: string | undefined;
  profileExists: boolean;
  authMode: 'refresh_token' | 'authorization_code';
  authorizedAt: string | undefined;
  refreshTokenTtlDays: number | undefined;
  clientAuth: 'post' | 'basic';
}

type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  if (env.ASOR_CONFIG_DIR) return env.ASOR_CONFIG_DIR;
  if (process.platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'asor-cli');
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'asor-cli');
}

export function configPath(env: Env = process.env): string {
  return join(configDir(env), 'config.json');
}

export function readConfigFile(env: Env = process.env): ConfigFile {
  const path = configPath(env);
  if (!existsSync(path)) return { profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConfigFile>;
    return { defaultProfile: parsed.defaultProfile, profiles: parsed.profiles ?? {} };
  } catch (err) {
    throw new CliError('config', `Could not parse ${path}.`, { hint: 'Fix or delete the file, then run `asor login` again.', cause: err });
  }
}

/** Writes a file that only the current user can read. Writes to a temp file first so a crash never leaves half a config. */
export function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is a no-op on Windows; the file lives under the user's own profile directory there.
  }
}

export function writeConfigFile(file: ConfigFile, env: Env = process.env): void {
  writePrivateFile(configPath(env), `${JSON.stringify(file, null, 2)}\n`);
}

export function saveProfile(name: string, profile: Profile, opts: { makeDefault?: boolean; env?: Env } = {}): void {
  const env = opts.env ?? process.env;
  const file = readConfigFile(env);
  file.profiles[name] = stripUndefined({ ...file.profiles[name], ...profile });
  if (opts.makeDefault || !file.defaultProfile) file.defaultProfile = name;
  writeConfigFile(file, env);
}

export function removeProfile(name: string, env: Env = process.env): boolean {
  const file = readConfigFile(env);
  if (!file.profiles[name]) return false;
  delete file.profiles[name];
  if (file.defaultProfile === name) {
    const next = Object.keys(file.profiles)[0];
    if (next) file.defaultProfile = next;
    else delete file.defaultProfile;
  }
  writeConfigFile(file, env);
  return true;
}

export function normalizeOrigin(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Merges the saved profile with ASOR_* environment variables (env wins) and fills in derived URLs.
 * Bots can run on environment variables alone and never touch the config file.
 */
export function resolveConfig(opts: { profile?: string; env?: Env } = {}): ResolvedConfig {
  const env = opts.env ?? process.env;
  const file = readConfigFile(env);
  const profileName = opts.profile ?? env.ASOR_PROFILE ?? file.defaultProfile ?? DEFAULT_PROFILE;
  const saved = file.profiles[profileName] ?? {};
  if ((opts.profile || env.ASOR_PROFILE) && !file.profiles[profileName]) {
    throw new CliError('config', `Profile "${profileName}" does not exist.`, { hint: 'Run `asor profiles` to see saved profiles, or `asor login --profile ' + profileName + '`.' });
  }

  const host = env.ASOR_HOST ?? saved.host ?? DEFAULT_HOST;
  const tenant = env.ASOR_TENANT ?? saved.tenant;
  if (!tenant) {
    throw new CliError('config', 'No Workday tenant is configured.', { hint: 'Run `asor login`, or set ASOR_TENANT (and ASOR_CLIENT_ID, ASOR_CLIENT_SECRET, ASOR_REFRESH_TOKEN).' });
  }
  const origin = normalizeOrigin(host);
  const agentAuth = parseAgentAuth(env.ASOR_AGENT_AUTH ?? saved.agentAuth ?? (env.ASOR_AGENT_TOKEN ? 'bearer' : 'none'));

  return {
    profileName,
    host,
    tenant,
    tokenUrl: env.ASOR_TOKEN_URL ?? saved.tokenUrl ?? `${origin}/auth/oauth2/${encodeURIComponent(tenant)}/token`,
    asorBaseUrl: (env.ASOR_BASE_URL ?? saved.asorBaseUrl ?? `${origin}/asor/v1`).replace(/\/+$/, ''),
    clientId: env.ASOR_CLIENT_ID ?? saved.clientId,
    clientSecret: env.ASOR_CLIENT_SECRET ?? saved.clientSecret,
    refreshToken: env.ASOR_REFRESH_TOKEN ?? readTokenFile(env.ASOR_REFRESH_TOKEN_FILE) ?? saved.refreshToken,
    accessToken: env.ASOR_ACCESS_TOKEN || undefined,
    agentAuth,
    agentToken: env.ASOR_AGENT_TOKEN || undefined,
    refreshTokenSource: env.ASOR_REFRESH_TOKEN ? 'env' : env.ASOR_REFRESH_TOKEN_FILE ? 'tokenFile' : saved.refreshToken ? 'file' : 'none',
    refreshTokenFile: env.ASOR_REFRESH_TOKEN ? undefined : env.ASOR_REFRESH_TOKEN_FILE || undefined,
    profileExists: Boolean(file.profiles[profileName]),
    authMode: saved.authMode ?? 'refresh_token',
    authorizedAt: saved.authorizedAt,
    refreshTokenTtlDays: saved.refreshTokenTtlDays,
    clientAuth: parseClientAuthValue(env.ASOR_CLIENT_AUTH ?? saved.clientAuth ?? 'post'),
  };
}

function readTokenFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch (err) {
    throw new CliError('config', `Cannot read ASOR_REFRESH_TOKEN_FILE (${path}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.`, {
      hint: 'Create the file with the refresh token in it, and make it writable: asor replaces it each time Workday rotates the token.',
    });
  }
}

function parseClientAuthValue(value: string): 'post' | 'basic' {
  if (value === 'post' || value === 'basic') return value;
  throw new CliError('config', `Unknown client auth method "${value}".`, { hint: 'Set ASOR_CLIENT_AUTH (or --client-auth) to post or basic.' });
}

export function parseAgentAuth(value: string): AgentAuthMode {
  if (value === 'none' || value === 'workday' || value === 'bearer') return value;
  throw new CliError('usage', `Unknown agent auth mode "${value}".`, { hint: 'Use one of: none, workday, bearer.' });
}

/** Masks a secret for display: keeps the first and last 3 characters of long values. */
export function mask(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '')) as T;
}
