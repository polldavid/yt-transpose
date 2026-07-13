// YouTube audio extraction with a fallback chain. YouTube frequently changes
// its internals and bot-blocks datacenter IPs, so no single extractor is
// reliable; each library here uses a different access path.
const { Readable } = require('node:stream');
const ytdl = require('@distube/ytdl-core');

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
  const audio = formats.filter((f) => f.hasAudio && !f.hasVideo);
  if (!audio.length) return null;
  // AAC/mp4 (itag 140) decodes everywhere, including iOS Safari.
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

let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = import('youtubei.js').then(({ Innertube }) => Innertube.create());
  }
  return innertubePromise;
}

const INNERTUBE_CLIENTS = ['IOS', 'ANDROID', 'TV', 'WEB_EMBEDDED'];

async function viaInnertube(url) {
  const id = ytdl.getURLVideoID(url);
  const yt = await getInnertube();
  let lastError = null;
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, client);
      if (info.playability_status && info.playability_status.status !== 'OK') {
        throw new Error(`innertube(${client}): ${info.playability_status.reason || info.playability_status.status}`);
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
      lastError = err;
    }
  }
  throw lastError || new Error('innertube: all clients failed');
}

async function extract(url) {
  const errors = [];
  for (const attempt of [viaYtdl, viaInnertube]) {
    try {
      return await attempt(url);
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
