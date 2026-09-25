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

describe('withLock', () => {
  it('serializes callers and clears an abandoned lock', async () => {
    const { withLock } = await import('../src/auth.js');
    const { utimesSync, writeFileSync: write } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(tempDir(), 'x.lock');
    const order: string[] = [];
    await Promise.all([
      withLock(path, async () => { order.push('a+'); await new Promise((r) => setTimeout(r, 50)); order.push('a-'); }),
      withLock(path, async () => { order.push('b+'); order.push('b-'); }),
    ]);
    assert.ok(order.join(',') === 'a+,a-,b+,b-' || order.join(',') === 'b+,b-,a+,a-', order.join(','));
    write(path, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    let ran = false;
    await withLock(path, async () => { ran = true; });
    assert.ok(ran);
  });
});

describe('fetchWithRetry', () => {
  it('retries transient connection failures and 429s, but not other errors', async () => {
    const { fetchWithRetry } = await import('../src/http.js');
    process.env.ASOR_RETRY_BASE_MS = '1';
    const connectTimeout = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw connectTimeout;
      if (calls === 2) return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const res = await fetchWithRetry(flaky, 'https://example.test/x', { method: 'GET' });
    assert.equal(res.status, 200);
    assert.equal(calls, 3);

    const hardFail = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
    }) as typeof fetch;
    await assert.rejects(fetchWithRetry(hardFail, 'https://example.test/x', { method: 'GET' }), /fetch failed/);
  });
});

describe('withWorkdayConfig', () => {
  it('adds a Delegate entry for each skill that lacks one and keeps existing entries', async () => {
    const { withWorkdayConfig } = await import('../src/asor.js');
    const out = withWorkdayConfig({
      name: 'x',
      skills: [{ id: 'a' }, { id: 'b' }],
      workdayConfig: [{ skillId: 'a', executionMode: { id: 'Mode=Ambient' }, workdayResources: [{ tool_name: 't' }] }],
    });
    assert.deepEqual(out.workdayConfig, [
      { skillId: 'a', executionMode: { id: 'Mode=Ambient' }, workdayResources: [{ tool_name: 't' }] },
      { skillId: 'b', executionMode: { id: 'Mode=Delegate' }, workdayResources: [] },
    ]);
  });
});

describe('resolve: partial slugs', () => {
  it('matches a partial slug across spaces and punctuation', () => {
    assert.equal(pickAgent([{ id: '1', name: 'asor-cli Echo Test' }, { id: '2', name: 'Payroll' }], 'echo-test').id, '1');
  });
});

describe('examples/echo-agent (the deployed test agent)', () => {
  it('answers send, stream, follow-up, and failure over A2A', async () => {
    const { createServer } = await import('node:http');
    const handler = (await import(new URL('../../examples/echo-agent/api/a2a.js', import.meta.url).href)).default;
    const { a2aInvoker } = await import('../src/invoke.js');
    const srv = createServer((req, res) => handler(req, res)).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    try {
      const card = { name: 'echo', url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/a2a` };
      const opts = { timeoutMs: 5000 };
      assert.equal((await a2aInvoker.invoke(card, { text: 'hi' }, opts)).text, 'Echo: hi');
      assert.equal((await a2aInvoker.invoke(card, { text: 'hi', skill: 'shout' }, { ...opts, stream: true })).text, 'Echo: HI');
      const q = await a2aInvoker.invoke(card, { text: 'please ask me' }, opts);
      assert.equal(q.state, 'input-required');
      const a = await a2aInvoker.invoke(card, { text: '2026', contextId: q.contextId!, taskId: q.taskId! }, opts);
      assert.deepEqual([a.state, a.text, a.contextId], ['completed', 'Echo: 2026', q.contextId]);
      assert.equal((await a2aInvoker.invoke(card, { text: 'fail' }, opts)).state, 'failed');
    } finally {
      srv.close();
    }
  });
});
