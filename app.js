import { PitchShifter } from './vendor/soundtouch.js';

const $ = (id) => document.getElementById(id);

const form = $('url-form');
const urlInput = $('url-input');
const loadBtn = $('load-btn');
const statusEl = $('status');
const playerEl = $('player');
const thumbEl = $('thumb');
const titleEl = $('title');
const authorEl = $('author');
const pitchValueEl = $('pitch-value');
const tempoSlider = $('tempo-slider');
const tempoValueEl = $('tempo-value');
const playBtn = $('play-btn');
const iconPlay = $('icon-play');
const iconPause = $('icon-pause');
const seekSlider = $('seek-slider');
const timeCurrentEl = $('time-current');
const timeTotalEl = $('time-total');

const MIN_SEMITONES = -12;
const MAX_SEMITONES = 12;
const MAX_SECONDS = 20 * 60;

let audioCtx = null;
let gainNode = null;
let shifter = null;
let audioBuffer = null;
let isPlaying = false;
let isSeeking = false;
let semitones = 0;
let tempo = 1;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function formatTime(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function ensureAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);
  }
  return audioCtx;
}

function stopPlayback() {
  if (shifter && isPlaying) shifter.disconnect();
  isPlaying = false;
  iconPlay.classList.remove('hidden');
  iconPause.classList.add('hidden');
  playBtn.setAttribute('aria-label', 'Play');
}

function startPlayback() {
  if (!shifter) return;
  ensureAudioContext().resume();
  shifter.connect(gainNode);
  isPlaying = true;
  iconPlay.classList.add('hidden');
  iconPause.classList.remove('hidden');
  playBtn.setAttribute('aria-label', 'Pause');
}

function onTrackEnd() {
  // Fires (repeatedly) once the source is exhausted — stop and rewind once.
  if (!isPlaying) return;
  stopPlayback();
  shifter.percentagePlayed = 0;
  seekSlider.value = 0;
  timeCurrentEl.textContent = '0:00';
}

function createShifter() {
  if (shifter) {
    if (isPlaying) shifter.disconnect();
    shifter.off();
    shifter = null;
  }
  shifter = new PitchShifter(ensureAudioContext(), audioBuffer, 4096, onTrackEnd);
  shifter.pitchSemitones = semitones;
  shifter.tempo = tempo;
  shifter.on('play', (detail) => {
    // Late events can arrive after pause/end; don't let them move the UI.
    if (!isPlaying || isSeeking) return;
    seekSlider.value = Math.min(1000, Math.round(detail.percentagePlayed * 10));
    timeCurrentEl.textContent = formatTime(detail.timePlayed);
  });
}

function applyPitch(value) {
  semitones = Math.min(MAX_SEMITONES, Math.max(MIN_SEMITONES, value));
  pitchValueEl.textContent = semitones > 0 ? `+${semitones}` : String(semitones);
  pitchValueEl.classList.toggle('up', semitones > 0);
  pitchValueEl.classList.toggle('down', semitones < 0);
  if (shifter) shifter.pitchSemitones = semitones;
}

