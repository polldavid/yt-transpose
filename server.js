process.env.YTDL_NO_UPDATE = process.env.YTDL_NO_UPDATE || '1';

const express = require('express');
const path = require('path');
const { extract, validateURL } = require('./lib/extract');

const app = express();
const PORT = process.env.PORT || 3000;

// Songs longer than this are rejected: the whole track is decoded to PCM in the
// browser, and phones run out of memory somewhere past the 20-minute mark.
const MAX_DURATION_SECONDS = 20 * 60;

app.use(express.static(path.join(__dirname, 'public')));

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

async function extractOr502(url, res) {
  try {
    return await extract(url);
  } catch (err) {
    console.error('extraction failed:', err.message);
    res.status(502).json({
      error:
        'Could not read that video from YouTube. It may be private, region-locked, age-restricted, or YouTube may be temporarily blocking this server.',
    });
    return null;
  }
}

// Lets the frontend detect that it's running against this server (vs. being
// statically hosted, e.g. on GitHub Pages, where it falls back to public mirrors).
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !validateURL(url)) {
    return badRequest(res, 'That does not look like a valid YouTube link.');
  }

  const track = await extractOr502(url, res);
  if (!track) return;

  res.json({
    id: track.id,
    title: track.title,
    author: track.author,
    lengthSeconds: track.lengthSeconds,
    tooLong: track.lengthSeconds > MAX_DURATION_SECONDS,
    maxSeconds: MAX_DURATION_SECONDS,
    thumbnail: track.thumbnail,
  });
});

app.get('/api/audio', async (req, res) => {
  const { url } = req.query;
  if (!url || !validateURL(url)) {
    return badRequest(res, 'That does not look like a valid YouTube link.');
  }

  const track = await extractOr502(url, res);
  if (!track) return;

  if (track.lengthSeconds > MAX_DURATION_SECONDS) {
    return badRequest(
      res,
      `Video is longer than ${MAX_DURATION_SECONDS / 60} minutes — too big to transpose in the browser.`
    );
  }

  let stream;
  try {
    stream = await track.createStream();
  } catch (err) {
    console.error('audio stream creation failed:', err.message);
    return res.status(502).json({ error: 'Could not start the audio download. Try again.' });
  }

  res.setHeader('Content-Type', track.mimeType);
  if (track.contentLength) res.setHeader('Content-Length', track.contentLength);

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
