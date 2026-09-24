import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_REFRESH_TOKEN, MOCK_TENANT, startMockServer, type MockServer } from '../mock/server.js';
import { startUi, type UiServer } from '../src/ui/server.js';
import { crc32 } from '../src/ui/zip.js';
import { run, tempDir } from './helpers.js';

/** Raw HTTP so tests can set a hostile Host header, which fetch does not allow. */
function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Reads a stored-only ZIP (the kind zip.ts writes) and checks every CRC. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory present');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    files.set(name, data);
    p += 46 + nameLen;
  }
  return files;
}

describe('asor ui server', () => {
  let mock: MockServer;
  let ui: UiServer;
  let base: string;
  let token: string;
  let outRoot: string;
  const saved: Record<string, string | undefined> = {};

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-asor-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  before(async () => {
    mock = await startMockServer();
    // startUi resolves config from process.env, like the real CLI. This file runs in its own process.
    for (const [k, v] of Object.entries({ ...mock.env, ASOR_CONFIG_DIR: tempDir() })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    outRoot = tempDir('asor-ui-out-');
    ui = await startUi({ outRoot });
    const u = new URL(ui.url);
    base = u.origin;
    token = u.searchParams.get('t')!;
  });
  after(async () => {
    await ui.close();
    await mock.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('serves the page only with the session token, with a nonce CSP', async () => {
    assert.equal((await raw(`${base}/`)).status, 403);
    assert.equal((await raw(`${base}/?t=wrong`)).status, 403);
    const ok = await raw(`${base}/?t=${token}`);
    assert.equal(ok.status, 200);
    const csp = String(ok.headers['content-security-policy']);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, 'CSP carries a nonce');
    assert.match(ok.body.toString(), new RegExp(`<script nonce="${nonce!.replace(/[+/=]/g, '\\$&')}">`));
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  });

  it('rejects API calls without the token, from foreign hosts, or without JSON', async () => {
    assert.equal((await fetch(`${base}/api/agents`)).status, 403);
    const rebound = await raw(`${base}/api/agents`, { headers: { Host: 'evil.example:80', 'x-asor-token': token } });
    assert.equal(rebound.status, 403, 'DNS-rebinding style Host is refused');
    const noJson = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'x-asor-token': token, 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(noJson.status, 415);
  });

  it('reports status and lists agents', async () => {
    const status = await api('GET', '/api/status');
    assert.equal(status.json.configured, true);
    assert.equal(status.json.tenant, MOCK_TENANT);
    const agents = await api('GET', '/api/agents');
    assert.deepEqual(
      agents.json.map((a: { command: string; invocable: boolean }) => [a.command, a.invocable]),
      [
        ['echo-agent', true],
        ['benefits-helper', true],
        ['workday-native-bot', false],
      ],
    );
  });

  it('lets you try an agent, including follow-ups', async () => {
    const first = await api('POST', '/api/invoke', { ref: 'echo', message: 'please ask me' });
    assert.equal(first.json.state, 'input-required');
    const second = await api('POST', '/api/invoke', { ref: 'echo', message: 'about 2026', contextId: first.json.contextId, taskId: first.json.taskId });
    assert.equal(second.json.state, 'completed');
    assert.equal(second.json.text, 'Echo: about 2026');
  });

  it('generates a CLI pinned to one agent that works on its own', async () => {
    const res = await api('POST', '/api/generate', { ref: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const out = res.json;
    assert.equal(out.command, 'echo-agent');
    assert.equal(out.outDir, join(outRoot, 'echo-agent'));
    assert.ok(existsSync(join(out.outDir, 'SKILL.md')));
    assert.ok(!out.files.includes('lib/cli.js') && !out.files.some((f: string) => f.startsWith('lib/ui/')), 'generator and UI are not vendored');
    assert.deepEqual(
      out.snippets.map((s: { surface: string }) => s.surface),
      ['Install', 'Terminal / scripts', 'Credentials', 'Slack', 'Microsoft Teams', 'Claude Code', 'Any LLM tool-calling bot'],
    );
    const r = await run(out.binPath, ['ask', '--json'], { env: { ...mock.env, ASOR_CONFIG_DIR: tempDir() }, input: 'standalone' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).text, 'Echo: standalone');
  });

  it('refuses to overwrite unless asked, with a UI-specific hint', async () => {
    const again = await api('POST', '/api/generate', { ref: 'echo' });
    assert.equal(again.status, 400);
    assert.match(again.json.error.hint, /Overwrite if the folder exists/);
    const forced = await api('POST', '/api/generate', { ref: 'echo', force: true, command: 'my-echo', outDir: join(outRoot, 'custom') });
    assert.equal(forced.status, 200);
    assert.equal(forced.json.command, 'my-echo');
    assert.ok(existsSync(join(outRoot, 'custom', 'bin', 'my-echo.js')));
  });

  it('downloads a generated package as a valid zip', async () => {
    const gen = await api('POST', '/api/generate', { ref: 'benefits' });
    assert.equal((await raw(`${base}/download?id=${gen.json.downloadId}`)).status, 403, 'token required');
    assert.equal((await raw(`${base}/download?id=nope&t=${token}`)).status, 404);
    const res = await raw(`${base}/download?id=${gen.json.downloadId}&t=${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/zip');
    const files = readZip(res.body);
    assert.ok(files.has('benefits-helper/bin/benefits-helper.js'));
    assert.ok(files.has('benefits-helper/lib/wrapped.js'));
    assert.equal(files.get('benefits-helper/SKILL.md')!.toString(), readFileSync(join(gen.json.outDir, 'SKILL.md'), 'utf8'));
  });

  it('saves and verifies a tenant login', async () => {
    const bad = await api('POST', '/api/login', { profile: 'x', host: mock.url, tenant: MOCK_TENANT, clientId: MOCK_CLIENT_ID, clientSecret: 'wrong', refreshToken: MOCK_REFRESH_TOKEN });
    assert.equal(bad.status, 502);
    assert.match(bad.json.error.message, /Token exchange failed/);
    const afterBad = await api('GET', '/api/status');
    assert.ok(!afterBad.json.profiles.some((p: { name: string }) => p.name === 'x'), 'a failed login is rolled back');
    const good = await api('POST', '/api/login', { profile: 'mock', host: mock.url, tenant: MOCK_TENANT, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, refreshToken: MOCK_REFRESH_TOKEN, makeDefault: true });
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.equal(good.json.agents, 3);
    const status = await api('GET', '/api/status?profile=mock');
    assert.equal(status.json.profileSaved, true);
    assert.doesNotMatch(JSON.stringify(status.json), /mock-secret|mock-refresh/);
  });
});

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });
});