function fatal(message) {
  // A fatal error aborts the mirror fallback chain (e.g. video too long).
  const err = new Error(message);
  err.fatal = true;
  return err;
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

// ---------------------------------------------------------------------------
// Audio sources. "server" talks to this app's own Node backend (localhost or
// a deployed instance). "mirrors" is the fallback for static hosting (GitHub
// Pages): community-run Piped/Invidious instances that proxy YouTube audio
// with CORS enabled. Both return { info, arrayBuffer }.
// ---------------------------------------------------------------------------

let backendPromise = null;
function detectBackend() {
  if (!backendPromise) {
    // Relative path: resolves under the app's base URL both at a domain root
    // and at a subpath like username.github.io/repo/.
    backendPromise = fetch('api/health')
      .then((r) => (r.ok ? 'server' : 'mirrors'))
      .catch(() => 'mirrors');
  }
  return backendPromise;
}

async function loadViaServer(url) {
  setStatus('Looking up video…');
  const info = await fetchJson(`api/info?url=${encodeURIComponent(url)}`);
  if (info.tooLong) {
    throw fatal(`That video is over ${Math.round(info.maxSeconds / 60)} minutes — pick something shorter.`);
  }

  setStatus('Downloading audio…');
  const audioRes = await fetch(`api/audio?url=${encodeURIComponent(url)}`);
  if (!audioRes.ok) {
    let message = `Audio download failed (${audioRes.status})`;
    try {
      message = (await audioRes.json()).error || message;
    } catch (_) { /* non-JSON error body */ }
    throw new Error(message);
  }
  return { info, arrayBuffer: await audioRes.arrayBuffer() };
}

// Known-good instances (snapshot of the official public-instance lists).
// Used when the live directories below are unreachable.
const FALLBACK_MIRRORS = [
  { type: 'piped', base: 'https://pipedapi.kavin.rocks' },
  { type: 'piped', base: 'https://pipedapi.adminforge.de' },
  { type: 'piped', base: 'https://api.piped.private.coffee' },
  { type: 'piped', base: 'https://pipedapi.ducks.party' },
  { type: 'piped', base: 'https://pipedapi.drgns.space' },
  { type: 'piped', base: 'https://pipedapi.leptons.xyz' },
  { type: 'piped', base: 'https://pipedapi.nosebs.ru' },
  { type: 'piped', base: 'https://api.piped.yt' },
  { type: 'piped', base: 'https://pipedapi.owo.si' },
  { type: 'piped', base: 'https://pipedapi.reallyaweso.me' },
  { type: 'piped', base: 'https://piped-api.privacy.com.de' },
  { type: 'piped', base: 'https://piped-api.codespace.cz' },
  { type: 'piped', base: 'https://pipedapi.darkness.services' },
  { type: 'piped', base: 'https://pipedapi.orangenet.cc' },
  { type: 'piped', base: 'https://pipedapi-libre.kavin.rocks' },
  { type: 'invidious', base: 'https://inv.nadeko.net' },
  { type: 'invidious', base: 'https://invidious.nerdvpn.de' },
  { type: 'invidious', base: 'https://invidious.tiekoetter.com' },
  { type: 'invidious', base: 'https://yt.chocolatemoo53.com' },
  { type: 'invidious', base: 'https://invidious.f5.si' },
  { type: 'invidious', base: 'https://inv.zoomerville.com' },
];

// Both projects publish live, health-checked instance directories (with CORS
// open). Discover current mirrors at runtime so the list never goes stale;
// fall back to the snapshot above if the directories are down.
let mirrorsPromise = null;
function discoverMirrors() {
  if (!mirrorsPromise) {
    mirrorsPromise = (async () => {
      const discovered = [];
      const [piped, invidious] = await Promise.allSettled([
        fetchWithTimeout('https://piped-instances.kavin.rocks/', 8000).then((r) => r.json()),
        fetchWithTimeout('https://api.invidious.io/instances.json?sort_by=health', 8000).then((r) => r.json()),
      ]);
      if (piped.status === 'fulfilled' && Array.isArray(piped.value)) {
        for (const inst of piped.value) {
          if (inst && inst.api_url) discovered.push({ type: 'piped', base: inst.api_url });
        }
      }
      if (invidious.status === 'fulfilled' && Array.isArray(invidious.value)) {
        for (const entry of invidious.value) {
          const d = Array.isArray(entry) ? entry[1] : null;
          if (d && d.type === 'https' && d.api !== false && d.cors !== false) {
            discovered.push({ type: 'invidious', base: d.uri.replace(/\/+$/, '') });
          }
        }
      }
      const seen = new Set();
      const merged = [];
      for (const m of [...discovered, ...FALLBACK_MIRRORS]) {
        try {
          const host = new URL(m.base).hostname;
          if (!seen.has(host)) {
            seen.add(host);
            merged.push(m);
          }
        } catch (_) { /* malformed directory entry */ }
      }
      return merged.slice(0, 24);
    })().catch(() => FALLBACK_MIRRORS);
  }
  return mirrorsPromise;
}

function parseVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      if (/^[\w-]{11}$/.test(id)) return id;
    }
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch (_) { /* not a URL */ }
  return null;
}

// Prefer AAC/mp4 (every browser incl. iOS Safari decodes it), highest bitrate.
function rankAudio(a, b) {
  const mp4 = (s) => ((s.mimeType || s.type || '').includes('audio/mp4') ? 1 : 0);
  return mp4(b) - mp4(a) || (b.bitrate || 0) - (a.bitrate || 0);
}

