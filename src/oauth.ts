import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FetchLike } from './auth.js';
import { CliError } from './errors.js';
import { openBrowser } from './open.js';

/**
 * OAuth 2.0 Authorization Code flow for Workday API clients registered with that grant (the kind the ASOR scope uses).
 *
 * `asor login --authorize` opens Workday's authorize page, gets the code back, exchanges it for a refresh token, and
 * stores that token in the profile. From then on the normal refresh-token path is used.
 *
 * The code comes back in one of two ways:
 *  - callback mode: the client's redirect URI is http://localhost:<port>/<path>, and we listen there for one request;
 *  - paste mode: any other redirect URI (e.g. https://cb.myworkday.com/cb1); the user pastes the URL they land on.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function pkcePair(verifier = randomBytes(32).toString('base64url')): PkcePair {
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrlFor(host: string, tenant: string): string {
  const origin = /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`;
  return `${origin}/auth/authorize/${encodeURIComponent(tenant)}`;
}

export function buildAuthorizeUrl(base: string, p: { clientId: string; redirectUri: string; state: string; challenge?: string; scope?: string }): string {
  const url = new URL(base);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('state', p.state);
  if (p.scope) url.searchParams.set('scope', p.scope);
  if (p.challenge) {
    url.searchParams.set('code_challenge', p.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/** True for redirect URIs we can receive ourselves: plain http on a loopback host with an explicit port. */
export function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.port !== '';
  } catch {
    return false;
  }
}

/**
 * Extracts the code from what the user pasted: the full redirected URL, its query string, or the bare code.
 * The state is checked whenever it is present (a bare code cannot carry one).
 */
export function parseRedirect(input: string, expectedState: string): { code: string; stateChecked: boolean } {
  const text = input.trim();
  if (!text) throw new CliError('usage', 'Nothing was pasted.');
  let params: URLSearchParams | undefined;
  if (/^https?:\/\//i.test(text)) params = new URL(text).searchParams;
  else if (text.includes('code=') || text.includes('error=')) params = new URLSearchParams(text.replace(/^[?#]/, ''));

  if (!params) {
    if (/\s/.test(text)) throw new CliError('usage', 'That does not look like a URL or an authorization code.');
    return { code: text, stateChecked: false };
  }
  return { code: codeFromParams(params, expectedState), stateChecked: true };
}

function codeFromParams(params: URLSearchParams, expectedState: string): string {
  const error = params.get('error');
  if (error) {
    const desc = params.get('error_description');
    throw new CliError('auth', `Workday declined the authorization: ${error}${desc ? ` (${desc})` : ''}.`, {
      hint: error === 'access_denied' ? 'Run the command again and choose Allow on the consent screen.' : 'Check the API client\'s grant type, redirect URI, and scope in Workday.',
    });
  }
  const state = params.get('state');
  if (state !== expectedState) {
    throw new CliError('auth', 'The authorization response did not match this login attempt (state mismatch).', { hint: 'Start over with `asor login --authorize`, and use the newest browser tab.' });
  }
  const code = params.get('code');
  if (!code) throw new CliError('auth', 'The authorization response had no code.');
  return code;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#16191f"><h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;

/** Listens on the loopback redirect URI for exactly one authorization response. */
export function waitForCallback(redirectUri: string, expectedState: string, timeoutMs: number): { ready: Promise<void>; code: Promise<string>; close: () => void } {
  const target = new URL(redirectUri);
  const port = Number(target.port);
  // `localhost` may resolve to IPv4 or IPv6 in the browser, so listen on both loopback addresses.
  const hosts = target.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [target.hostname.replace(/^\[|\]$/g, '')];
  const servers: Server[] = [];
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const close = () => {
    clearTimeout(timer);
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  };
  const timer = setTimeout(() => {
    settle.reject(new CliError('timeout', 'Timed out waiting for Workday to redirect back.', { hint: 'Finish signing in within 5 minutes, or use --paste if the browser cannot reach localhost.' }));
    close();
  }, timeoutMs);

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== target.pathname) {
      res.writeHead(404).end();
      return;
    }
    try {
      const got = codeFromParams(url.searchParams, expectedState);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('Signed in to Workday', 'asor-cli received the authorization. You can close this tab and return to the terminal.'));
      settle.resolve(got);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in did not complete', 'Return to the terminal for details.'));
      settle.reject(err as Error);
    }
    setImmediate(close);
  };

  const ready = Promise.all(
    hosts.map(
      (host, i) =>
        new Promise<void>((resolve, reject) => {
          const s = createServer(handler);
          s.once('error', (err: NodeJS.ErrnoException) => {
            // IPv6 may be unavailable; only the first address is required.
            if (i > 0) resolve();
            else reject(new CliError('usage', `Cannot listen on ${redirectUri} (${err.code ?? err.message}).`, { hint: 'Another program may be using that port. Close it, or use --paste.' }));
          });
          s.listen(port, host, () => {
            servers.push(s);
            resolve();
          });
        }),
    ),
  ).then(() => undefined);
  return { ready, code, close };
}

export interface CodeExchangeResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  /** Seconds, when the server reports it. */
  refreshTokenExpiresIn?: number;
}

export async function exchangeCode(p: { tokenUrl: string; clientId: string; clientSecret: string; code: string; redirectUri: string; verifier?: string; fetch?: FetchLike }): Promise<CodeExchangeResult> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri });
  if (p.verifier) body.set('code_verifier', p.verifier);
  const res = await (p.fetch ?? fetch)(p.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // fall through
  }
  if (!res.ok || typeof json.access_token !== 'string') {
    const reason = (json.error_description as string) ?? (json.error as string) ?? (text.slice(0, 200) || res.statusText);
    throw new CliError('auth', `Exchanging the authorization code failed (HTTP ${res.status}): ${reason}`, {
      status: res.status,
      hint: 'Check the client secret and that the redirect URI matches the API client exactly. Codes are single-use and expire quickly, so start over with `asor login --authorize`.',
    });
  }
  if (typeof json.refresh_token !== 'string') {
    throw new CliError('auth', 'Workday issued an access token but no refresh token.', {
      hint: 'Make sure the API client has a refresh token timeout set (not zero) so asor can stay signed in.',
    });
  }
  const rtExpires = Number(json.refresh_token_expires_in);
  return {
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in ?? 3600) || 3600,
    refreshToken: json.refresh_token,
    ...(Number.isFinite(rtExpires) && rtExpires > 0 ? { refreshTokenExpiresIn: rtExpires } : {}),
  };
}

