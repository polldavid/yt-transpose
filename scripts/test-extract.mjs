// Standalone extraction check: resolves a video and downloads the first
// ~200 KB of audio. Run in CI (datacenter IP) to verify YouTube extraction
// works from an environment like a cloud host's.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extract } = require('../lib/extract.js');

const url = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

console.log('extracting:', url);
const started = Date.now();
try {
  const track = await extract(url);
  console.log('source:      ', track.source);
  console.log('title:       ', track.title);
  console.log('author:      ', track.author);
  console.log('duration:    ', track.lengthSeconds, 's');
  console.log('mime:        ', track.mimeType);

  const stream = await track.createStream();
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes >= 200_000) break;
  }
  stream.destroy();
  console.log('downloaded:  ', bytes, 'bytes in', Date.now() - started, 'ms');

  if (bytes < 10_000) {
    console.error('FAIL: audio stream produced almost no data');
    process.exit(1);
  }
  console.log('EXTRACTION OK');
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
