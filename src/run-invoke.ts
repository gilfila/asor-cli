import { INTERRUPTED_STATES } from './a2a.js';
import { stderr, stdout, type Context } from './context.js';
import { CliError, ExitCode, toCliError } from './errors.js';
import { a2aInvoker, agentHeaders, type InvokeEvent } from './invoke.js';
import { errorEnvelope, successEnvelope } from './output.js';
import { readStdin } from './prompt.js';
import type { AgentCard } from './types.js';

export interface InvokeFlags {
  skill?: string;
  contextId?: string;
  taskId?: string;
  stream?: boolean;
  json?: boolean;
  timeout?: string;
}

/** Resolves the prompt: positional words, `-` for stdin, or stdin when nothing is given and stdin is piped. */
export async function readPrompt(words: string[]): Promise<string> {
  const fromArgs = words.join(' ').trim();
  if (fromArgs && fromArgs !== '-') return fromArgs;
  if (process.stdin.isTTY) {
    throw new CliError('usage', 'No message given.', { hint: 'Pass the message as an argument, or pipe it on stdin (safer for bots: `echo "hi" | asor invoke <agent> --json`).' });
  }
  const text = (await readStdin()).trim();
  if (!text) throw new CliError('usage', 'The message on stdin was empty.');
  return text;
}

export function parseTimeout(value: string | undefined): number {
  if (value === undefined) return 120_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new CliError('usage', `Invalid --timeout "${value}". Use a number of seconds.`);
  return seconds * 1000;
}

/**
 * Runs one invocation and prints the result. Shared by `asor invoke` and by CLIs generated with `asor wrap`.
 * Returns the process exit code.
 */
export async function runInvoke(ctx: Context, loadAgent: () => Promise<AgentCard>, words: string[], flags: InvokeFlags, invokeHint: string): Promise<number> {
  const json = Boolean(flags.json);
  let agent: AgentCard | null = null;
  try {
    const timeoutMs = parseTimeout(flags.timeout);
    const text = await readPrompt(words);
    agent = await loadAgent();
    ctx.debug(`invoking ${agent.name ?? agent.id} via ${a2aInvoker.name}`);

    let wroteText = false;
    const onEvent = (event: InvokeEvent) => {
      if (json) {
        if (flags.stream) stdout(JSON.stringify({ type: 'event', event }));
        return;
      }
      if (event.type === 'state') ctx.debug(`state: ${event.state}`);
      else if (event.type === 'text' && flags.stream) {
        // Status messages are progress; artifacts and messages are the answer.
        if (event.source === 'status') stderr(event.text);
        else {
          process.stdout.write(event.text);
          wroteText = true;
        }
      }
    };

    const result = await a2aInvoker.invoke(
      agent,
      {
        text,
        ...(flags.skill ? { skill: flags.skill } : {}),
        ...(flags.contextId ? { contextId: flags.contextId } : {}),
        ...(flags.taskId ? { taskId: flags.taskId } : {}),
      },
      { timeoutMs, stream: Boolean(flags.stream), headers: await agentHeaders(ctx.cfg, ctx.tokens), fetch: ctx.fetch, onEvent },
    );

    const ok = result.state === 'completed' || INTERRUPTED_STATES.has(result.state);
    const envelope = successEnvelope(agent, result, ok);
    if (!ok) {
      envelope.error = {
        kind: 'agent',
        message: `The agent's task ended in state "${result.state}".`,
        hint: result.text ? null : 'The agent returned no explanation.',
        exitCode: ExitCode.AGENT,
      };
    }

    if (json) {
      stdout(JSON.stringify(flags.stream ? { type: 'result', ...envelope } : envelope));
    } else {
      if (!wroteText && result.text) process.stdout.write(result.text);
      if (result.text || wroteText) process.stdout.write('\n');
      if (INTERRUPTED_STATES.has(result.state)) {
        stderr(`\n[${result.state}] The agent is waiting on you. Reply with:\n  ${invokeHint} --context-id ${result.contextId ?? '?'} --task-id ${result.taskId ?? '?'} "<your answer>"`);
      } else if (!ok) {
        stderr(`${invokeHint.split(' ')[0]}: error: ${envelope.error!.message}`);
      } else if (result.contextId) {
        ctx.debug(`context: ${result.contextId} (pass --context-id to continue this conversation)`);
      }
    }
    return ok ? ExitCode.OK : ExitCode.AGENT;
  } catch (err) {
    const e = toCliError(err);
    if (json) {
      stdout(JSON.stringify(flags.stream ? { type: 'result', ...errorEnvelope(e, agent) } : errorEnvelope(e, agent)));
      return e.exitCode;
    }
    throw e;
  }
}
