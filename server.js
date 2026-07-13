process.env.YTDL_NO_UPDATE = process.env.YTDL_NO_UPDATE || '1';

const express = require('express');
const path = require('path');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

// Songs longer than this are rejected: the whole track is decoded to PCM in the
// browser, and phones run out of memory somewhere past the 20-minute mark.
const MAX_DURATION_SECONDS = 20 * 60;

app.use(express.static(path.join(__dirname, 'public')));

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

async function getInfoOr502(url, res) {
  try {
    return await ytdl.getInfo(url);
  } catch (err) {
    console.error('ytdl.getInfo failed:', err.message);
    res.status(502).json({
      error:
        'Could not read that video from YouTube. It may be private, region-locked, age-restricted, or YouTube may be temporarily blocking this server.',
    });
    return null;
  }
}

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !ytdl.validateURL(url)) {
    return badRequest(res, 'That does not look like a valid YouTube link.');
  }

  const info = await getInfoOr502(url, res);
  if (!info) return;

  const d = info.videoDetails;
  const lengthSeconds = Number(d.lengthSeconds) || 0;
  res.json({
    id: d.videoId,
    title: d.title,
    author: d.author && d.author.name,
    lengthSeconds,
    tooLong: lengthSeconds > MAX_DURATION_SECONDS,
    maxSeconds: MAX_DURATION_SECONDS,
    thumbnail:
      Array.isArray(d.thumbnails) && d.thumbnails.length
        ? d.thumbnails[d.thumbnails.length - 1].url
        : null,
  });
});

app.get('/api/audio', async (req, res) => {
  const { url } = req.query;
  if (!url || !ytdl.validateURL(url)) {
    return badRequest(res, 'That does not look like a valid YouTube link.');
  }

  const info = await getInfoOr502(url, res);
  if (!info) return;

  const lengthSeconds = Number(info.videoDetails.lengthSeconds) || 0;
  if (lengthSeconds > MAX_DURATION_SECONDS) {
    return badRequest(
      res,
      `Video is longer than ${MAX_DURATION_SECONDS / 60} minutes — too big to transpose in the browser.`
    );
  }

  const audioFormats = info.formats.filter((f) => f.hasAudio && !f.hasVideo);
  if (!audioFormats.length) {
    return res.status(502).json({ error: 'No audio stream found for this video.' });
  }

  // Prefer AAC in an mp4 container (itag 140): it's the one format every
  // browser's decodeAudioData handles, including iOS Safari. Opus/webm is
  // higher quality but Safari cannot decode it.
  const format =
    audioFormats.find((f) => f.itag === 140) ||
    audioFormats.find((f) => f.container === 'mp4') ||
    ytdl.chooseFormat(audioFormats, { quality: 'highestaudio' });

  res.setHeader('Content-Type', (format.mimeType || 'audio/mp4').split(';')[0]);
  if (format.contentLength) res.setHeader('Content-Length', format.contentLength);

  const stream = ytdl.downloadFromInfo(info, { format });
  stream.on('error', (err) => {
    console.error('audio stream error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Audio download failed mid-stream. Try again.' });
    } else {
      res.destroy();
    }
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`YT Transpose running on http://localhost:${PORT}`);
});
