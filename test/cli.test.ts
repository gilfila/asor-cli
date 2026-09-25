import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TokenProvider } from '../src/auth.js';
import { resolveConfig, saveProfile } from '../src/config.js';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_REFRESH_TOKEN, MOCK_TENANT, startMockServer, type MockServer } from '../mock/server.js';
import { CLI, run, runCli, tempDir } from './helpers.js';

const ECHO_ID = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';

describe('asor CLI against the mock tenant', () => {
  let mock: MockServer;
  let env: Record<string, string>;

  before(async () => {
    mock = await startMockServer();
    env = { ...mock.env, ASOR_CONFIG_DIR: tempDir() };
  });
  after(() => mock.close());

  it('lists agents as a table and as JSON', async () => {
    const table = await runCli(['agents', 'list'], { env });
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /Echo Agent/);
    assert.match(table.stdout, /Workday Native Bot .* no /);

    const json = await runCli(['agents', 'list', '--json'], { env });
    const agents = JSON.parse(json.stdout) as Array<{ name: string; invocable: boolean }>;
    assert.deepEqual(
      agents.map((a) => [a.name, a.invocable]),
      [
        ['Echo Agent', true],
        ['Benefits Helper', true],
        ['Workday Native Bot', false],
      ],
    );
  });

  it('sends the tenant alias header on every ASOR call', () => {
    assert.ok(mock.state.asorRequests.length > 0);
    assert.ok(mock.state.asorRequests.every((r) => r.tenant === MOCK_TENANT));
  });

  it('reuses the cached access token across processes', async () => {
    const before = mock.state.tokenExchanges;
    await runCli(['agents', 'list', '--json'], { env });
    await runCli(['agents', 'list', '--json'], { env });
    assert.equal(mock.state.tokenExchanges, before);
  });

  it('gets one agent by name, slug, or id', async () => {
    for (const ref of ['Benefits Helper', 'benefits-helper', '11112222333344445555666677778888']) {
      const r = await runCli(['agents', 'get', ref, '--json'], { env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).name, 'Benefits Helper');
    }
  });

  it('invokes an agent and prints plain text', async () => {
    const r = await runCli(['invoke', 'echo', 'hello', 'world'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Echo: hello world\n');
  });

  it('reads the prompt from stdin and prints the JSON envelope', async () => {
    const r = await runCli(['invoke', 'Echo Agent', '--json'], { env, input: 'from stdin; rm -rf / "quotes"' });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.state, 'completed');
    assert.equal(out.text, 'Echo: from stdin; rm -rf / "quotes"');
    assert.equal(out.agent.id, ECHO_ID);
    assert.ok(out.contextId && out.taskId);
    assert.equal(out.error, null);
  });

  it('sends the chosen skill as message metadata', async () => {
    const r = await runCli(['invoke', 'echo', '--skill', 'shout', 'quiet please', '--json'], { env });
    assert.equal(JSON.parse(r.stdout).text, 'Echo: QUIET PLEASE');
  });

  it('handles agents that answer with a Message instead of a Task', async () => {
    const r = await runCli(['invoke', 'benefits', 'when is enrollment?', '--json'], { env });
    const out = JSON.parse(r.stdout);
    assert.equal(out.state, 'completed');
    assert.match(out.text, /Open enrollment runs Nov 1-15/);
  });

  it('streams answers, with JSON Lines ending in the envelope', async () => {
    const text = await runCli(['invoke', 'echo', '--stream', 'streaming works'], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.equal(text.stdout, 'Echo: streaming works\n');
    assert.match(text.stderr, /Thinking…/);

    const lines = (await runCli(['invoke', 'echo', '--stream', '--json', 'abc'], { env })).stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.type === 'event' && l.event.type === 'text'));
    const last = lines[lines.length - 1];
    assert.equal(last.type, 'result');
    assert.equal(last.ok, true);
    assert.equal(last.text, 'Echo: abc');
    assert.equal(last.artifacts[0].parts.length, 1, 'streamed chunks are merged into one text part');
  });

  it('polls long-running tasks until they finish', async () => {
    const r = await runCli(['invoke', 'echo', 'a slow request', '--json'], { env });
    const out = JSON.parse(r.stdout);
    assert.equal(out.state, 'completed');
    assert.equal(out.text, 'Echo: a slow request');
  });

  it('supports input-required follow-ups with --context-id and --task-id', async () => {
    const first = JSON.parse((await runCli(['invoke', 'echo', 'please ask me', '--json'], { env })).stdout);
    assert.equal(first.ok, true);
    assert.equal(first.state, 'input-required');
    assert.equal(first.text, 'Which year do you mean?');

    const second = await runCli(['invoke', 'echo', '--context-id', first.contextId, '--task-id', first.taskId, '--json', 'ask about 2026'], { env });
    const out = JSON.parse(second.stdout);
    assert.equal(out.state, 'completed');
    assert.equal(out.contextId, first.contextId);
    assert.equal(out.taskId, first.taskId);
  });

  it('exits 5 with ok:false when the task fails', async () => {
    const r = await runCli(['invoke', 'echo', 'fail please', '--json'], { env });
    assert.equal(r.code, 5);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.state, 'failed');
    assert.equal(out.error.kind, 'agent');
  });

  it('exits 4 for agents without an endpoint', async () => {
    const r = await runCli(['invoke', 'native', 'hi', '--json'], { env });
    assert.equal(r.code, 4);
    assert.equal(JSON.parse(r.stdout).error.kind, 'not_invocable');
  });

  it('exits 2 for ambiguous names and usage errors', async () => {
    assert.equal((await runCli(['invoke', 'e', 'hi'], { env })).code, 2);
    assert.equal((await runCli(['invoke', 'echo', 'hi', '--bogus'], { env })).code, 2);
    const empty = await runCli(['invoke', 'echo', '--json'], { env, input: '   ' });
    assert.equal(empty.code, 2);
    assert.equal(JSON.parse(empty.stdout).error.kind, 'usage');
  });

  it('exits 3 with a hint when credentials are wrong', async () => {
    const r = await runCli(['agents', 'list'], { env: { ...env, ASOR_CLIENT_SECRET: 'wrong', ASOR_NO_TOKEN_CACHE: '1' } });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Token exchange failed \(HTTP 401\)/);
    assert.match(r.stderr, /hint:/);
  });

  it('does not forward the Workday token to agents unless asked', async () => {
    mock.state.a2aRequests.length = 0;
    await runCli(['invoke', 'echo', 'no auth'], { env });
    assert.equal(mock.state.a2aRequests[0]?.authorization, undefined);

    await runCli(['invoke', 'echo', 'workday auth', '--agent-auth', 'workday'], { env });
    assert.match(mock.state.a2aRequests[1]?.authorization ?? '', /^Bearer mock-access-/);

    await runCli(['invoke', 'echo', 'bearer auth'], { env: { ...env, ASOR_AGENT_TOKEN: 'agent-secret' } });
    assert.equal(mock.state.a2aRequests[2]?.authorization, 'Bearer agent-secret');
  });

  it('registers an agent from a card file (upsert by name + version)', async () => {
    const file = join(tempDir(), 'card.json');
    const card = { name: 'New Agent', description: 'd', url: 'https://example.com/a2a', version: '0.1.0', provider: { id: 'Provider=SELF-BUILT' }, platform: { id: 'Platform=OTHER' }, capabilities: {}, skills: [] };
    writeFileSync(file, JSON.stringify(card));
    const r1 = JSON.parse((await runCli(['agents', 'register', '--file', file, '--json'], { env })).stdout);
    const r2 = JSON.parse((await runCli(['agents', 'register', '--file', file, '--json'], { env })).stdout);
    assert.ok(r1.id);
    assert.equal(r2.id, r1.id);
  });

  it('whoami reports config with masked secrets and passing checks', async () => {
    const r = await runCli(['whoami', '--json'], { env });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.tenant, MOCK_TENANT);
    assert.doesNotMatch(r.stdout, new RegExp(MOCK_CLIENT_SECRET));
    assert.doesNotMatch(r.stdout, new RegExp(MOCK_REFRESH_TOKEN));
  });
});

