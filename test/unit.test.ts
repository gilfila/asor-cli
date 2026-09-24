import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseSse } from '../src/a2a.js';
import { extractList } from '../src/asor.js';
import { mask, resolveConfig, saveProfile } from '../src/config.js';
import { CliError, ExitCode } from '../src/errors.js';
import { fromTask } from '../src/invoke.js';
import { pickAgent, slugify } from '../src/resolve.js';
import { a2aEndpoint, summarize } from '../src/types.js';
import { toolDefinition } from '../src/wrap.js';
import { VERSION } from '../src/version.js';
import { tempDir } from './helpers.js';

describe('config', () => {
  it('derives token and ASOR URLs from host and tenant', () => {
    const cfg = resolveConfig({ env: { ASOR_CONFIG_DIR: tempDir(), ASOR_TENANT: 'acme', ASOR_HOST: 'eu.agent.workday.com' } });
    assert.equal(cfg.tokenUrl, 'https://eu.agent.workday.com/auth/oauth2/acme/token');
    assert.equal(cfg.asorBaseUrl, 'https://eu.agent.workday.com/asor/v1');
    assert.equal(cfg.agentAuth, 'none');
  });

  it('lets environment variables override a saved profile', () => {
    const env = { ASOR_CONFIG_DIR: tempDir() };
    saveProfile('work', { tenant: 'saved', clientId: 'id', clientSecret: 's', refreshToken: 'r' }, { env });
    const cfg = resolveConfig({ env: { ...env, ASOR_REFRESH_TOKEN: 'from-env' } });
    assert.equal(cfg.profileName, 'work');
    assert.equal(cfg.tenant, 'saved');
    assert.equal(cfg.refreshToken, 'from-env');
    assert.equal(cfg.refreshTokenSource, 'env');
  });

  it('fails clearly when no tenant is configured', () => {
    assert.throws(() => resolveConfig({ env: { ASOR_CONFIG_DIR: tempDir() } }), (e: unknown) => e instanceof CliError && e.exitCode === ExitCode.AUTH);
  });

  it('rejects an unknown explicit profile', () => {
    assert.throws(() => resolveConfig({ profile: 'nope', env: { ASOR_CONFIG_DIR: tempDir(), ASOR_TENANT: 't' } }), /does not exist/);
  });

  it('switches agent auth to bearer when ASOR_AGENT_TOKEN is set', () => {
    const cfg = resolveConfig({ env: { ASOR_CONFIG_DIR: tempDir(), ASOR_TENANT: 't', ASOR_AGENT_TOKEN: 'x' } });
    assert.equal(cfg.agentAuth, 'bearer');
  });

  it('masks secrets', () => {
    assert.equal(mask(undefined), '(not set)');
    assert.equal(mask('short'), '****');
    assert.equal(mask('abcdefghijkl'), 'abc…jkl');
  });
});

describe('parseSse', () => {
  const streamOf = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });

  it('splits events and joins multi-line data', async () => {
    const out: string[] = [];
    for await (const d of parseSse(streamOf('data: a\n\ndata: b1\ndata: b2\n\n: comment\nevent: x\ndata: c\n\n'))) out.push(d);
    assert.deepEqual(out, ['a', 'b1\nb2', 'c']);
  });

  it('handles events split across chunks, including a split \\r\\n', async () => {
    const out: string[] = [];
    for await (const d of parseSse(streamOf('da', 'ta: {"x":', '1}\r', '\n\r\n', 'data: tail'))) out.push(d);
    assert.deepEqual(out, ['{"x":1}', 'tail']);
  });
});

describe('resolve', () => {
  const agents = [
    { id: 'a1', name: 'Benefits Helper' },
    { id: 'a2', name: 'Benefits Helper Pro' },
    { id: 'a3', name: 'Payroll Agent' },
  ];

  it('prefers id, then exact name, then slug, then a unique substring', () => {
    assert.equal(pickAgent(agents, 'a3').id, 'a3');
    assert.equal(pickAgent(agents, 'benefits helper').id, 'a1');
    assert.equal(pickAgent(agents, 'benefits-helper-pro').id, 'a2');
    assert.equal(pickAgent(agents, 'payroll').id, 'a3');
  });

  it('reports ambiguous and missing matches', () => {
    assert.throws(() => pickAgent(agents, 'benefits h'), (e: unknown) => e instanceof CliError && e.kind === 'usage' && /matches 2 agents/.test(e.message));
    assert.throws(() => pickAgent(agents, 'expenses'), (e: unknown) => e instanceof CliError && e.kind === 'not_found');
  });

  it('slugifies names', () => {
    assert.equal(slugify('  HR: Time-Off Bot (v2) '), 'hr-time-off-bot-v2');
  });
});

describe('agent cards', () => {
  it('finds a JSON-RPC endpoint, including via additionalInterfaces', () => {
    assert.equal(a2aEndpoint({ url: 'https://a.example/a2a' }), 'https://a.example/a2a');
    assert.equal(a2aEndpoint({ url: 'https://a.example/grpc', preferredTransport: 'GRPC' }), null);
    assert.equal(
      a2aEndpoint({ url: 'https://a.example/grpc', preferredTransport: 'GRPC', additionalInterfaces: [{ transport: 'JSONRPC', url: 'https://a.example/rpc' }] }),
      'https://a.example/rpc',
    );
    assert.equal(a2aEndpoint({ url: 'mailto:someone' }), null);
  });

  it('summarizes Workday reference fields', () => {
    const s = summarize({ id: 'x', name: 'N', provider: { id: 'Provider=SELF-BUILT', descriptor: 'Acme' }, platform: 'Platform=OTHER', skills: [{ id: 's1' }] });
    assert.equal(s.provider, 'Acme');
    assert.equal(s.platform, 'Platform=OTHER');
    assert.deepEqual(s.skills, ['s1']);
    assert.equal(s.invocable, false);
  });

  it('accepts the list shapes Workday APIs use', () => {
    assert.equal(extractList([{ name: 'a' }]).items.length, 1);
    assert.deepEqual(extractList({ total: 5, data: [{ name: 'a' }] }).total, 5);
    assert.equal(extractList({ agentDefinitions: [{}, {}] }).items.length, 2);
    assert.equal(extractList(null).items.length, 0);
  });

  it('pulls answer text from artifacts, then the status message, then history', () => {
    const base = { kind: 'task' as const, id: 't', contextId: 'c' };
    assert.equal(fromTask({ ...base, status: { state: 'completed' }, artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: 'art' }] }] }).text, 'art');
    assert.equal(fromTask({ ...base, status: { state: 'completed', message: { kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: 'status' }] } } }).text, 'status');
    assert.equal(fromTask({ ...base, status: { state: 'completed' }, history: [{ kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'data', data: { n: 1 } }] }] }).text, '{\n  "n": 1\n}');
  });
});

describe('wrap tool definition', () => {
  it('builds a function-calling schema from the card', () => {
    const tool = toolDefinition({ name: 'Time Off', description: 'Books leave.', skills: [{ id: 'book', name: 'Book leave' }] }, 'time-off');
    assert.equal(tool.name, 'time_off');
    assert.match(tool.description, /Books leave\. Skills: Book leave\./);
    assert.deepEqual((tool.input_schema.properties as Record<string, { enum?: string[] }>).skill?.enum, ['book']);
    assert.deepEqual(tool.invocation.args, ['ask', '--json']);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});
