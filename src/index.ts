/**
 * Library entry point. Node bots can import these directly instead of spawning the CLI:
 *
 *   import { createContext, resolveAgent, a2aInvoker, agentHeaders } from 'asor-cli';
 *   const ctx = createContext({});
 *   const agent = await resolveAgent(ctx.client, 'benefits-helper');
 *   const result = await a2aInvoker.invoke(agent, { text: 'hi' }, { timeoutMs: 60_000, headers: await agentHeaders(ctx.cfg, ctx.tokens) });
 */
export { AsorClient, asorHttpError } from './asor.js';
export { TokenProvider, type TokenInfo } from './auth.js';
export { configDir, configPath, resolveConfig, saveProfile, type Profile, type ResolvedConfig, type AgentAuthMode } from './config.js';
export { createContext, type Context, type GlobalFlags } from './context.js';
export { CliError, ExitCode, type ErrorKind } from './errors.js';
export { a2aInvoker, agentHeaders, type Invoker, type InvokeInput, type InvokeOptions, type InvokeResult, type InvokeEvent } from './invoke.js';
export { getTask, sendMessage, streamMessage, userMessage, parseSse, type Message, type Task, type TaskState, type StreamEvent } from './a2a.js';
export { successEnvelope, errorEnvelope, type Envelope } from './output.js';
export { pickAgent, resolveAgent, slugify } from './resolve.js';
export { a2aEndpoint, summarize, type AgentCard, type AgentSkill, type AgentSummary } from './types.js';
export { generateWrapper, toolDefinition, type WrapOptions, type WrapResult } from './wrap.js';
export { runWrapped, type PinnedAgent } from './wrapped.js';
export { VERSION } from './version.js';
