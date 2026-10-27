import { upload } from './vendor/blob-client.js'; // bundled @vercel/blob@2.8.2 client
import { createMix, addInto, channelsOf, encodeWav, computePeaks } from './audio.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const els = {
  track: $('#track'),
  drop: $('#drop'),
  file: $('#file'),
  source: $('#source'),
  fileName: $('#fileName'),
  fileMeta: $('#fileMeta'),
  changeFile: $('#changeFile'),
  sourceWave: $('#sourceWave'),
  lanes: $('#lanes'),
  form: $('#controls'),
  quality: $('.choice.quality'),
  codeRow: $('#codeRow'),
  code: $('#code'),
  go: $('#go'),
  status: $('#status'),
  statusText: $('#statusText'),
  statusBar: $('#statusBar'),
  player: $('#player'),
  play: $('#play'),
  seek: $('#seek'),
  time: $('#time'),
  restart: $('#restart'),
  audio: $('#audio'),
};

const MAX_BYTES = 60 * 1024 * 1024;
const POLL_MS = 2500;
const POLL_LIMIT_MS = 20 * 60 * 1000;
const INSTRUMENT_STEMS = ['drums', 'bass', 'other', 'guitar', 'piano'];
const COLORS = { vocals: '#FF8FA3', instrumental: '#6FD3C7', source: '#A99CBD' };
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$/i;

const state = {
  file: null,
  sourcePeaks: null,
  stems: null, // { vocals: { url, peaks, duration, filename }, instrumental: {...} }
  current: null,
  busy: false,
  accessRequired: false,
};

let audioCtx;
function ctx() {
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// ---------- Access code ----------

function storedCode() {
  try { return localStorage.getItem('wavefork-code') || ''; } catch { return ''; }
}
function saveCode(code) {
  try { localStorage.setItem('wavefork-code', code); } catch { /* storage unavailable */ }
}
function accessCode() {
  return els.code.value.trim();
}

fetch('/api/config')
  .then((r) => r.json())
  .then(({ accessRequired }) => {
    state.accessRequired = accessRequired;
    if (accessRequired) {
      els.codeRow.hidden = false;
      els.code.value = storedCode();
    }
  })
  .catch(() => {});

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-access-code': accessCode(), ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    els.codeRow.hidden = false;
    throw new Error('Enter the access code to use WaveFork.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---------- Choosing a file ----------

els.file.addEventListener('change', () => pickFile(els.file.files[0]));
els.changeFile.addEventListener('click', () => els.file.click());

els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('is-over'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('is-over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('is-over');
  pickFile(e.dataTransfer.files[0]);
});

async function pickFile(file) {
  if (!file || state.busy) return;
  if (!(file.type.startsWith('audio/') || AUDIO_EXT.test(file.name))) {
    return showError(`${file.name} isn't an audio file. Choose an MP3, WAV, FLAC, M4A or OGG.`);
  }
  if (file.size > MAX_BYTES) {
    return showError(`${file.name} is ${mb(file.size)}. The limit is 60 MB, so try an MP3 or a shorter track.`);
  }

  state.file = file;
  state.sourcePeaks = null;
  hideStatus();
  els.drop.hidden = true;
  els.source.hidden = false;
  els.track.dataset.state = 'source';
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = mb(file.size);
  els.go.disabled = false;
  clearCanvas(els.sourceWave);

  try {
    const buf = await ctx().decodeAudioData(await file.arrayBuffer());
    if (state.file !== file) return; // a newer pick replaced this one
    state.sourcePeaks = computePeaks(channelsOf(buf));
    els.fileMeta.textContent = `${clock(buf.duration)}, ${mb(file.size)}`;
    drawWave(els.sourceWave, state.sourcePeaks, COLORS.source);
  } catch {
    // The browser can't preview this format; Demucs may still handle it.
  }
}

// ---------- Splitting ----------

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.file || state.busy) return;
  const mode = els.form.elements.mode.value;
  const quality = els.form.elements.quality.value;
  if (state.accessRequired && !accessCode()) {
    els.code.focus();
    return showError('Enter the access code to use WaveFork.');
  }
  saveCode(accessCode());
  ctx().resume?.();
  setBusy(true);

  try {
    const file = state.file;
    setStatus('Uploading 0%', 0);
    const blob = await upload(`uploads/${safeName(file.name)}`, file, {
      access: 'public',
      handleUploadUrl: '/api/upload',
      clientPayload: accessCode() || null,
      contentType: file.type || guessType(file.name),
      multipart: file.size > 8 * 1024 * 1024,
      onUploadProgress: ({ percentage }) => setStatus(`Uploading ${Math.round(percentage)}%`, percentage),
    });

    setStatus('Starting separation', null);
    const { id } = await api('/api/separate', {
      method: 'POST',
      body: JSON.stringify({ audioUrl: blob.url, quality }),
    });

    const output = await poll(id, blob.url);
    await buildStems(output, file.name);
    showResults(mode);
  } catch (err) {
    showError(friendly(err));
  } finally {
    setBusy(false);
  }
});

