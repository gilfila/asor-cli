import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_TENANT, startMockServer, type MockOptions } from '../mock/server.js';
import { CliError } from '../src/errors.js';
import { buildAuthorizeUrl, isLoopbackRedirect, parseRedirect, pkcePair, waitForCallback } from '../src/oauth.js';
import { redact } from '../src/output.js';
import { CLI, runCli, tempDir } from './helpers.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Spawns the CLI with stdin left open, so a test can play the user's part mid-flow. */
function spawnCli(args: string[], env: Record<string, string>) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ASOR_')));
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI, ...args], { env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const waiters: Array<{ re: RegExp; resolve: (m: RegExpMatchArray) => void }> = [];
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => {
    stderr += d;
    for (const w of [...waiters]) {
      const m = stderr.match(w.re);
      if (m) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr })));
  const waitFor = (re: RegExp) =>
    new Promise<RegExpMatchArray>((resolve, reject) => {
      const m = stderr.match(re);
      if (m) return resolve(m);
      waiters.push({ re, resolve });
      setTimeout(() => reject(new Error(`Timed out waiting for ${re} in stderr:\n${stderr}`)), 10_000).unref();
    });
  return { child, done, waitFor };
}

const AUTH_URL = /^\s+(http:\/\/127\.0\.0\.1:\d+\/auth\/authorize\/\S+)$/m;

