import type { FetchLike, TokenProvider } from './auth.js';
import type { ResolvedConfig } from './config.js';
import { CliError } from './errors.js';
import { fetchWithRetry } from './http.js';
import type { AgentCard } from './types.js';

const PAGE_SIZE = 100;
/** Stop paging after this many agents so a server that ignores offset cannot loop forever. */
const MAX_AGENTS = 10_000;

export interface AsorClientOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  debug?: (message: string) => void;
}

/** A thin client for the Workday Agent System of Record API (`/asor/v1/agentDefinition`). */
export class AsorClient {
  private readonly cfg: ResolvedConfig;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly debug: (message: string) => void;

  constructor(cfg: ResolvedConfig, tokens: TokenProvider, opts: AsorClientOptions = {}) {
    this.cfg = cfg;
    this.tokens = tokens;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.debug = opts.debug ?? (() => {});
  }

  /**
   * Lists every agent definition. The v1.2 spec documents no paging parameters, so the first call sends none;
   * limit/offset paging (the Workday REST convention) kicks in only when the response reports a larger `total`.
   */
  async listAgents(): Promise<AgentCard[]> {
    const first = extractList(await this.request('GET', '/agentDefinition'));
    const agents = [...first.items];
    const total = first.total;
    while (total !== undefined && agents.length < total && agents.length < MAX_AGENTS) {
      const page = extractList(await this.request('GET', `/agentDefinition?limit=${PAGE_SIZE}&offset=${agents.length}`));
      if (page.items.length === 0) break;
      agents.push(...page.items);
    }
    return agents;
  }

  async getAgent(id: string): Promise<AgentCard> {
    try {
      return unwrapCard(await this.request('GET', `/agentDefinition/${encodeURIComponent(id)}`));
    } catch (err) {
      // Live ASOR answers 401 (not 404) for an id that does not exist or is not visible. If the same token can still
      // list agents, the credentials are fine and the id is the problem.
      if (err instanceof CliError && err.status === 401 && (await this.canList())) {
        throw new CliError('not_found', `No agent with id "${id}" is visible in ASOR.`, {
          status: 401,
          hint: 'ASOR returns 401 for ids that do not exist or that this user cannot see. Run `asor agents list` to see valid ids.',
        });
      }
      throw err;
    }
  }

  private async canList(): Promise<boolean> {
    try {
      await this.request('GET', '/agentDefinition?limit=1&offset=0');
      return true;
    } catch {
      return false;
    }
  }

  /** Creates an agent definition. ASOR upserts when name, provider, and version match an existing one. */
  async registerAgent(card: AgentCard): Promise<AgentCard> {
    const body = await this.request('POST', '/agentDefinition', card);
    return unwrapCard(body);
  }

  private async request(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    const url = `${this.cfg.asorBaseUrl}${path}`;
    let retried = false;
    for (;;) {
      const token = await this.tokens.getToken();
      this.debug(`${method} ${url}`);
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'wd-agent-tenant-alias': this.cfg.tenant,
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      };
      const res =
        method === 'GET'
          ? await fetchWithRetry(this.fetchImpl, url, { ...init, timeoutMs: this.timeoutMs })
          : await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await res.text();
      // A token from the disk cache may have been revoked early: retry once with a fresh exchange. A token we just
      // exchanged is not stale, so retrying would only spend the token endpoint's rate limit (and ASOR also uses 401
      // for unknown agent ids).
      if (res.status === 401 && !retried && token.source === 'cache') {
        retried = true;
        this.tokens.invalidate();
        await this.tokens.getToken({ forceRefresh: true });
        continue;
      }
      if (!res.ok) throw asorHttpError(res.status, text);
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new CliError('http', `ASOR returned a non-JSON response (HTTP ${res.status}).`, { status: res.status });
      }
    }
  }
}

/** Maps ASOR HTTP failures to errors with a fix-it hint. */
export function asorHttpError(status: number, bodyText: string): CliError {
  const detail = workdayErrorMessage(bodyText);
  const msg = `ASOR request failed (HTTP ${status})${detail ? `: ${detail}` : '.'}`;
  switch (status) {
    case 401:
      return new CliError('auth', msg, { status, hint: 'The access token was rejected. Check that the API client includes the ASOR scope, then run `asor login` again or refresh the token.' });
    case 403:
      return new CliError('forbidden', msg, { status, hint: 'The integration user needs the "Setup: Agents" domain permission (and "Development" to register), and the API client needs the ASOR scope.' });
    case 404:
      return new CliError('not_found', msg, { status, hint: 'The agent does not exist, or ASOR is not enabled for this tenant. Check the host and tenant alias with `asor whoami`.' });
    default:
      return new CliError('http', msg, { status });
  }
}

function workdayErrorMessage(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown; errors?: Array<{ error?: string; message?: string }> };
    const first = j.errors?.[0];
    const parts = [typeof j.error === 'string' ? j.error : undefined, typeof j.message === 'string' ? j.message : undefined, first?.error ?? first?.message];
    return parts.filter(Boolean).join(' — ') || undefined;
  } catch {
    return text.replace(/\s+/g, ' ').slice(0, 200);
  }
}

/** Accepts the list shapes Workday APIs use: a bare array, or `{ total, data }` (plus a few aliases). */
export function extractList(body: unknown): { items: AgentCard[]; total: number | undefined } {
  if (Array.isArray(body)) return { items: body as AgentCard[], total: undefined };
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const items = (o.data ?? o.agentDefinitions ?? o.items ?? o.results ?? []) as AgentCard[];
    const total = typeof o.total === 'number' ? o.total : undefined;
    return { items: Array.isArray(items) ? items : [], total };
  }
  return { items: [], total: undefined };
}

function unwrapCard(body: unknown): AgentCard {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)) return o.data as AgentCard;
    return o as AgentCard;
  }
  throw new CliError('http', 'ASOR returned an unexpected agent definition payload.');
}