async function poll(id, blobUrl) {
  const started = Date.now();
  const path = `/api/status?id=${encodeURIComponent(id)}&blob=${encodeURIComponent(blobUrl)}`;
  while (Date.now() - started < POLL_LIMIT_MS) {
    const job = await api(path);
    if (job.status === 'succeeded') return job.output;
    if (job.status === 'failed' || job.status === 'canceled') {
      throw new Error(`Separation failed: ${job.error || 'the model stopped without a result'}. Try again, or try a different file.`);
    }
    if (job.status === 'starting') {
      setStatus('Waiting for a GPU. The first run after a quiet spell can take a minute or two.', null);
    } else if (job.progress != null) {
      setStatus(`Separating vocals from music ${job.progress}%`, job.progress);
    } else {
      setStatus('Separating vocals from music', null);
    }
    await sleep(POLL_MS);
  }
  throw new Error('Separation is taking longer than 20 minutes. Try again, or try a shorter track.');
}

async function fetchStem(url) {
  const res = await fetch(`/api/stem?url=${encodeURIComponent(url)}`, {
    headers: { 'x-access-code': accessCode() },
  });
  if (!res.ok) throw new Error('Could not download a separated track. Try again.');
  return res.arrayBuffer();
}

async function buildStems(output, originalName) {
  if (!output?.vocals) throw new Error('The model finished but returned no vocal track. Try again.');
  const others = INSTRUMENT_STEMS.filter((name) => output[name]);
  if (!others.length) throw new Error('The model finished but returned no instrument tracks. Try again.');

  setStatus('Downloading the separated tracks', null);
  const [vocalBytes, ...otherBytes] = await Promise.all(
    [output.vocals, ...others.map((name) => output[name])].map(fetchStem),
  );

  const base = originalName.replace(/\.[^.]+$/, '') || 'track';

  // Blob copies the bytes before decodeAudioData detaches the buffer.
  const vocalFile = new Blob([vocalBytes], { type: 'audio/mpeg' });
  const vocalBuf = await ctx().decodeAudioData(vocalBytes);
  const vocals = {
    url: URL.createObjectURL(vocalFile),
    peaks: computePeaks(channelsOf(vocalBuf)),
    duration: vocalBuf.duration,
    filename: `${base} (vocals).mp3`,
  };

  setStatus('Mixing the instrumental', null);
  let mix;
  for (const bytes of otherBytes) {
    const buf = await ctx().decodeAudioData(bytes); // one at a time to limit memory
    mix ??= createMix(buf.length, buf.sampleRate);
    addInto(mix, buf);
  }
  const wav = new Blob([encodeWav(mix)], { type: 'audio/wav' });
  const instrumental = {
    url: URL.createObjectURL(wav),
    peaks: computePeaks(mix.channels),
    duration: mix.length / mix.sampleRate,
    filename: `${base} (instrumental).wav`,
  };

  state.stems = { vocals, instrumental };
}

