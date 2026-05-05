// Scan page — upload image of sheet music, POST to Audiveris service,
// render returned MusicXML with OSMD, play via soundfont.

import { ScoreManager } from './score.js';
import { ReferenceToneEngine } from './audio.js';
import { ScorePlayer } from './playback.js';

const ENGINE_DEFAULTS = {
  audiveris: { url: 'http://localhost:8001', hint: '30–90 s on clean scans; rule-based.' },
  oemer:     { url: 'http://localhost:8002', hint: '1–5 min; first run downloads ONNX weights.' },
  clarity:   { url: 'http://localhost:8003', hint: '1–10 min; first run downloads HF models.' },
};

const state = {
  audioContext: null,
  scoreManager: new ScoreManager(),
  referenceTone: null,
  scorePlayer: null,
  imageFile: null,
  activeNotes: [],
  isPlaying: false,
  // Per-engine URL overrides so switching engines remembers the last URL you typed.
  engineUrls: { ...Object.fromEntries(Object.entries(ENGINE_DEFAULTS).map(([k, v]) => [k, v.url])) },
};

const els = {};

function $(id) { return document.getElementById(id); }

function initDOM() {
  els.engineSelect = $('engine-select');
  els.serverUrl = $('server-url');
  els.healthBtn = $('health-btn');
  els.imageInput = $('image-input');
  els.scanBtn = $('scan-btn');
  els.bpmInput = $('bpm-input');
  els.playBtn = $('play-btn');
  els.status = $('status');
  els.preview = $('preview');
  els.scoreContainer = $('score-container');
}

function currentEngine() {
  return els.engineSelect?.value || 'audiveris';
}

function onEngineChange() {
  const engine = currentEngine();
  els.serverUrl.value = state.engineUrls[engine] || ENGINE_DEFAULTS[engine].url;
  const hint = ENGINE_DEFAULTS[engine]?.hint || '';
  setStatus(`Engine: ${engine} — ${hint}`);
}

function rememberUrlForCurrentEngine() {
  state.engineUrls[currentEngine()] = els.serverUrl.value;
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', !!isError);
}

function ensureAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (state.audioContext.state === 'suspended') {
    state.audioContext.resume();
  }
  return state.audioContext;
}

function getServerUrl() {
  return (els.serverUrl.value || '').replace(/\/+$/, '');
}

async function checkHealth() {
  const url = getServerUrl();
  if (!url) { setStatus('Set an OMR service URL first.', true); return; }
  setStatus(`Checking ${currentEngine()} at ${url}…`);
  try {
    const res = await fetch(`${url}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    setStatus(`Service OK: ${JSON.stringify(body)}`);
  } catch (err) {
    setStatus(`Cannot reach service: ${err.message}`, true);
  }
}

function onImageSelected() {
  const file = els.imageInput.files[0];
  state.imageFile = file || null;
  els.scanBtn.disabled = !file;

  if (!file) {
    els.preview.classList.add('hidden');
    els.preview.src = '';
    return;
  }

  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    els.preview.src = url;
    els.preview.classList.remove('hidden');
  } else {
    els.preview.classList.add('hidden');
  }
  setStatus(`Ready: ${file.name} (${Math.round(file.size / 1024)} KB)`);
}

async function scan() {
  const file = state.imageFile;
  if (!file) return;

  const url = getServerUrl();
  if (!url) { setStatus('Set an OMR service URL first.', true); return; }
  const engine = currentEngine();

  els.scanBtn.disabled = true;
  els.playBtn.disabled = true;
  setStatus(`Uploading to ${engine} — ${ENGINE_DEFAULTS[engine]?.hint || ''}`);

  const form = new FormData();
  form.append('image', file, file.name);

  try {
    const res = await fetch(`${url}/omr`, { method: 'POST', body: form });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        detail = err.error || detail;
        if (err.stderr) console.warn(`[${engine} stderr]`, err.stderr);
      } catch (_) {}
      throw new Error(detail);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const nameMatch = /filename="?([^"]+)"?/i.exec(disposition);
    const filename = nameMatch ? nameMatch[1] : 'scan.mxl';

    // Hand the blob to ScoreManager as if it were a normal file upload.
    const scoreFile = new File([blob], filename, { type: blob.type });
    setStatus(`Received ${filename} (${Math.round(blob.size / 1024)} KB) — rendering…`);
    await loadScore(scoreFile);
  } catch (err) {
    setStatus(`Scan failed: ${err.message}`, true);
    console.error(err);
  } finally {
    els.scanBtn.disabled = false;
  }
}

async function loadScore(file) {
  els.scoreContainer.innerHTML = '<p>Rendering score…</p>';
  try {
    await state.scoreManager.loadFile(file);
    const parts = state.scoreManager.getParts();
    state.activeNotes = state.scoreManager.getNotesForPart(0);

    const bpm = state.scoreManager.getBPM();
    if (bpm) els.bpmInput.value = bpm;

    els.playBtn.disabled = !state.activeNotes.length;
    setStatus(
      `Loaded ${parts.length} part(s), ${state.activeNotes.length} notes in part 1.`
    );
  } catch (err) {
    setStatus(`Render failed: ${err.message}`, true);
    console.error(err);
    els.scoreContainer.innerHTML = `<p class="error">Error: ${err.message}</p>`;
  }
}

function setPlayBtnState(loading, playing) {
  els.playBtn.textContent = loading ? 'Loading…' : (playing ? '⏹ Stop' : '▶ Play');
  els.playBtn.disabled = loading;
  els.playBtn.classList.toggle('active', !!playing);
}

async function togglePlayback() {
  if (state.isPlaying) {
    stopPlayback();
    return;
  }
  if (!state.activeNotes.length) return;

  const ctx = ensureAudioContext();
  await ctx.resume();

  setPlayBtnState(true, false);

  try {
    if (!state.referenceTone) state.referenceTone = new ReferenceToneEngine(ctx);
    await state.referenceTone.init();

    if (!state.scorePlayer) state.scorePlayer = new ScorePlayer(ctx);
    state.scorePlayer.player = state.referenceTone.player;
    if (!state.scorePlayer.player) throw new Error('Soundfont player failed to load');

    const bpm = Math.max(20, Math.min(400, parseInt(els.bpmInput.value) || 120));

    state.scorePlayer.onNoteIndex = (idx) => {
      const note = state.activeNotes[idx];
      if (note) state.scoreManager.syncCursor(note.scoreStartBeat ?? note.startBeat);
    };
    state.scorePlayer.onEnded = () => {
      state.isPlaying = false;
      setPlayBtnState(false, false);
    };

    state.isPlaying = true;
    setPlayBtnState(false, true);
    state.scorePlayer.play(state.activeNotes, bpm, 0);
  } catch (err) {
    console.error(err);
    setStatus(`Playback failed: ${err.message}`, true);
    state.isPlaying = false;
    setPlayBtnState(false, false);
  }
}

function stopPlayback() {
  if (state.scorePlayer) state.scorePlayer.stop();
  state.isPlaying = false;
  setPlayBtnState(false, false);
}

function init() {
  initDOM();
  els.engineSelect.addEventListener('change', onEngineChange);
  els.serverUrl.addEventListener('input', rememberUrlForCurrentEngine);
  els.healthBtn.addEventListener('click', checkHealth);
  els.imageInput.addEventListener('change', onImageSelected);
  els.scanBtn.addEventListener('click', scan);
  els.playBtn.addEventListener('click', togglePlayback);
  onEngineChange();
}

document.addEventListener('DOMContentLoaded', init);
