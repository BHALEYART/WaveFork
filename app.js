import { createMix, addInto, encodeWav, computePeaks } from './audio.js';

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

const SAMPLE_RATE = 44100; // what the Demucs model expects
const MAX_SECONDS = 20 * 60; // keeps memory use reasonable on ordinary machines
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const COLORS = { vocals: '#FF3B3B', instrumental: '#DC143C', source: '#A38E90' };
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;

const state = {
  file: null,  // what the user picked (audio or video)
  audio: null, // its soundtrack at 44.1 kHz: { left, right, duration }
  sourcePeaks: null,
  stems: null, // { vocals: { url, peaks, duration, filename }, instrumental: {...} }
  current: null,
  busy: false,
};

if (!('Worker' in window) || typeof WebAssembly !== 'object') {
  showError("This browser can't run the separation. Try a recent version of Chrome, Edge, Firefox or Safari.");
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

// Decode straight to 44.1 kHz stereo, whatever the file's own rate is.
async function decodeForModel(file) {
  const decoder = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const buf = await decoder.decodeAudioData(await file.arrayBuffer());
  const left = buf.getChannelData(0);
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
  return { left, right, duration: buf.duration };
}

async function pickFile(file) {
  if (!file || state.busy) return;
  const isVideo = file.type.startsWith('video/') || VIDEO_EXT.test(file.name);
  const isAudio = !isVideo && (file.type.startsWith('audio/') || AUDIO_EXT.test(file.name));
  if (!isAudio && !isVideo) {
    return showError(`${file.name} isn't an audio or video file. Choose an MP3, WAV, FLAC, M4A, MP4, MOV or WebM.`);
  }
  if (isAudio && file.size > MAX_AUDIO_BYTES) {
    return showError(`${file.name} is ${mb(file.size)}. The limit for audio is 200 MB, so try an MP3 or a shorter track.`);
  }
  if (isVideo && file.size > MAX_VIDEO_BYTES) {
    return showError(`${file.name} is ${mb(file.size)}. The limit for video is 500 MB, so try a shorter clip.`);
  }

  state.file = file;
  state.audio = null;
  state.sourcePeaks = null;
  hideStatus();
  els.drop.hidden = true;
  els.source.hidden = false;
  els.track.dataset.state = 'source';
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = mb(file.size);
  els.go.disabled = true;
  clearCanvas(els.sourceWave);
  setStatus(isVideo ? 'Reading the audio from your video' : 'Reading your track', null);

  let audio;
  try {
    audio = await decodeForModel(file);
  } catch {
    if (state.file !== file) return;
    state.file = null;
    return showError(isVideo
      ? `Your browser couldn't read the audio in ${file.name}. Try Chrome or Firefox, or export the audio from the video first.`
      : `Your browser couldn't read ${file.name}. Try converting it to MP3 or WAV first.`);
  }
  if (state.file !== file) return; // a newer pick replaced this one

  if (audio.duration > MAX_SECONDS) {
    state.file = null;
    return showError(`${file.name} runs ${clock(audio.duration)}. The limit is 20 minutes, so try a shorter clip.`);
  }

  state.audio = audio;
  state.sourcePeaks = computePeaks([audio.left, audio.right]);
  drawWave(els.sourceWave, state.sourcePeaks, COLORS.source);
  els.fileMeta.textContent = isVideo ? `${clock(audio.duration)}, audio from video` : `${clock(audio.duration)}, ${mb(file.size)}`;
  hideStatus();
  els.go.disabled = false;
}

// ---------- Splitting (runs in a worker on this device) ----------

let worker = null;

function runSeparation(left, right) {
  worker ??= new Worker(new URL('./separator.worker.js', import.meta.url), { type: 'module' });
  const progress = { started: 0, backend: null };

  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') showWorkerStatus(data, progress);
      else if (data.type === 'done') resolve(data.stems);
      else if (data.type === 'error') reject(new Error(data.message));
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      reject(new Error(e.message || 'The separation stopped unexpectedly.'));
    };
    // Send copies so the original stays available for a retry.
    const l = left.slice();
    const r = right.slice();
    worker.postMessage({ type: 'separate', left: l, right: r }, [l.buffer, r.buffer]);
  });
}