// ---------- Results and playback ----------

function showResults(mode) {
  hideStatus();
  els.source.hidden = true;
  els.lanes.hidden = false;
  els.track.dataset.state = 'split';
  els.quality.hidden = true;
  els.go.hidden = true;
  els.codeRow.hidden = true;
  els.player.hidden = false;

  for (const link of $$('.download', els.lanes)) {
    const stem = state.stems[link.dataset.stem];
    link.href = stem.url;
    link.download = stem.filename;
  }
  selectStem(mode);
}

function selectStem(stem, seekTo) {
  if (!state.stems) return;
  const changed = state.current !== stem;
  state.current = stem;

  for (const btn of $$('.lane-pick')) btn.setAttribute('aria-pressed', String(btn.dataset.stem === stem));
  els.player.dataset.stem = stem;
  const radio = els.form.querySelector(`input[name="mode"][value="${stem}"]`);
  if (radio) radio.checked = true;

  const audio = els.audio;
  if (changed) {
    const t = seekTo ?? audio.currentTime;
    const wasPlaying = !audio.paused;
    audio.src = state.stems[stem].url;
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = Math.min(t, audio.duration || t);
      if (wasPlaying) audio.play().catch(() => {});
      updateTime();
    }, { once: true });
  } else if (seekTo != null) {
    audio.currentTime = seekTo;
  }
  drawLanes();
  updateTime();
}

els.lanes.addEventListener('click', (e) => {
  const pick = e.target.closest('.lane-pick');
  if (pick) return selectStem(pick.dataset.stem);

  const canvas = e.target.closest('canvas.wave');
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    selectStem(canvas.dataset.stem, frac * state.stems[canvas.dataset.stem].duration);
  }
});

els.form.addEventListener('change', (e) => {
  if (e.target.name === 'mode' && state.stems) selectStem(e.target.value);
});

els.play.addEventListener('click', () => {
  if (els.audio.paused) els.audio.play().catch(() => {});
  else els.audio.pause();
});

els.seek.addEventListener('input', () => {
  const d = els.audio.duration;
  if (d) els.audio.currentTime = (els.seek.value / 1000) * d;
  drawLanes();
});

let raf;
els.audio.addEventListener('play', () => {
  els.play.classList.add('is-playing');
  els.play.setAttribute('aria-label', 'Pause');
  const tick = () => { updateTime(); drawLanes(); raf = requestAnimationFrame(tick); };
  tick();
});
els.audio.addEventListener('pause', () => {
  els.play.classList.remove('is-playing');
  els.play.setAttribute('aria-label', 'Play');
  cancelAnimationFrame(raf);
  updateTime();
  drawLanes();
});
els.audio.addEventListener('ended', () => els.audio.pause());

function updateTime() {
  const a = els.audio;
  const d = a.duration || state.stems?.[state.current]?.duration || 0;
  els.time.textContent = `${clock(a.currentTime)} / ${clock(d)}`;
  if (document.activeElement !== els.seek) els.seek.value = d ? Math.round((a.currentTime / d) * 1000) : 0;
}

els.restart.addEventListener('click', reset);

function reset() {
  els.audio.pause();
  els.audio.removeAttribute('src');
  els.audio.load();
  if (state.stems) {
    URL.revokeObjectURL(state.stems.vocals.url);
    URL.revokeObjectURL(state.stems.instrumental.url);
  }
  Object.assign(state, { file: null, sourcePeaks: null, stems: null, current: null });
  els.file.value = '';
  els.track.dataset.state = 'empty';
  els.drop.hidden = false;
  els.source.hidden = true;
  els.lanes.hidden = true;
  els.player.hidden = true;
  els.quality.hidden = false;
  els.go.hidden = false;
  els.go.disabled = true;
  els.codeRow.hidden = !state.accessRequired;
  hideStatus();
}

