// Copies the browser build of soundtouchjs from node_modules into public/vendor
// so the frontend can import it without a bundler.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidates = [
  'node_modules/soundtouchjs/dist/soundtouch.js',
  'node_modules/soundtouchjs/dist/soundtouch.min.js'
];

const src = candidates.map((p) => join(root, p)).find((p) => existsSync(p));
if (!src) {
  console.error('soundtouchjs dist not found — did npm install run?');
  process.exit(1);
}

const destDir = join(root, 'public', 'vendor');
mkdirSync(destDir, { recursive: true });
copyFileSync(src, join(destDir, 'soundtouch.js'));
console.log('Copied soundtouchjs ->', join(destDir, 'soundtouch.js'));