function showWorkerStatus({ phase, progress: pct, backend }, run) {
  if (phase === 'downloading') {
    return setStatus(`Downloading the separation model (one time, about 170 MB) ${pct}%`, pct);
  }
  if (phase === 'loading') return setStatus('Loading the separation model', null);

  // separating
  if (backend) { run.backend = backend; run.started = 0; }
  if (!run.started) run.started = performance.now();
  const slow = run.backend === 'wasm' ? '. No GPU is available here, so this takes longer' : '';
  let eta = '';
  if (pct >= 5 && pct < 100) {
    const elapsed = (performance.now() - run.started) / 1000;
    const left = Math.max(0, elapsed / (pct / 100) - elapsed);
    eta = left >= 60 ? `, about ${Math.round(left / 60)} min left` : ', under a minute left';
  }
  setStatus(`Separating vocals from music ${pct}%${eta}${slow}`, pct);
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.audio || state.busy) return;
  const mode = els.form.elements.mode.value;
  setBusy(true);
  setStatus('Starting', null);

  try {
    const stems = await runSeparation(state.audio.left, state.audio.right);
    setStatus('Mixing the instrumental', null);
    await nextFrame();
    buildStems(stems, state.file.name);
    showResults(mode);
  } catch (err) {
    worker?.terminate(); // start fresh next time
    worker = null;
    showError(friendly(err));
  } finally {
    setBusy(false);
  }
});

// Stems arrive as { left, right } Float32Arrays at 44.1 kHz.
function buildStems(stems, originalName) {
  const base = baseName(originalName);
  const asBuffer = (s) => ({ numberOfChannels: 2, length: s.left.length, getChannelData: (c) => (c ? s.right : s.left) });

  const v = stems.vocals;
  const vocalsWav = new Blob([encodeWav({ channels: [v.left, v.right], sampleRate: SAMPLE_RATE, length: v.left.length })], { type: 'audio/wav' });
  const vocals = {
    url: URL.createObjectURL(vocalsWav),
    peaks: computePeaks([v.left, v.right]),
    duration: v.left.length / SAMPLE_RATE,
    filename: `${base} (vocals).wav`,
  };

  const mix = createMix(v.left.length, SAMPLE_RATE);
  for (const name of ['drums', 'bass', 'other']) addInto(mix, asBuffer(stems[name]));
  const instrumentalWav = new Blob([encodeWav(mix)], { type: 'audio/wav' });
  const instrumental = {
    url: URL.createObjectURL(instrumentalWav),
    peaks: computePeaks(mix.channels),
    duration: mix.length / SAMPLE_RATE,
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
  els.go.hidden = true;
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
  Object.assign(state, { file: null, audio: null, sourcePeaks: null, stems: null, current: null });
  els.file.value = '';
  els.track.dataset.state = 'empty';
  els.drop.hidden = false;
  els.source.hidden = true;
  els.lanes.hidden = true;
  els.player.hidden = true;
  els.go.hidden = false;
  els.go.disabled = true;
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
  els.go.disabled = busy || !state.audio;
  els.go.textContent = busy ? 'Splitting…' : 'Split track';
  els.changeFile.disabled = busy;
  els.file.disabled = busy;
}

function friendly(err) {
  const msg = err?.message || String(err);
  if (/memory|allocation|RangeError|out of bounds/i.test(msg) || err?.name === 'RangeError') {
    return 'Your device ran out of memory while separating. Try a shorter clip, close other tabs, or use a computer.';
  }
  if (/could not be downloaded/i.test(msg)) return `${msg} Check your connection and try again.`;
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return `Part of the separation engine could not be loaded (${msg}). Check your connection and try again.`;
  }
  return `Separation failed: ${msg}`;
}

// ---------- Small utilities ----------

function nextFrame() { return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); }

function baseName(name) { return name.replace(/\.[^.]+$/, '') || 'track'; }

function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

function clock(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
