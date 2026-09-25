import { createInterface } from 'node:readline';

/** Asks one question on the terminal. Secret answers are not echoed. */
export function ask(question: string, opts: { secret?: boolean; defaultValue?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const suffix = opts.defaultValue ? ` [${opts.defaultValue}]` : '';
    const prompt = `${question}${suffix}: `;
    let muted = false;
    if (opts.secret) {
      // readline has no built-in hidden input, so filter what it echoes. On every keypress readline clears the line
      // and redraws "prompt + typed text"; keep redrawing the prompt alone so it stays visible, never the text.
      const internal = rl as unknown as { _writeToOutput: (s: string) => void };
      const original = internal._writeToOutput.bind(rl);
      internal._writeToOutput = (s: string) => {
        if (!muted) original(s);
        else if (s.includes('\n')) original('\n');
        else if (s.startsWith(prompt)) original(prompt);
      };
    }
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('Cancelled.'));
    });
    rl.question(prompt, (answer) => {
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

/** Reads one line: a prompt on a terminal, or the next line of piped stdin (so scripted logins and tests work). */
export async function readLine(question: string): Promise<string> {
  if (process.stdin.isTTY) return ask(question);
  process.stderr.write(`${question}: `);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const line = await new Promise<string>((resolve) => {
      rl.once('line', resolve);
      rl.once('close', () => resolve(''));
    });
    process.stderr.write('\n');
    return line.trim();
  } finally {
    rl.close();
  }
}
