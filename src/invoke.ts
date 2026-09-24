import {
  getTask,
  INTERRUPTED_STATES,
  partsText,
  sendMessage,
  streamMessage,
  TERMINAL_STATES,
  userMessage,
  type A2ARequestOptions,
  type Artifact,
  type Message,
  type Part,
  type Task,
  type TaskState,
} from './a2a.js';
import type { FetchLike, TokenProvider } from './auth.js';
import type { ResolvedConfig } from './config.js';
import { CliError } from './errors.js';
import { a2aEndpoint, type AgentCard } from './types.js';

export interface InvokeInput {
  text: string;
  /** Skill id to target. Sent as message metadata (`skillId`); agents that route by skill can use it. */
  skill?: string;
  /** Continue an earlier conversation. */
  contextId?: string;
  /** Answer a task that is waiting in `input-required`. */
  taskId?: string;
}

export type InvokeEvent =
  | { type: 'state'; state: TaskState; taskId: string | null; contextId: string | null }
  | { type: 'text'; text: string; source: 'artifact' | 'status' | 'message' };

export interface InvokeOptions {
  timeoutMs: number;
  stream?: boolean;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  onEvent?: (event: InvokeEvent) => void;
  /** First poll delay for long-running tasks. It doubles up to 5 s. */
  pollIntervalMs?: number;
}

export interface InvokeResult {
  state: TaskState;
  contextId: string | null;
  taskId: string | null;
  text: string;
  artifacts: Artifact[];
}

/** Invokers turn an agent card plus a prompt into a result. A2A is the only transport today; the interface leaves room for others. */
export interface Invoker {
  readonly name: string;
  supports(card: AgentCard): { ok: true; endpoint: string } | { ok: false; reason: string };
  invoke(card: AgentCard, input: InvokeInput, opts: InvokeOptions): Promise<InvokeResult>;
}

export const a2aInvoker: Invoker = {
  name: 'a2a-jsonrpc',

  supports(card) {
    const endpoint = a2aEndpoint(card);
    if (endpoint) return { ok: true, endpoint };
    if (!card.url) return { ok: false, reason: 'its ASOR definition has no `url`, so there is no endpoint to call' };
    if (card.preferredTransport && card.preferredTransport.toUpperCase() !== 'JSONRPC') {
      return { ok: false, reason: `it only advertises the ${card.preferredTransport} transport; asor-cli speaks A2A JSON-RPC` };
    }
    return { ok: false, reason: `its url (${card.url}) is not an http(s) endpoint` };
  },

  async invoke(card, input, opts) {
    const support = this.supports(card);
    if (!support.ok) throw notInvocable(card, support.reason);
    const deadline = Date.now() + opts.timeoutMs;
    const req: A2ARequestOptions = {
      signal: AbortSignal.timeout(opts.timeoutMs),
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    };
    const message = userMessage(input.text, {
      ...(input.contextId ? { contextId: input.contextId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.skill ? { metadata: { skillId: input.skill } } : {}),
    });

    let result: InvokeResult;
    if (opts.stream) {
      result = await consumeStream(support.endpoint, message, req, opts);
    } else {
      const reply = await sendMessage(support.endpoint, message, req);
      result = reply.kind === 'message' ? fromMessage(reply) : fromTask(reply);
      if (reply.kind === 'message') opts.onEvent?.({ type: 'text', text: result.text, source: 'message' });
    }
    if (!isSettled(result.state) && result.taskId) {
      result = await poll(support.endpoint, result.taskId, req, opts, deadline);
    }
    return result;
  },
};

export function notInvocable(card: AgentCard, reason: string): CliError {
  return new CliError('not_invocable', `Agent "${card.name ?? card.id}" cannot be invoked: ${reason}.`, {
    hint: 'Only agents that expose an A2A JSON-RPC endpoint can be called from the CLI. Workday-native agents are listed for discovery but run inside Workday.',
  });
}

function isSettled(state: TaskState): boolean {
  return TERMINAL_STATES.has(state) || INTERRUPTED_STATES.has(state);
}

function fromMessage(msg: Message): InvokeResult {
  return { state: 'completed', contextId: msg.contextId ?? null, taskId: msg.taskId ?? null, text: partsText(msg.parts), artifacts: [] };
}

export function fromTask(task: Task): InvokeResult {
  const artifacts = task.artifacts ?? [];
  const lastAgentMessage = [...(task.history ?? [])].reverse().find((m) => m.role === 'agent');
  const text = artifacts.map((a) => partsText(a.parts)).filter(Boolean).join('\n') || partsText(task.status?.message?.parts) || partsText(lastAgentMessage?.parts);
  return { state: task.status?.state ?? 'unknown', contextId: task.contextId ?? null, taskId: task.id ?? null, text, artifacts };
}

async function poll(url: string, taskId: string, req: A2ARequestOptions, opts: InvokeOptions, deadline: number): Promise<InvokeResult> {
  let delay = opts.pollIntervalMs ?? 1000;
  let last: InvokeResult | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))));
    const prevState = last?.state;
    last = fromTask(await getTask(url, taskId, req));
    if (last.state !== prevState) opts.onEvent?.({ type: 'state', state: last.state, taskId: last.taskId, contextId: last.contextId });
    if (isSettled(last.state)) {
      if (last.text) opts.onEvent?.({ type: 'text', text: last.text, source: 'artifact' });
      return last;
    }
    delay = Math.min(delay * 2, 5000);
  }
  throw new CliError('timeout', `Task ${taskId} did not finish before the timeout (last state: ${last?.state ?? 'unknown'}).`, {
    hint: `Raise --timeout, or check on it later with the same --context-id / --task-id.`,
  });
}