async function mirrorLookup(mirror, id) {
  if (mirror.type === 'piped') {
    const res = await fetchWithTimeout(`${mirror.base}/streams/${id}`, 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const streams = (data.audioStreams || []).slice().sort(rankAudio);
    if (!streams.length) throw new Error('no audio streams');
    return {
      audioUrl: streams[0].url,
      info: {
        title: data.title,
        author: data.uploader,
        lengthSeconds: data.duration,
        thumbnail: data.thumbnailUrl,
      },
    };
  }
  // invidious — local=true proxies the stream through the instance (adds CORS)
  const res = await fetchWithTimeout(`${mirror.base}/api/v1/videos/${id}?local=true`, 10000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const streams = (data.adaptiveFormats || [])
    .filter((f) => (f.type || '').startsWith('audio/'))
    .sort(rankAudio);
  if (!streams.length) throw new Error('no audio streams');
  const audioUrl = new URL(streams[0].url, mirror.base).href;
  const thumbs = data.videoThumbnails || [];
  return {
    audioUrl,
    info: {
      title: data.title,
      author: data.author,
      lengthSeconds: data.lengthSeconds,
      thumbnail: thumbs.length ? thumbs[0].url : null,
    },
  };
}

async function loadViaMirrors(url) {
  const id = parseVideoId(url);
  if (!id) throw fatal('That does not look like a valid YouTube link.');

  setStatus('Finding a working mirror…');
  const mirrors = await discoverMirrors();
  const CHUNK = 6;
  let lastError = null;

  for (let i = 0; i < mirrors.length; i += CHUNK) {
    const chunk = mirrors.slice(i, i + CHUNK);
    setStatus(`Checking mirrors ${i + 1}–${Math.min(i + CHUNK, mirrors.length)} of ${mirrors.length}…`);
    const settled = await Promise.allSettled(
      chunk.map((m) => mirrorLookup(m, id).then((r) => ({ mirror: m, ...r })))
    );
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        lastError = result.reason;
        continue;
      }
      const { mirror, audioUrl, info } = result.value;
      if (info.lengthSeconds > MAX_SECONDS) {
        throw fatal(`That video is over ${MAX_SECONDS / 60} minutes — pick something shorter.`);
      }
      try {
        setStatus(`Downloading audio via ${new URL(mirror.base).hostname}…`);
        const audioRes = await fetchWithTimeout(audioUrl, 120000);
        if (!audioRes.ok) throw new Error(`audio HTTP ${audioRes.status}`);
        return { info, arrayBuffer: await audioRes.arrayBuffer() };
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw new Error(
    'All public YouTube mirrors failed for this video. These community mirrors go up and down — try again in a bit, or use the server-backed version (see README).'
      + (lastError ? ` (last error: ${lastError.message})` : '')
  );
}

// ---------------------------------------------------------------------------

async function loadSong(url) {
  loadBtn.disabled = true;
  playerEl.classList.add('hidden');
  stopPlayback();
  shifter = null;
  audioBuffer = null;

  try {
    const backend = await detectBackend();
    const { info, arrayBuffer } =
      backend === 'server' ? await loadViaServer(url) : await loadViaMirrors(url);

    titleEl.textContent = info.title;
    authorEl.textContent = info.author || '';
    if (info.thumbnail) thumbEl.src = info.thumbnail;

    setStatus('Decoding audio…');
    // Promise wrapper: iOS Safari still wants the callback form of decodeAudioData.
    audioBuffer = await new Promise((resolve, reject) => {
      ensureAudioContext().decodeAudioData(arrayBuffer, resolve, reject);
    });

    createShifter();
    seekSlider.value = 0;
    timeCurrentEl.textContent = '0:00';
    timeTotalEl.textContent = formatTime(audioBuffer.duration);
    playerEl.classList.remove('hidden');
    setStatus('Ready. Set your key and hit play.');
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', true);
  } finally {
    loadBtn.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // Creating/resuming the AudioContext inside this tap satisfies mobile
  // autoplay policies before any async work happens.
  ensureAudioContext().resume();
  const url = urlInput.value.trim();
  if (url) loadSong(url);
});

playBtn.addEventListener('click', () => {
  if (!shifter) return;
  if (isPlaying) stopPlayback();
  else startPlayback();
});

$('pitch-up').addEventListener('click', () => applyPitch(semitones + 1));
$('pitch-down').addEventListener('click', () => applyPitch(semitones - 1));
$('pitch-reset').addEventListener('click', () => applyPitch(0));

tempoSlider.addEventListener('input', () => {
  tempo = Number(tempoSlider.value) / 100;
  tempoValueEl.textContent = `${tempo.toFixed(2)}×`;
  if (shifter) shifter.tempo = tempo;
});

seekSlider.addEventListener('input', () => {
  isSeeking = true;
  if (audioBuffer) {
    timeCurrentEl.textContent = formatTime((Number(seekSlider.value) / 1000) * audioBuffer.duration);
  }
});

const commitSeek = () => {
  // Quirk in soundtouchjs: the percentagePlayed GETTER returns 0-100, but the
  // SETTER expects a 0-1 fraction of the track. Slider range is 0-1000.
  if (shifter) shifter.percentagePlayed = Number(seekSlider.value) / 1000;
  isSeeking = false;
};
seekSlider.addEventListener('change', commitSeek);
