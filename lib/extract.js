// YouTube audio extraction with a fallback chain. YouTube frequently changes
// its internals and bot-blocks datacenter IPs, so no single extractor is
// reliable; each one here uses a different access path. yt-dlp (a standalone
// binary, installed by scripts/install-yt-dlp.sh) is by far the most
// actively maintained and goes first when available.
const { spawn, execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const ytdl = require('@distube/ytdl-core');

// --- yt-dlp ----------------------------------------------------------------

let ytDlpBinPromise = null;
function getYtDlpBin() {
  if (!ytDlpBinPromise) {
    ytDlpBinPromise = (async () => {
      const local = path.join(__dirname, '..', 'bin', 'yt-dlp');
      const candidates = [process.env.YTDLP_PATH, existsSync(local) ? local : null, 'yt-dlp'].filter(Boolean);
      for (const bin of candidates) {
        try {
          const version = await new Promise((resolve, reject) =>
            execFile(bin, ['--version'], (err, stdout) => (err ? reject(err) : resolve(stdout.trim())))
          );
          console.log(`extract: yt-dlp ${version} at ${bin}`);
          return bin;
        } catch (_) { /* try next candidate */ }
      }
      console.log('extract: yt-dlp not available, using library extractors only');
      return null;
    })();
  }
  return ytDlpBinPromise;
}

// AAC/m4a first: it decodes everywhere, including iOS Safari.
const YTDLP_FORMAT = 'bestaudio[ext=m4a]/bestaudio';

async function viaYtDlp(url) {
  const bin = await getYtDlpBin();
  if (!bin) throw new Error('binary not installed');

  const json = await new Promise((resolve, reject) => {
    execFile(
      bin,
      ['--no-playlist', '--format', YTDLP_FORMAT, '--dump-single-json', '--no-warnings', url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) {
          const lines = String(stderr || err.message).split('\n').filter((l) => l.trim());
          return reject(new Error(lines[lines.length - 1] || 'yt-dlp failed'));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });

  const ext = json.ext;
  return {
    source: 'yt-dlp',
    id: json.id,
    title: json.title,
    author: json.uploader || json.channel || null,
    lengthSeconds: Math.round(json.duration || 0),
    thumbnail: json.thumbnail || null,
    mimeType: ext === 'webm' ? 'audio/webm' : 'audio/mp4',
    contentLength: json.filesize || json.filesize_approx || null,
    createStream: async () => {
      const proc = spawn(
        bin,
        ['--no-playlist', '--format', json.format_id || YTDLP_FORMAT, '--output', '-', '--no-warnings', '--quiet', url],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const stream = proc.stdout;
      let stderrTail = '';
      proc.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d).slice(-2048);
      });
      proc.on('close', (code) => {
        if (code !== 0 && !stream.destroyed && !stream.readableEnded) {
          stream.destroy(new Error(`yt-dlp exited ${code}: ${stderrTail.trim().split('\n').pop() || ''}`));
        }
      });
      stream.on('close', () => proc.kill('SIGKILL'));
      return stream;
    },
  };
}

// --- @distube/ytdl-core ------------------------------------------------------

// Optional: set YTDL_COOKIES to a JSON array of browser cookies (exported
// with an extension like "Get cookies.txt LOCALLY" in JSON form) to make
// requests look like a logged-in browser when YouTube blocks anonymous ones.
let ytdlAgent = null;
if (process.env.YTDL_COOKIES) {
  try {
    ytdlAgent = ytdl.createAgent(JSON.parse(process.env.YTDL_COOKIES));
    console.log('extract: using cookies from YTDL_COOKIES');
  } catch (err) {
    console.error('extract: could not parse YTDL_COOKIES:', err.message);
  }
}

function pickYtdlFormat(formats) {
  // Formats without a url failed signature deciphering (outdated extractor
  // vs. current YouTube player) and would 403 — treat them as absent.
  const audio = formats.filter((f) => f.hasAudio && !f.hasVideo && f.url);
  if (!audio.length) return null;
  return (
    audio.find((f) => f.itag === 140) ||
    audio.find((f) => f.container === 'mp4') ||
    ytdl.chooseFormat(audio, { quality: 'highestaudio' })
  );
}

async function viaYtdl(url) {
  const options = {
    playerClients: ['IOS', 'ANDROID', 'WEB_EMBEDDED', 'TV'],
    ...(ytdlAgent ? { agent: ytdlAgent } : {}),
  };
  const info = await ytdl.getInfo(url, options);
  const format = pickYtdlFormat(info.formats);
  if (!format) throw new Error('ytdl: no audio-only format found');
  const d = info.videoDetails;
  return {
    source: 'ytdl',
    id: d.videoId,
    title: d.title,
    author: d.author && d.author.name,
    lengthSeconds: Number(d.lengthSeconds) || 0,
    thumbnail:
      Array.isArray(d.thumbnails) && d.thumbnails.length
        ? d.thumbnails[d.thumbnails.length - 1].url
        : null,
    mimeType: (format.mimeType || 'audio/mp4').split(';')[0],
    contentLength: format.contentLength || null,
    createStream: async () => ytdl.downloadFromInfo(info, { format, ...options }),
  };
}

// --- youtubei.js (InnerTube) -------------------------------------------------

let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = import('youtubei.js').then(({ Innertube }) => Innertube.create());
  }
  return innertubePromise;
}

