import type { FetchLike } from './auth.js';

/** Statuses that mean "slow down and try again"; the request was not processed. */
const RETRYABLE = new Set([429, 503]);
const MAX_WAIT_MS = 30_000;

/**
 * fetch() that retries rate-limited responses (429/503), honoring Retry-After (seconds or an HTTP date) and
 * otherwise backing off 2s, 4s, 8s. Only use it for requests that are safe to repeat when the server refused
 * them: token exchanges and ASOR reads, not agent messages.
 */
export async function fetchWithRetry(fetchImpl: FetchLike, url: string, init: RequestInit & { timeoutMs?: number }, retries = 3): Promise<Response> {
  const base = Number(process.env.ASOR_RETRY_BASE_MS ?? 2000);
  for (let attempt = 0; ; attempt++) {
    const { timeoutMs = 30_000, ...rest } = init;
    let res: Response;
    try {
      res = await fetchImpl(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // A connection that never got established (or was reset) sent nothing the server acted on.
      if (attempt >= retries || !isTransientNetworkError(err)) throw err;
      const wait = Math.min(base * 2 ** attempt, MAX_WAIT_MS);
      process.stderr.write(`asor: could not reach ${new URL(url).host} (${networkCode(err)}); retrying in ${Math.ceil(wait / 1000)}s…\n`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!RETRYABLE.has(res.status) || attempt >= retries) return res;
    const wait = Math.min(retryAfterMs(res.headers.get('retry-after')) ?? base * 2 ** attempt, MAX_WAIT_MS);
    await res.body?.cancel().catch(() => {});
    process.stderr.write(`asor: ${url.replace(/\?.*$/, '')} is rate limiting (HTTP ${res.status}); retrying in ${Math.ceil(wait / 1000)}s…\n`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

const TRANSIENT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

function networkCode(err: unknown): string {
  const cause = (err as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (err as { code?: string })?.code ?? 'network error';
}

export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof TypeError && TRANSIENT_CODES.has(networkCode(err));
}

export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