export interface AuthorizeFlowOptions {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  pkce: boolean;
  scope?: string;
  open: boolean;
  /** Force paste mode even for a loopback redirect URI. */
  paste: boolean;
  timeoutMs?: number;
  log: (message: string) => void;
  /** Reads one pasted line from the user. */
  readPasted: (prompt: string) => Promise<string>;
  fetch?: FetchLike;
}

export async function runAuthorizeFlow(o: AuthorizeFlowOptions): Promise<CodeExchangeResult> {
  const state = randomBytes(16).toString('base64url');
  const pkce = o.pkce ? pkcePair() : undefined;
  const url = buildAuthorizeUrl(o.authorizeUrl, {
    clientId: o.clientId,
    redirectUri: o.redirectUri,
    state,
    ...(pkce ? { challenge: pkce.challenge } : {}),
    ...(o.scope ? { scope: o.scope } : {}),
  });

  let code: string;
  if (isLoopbackRedirect(o.redirectUri) && !o.paste) {
    const cb = waitForCallback(o.redirectUri, state, o.timeoutMs ?? 5 * 60_000);
    await cb.ready.catch((err: unknown) => {
      cb.close();
      throw err;
    });
    o.log(`Sign in to Workday and approve access in your browser. If it did not open, visit:\n\n  ${url}\n\nWaiting for Workday to redirect to ${o.redirectUri} …`);
    if (o.open) openBrowser(url);
    code = await cb.code;
  } else {
    o.log(`Sign in to Workday and approve access in your browser. If it did not open, visit:\n\n  ${url}\n\nAfter you approve, Workday sends you to ${o.redirectUri}. Copy the full address of that page from the address bar.`);
    if (o.open) openBrowser(url);
    const parsed = parseRedirect(await o.readPasted('Paste the address you landed on'), state);
    if (!parsed.stateChecked) o.log('warning: a bare code was pasted, so the state could not be checked. Pasting the full address is safer.');
    code = parsed.code;
  }

  return exchangeCode({
    tokenUrl: o.tokenUrl,
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    code,
    redirectUri: o.redirectUri,
    ...(pkce ? { verifier: pkce.verifier } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
}