async function consumeStream(url: string, message: Message, req: A2ARequestOptions, opts: InvokeOptions): Promise<InvokeResult> {
  let state: TaskState = 'submitted';
  let contextId: string | null = message.contextId ?? null;
  let taskId: string | null = message.taskId ?? null;
  let statusText = '';
  const artifacts = new Map<string, Artifact>();
  const emitState = () => opts.onEvent?.({ type: 'state', state, taskId, contextId });

  for await (const event of streamMessage(url, message, req)) {
    switch (event.kind) {
      case 'message': {
        const text = partsText(event.parts);
        opts.onEvent?.({ type: 'text', text, source: 'message' });
        return { state: 'completed', contextId: event.contextId ?? contextId, taskId: event.taskId ?? taskId, text, artifacts: [] };
      }
      case 'task': {
        state = event.status?.state ?? state;
        contextId = event.contextId ?? contextId;
        taskId = event.id ?? taskId;
        for (const a of event.artifacts ?? []) artifacts.set(a.artifactId, a);
        emitState();
        break;
      }
      case 'status-update': {
        state = event.status.state;
        contextId = event.contextId ?? contextId;
        taskId = event.taskId ?? taskId;
        emitState();
        const text = partsText(event.status.message?.parts);
        if (text) {
          statusText = text;
          opts.onEvent?.({ type: 'text', text, source: 'status' });
        }
        break;
      }
      case 'artifact-update': {
        contextId = event.contextId ?? contextId;
        taskId = event.taskId ?? taskId;
        const prev = artifacts.get(event.artifact.artifactId);
        artifacts.set(event.artifact.artifactId, prev && event.append ? { ...prev, parts: mergeParts(prev.parts, event.artifact.parts) } : event.artifact);
        const delta = partsText(event.artifact.parts);
        if (delta) opts.onEvent?.({ type: 'text', text: delta, source: 'artifact' });
        break;
      }
    }
  }

  const list = [...artifacts.values()];
  const text = list.map((a) => partsText(a.parts)).filter(Boolean).join('\n') || statusText;
  return { state, contextId, taskId, text, artifacts: list };
}

/** Appends streamed chunks, joining adjacent text parts so the final artifact reads as one string. */
function mergeParts(prev: Part[], next: Part[]): Part[] {
  const out = [...prev];
  for (const part of next) {
    const tail = out[out.length - 1];
    if (tail?.kind === 'text' && part.kind === 'text') out[out.length - 1] = { ...tail, text: tail.text + part.text };
    else out.push(part);
  }
  return out;
}

/** Builds headers for the agent's own endpoint. The Workday token is forwarded only when asked for, because the endpoint may be a third party. */
export async function agentHeaders(cfg: ResolvedConfig, tokens: TokenProvider): Promise<Record<string, string>> {
  switch (cfg.agentAuth) {
    case 'workday':
      return { Authorization: `Bearer ${await tokens.getAccessToken()}`, 'wd-agent-tenant-alias': cfg.tenant };
    case 'bearer':
      if (!cfg.agentToken) throw new CliError('config', '--agent-auth bearer needs ASOR_AGENT_TOKEN to be set.');
      return { Authorization: `Bearer ${cfg.agentToken}` };
    default:
      return {};
  }
}