// Non-web clients are less likely to require a Proof-of-Origin token.
const INNERTUBE_CLIENTS = ['IOS', 'ANDROID', 'TV', 'TV_EMBEDDED', 'ANDROID_VR', 'WEB_EMBEDDED'];

async function viaInnertube(url) {
  const id = ytdl.getURLVideoID(url);
  const yt = await getInnertube();
  const errors = [];
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      if (info.playability_status && info.playability_status.status !== 'OK') {
        throw new Error(info.playability_status.reason || info.playability_status.status);
      }
      const downloadOptions = { type: 'audio', quality: 'best', format: 'mp4', client };
      const format = info.chooseFormat(downloadOptions);
      const b = info.basic_info;
      return {
        source: `innertube:${client}`,
        id,
        title: b.title,
        author: b.author,
        lengthSeconds: Number(b.duration) || 0,
        thumbnail:
          Array.isArray(b.thumbnail) && b.thumbnail.length ? b.thumbnail[0].url : null,
        mimeType: (format.mime_type || 'audio/mp4').split(';')[0],
        contentLength: format.content_length || null,
        createStream: async () => Readable.fromWeb(await info.download(downloadOptions)),
      };
    } catch (err) {
      errors.push(`${client}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

// --- chain -------------------------------------------------------------------

// Metadata can extract fine while the stream URL still 403s (broken
// deciphering, expired signatures). Read the first bytes before trusting an
// extractor, so a dead stream falls through to the next one.
function probeStream(track) {
  return track.createStream().then(
    (stream) =>
      new Promise((resolve, reject) => {
        const finish = (err) => {
          clearTimeout(timer);
          stream.destroy();
          err ? reject(err) : resolve();
        };
        const timer = setTimeout(() => finish(new Error('stream probe timed out')), 15000);
        stream.once('data', () => finish());
        stream.once('error', finish);
        stream.once('end', () => finish(new Error('stream probe: empty stream')));
      })
  );
}

async function extract(url) {
  const errors = [];
  for (const attempt of [viaYtDlp, viaYtdl, viaInnertube]) {
    try {
      const track = await attempt(url);
      await probeStream(track);
      return track;
    } catch (err) {
      errors.push(`${attempt.name}: ${err.message}`);
      console.error(`extract: ${attempt.name} failed —`, err.message);
    }
  }
  const combined = new Error(errors.join(' | '));
  combined.allExtractorsFailed = true;
  throw combined;
}

module.exports = { extract, validateURL: ytdl.validateURL };
