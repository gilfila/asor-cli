import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, saveProfile, writePrivateFile, type ResolvedConfig } from './config.js';
import { CliError } from './errors.js';

export type FetchLike = typeof fetch;
type Env = Record<string, string | undefined>;

export interface TokenInfo {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  source: 'env' | 'cache' | 'exchange';
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  refresh_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Refresh the access token this many ms before Workday says it expires. */
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TTL_S = 3600;

export interface TokenProviderOptions {
  fetch?: FetchLike;
  env?: Env;
  /** Called with warnings meant for stderr (e.g. a rotated refresh token that could not be saved). */
  warn?: (message: string) => void;
  /** Disable the on-disk access token cache. Also disabled by ASOR_NO_TOKEN_CACHE=1. */
  noDiskCache?: boolean;
}

/**
 * Exchanges the Workday refresh token for access tokens and caches them.
 *
 * Every CLI call is a fresh process (a bot may run hundreds a day), so access tokens are also cached on disk,
 * keyed by a hash of the token URL, client, and refresh token. The cache file sits beside the config with 0600 permissions.
 */
export class TokenProvider {
  private readonly cfg: ResolvedConfig;
  private readonly fetchImpl: FetchLike;
  private readonly env: Env;
  private readonly warn: (message: string) => void;
  private readonly diskCache: boolean;
  private current: TokenInfo | undefined;

  constructor(cfg: ResolvedConfig, opts: TokenProviderOptions = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetch ?? fetch;
    this.env = opts.env ?? process.env;
    this.warn = opts.warn ?? ((m) => process.stderr.write(`asor: warning: ${m}\n`));
    this.diskCache = !(opts.noDiskCache || this.env.ASOR_NO_TOKEN_CACHE === '1');
  }

  async getToken(opts: { forceRefresh?: boolean } = {}): Promise<TokenInfo> {
    if (this.cfg.accessToken) {
      return { accessToken: this.cfg.accessToken, expiresAt: Number.POSITIVE_INFINITY, source: 'env' };
    }
    if (!opts.forceRefresh) {
      if (this.current && this.current.expiresAt - EXPIRY_SKEW_MS > Date.now()) return this.current;
      const cached = this.readCache();
      if (cached) return (this.current = cached);
    }
    return (this.current = await this.exchange());
  }

  async getAccessToken(): Promise<string> {
    return (await this.getToken()).accessToken;
  }

  /** Drops cached tokens, e.g. after the API answered 401 with a token we believed was valid. */
  invalidate(): void {
    this.current = undefined;
    if (!this.diskCache) return;
    const all = this.readCacheFile();
    if (all[this.cacheKey()]) {
      delete all[this.cacheKey()];
      writePrivateFile(this.cachePath(), JSON.stringify(all));
    }
  }

  private async exchange(): Promise<TokenInfo> {
    const { clientId, clientSecret, refreshToken, tokenUrl } = this.cfg;
    const missing = [
      !clientId && 'client id (ASOR_CLIENT_ID)',
      !clientSecret && 'client secret (ASOR_CLIENT_SECRET)',
      !refreshToken && 'refresh token (ASOR_REFRESH_TOKEN)',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new CliError('config', `Missing ${missing.join(', ')}.`, { hint: 'Run `asor login`, or set the ASOR_* environment variables. See the README section "Tenant setup".' });
    }

    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken! });
    const res = await this.fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    let json: TokenResponse = {};
    try {
      json = text ? (JSON.parse(text) as TokenResponse) : {};
    } catch {
      // Workday sometimes answers auth failures with HTML; fall through to the status handling below.
    }

    if (!res.ok || !json.access_token) {
      const reason = json.error_description ?? json.error ?? (text.slice(0, 200) || res.statusText);
      const hint =
        res.status === 400 || res.status === 401
          ? 'The refresh token or client credentials were rejected. Generate a new refresh token for the integration user, check the client id/secret, and confirm the token URL (see `asor whoami`).'
          : res.status === 404
            ? 'Token endpoint not found. Check the host and tenant alias, or set ASOR_TOKEN_URL (e.g. https://{host}/ccx/oauth2/{tenant}/token).'
            : undefined;
      throw new CliError('auth', `Token exchange failed (HTTP ${res.status}): ${reason}`, { status: res.status, ...(hint ? { hint } : {}) });
    }

    if (json.refresh_token && json.refresh_token !== refreshToken) this.handleRotation(json.refresh_token);

    const ttl = Number(json.expires_in ?? DEFAULT_TTL_S) || DEFAULT_TTL_S;
    const info: TokenInfo = { accessToken: json.access_token, expiresAt: Date.now() + ttl * 1000, source: 'exchange' };
    this.writeCache(info);
    return info;
  }

  /** Workday can rotate refresh tokens. Keep the new one, or tell the operator loudly if it can't be kept. */
  private handleRotation(newToken: string): void {
    if (this.cfg.refreshTokenSource === 'file' && this.cfg.profileExists) {
      saveProfile(this.cfg.profileName, { refreshToken: newToken }, { env: this.env });
      this.cfg.refreshToken = newToken;
      return;
    }
    this.cfg.refreshToken = newToken;
    this.warn(
      'Workday issued a new refresh token, but the current one came from ASOR_REFRESH_TOKEN, so it was not saved. ' +
        'If your API client rotates refresh tokens, update the secret in your bot host, or store it with `asor login`.',
    );
  }

  private cachePath(): string {
    return join(configDir(this.env), 'token-cache.json');
  }

  private cacheKey(): string {
    return createHash('sha256')
      .update([this.cfg.tokenUrl, this.cfg.clientId, this.cfg.refreshToken].join('\n'))
      .digest('hex')
      .slice(0, 32);
  }

  private readCacheFile(): Record<string, { accessToken: string; expiresAt: number }> {
    const path = this.cachePath();
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return {};
    }
  }

  private readCache(): TokenInfo | undefined {
    if (!this.diskCache) return undefined;
    const hit = this.readCacheFile()[this.cacheKey()];
    if (!hit || hit.expiresAt - EXPIRY_SKEW_MS <= Date.now()) return undefined;
    return { accessToken: hit.accessToken, expiresAt: hit.expiresAt, source: 'cache' };
  }

  private writeCache(info: TokenInfo): void {
    if (!this.diskCache) return;
    try {
      const now = Date.now();
      const all = Object.fromEntries(Object.entries(this.readCacheFile()).filter(([, v]) => v.expiresAt > now));
      all[this.cacheKey()] = { accessToken: info.accessToken, expiresAt: info.expiresAt };
      writePrivateFile(this.cachePath(), JSON.stringify(all));
    } catch (err) {
      this.warn(`could not write the token cache (${(err as Error).message}); continuing without it.`);
    }
  }
}
