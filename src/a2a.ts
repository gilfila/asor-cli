import { randomUUID } from 'node:crypto';
import type { FetchLike } from './auth.js';
import { CliError } from './errors.js';

/**
 * A minimal client for the A2A protocol (v0.3) over JSON-RPC 2.0: `message/send`, `message/stream` (SSE), and `tasks/get`.
 * See https://a2a-protocol.org/latest/specification/
 */

export type Part =
  | { kind: 'text'; text: string; metadata?: Record<string, unknown> }
  | { kind: 'data'; data: unknown; metadata?: Record<string, unknown> }
  | { kind: 'file'; file: { name?: string; mimeType?: string; uri?: string; bytes?: string }; metadata?: Record<string, unknown> };

export interface Message {
  kind: 'message';
  role: 'user' | 'agent';
  parts: Part[];
  messageId: string;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export type TaskState = 'submitted' | 'working' | 'input-required' | 'auth-required' | 'completed' | 'canceled' | 'failed' | 'rejected' | 'unknown';

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export interface Task {
  kind: 'task';
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

export interface TaskStatusUpdateEvent {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: TaskStatus;
  final?: boolean;
}

export interface TaskArtifactUpdateEvent {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
}

export type StreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/** States after which a task will not change without new input. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['completed', 'canceled', 'failed', 'rejected', 'unknown']);
/** States where the agent is waiting on the caller. */
export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set(['input-required', 'auth-required']);

export interface A2ARequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

export function userMessage(text: string, opts: { contextId?: string; taskId?: string; metadata?: Record<string, unknown> } = {}): Message {
  return {
    kind: 'message',
    role: 'user',
    messageId: randomUUID(),
    parts: [{ kind: 'text', text }],
    ...(opts.contextId ? { contextId: opts.contextId } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

function rpcBody(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
}

function rpcError(err: { code: number; message: string; data?: unknown }): CliError {
  // -32001 TaskNotFound, -32004 UnsupportedOperation, -32005 ContentTypeNotSupported (A2A error codes)
  const hint =
    err.code === -32601
      ? 'The agent endpoint does not implement this A2A method. It may speak a different transport or protocol version.'
      : err.code === -32004
        ? 'The agent does not support this operation (for streaming, retry without --stream).'
        : undefined;
  return new CliError('agent', `Agent returned JSON-RPC error ${err.code}: ${err.message}`, hint ? { hint } : {});
}

async function post(url: string, body: string, accept: string, opts: A2ARequestOptions): Promise<Response> {
  const res = await (opts.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: accept, ...opts.headers },
    body,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    const hint =
      res.status === 401 || res.status === 403
        ? 'The agent endpoint rejected the credentials. Use --agent-auth workday to forward the Workday token, or set ASOR_AGENT_TOKEN for --agent-auth bearer.'
        : res.status === 404
          ? 'The agent URL in its ASOR definition did not resolve. Check the `url` field with `asor agents get`.'
          : undefined;
    throw new CliError(res.status === 401 || res.status === 403 ? 'auth' : 'agent', `Agent endpoint answered HTTP ${res.status}${text ? `: ${text}` : ''}`, {
      status: res.status,
      ...(hint ? { hint } : {}),
    });
  }
  return res;
}

async function call<T>(url: string, method: string, params: unknown, opts: A2ARequestOptions): Promise<T> {
  const res = await post(url, rpcBody(method, params), 'application/json', opts);
  const text = await res.text();
  let parsed: JsonRpcResponse<T>;
  try {
    parsed = JSON.parse(text) as JsonRpcResponse<T>;
  } catch {
    throw new CliError('agent', `Agent returned a non-JSON response to ${method}.`, { hint: 'The URL may not be an A2A JSON-RPC endpoint.' });
  }
  if (parsed.error) throw rpcError(parsed.error);
  if (parsed.result === undefined) throw new CliError('agent', `Agent returned no result for ${method}.`);
  return parsed.result;
}

export function sendMessage(url: string, message: Message, opts: A2ARequestOptions & { acceptedOutputModes?: string[] } = {}): Promise<Task | Message> {
  return call<Task | Message>(
    url,
    'message/send',
    { message, configuration: { blocking: true, acceptedOutputModes: opts.acceptedOutputModes ?? ['text/plain', 'application/json'] } },
    opts,
  );
}

export function getTask(url: string, taskId: string, opts: A2ARequestOptions = {}): Promise<Task> {
  return call<Task>(url, 'tasks/get', { id: taskId }, opts);
}

/** Sends `message/stream` and yields each event from the Server-Sent Events response. */
export async function* streamMessage(url: string, message: Message, opts: A2ARequestOptions = {}): AsyncGenerator<StreamEvent> {
  const res = await post(url, rpcBody('message/stream', { message }), 'text/event-stream', opts);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    // Some servers answer a stream request with a single JSON-RPC response. Treat that as a one-event stream.
    const parsed = JSON.parse(await res.text()) as JsonRpcResponse<StreamEvent>;
    if (parsed.error) throw rpcError(parsed.error);
    if (parsed.result) yield parsed.result;
    return;
  }
  if (!res.body) return;
  for await (const data of parseSse(res.body)) {
    let parsed: JsonRpcResponse<StreamEvent>;
    try {
      parsed = JSON.parse(data) as JsonRpcResponse<StreamEvent>;
    } catch {
      continue;
    }
    if (parsed.error) throw rpcError(parsed.error);
    if (parsed.result) yield parsed.result;
  }
}

/** Parses a Server-Sent Events byte stream into the `data` payload of each event. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A lone \r at the end of a chunk may be the first half of \r\n; wait for the next chunk.
        if (!done && buffer[nl] === '\r' && nl === buffer.length - 1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
        if (line === '') {
          if (data.length > 0) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
        // Other fields (event:, id:, retry:) and comments (:) are not used by A2A.
      }
      if (done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
    if (data.length > 0) yield data.join('\n');
  } finally {
    reader.releaseLock();
  }
}

export function partsText(parts: Part[] | undefined): string {
  if (!parts) return '';
  return parts
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'data' ? JSON.stringify(p.data, null, 2) : p.kind === 'file' ? `[file: ${p.file.name ?? p.file.uri ?? 'attachment'}]` : ''))
    .filter(Boolean)
    .join('\n');
}