describe('login and profiles', () => {
  let mock: MockServer;
  before(async () => {
    mock = await startMockServer({ rotateRefreshToken: true });
  });
  after(() => mock.close());

  it('saves a profile from flags, verifies it, and keeps rotated refresh tokens', async () => {
    const dir = tempDir();
    const login = await runCli(
      ['login', '--profile', 'mock', '--host', mock.url, '--tenant', MOCK_TENANT, '--client-id', MOCK_CLIENT_ID, '--client-secret', MOCK_CLIENT_SECRET, '--refresh-token', MOCK_REFRESH_TOKEN],
      { env: { ASOR_CONFIG_DIR: dir } },
    );
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stderr, /3 agent\(s\) visible/);

    const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.defaultProfile, 'mock');
    assert.equal(saved.profiles.mock.refreshToken, mock.state.lastIssuedRefreshToken, 'the rotated token was saved');
    assert.notEqual(saved.profiles.mock.refreshToken, MOCK_REFRESH_TOKEN);

    const list = await runCli(['agents', 'list', '--json'], { env: { ASOR_CONFIG_DIR: dir, ASOR_NO_TOKEN_CACHE: '1' } });
    assert.equal(list.code, 0, list.stderr);

    const profiles = JSON.parse((await runCli(['profiles', '--json'], { env: { ASOR_CONFIG_DIR: dir } })).stdout);
    assert.deepEqual(profiles.map((p: { name: string; default: boolean }) => [p.name, p.default]), [['mock', true]]);
    assert.doesNotMatch(JSON.stringify(profiles), /secret|refresh/i);

    assert.equal((await runCli(['logout', '--profile', 'mock'], { env: { ASOR_CONFIG_DIR: dir } })).code, 0);
    assert.equal(JSON.parse((await runCli(['profiles', '--json'], { env: { ASOR_CONFIG_DIR: dir } })).stdout).length, 0);
  });

  it('login without a TTY names the missing flags', async () => {
    const r = await runCli(['login', '--tenant', 't'], { env: { ASOR_CONFIG_DIR: tempDir() } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--client-id, --client-secret, --refresh-token/);
  });

  it('warns instead of saving when a rotated refresh token came from the environment', async () => {
    const dir = tempDir();
    const warnings: string[] = [];
    const cfg = resolveConfig({ env: { ...mock.env, ASOR_REFRESH_TOKEN: mock.state.lastIssuedRefreshToken, ASOR_CONFIG_DIR: dir } });
    const tokens = new TokenProvider(cfg, { env: { ASOR_CONFIG_DIR: dir }, warn: (m) => warnings.push(m), noDiskCache: true });
    await tokens.getToken();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /ASOR_REFRESH_TOKEN/);
  });

  it('pages through large agent lists', async () => {
    const paged = await startMockServer({ pageSize: 2 });
    try {
      const dir = tempDir();
      saveProfile('p', { host: paged.url, tenant: MOCK_TENANT, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, refreshToken: MOCK_REFRESH_TOKEN }, { env: { ASOR_CONFIG_DIR: dir } });
      const r = await run(CLI, ['agents', 'list', '--json'], { env: { ASOR_CONFIG_DIR: dir } });
      assert.equal(JSON.parse(r.stdout).length, 3);
      assert.equal(paged.state.asorRequests.filter((q) => q.path === '/agentDefinition' && q.method === 'GET').length, 2, 'two pages fetched');
    } finally {
      await paged.close();
    }
  });
});

