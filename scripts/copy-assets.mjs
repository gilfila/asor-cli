// tsc only emits .js; copy the non-TypeScript runtime assets next to their compiled modules.
import { copyFileSync, mkdirSync } from 'node:fs';

const assets = [['src/ui/page.html', 'dist/src/ui/page.html']];
for (const [from, to] of assets) {
  mkdirSync(to.slice(0, to.lastIndexOf('/')), { recursive: true });
  copyFileSync(from, to);
}
