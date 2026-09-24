import { AsorClient } from './asor.js';
import { TokenProvider, type FetchLike } from './auth.js';
import { parseAgentAuth, resolveConfig, type ResolvedConfig } from './config.js';
import { toCliError } from './errors.js';
import { errorEnvelope } from './output.js';

export interface GlobalFlags {
  profile?: string;
  json?: boolean;
  verbose?: boolean;
  agentAuth?: string;
}

export interface Context {
  cfg: ResolvedConfig;
  tokens: TokenProvider;
  client: AsorClient;
  flags: GlobalFlags;
  debug: (message: string) => void;
  fetch: FetchLike;
}

export function stderr(message: string): void {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

export function stdout(message: string): void {
  process.stdout.write(message.endsWith('\n') ? message : `${message}\n`);
}

/** Resolves config and builds the token provider and ASOR client that every tenant-facing command uses. */
export function createContext(flags: GlobalFlags, opts: { fetch?: FetchLike } = {}): Context {
  const cfg = resolveConfig(flags.profile ? { profile: flags.profile } : {});
  if (flags.agentAuth) cfg.agentAuth = parseAgentAuth(flags.agentAuth);
  const debug = flags.verbose ? (m: string) => stderr(`asor: ${m}`) : () => {};
  const fetchImpl = opts.fetch ?? fetch;
  const tokens = new TokenProvider(cfg, { fetch: fetchImpl });
  const client = new AsorClient(cfg, tokens, { fetch: fetchImpl, debug });
  return { cfg, tokens, client, flags, debug, fetch: fetchImpl };
}

/** Just the variables that say where config lives, without any ASOR_* credential overrides. */
export function configLocationEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    ['ASOR_CONFIG_DIR', 'APPDATA', 'XDG_CONFIG_HOME', 'ASOR_NO_TOKEN_CACHE'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
}

/**
 * Tests a saved profile exactly as stored, ignoring ASOR_* credential overrides, so `login` verifies what the user
 * just typed rather than whatever the environment happens to hold. Returns the number of visible agents.
 */
export async function verifySavedProfile(profile: string, opts: { fetch?: FetchLike } = {}): Promise<{ tenant: string; agents: number }> {
  const locationOnly = configLocationEnv();
  const cfg = resolveConfig({ profile, env: locationOnly });
  const fetchImpl = opts.fetch ?? fetch;
  const tokens = new TokenProvider(cfg, { fetch: fetchImpl, env: locationOnly });
  tokens.invalidate();
  await tokens.getToken({ forceRefresh: true });
  const agents = await new AsorClient(cfg, tokens, { fetch: fetchImpl }).listAgents();
  return { tenant: cfg.tenant, agents: agents.length };
}

/** Prints an error (as a JSON envelope with --json, otherwise as text on stderr) and returns its exit code. */
export function reportError(err: unknown, json: boolean, prefix = 'asor'): number {
  const e = toCliError(err);
  if (json) stdout(JSON.stringify(errorEnvelope(e)));
  else {
    stderr(`${prefix}: error: ${e.message}`);
    if (e.hint) stderr(`  hint: ${e.hint}`);
    if (e.kind === 'internal' && process.env.ASOR_DEBUG && e.cause instanceof Error) stderr(e.cause.stack ?? '');
  }
  return e.exitCode;
}
