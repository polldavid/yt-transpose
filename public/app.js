import { PitchShifter } from '/vendor/soundtouch.js';

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

async function fetchJson(url) {
  const res = await fetch(url);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

async function loadSong(url) {
  loadBtn.disabled = true;
  playerEl.classList.add('hidden');
  stopPlayback();
  shifter = null;
  audioBuffer = null;

  try {
    setStatus('Looking up video…');
    const info = await fetchJson(`/api/info?url=${encodeURIComponent(url)}`);
    if (info.tooLong) {
      throw new Error(`That video is over ${Math.round(info.maxSeconds / 60)} minutes — pick something shorter.`);
    }

    titleEl.textContent = info.title;
    authorEl.textContent = info.author || '';
    if (info.thumbnail) thumbEl.src = info.thumbnail;
    timeTotalEl.textContent = formatTime(info.lengthSeconds);

    setStatus('Downloading audio…');
    const audioRes = await fetch(`/api/audio?url=${encodeURIComponent(url)}`);
    if (!audioRes.ok) {
      let message = `Audio download failed (${audioRes.status})`;
      try {
        message = (await audioRes.json()).error || message;
      } catch (_) { /* non-JSON error body */ }
      throw new Error(message);
    }
    const arrayBuffer = await audioRes.arrayBuffer();

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
