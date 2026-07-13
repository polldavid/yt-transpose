# YT Transpose

Paste a YouTube link, shift the song's key up or down in semitones, and play it back — without changing the speed. There's also an independent speed slider (0.5×–1.5×) for practicing. The UI is mobile-first and works on phones.

## How it works

YouTube's embedded player can't be pitch-shifted (its audio is sealed inside a cross-origin iframe), so this app:

1. Runs a small Node/Express server that extracts the **audio-only stream** of a pasted YouTube link (via [`@distube/ytdl-core`](https://github.com/distubejs/ytdl-core)). It prefers the AAC/mp4 stream because every browser — including iOS Safari — can decode it.
2. The browser downloads and decodes that audio, then plays it through the Web Audio API using [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS), which shifts pitch in semitones and stretches tempo independently, in real time.

Pitch and speed changes apply live during playback — no re-processing.

## Run it locally

```bash
npm install   # also copies the SoundTouchJS browser build into public/vendor
npm start     # serves on http://localhost:3000
```

To try it from your phone on the same Wi-Fi, open `http://<your-computer's-ip>:3000`.

## Get a test URL in a few clicks

**GitHub Pages (no server at all)** — this repo ships a workflow that publishes the app to `https://polldavid.github.io/yt-transpose/` on every push. On static hosting there is no backend, so the app automatically falls back to community-run YouTube mirrors (Piped/Invidious) to fetch audio, trying several until one works. Those mirrors go up and down — if a song won't load there, it's the mirrors, not the app; the server-backed deploys below are the reliable option.

To turn it on once: repo **Settings → Pages → Source: "GitHub Actions"** (the workflow also tries to enable this automatically on first run).

Two more zero-config options (both read the configs already in this repo):

**Render (free tier, permanent URL)** — click, sign in, and it deploys this branch using `render.yaml`:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/polldavid/yt-transpose/tree/claude/youtube-song-transposer-bq961f)

You'll get a URL like `https://yt-transpose.onrender.com` that works from your phone. Free instances sleep when idle, so the first request after a while takes ~30s to wake.

**CodeSandbox (instant, throwaway)** — opens the repo in a cloud VM and starts the server with a shareable preview URL:

https://codesandbox.io/p/github/polldavid/yt-transpose/tree/claude/youtube-song-transposer-bq961f

## Deploy (to make it reachable from anywhere)

This needs a long-running Node server (audio streams can take a while), so pick a host that runs persistent Node processes rather than short-lived serverless functions:

- **Render / Railway / Fly.io** — create a Node service from this repo. Build command: `npm install`, start command: `npm start`. The server reads `PORT` from the environment automatically.

### A note on YouTube blocking

YouTube periodically changes its internals and rate-limits or bot-blocks datacenter IPs. If `/api/info` starts returning errors on a deployed instance:

- update the extractor: `npm update @distube/ytdl-core`
- if it persists, `@distube/ytdl-core` supports passing browser cookies to authenticate requests — see its README.

## Limits

- Videos are capped at **20 minutes**: the whole track is decoded to raw PCM in the browser, and phones run out of memory past that.
- Pitch range: ±12 semitones. Speed: 0.5×–1.5×.

## Legal

This downloads audio from YouTube for playback, which is against YouTube's Terms of Service for content you don't have rights to. Use it for personal practice with content you're entitled to use.
