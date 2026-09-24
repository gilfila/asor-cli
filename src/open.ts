import { spawn } from 'node:child_process';

/**
 * Opens a URL in the default browser without going through a shell. On Windows this uses the URL protocol handler
 * directly, because `cmd /c start` would reinterpret `&` and `%` in OAuth query strings.
 * Only call it with URLs this program built itself, never with user input.
 */
export function openBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {
    // Callers always print the URL as well.
  }
}
