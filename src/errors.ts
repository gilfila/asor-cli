/** Process exit codes. These are part of the bot contract, so do not renumber them. */
export const ExitCode = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  AGENT: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorKind = 'usage' | 'config' | 'auth' | 'forbidden' | 'not_found' | 'not_invocable' | 'agent' | 'http' | 'timeout' | 'internal';

/** An error with a stable kind, an exit code, and an optional hint on how to fix it. */
export class CliError extends Error {
  readonly kind: ErrorKind;
  readonly exitCode: ExitCodeValue;
  readonly hint: string | undefined;
  readonly status: number | undefined;

  constructor(kind: ErrorKind, message: string, opts: { hint?: string; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'CliError';
    this.kind = kind;
    this.exitCode = exitCodeFor(kind);
    this.hint = opts.hint;
    this.status = opts.status;
  }
}

function exitCodeFor(kind: ErrorKind): ExitCodeValue {
  switch (kind) {
    case 'usage':
      return ExitCode.USAGE;
    case 'config':
    case 'auth':
    case 'forbidden':
      return ExitCode.AUTH;
    case 'not_found':
    case 'not_invocable':
      return ExitCode.NOT_FOUND;
    case 'agent':
    case 'timeout':
      return ExitCode.AGENT;
    default:
      return ExitCode.GENERIC;
  }
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new CliError('timeout', 'The request timed out.', { hint: 'Raise --timeout, or check that the agent endpoint is reachable.', cause: err });
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? 'network error';
    return new CliError('http', `Network request failed (${detail}).`, { hint: 'Check the host name and your network or proxy settings.', cause: err });
  }
  return new CliError('internal', err instanceof Error ? err.message : String(err), { cause: err });
}