describe('live ASOR quirks (captured from a real tenant, 2026-09-25)', () => {
  it('parses the live list shape', async () => {
    const { extractList } = await import('../src/asor.js');
    const live = JSON.parse(readFileSync(new URL('../../test/fixtures/asor-v1-list-empty.json', import.meta.url), 'utf8'));
    assert.deepEqual(extractList(live), { items: [], total: 0 });
  });

  it('treats a 401 for an unknown agent id as not found, without spending token exchanges', async () => {
    const mock = await startMockServer();
    try {
      const env = { ...mock.env, ASOR_CONFIG_DIR: tempDir() };
      await runCli(['agents', 'list', '--json'], { env });
      const exchanges = mock.state.tokenExchanges;
      const r = await runCli(['agents', 'get', '0'.repeat(32), '--json'], { env });
      assert.equal(r.code, 4, r.stdout);
      assert.equal(JSON.parse(r.stdout).error.kind, 'not_found');
      assert.equal(mock.state.tokenExchanges - exchanges, 1, 'one forced refresh for the cached token, then no more');
    } finally {
      await mock.close();
    }
  });

  it('rides out a rate-limited token endpoint', async () => {
    const mock = await startMockServer({ tokenRateLimit: 2 });
    try {
      const r = await runCli(['agents', 'list', '--json'], { env: { ...mock.env, ASOR_CONFIG_DIR: tempDir() } });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /rate limiting \(HTTP 429\); retrying/);
      assert.equal(JSON.parse(r.stdout).length, 3);
    } finally {
      await mock.close();
    }
  });
});