// ---------- Drawing ----------

function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

function clearCanvas(canvas) {
  const { w, h } = sizeCanvas(canvas);
  canvas.getContext('2d').clearRect(0, 0, w, h);
}

// Rounded bars, mirrored around the centre line. `played` (0–1) is drawn at
// full strength; the rest is faded. Unselected lanes are faded throughout.
function drawWave(canvas, peaks, color, { played = 0, selected = true } = {}) {
  const { w, h, dpr } = sizeCanvas(canvas);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!peaks || !w) return;

  const bar = 3 * dpr;
  const gap = 2 * dpr;
  const count = Math.max(1, Math.floor((w + gap) / (bar + gap)));
  let max = 0;
  for (const p of peaks) if (p > max) max = p;
  const scale = max > 0 ? 1 / max : 0;

  for (let i = 0; i < count; i++) {
    const from = Math.floor((i / count) * peaks.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / count) * peaks.length));
    let v = 0;
    for (let j = from; j < to; j++) if (peaks[j] > v) v = peaks[j];
    const bh = Math.max(2 * dpr, v * scale * (h - 4 * dpr));
    const x = i * (bar + gap);
    const isPlayed = (i + 0.5) / count <= played;
    g.globalAlpha = selected ? (isPlayed ? 1 : 0.42) : 0.18;
    g.fillStyle = color;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, (h - bh) / 2, bar, bh, bar / 2);
    else g.rect(x, (h - bh) / 2, bar, bh);
    g.fill();
  }
  g.globalAlpha = 1;
}

function drawLanes() {
  if (!state.stems) return;
  const a = els.audio;
  const played = a.duration ? a.currentTime / a.duration : 0;
  for (const canvas of $$('canvas.wave', els.lanes)) {
    const stem = canvas.dataset.stem;
    drawWave(canvas, state.stems[stem].peaks, COLORS[stem], { played, selected: stem === state.current });
  }
}

new ResizeObserver(() => {
  if (!els.source.hidden && state.sourcePeaks) drawWave(els.sourceWave, state.sourcePeaks, COLORS.source);
  drawLanes();
}).observe(els.track);

// ---------- Status ----------

function setStatus(text, percent) {
  els.status.hidden = false;
  els.status.classList.remove('is-error');
  els.statusText.textContent = text;
  const bar = els.statusBar.parentElement;
  bar.hidden = false;
  bar.classList.toggle('is-indeterminate', percent == null);
  els.statusBar.style.width = percent == null ? '' : `${Math.max(2, Math.min(100, percent))}%`;
}

function showError(text) {
  els.status.hidden = false;
  els.status.classList.add('is-error');
  els.statusText.textContent = text;
  els.statusBar.parentElement.hidden = true;
}

function hideStatus() {
  els.status.hidden = true;
}

function setBusy(busy) {
  state.busy = busy;
  els.go.disabled = busy || !state.file;
  els.go.textContent = busy ? 'Splitting…' : 'Split track';
  els.changeFile.disabled = busy;
  els.file.disabled = busy;
  for (const input of els.quality.querySelectorAll('input')) input.disabled = busy;
}

function friendly(err) {
  const msg = err?.message || String(err);
  if (/access code/i.test(msg)) {
    els.codeRow.hidden = false;
    return 'That access code was not accepted. Check it and try again.';
  }
  if (/client token/i.test(msg)) return 'The upload could not start. Check your connection and try again.';
  if (/decode/i.test(msg) || err?.name === 'EncodingError') {
    return 'Your browser could not read the separated tracks. Try again in Chrome, Edge or Firefox.';
  }
  return msg;
}

// ---------- Small utilities ----------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

function clock(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function safeName(name) {
  const clean = name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(-80);
  return clean || 'track.mp3';
}

function guessType(name) {
  const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
  return {
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff',
  }[ext] || 'audio/mpeg';
}
