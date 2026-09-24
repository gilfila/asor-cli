import { createInterface } from 'node:readline';

/** Asks one question on the terminal. Secret answers are not echoed. */
export function ask(question: string, opts: { secret?: boolean; defaultValue?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const suffix = opts.defaultValue ? ` [${opts.defaultValue}]` : '';
    let muted = false;
    if (opts.secret) {
      // readline has no built-in hidden input; swallow the echo after the question is printed.
      const internal = rl as unknown as { _writeToOutput: (s: string) => void };
      const original = internal._writeToOutput.bind(rl);
      internal._writeToOutput = (s: string) => {
        if (!muted || s.includes('\n')) original(muted ? '\n' : s);
      };
    }
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('Cancelled.'));
    });
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || opts.defaultValue || '');
    });
    muted = Boolean(opts.secret);
  });
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}
