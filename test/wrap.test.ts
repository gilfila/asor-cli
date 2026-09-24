import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startMockServer, type MockServer } from '../mock/server.js';
import { run, runCli, tempDir } from './helpers.js';

describe('asor wrap', () => {
  let mock: MockServer;
  let env: Record<string, string>;
  let out: string;
  let bin: string;

  before(async () => {
    mock = await startMockServer();
    env = { ...mock.env, ASOR_CONFIG_DIR: tempDir() };
    out = join(tempDir(), 'echo');
    const r = await runCli(['wrap', 'Echo Agent', '--out', out, '--json'], { env });
    assert.equal(r.code, 0, r.stderr);
    bin = JSON.parse(r.stdout).binPath;
  });
  after(() => mock.close());

  it('generates a self-contained package', () => {
    for (const f of ['bin/echo-agent.js', 'lib/wrapped.js', 'package.json', 'tool.json', 'SKILL.md', 'README.md', 'agent-card.json']) {
      assert.ok(existsSync(join(out, f)), `${f} exists`);
    }
    const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.bin, { 'echo-agent': 'bin/echo-agent.js' });
    assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
    assert.match(readFileSync(join(out, 'SKILL.md'), 'utf8'), /^---\nname: echo-agent\n/);
  });

  it('refuses to overwrite a non-empty directory without --force', async () => {
    const r = await runCli(['wrap', 'Echo Agent', '--out', out], { env });
    assert.equal(r.code, 2);
    assert.equal((await runCli(['wrap', 'Echo Agent', '--out', out, '--force'], { env })).code, 0);
  });

  it('the wrapped CLI answers without naming the agent', async () => {
    const plain = await run(bin, ['hello from wrapper'], { env });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, 'Echo: hello from wrapper\n');

    const json = await run(bin, ['ask', '--json'], { env, input: 'piped' });
    const envelope = JSON.parse(json.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.text, 'Echo: piped');
    assert.equal(envelope.agent.name, 'Echo Agent');
  });

  it('lists skills offline and shows help', async () => {
    const skills = await run(bin, ['skills', '--json'], { env: {} });
    assert.equal(skills.code, 0, skills.stderr);
    assert.deepEqual(
      JSON.parse(skills.stdout).map((s: { id: string }) => s.id),
      ['echo', 'shout'],
    );
    const help = await run(bin, ['--help'], { env: {} });
    assert.match(help.stdout, /echo-agent ask \[message\]/);
  });

  it('defaults the output folder to ./asor-agents/<command> and needs an agent without a TTY', async () => {
    const cwd = tempDir();
    const r = await runCli(['wrap', 'benefits'], { env, cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(cwd, 'asor-agents', 'benefits-helper', 'bin', 'benefits-helper.js')));
    assert.match(r.stdout, /npm install -g/);
    const missing = await runCli(['wrap'], { env, cwd });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /asor ui/);
    assert.equal((await runCli(['generate', 'echo', '--out', join(cwd, 'g')], { env })).code, 0, 'generate is an alias of wrap');
  });

  it('reports errors with its own command name and exit codes', async () => {
    const r = await run(bin, ['ask', 'hi'], { env: { ASOR_CONFIG_DIR: tempDir() } });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /^echo-agent: error: No Workday tenant is configured/);
  });
});