describe('rotating refresh tokens (Workday rotates on every exchange)', () => {
  it('serializes refreshes so parallel processes do not burn each other\'s token', async () => {
    const mock = await startMockServer({ rotateRefreshToken: true });
    try {
      const dir = tempDir();
      saveProfile('p', { host: mock.url, tenant: MOCK_TENANT, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, refreshToken: MOCK_REFRESH_TOKEN }, { env: { ASOR_CONFIG_DIR: dir } });
      const runs = await Promise.all(Array.from({ length: 5 }, () => runCli(['agents', 'list', '--json'], { env: { ASOR_CONFIG_DIR: dir } })));
      for (const r of runs) assert.equal(r.code, 0, r.stderr);
      assert.equal(mock.state.tokenExchanges, 1, 'one exchange; the others reused its token');
    } finally {
      await mock.close();
    }
  });

  it('keeps an ASOR_REFRESH_TOKEN_FILE up to date for bot hosts', async () => {
    const mock = await startMockServer({ rotateRefreshToken: true });
    try {
      const file = join(tempDir(), 'refresh-token');
      writeFileSync(file, `${MOCK_REFRESH_TOKEN}\n`);
      const env = { ...mock.env, ASOR_REFRESH_TOKEN: '', ASOR_REFRESH_TOKEN_FILE: file, ASOR_CONFIG_DIR: tempDir(), ASOR_NO_TOKEN_CACHE: '1' };
      delete (env as Record<string, string | undefined>).ASOR_REFRESH_TOKEN;
      for (let i = 0; i < 3; i++) {
        const r = await runCli(['agents', 'list', '--json'], { env });
        assert.equal(r.code, 0, r.stderr);
        assert.doesNotMatch(r.stderr, /could not be saved/);
      }
      assert.equal(readFileSync(file, 'utf8').trim(), mock.state.lastIssuedRefreshToken);
      assert.equal(mock.state.tokenExchanges, 3);
    } finally {
      await mock.close();
    }
  });

  it('warns that an env-only refresh token will die after rotation', async () => {
    const mock = await startMockServer({ rotateRefreshToken: true });
    try {
      const r = await runCli(['agents', 'list', '--json'], { env: { ...mock.env, ASOR_CONFIG_DIR: tempDir() } });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /ASOR_REFRESH_TOKEN_FILE/);
    } finally {
      await mock.close();
    }
  });
});