describe('oauth helpers', () => {
  it('computes the RFC 7636 PKCE challenge', () => {
    assert.equal(pkcePair('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const a = pkcePair();
    assert.notEqual(a.verifier, pkcePair().verifier);
    assert.ok(a.verifier.length >= 43);
  });

  it('builds the authorize URL', () => {
    const u = new URL(buildAuthorizeUrl('https://us.agent.workday.com/auth/authorize/acme', { clientId: 'c', redirectUri: 'http://localhost:8765/callback', state: 's', challenge: 'x' }));
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8765/callback');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('scope'), null);
  });

  it('recognizes redirect URIs it can receive itself', () => {
    assert.equal(isLoopbackRedirect('http://localhost:8765/callback'), true);
    assert.equal(isLoopbackRedirect('http://127.0.0.1:9000/cb'), true);
    assert.equal(isLoopbackRedirect('http://localhost/callback'), false, 'needs an explicit port');
    assert.equal(isLoopbackRedirect('https://localhost:8765/callback'), false, 'no TLS listener');
    assert.equal(isLoopbackRedirect('https://cb.myworkday.com/cb1'), false);
  });

  it('parses pasted redirects and rejects mismatches and denials', () => {
    assert.deepEqual(parseRedirect('https://cb.myworkday.com/cb1?code=abc&state=s1', 's1'), { code: 'abc', stateChecked: true });
    assert.deepEqual(parseRedirect('?code=abc&state=s1', 's1'), { code: 'abc', stateChecked: true });
    assert.deepEqual(parseRedirect('  bare-code-123 ', 's1'), { code: 'bare-code-123', stateChecked: false });
    assert.throws(() => parseRedirect('https://cb.myworkday.com/cb1?code=abc&state=other', 's1'), /state mismatch/);
    assert.throws(() => parseRedirect('https://cb.myworkday.com/cb1?error=access_denied&state=s1', 's1'), (e: unknown) => e instanceof CliError && e.kind === 'auth' && /Allow/.test(e.hint ?? ''));
    assert.throws(() => parseRedirect('not a url', 's1'), /does not look like/);
  });

  it('receives exactly one callback on the loopback redirect', async () => {
    const port = await freePort();
    const cb = waitForCallback(`http://127.0.0.1:${port}/callback`, 'st', 5000);
    await cb.ready;
    assert.equal((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status, 404);
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=st`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /You can close this tab/);
    assert.equal(await cb.code, 'the-code');
  });

  it('redacts identifying values but keeps shape and Workday reference IDs', () => {
    const out = redact([{ id: 'abc', name: 'Payroll Bot', url: 'https://agents.acme.com/a2a', provider: { id: 'Provider=SELF-BUILT' }, skills: [{ id: 'abc', description: 'kept' }] }]) as any[];
    assert.equal(out[0].id, '<id-1>');
    assert.equal(out[0].skills[0].id, '<id-1>', 'same value, same placeholder');
    assert.equal(out[0].name, '<name-2>');
    assert.equal(out[0].url, '<url-3>');
    assert.equal(out[0].provider.id, 'Provider=SELF-BUILT');
    assert.equal(out[0].skills[0].description, 'kept');
  });
});

describe('asor login --authorize', () => {
  const loginArgs = (mockUrl: string, redirectUri: string, extra: string[] = []) => [
    'login', '--authorize', '--no-open', '--profile', 'wd', '--host', mockUrl, '--tenant', MOCK_TENANT,
    '--client-id', MOCK_CLIENT_ID, '--client-secret', MOCK_CLIENT_SECRET, '--redirect-uri', redirectUri, ...extra,
  ];

  async function withMock<T>(opts: MockOptions, fn: (mock: Awaited<ReturnType<typeof startMockServer>>) => Promise<T>): Promise<T> {
    const mock = await startMockServer(opts);
    try {
      return await fn(mock);
    } finally {
      await mock.close();
    }
  }

  it('signs in through a localhost callback, stores the refresh token, and verifies it', async () => {
    const port = await freePort();
    const redirectUri = `http://localhost:${port}/callback`;
    await withMock({ redirectUri, refreshTokenExpiresIn: 30 * 86400 }, async (mock) => {
      const dir = tempDir();
      const cli = spawnCli(loginArgs(mock.url, redirectUri), { ASOR_CONFIG_DIR: dir });
      const [, url] = await cli.waitFor(AUTH_URL);
      // Play the browser: the mock "signs in", then redirects to our callback listener.
      const page = await fetch(url!);
      assert.equal(page.status, 200);
      const result = await cli.done;
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /Authorized\. Saved profile "wd"/);
      assert.match(result.stderr, /Connected to tenant "acme_dev1"\. 3 agent/);

      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).profiles.wd;
      assert.equal(saved.authMode, 'authorization_code');
      assert.equal(saved.redirectUri, redirectUri);
      assert.equal(saved.refreshTokenTtlDays, 30);
      assert.match(saved.refreshToken, /^mock-refresh-ac-/);
      assert.equal(mock.state.authorizeRequests[0]!.code_challenge_method, 'S256', 'PKCE is sent by default');

      const who = JSON.parse((await runCli(['whoami', '--json'], { env: { ASOR_CONFIG_DIR: dir } })).stdout);
      assert.equal(who.ok, true);
      assert.match(who.auth, /authorization code, signed in today; refresh token expires in ~30 days/);
    });
  });

  it('supports paste mode for a redirect URI it cannot listen on', async () => {
    const redirectUri = 'https://cb.myworkday.com/cb1';
    await withMock({ redirectUri }, async (mock) => {
      const dir = tempDir();
      const cli = spawnCli(loginArgs(mock.url, redirectUri, ['--no-pkce']), { ASOR_CONFIG_DIR: dir });
      const [, url] = await cli.waitFor(AUTH_URL);
      await cli.waitFor(/Paste the address you landed on/);
      const res = await fetch(url!, { redirect: 'manual' });
      const landed = res.headers.get('location')!;
      assert.match(landed, /^https:\/\/cb\.myworkday\.com\/cb1\?/);
      cli.child.stdin.end(`${landed}\n`);
      const result = await cli.done;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(mock.state.authorizeRequests[0]!.code_challenge, undefined, '--no-pkce omits the challenge');
    });
  });

  it('reports a denied consent with exit code 3 and a hint', async () => {
    const port = await freePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    await withMock({ denyAuthorize: true }, async (mock) => {
      const cli = spawnCli(loginArgs(mock.url, redirectUri), { ASOR_CONFIG_DIR: tempDir() });
      const [, url] = await cli.waitFor(AUTH_URL);
      assert.equal((await fetch(url!)).status, 400);
      const result = await cli.done;
      assert.equal(result.code, 3);
      assert.match(result.stderr, /declined the authorization: access_denied/);
      assert.match(result.stderr, /choose Allow/);
    });
  });

  it('explains a busy callback port', async () => {
    const blocker = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const port = (blocker.address() as { port: number }).port;
    try {
      await withMock({}, async (mock) => {
        const r = await runCli(loginArgs(mock.url, `http://127.0.0.1:${port}/callback`), { env: { ASOR_CONFIG_DIR: tempDir() } });
        assert.equal(r.code, 2);
        assert.match(r.stderr, /Cannot listen on/);
        assert.match(r.stderr, /--paste/);
      });
    } finally {
      blocker.close();
    }
  });

  it('tells you to sign in again when an authorized refresh token expires', async () => {
    await withMock({}, async (mock) => {
      const dir = tempDir();
      const cfg = { defaultProfile: 'wd', profiles: { wd: { host: mock.url, tenant: MOCK_TENANT, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, refreshToken: 'expired', authMode: 'authorization_code', refreshTokenTtlDays: 30 } } };
      (await import('node:fs')).writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
      const r = await runCli(['agents', 'list'], { env: { ASOR_CONFIG_DIR: dir } });
      assert.equal(r.code, 3);
      assert.match(r.stderr, /expired or was revoked \(this client's tokens last 30 days\)/);
      assert.match(r.stderr, /asor login --authorize --profile wd/);
    });
  });

  it('redacts live payloads for fixtures', async () => {
    await withMock({}, async (mock) => {
      const r = await runCli(['agents', 'list', '--raw', '--json', '--redact'], { env: { ...mock.env, ASOR_CONFIG_DIR: tempDir() } });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /127\.0\.0\.1|0a1b2c3d4e5f|Echo Agent/);
      assert.match(r.stdout, /Provider=SELF-BUILT/);
      assert.equal(JSON.parse(r.stdout).length, 3);
    });
  });
});
