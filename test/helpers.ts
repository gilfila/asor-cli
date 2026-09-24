import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function tempDir(prefix = 'asor-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Runs a script with a clean ASOR_* environment. Stdin is always a pipe (closed after `input`). */
export function run(script: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<RunResult> {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ASOR_')));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...base, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

export function runCli(args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<RunResult> {
  return run(CLI, args, opts);
}
