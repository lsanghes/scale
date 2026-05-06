// Main controller — wires everything together

import {
  frequencyToNoteNumber,
  noteNumberToFrequency,
  noteNumberToName,
  nearestNoteNumber,
  centsDifference,
} from './notemath.js';
import { PitchDetector } from './pitch.js';
import { ReferenceToneEngine } from './audio.js';
import { ScoreManager } from './score.js';
import { ScorePlayer } from './playback.js';
import { generateScaleNotes, SCALE_TYPES, ARPEGGIO_TYPES, NOTE_NAMES } from './scales.js';

const state = {
  audioContext: null,
  pitchDetector: null,
  referenceTone: null,
  scorePlayer: null,
  scoreManager: new ScoreManager(),
  currentPartIndex: 0,
  currentMeasure: 1,
  currentNoteIndex: 0,
  isListening: false,
  isPlaying: false,
  mode: 'simultaneous',
  scrollMode: 'continuous', // 'jump' | 'continuous'
  scoreLoaded: false,
  activeNotes: [], // notes for the selected part
  inTuneSince: 0,  // timestamp when player was first in-tune on current note
  view: 'score',           // 'score' | 'scales'
  scaleSubMode: 'playAlong', // 'playAlong' | 'detect'
  scaleKey: 0,
  scaleType: 'Major',
  scaleIsArpeggio: false,
  // continuous scroll state
  _scrollTarget: 0,
  _scrollCurrent: 0,
  _scrollRafId: null,
  _scrollTimeline: [],
  _scrollMinTarget: 0,
  _playbackScrollEnabled: true,
  _lastPlaybackMeasure: null,
  _repeatScrollStartMeasure: null,
};

// DOM elements
const els = {};

function initDOM() {
  els.fileInput = document.getElementById('file-input');
  els.loadBtn = document.getElementById('load-btn');
  els.partSelect = document.getElementById('part-select');
  els.modeSelect = document.getElementById('mode-select');
  els.startBtn = document.getElementById('start-btn');
  els.detectedNote = document.getElementById('detected-note');
  els.detectedFreq = document.getElementById('detected-freq');
  els.targetNote = document.getElementById('target-note');
  els.centsValue = document.getElementById('cents-value');
  els.centsIndicator = document.getElementById('cents-indicator');
  els.centsMeter = document.getElementById('cents-meter');
  els.measureInfo = document.getElementById('measure-info');
  els.scoreContainer = document.getElementById('score-container');
  els.prevNote = document.getElementById('prev-note');
  els.nextNote = document.getElementById('next-note');
  els.prevMeasure = document.getElementById('prev-measure');
  els.nextMeasure = document.getElementById('next-measure');
  els.midiNoteList = document.getElementById('midi-note-list');
  els.confidenceBar = document.getElementById('confidence-bar');
  els.playBtn = document.getElementById('play-btn');
  els.bpmInput = document.getElementById('bpm-input');
  els.collapseBtn = document.getElementById('collapse-btn');
  els.expandBtn = document.getElementById('expand-btn');
  els.focusPlayBtn = document.getElementById('focus-play-btn');
  els.focusBpmInput = document.getElementById('focus-bpm-input');
  els.focusStartBtn = document.getElementById('focus-start-btn');
  els.scrollModeSelect = document.getElementById('scroll-mode-select');
  // Scale mode elements
  els.viewTabs = document.querySelectorAll('.view-tab');
  els.scaleContainer = document.getElementById('scale-container');
  els.scaleKeyButtons = document.getElementById('scale-key-buttons');
  els.scaleTypeButtons = document.getElementById('scale-type-buttons');
  els.submodePlayAlong = document.getElementById('submode-play-along');
  els.submodeDetect = document.getElementById('submode-detect');
  els.noteNameOverlay = document.getElementById('note-name-overlay');
}

function showNoteNameOverlay(note, cursorEl) {
  if (!els.noteNameOverlay || !note) return;

  // Try to find the cursor element if not provided
  if (!cursorEl) {
    const osmdCursor = state.scoreManager.osmd?.cursor;
    cursorEl = osmdCursor?.cursorElement || osmdCursor?.GetCurrentSymbol?.()?.cursorElement;
  }

  let cursorRect = null;
  if (cursorEl && cursorEl.getBoundingClientRect) {
    cursorRect = cursorEl.getBoundingClientRect();
    if (!cursorRect.height && !cursorRect.width) cursorRect = null;
  }

  els.noteNameOverlay.textContent = note.name;

  if (cursorRect) {
    // Position below the cursor with enough gap to not block the note
    const left = cursorRect.left + cursorRect.width / 2 + window.scrollX;
    const top = cursorRect.bottom + window.scrollY + 35;
    els.noteNameOverlay.style.left = `${left}px`;
    els.noteNameOverlay.style.top = `${top}px`;
    els.noteNameOverlay.style.display = 'block';
  } else {
    // Cursor not ready yet — don't show until we have a valid position
    els.noteNameOverlay.style.display = 'none';
  }
}

function hideNoteNameOverlay() {
  if (els.noteNameOverlay) els.noteNameOverlay.style.display = 'none';
}

// Sync both play buttons and both BPM inputs to the same state
function setPlayBtnState(loading, playing) {
  const text = loading ? 'Loading…' : (playing ? '⏹ Stop' : '▶ Play');
  const disabled = loading;
  els.playBtn.textContent = text;
  els.playBtn.disabled = disabled;
  els.playBtn.classList.toggle('active', playing);
  els.focusPlayBtn.textContent = text;
  els.focusPlayBtn.disabled = disabled;
  els.focusPlayBtn.classList.toggle('active', playing);
}

function setStartBtnState(listening) {
  const text = listening ? 'Stop' : 'Start';
  els.startBtn.textContent = text;
  els.startBtn.classList.toggle('active', listening);
  els.focusStartBtn.textContent = text;
  els.focusStartBtn.classList.toggle('active', listening);
}

function enablePlayBtns(enabled) {
  els.playBtn.disabled = !enabled;
  els.focusPlayBtn.disabled = !enabled;
}

function getBpm() {
  const src = document.body.classList.contains('focused') ? els.focusBpmInput : els.bpmInput;
  return Math.max(20, Math.min(400, parseInt(src.value) || 120));
}

function setBpm(val) {
  els.bpmInput.value = val;
  els.focusBpmInput.value = val;
}

function toggleFocus() {
  document.body.classList.toggle('focused');
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

// File loading
async function handleFileLoad() {
  const file = els.fileInput.files[0];
  if (!file) return;
  await loadScoreData(() => state.scoreManager.loadFile(file));
}

async function loadScoreData(loader) {
  els.scoreContainer.innerHTML = '<p>Loading score...</p>';
  els.midiNoteList.innerHTML = '';

  try {
    await loader();
    state.scoreLoaded = true;

    const parts = state.scoreManager.getParts();
    els.partSelect.innerHTML = '';
    parts.forEach((name, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = name;
      els.partSelect.appendChild(opt);
    });
    els.partSelect.disabled = false;

    selectPart(0);
    setBpm(state.scoreManager.getBPM());
    enablePlayBtns(true);

    if (state.scoreManager.scoreType === 'midi') {
      els.scoreContainer.innerHTML = '<p class="info">MIDI file loaded — note list shown below.</p>';
      renderMidiNoteList();
    }
  } catch (err) {
    els.scoreContainer.innerHTML = `<p class="error">Error loading score: ${err.message}</p>`;
    console.error(err);
  }
}

async function loadSampleScore() {
  try {
    const res = await fetch('sample.musicxml');
    if (!res.ok) return;
    const text = await res.text();
    await loadScoreData(() => state.scoreManager._loadMusicXML(text));
  } catch (_) {}
}

function renderMidiNoteList() {
  const notes = state.activeNotes;
  if (notes.length === 0) {
    els.midiNoteList.innerHTML = '<p>No notes found in this part.</p>';
    return;
  }

  let currentMeasure = 0;
  let html = '';
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (note.measure !== currentMeasure) {
      if (currentMeasure !== 0) html += '</div>';
      currentMeasure = note.measure;
      html += `<div class="midi-measure" data-measure="${currentMeasure}">`;
      html += `<span class="midi-measure-num">M${currentMeasure}</span> `;
    }
    html += `<span class="midi-note-item" data-idx="${i}">${note.name}</span> `;
  }
  html += '</div>';
  els.midiNoteList.innerHTML = html;

  // Click handler for measures
  els.midiNoteList.querySelectorAll('.midi-measure').forEach((el) => {
    el.addEventListener('click', () => {
      const m = parseInt(el.dataset.measure);
      jumpToMeasure(m);
    });
  });
}

function selectPart(partIndex) {
  state.currentPartIndex = partIndex;
  state.activeNotes = state.scoreManager.getNotesForPart(partIndex);
  state._scrollTimeline = buildScrollTimeline(state.activeNotes);
  state._scrollMinTarget = 0;
  state.currentNoteIndex = 0;
  state.currentMeasure = 1;
  updateTargetDisplay();
}

function buildScrollTimeline(notes) {
  if (!notes.length || state.scoreManager.scoreType !== 'musicxml') return [];

  const timeline = [];
  let current = null;

  for (const note of notes) {
    const systemLayout = state.scoreManager.getSystemLayoutForMeasure(note.measure);
    if (!systemLayout) continue;

    if (!current || current.startMeasure !== systemLayout.startMeasure) {
      current = {
        startMeasure: systemLayout.startMeasure,
        endMeasure: systemLayout.endMeasure,
        topPx: systemLayout.topPx,
        deltaToNextPx: systemLayout.deltaToNextPx,
        startBeat: note.startBeat,
        endBeat: note.startBeat + note.duration,
      };
      timeline.push(current);
    } else {
      current.endBeat = Math.max(current.endBeat, note.startBeat + note.duration);
    }
  }

  for (let i = 0; i < timeline.length - 1; i++) {
    const currentSystem = timeline[i];
    const nextSystem = timeline[i + 1];
    currentSystem.endBeat = Math.max(currentSystem.endBeat, nextSystem.startBeat);
  }

  return timeline;
}

function jumpToMeasure(measure) {
  state._scrollMinTarget = 0;
  state.currentMeasure = measure;
  // Find first note in this measure
  const idx = state.activeNotes.findIndex((n) => n.measure === measure);
  if (idx >= 0) {
    state.currentNoteIndex = idx;
  }
  updateTargetDisplay();
  updateMidiHighlight();

  // In drone mode, start droning the target note
  if (state.mode === 'drone' && state.referenceTone) {
    const note = state.activeNotes[state.currentNoteIndex];
    if (note) {
      state.referenceTone.startDrone(note.frequency);
    }
  }
}

function advanceNote(delta) {
  const newIdx = state.currentNoteIndex + delta;
  if (newIdx >= 0 && newIdx < state.activeNotes.length) {
    state._scrollMinTarget = 0;
    state.currentNoteIndex = newIdx;
    state.currentMeasure = state.activeNotes[newIdx].measure;
    state.inTuneSince = 0;
    updateTargetDisplay();
    if (state.view === 'scales') {
      updateScaleHighlight();
    } else {
      updateMidiHighlight();
    }

    if (state.referenceTone) {
      const note = state.activeNotes[newIdx];
      if (state.mode === 'drone') {
        state.referenceTone.startDrone(note.frequency);
      } else if (state.mode === 'simultaneous' && state.referenceTone.activeOscs.length) {
        state.referenceTone.setTargetNote(note.frequency);
      }
    }
  } else if (newIdx >= state.activeNotes.length && state.view === 'scales') {
    // Scale complete
    showScaleComplete();
  }
}

function updateTargetDisplay() {
  const note = state.activeNotes[state.currentNoteIndex];
  if (note) {
    els.targetNote.textContent = note.name;
    if (state.view === 'scales') {
      els.measureInfo.textContent = `Note ${state.currentNoteIndex + 1}/${state.activeNotes.length}`;
    } else {
      els.measureInfo.textContent = `Measure ${note.measure} — Note ${state.currentNoteIndex + 1}/${state.activeNotes.length}`;
      // Sync OSMD cursor and scroll
      const cursorEl = state.scoreManager.syncCursor(note.scoreStartBeat ?? note.startBeat);
      scrollScoreToCursor(cursorEl, note);
    }
  } else {
    els.targetNote.textContent = '-';
    els.measureInfo.textContent = state.scoreLoaded ? 'No notes' : 'Load a score to begin';
  }
}

function scrollScoreToCursor(cursorEl, note) {
  try {
    if (state.isPlaying && state.scrollMode === 'continuous' && !state._playbackScrollEnabled) {
      return;
    }

    const container = els.scoreContainer;
    const containerRect = container.getBoundingClientRect();
    let cursorRect = null;
    let relTop = null;

    if (cursorEl) {
      cursorRect = cursorEl.getBoundingClientRect();
      if (cursorRect.height || cursorRect.width) {
        relTop = cursorRect.top - containerRect.top + container.scrollTop;
      }
    }

    if (relTop === null && note) {
      const measureTop = state.scoreManager.getMeasureTopPx(note.measure);
      if (measureTop !== null && !Number.isNaN(measureTop)) {
        relTop = measureTop;
      }
    }

    if (relTop === null) return;

    const baseTarget = Math.max(0, relTop - containerRect.height / 3);

    if (state.scrollMode === 'continuous') {
      setContinuousScrollTarget(getContinuousScrollTarget(note, containerRect, baseTarget, cursorRect, note ? note.startBeat : null));
      startContinuousScroll();
    } else {
      container.scrollTo({ top: baseTarget, behavior: 'smooth' });
    }
  } catch (_) {}
}

function setContinuousScrollTarget(target, allowBackward = false) {
  const clampedTarget = Math.max(0, target);
  if (allowBackward) {
    state._scrollMinTarget = clampedTarget;
    state._scrollTarget = clampedTarget;
    return;
  }

  const floor = Math.max(state._scrollMinTarget, els.scoreContainer.scrollTop);
  const nextTarget = Math.max(clampedTarget, floor);
  state._scrollMinTarget = nextTarget;
  state._scrollTarget = nextTarget;
}

function getScrollTimelineEntry(note, currentBeat = null) {
  if (!note) return null;

  const beat = currentBeat ?? note.startBeat;
  const matchingEntry = state._scrollTimeline.find((entry) =>
    beat >= entry.startBeat && beat < entry.endBeat &&
    note.measure >= entry.startMeasure && note.measure <= entry.endMeasure
  );
  if (matchingEntry) return matchingEntry;

  return state._scrollTimeline.find((entry) =>
    note.measure >= entry.startMeasure && note.measure <= entry.endMeasure
  ) || null;
}

function getContinuousScrollTarget(note, containerRect, baseTarget, cursorRect, currentBeat = null) {
  const systemLayout = note ? state.scoreManager.getSystemLayoutForMeasure(note.measure) : null;
  if (!systemLayout) return baseTarget;

  const container = els.scoreContainer;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);

  const systemEntry = getScrollTimelineEntry(note, currentBeat);

  const systemHeight = Math.max(60, systemLayout.heightPx || 0);
  let anchorY = systemLayout.topPx + systemHeight / 2;

  if (systemEntry && systemEntry.deltaToNextPx > 0) {
    const beat = currentBeat ?? note.startBeat;
    const duration = Math.max(0.001, systemEntry.endBeat - systemEntry.startBeat);
    const progress = Math.max(0, Math.min(1, (beat - systemEntry.startBeat) / duration));
    const easedProgress = progress * progress * (3 - 2 * progress);
    anchorY += easedProgress * systemEntry.deltaToNextPx;
  } else if (cursorRect) {
    const horizontalProgress = Math.max(0, Math.min(1,
      (cursorRect.left + cursorRect.width / 2 - containerRect.left) / containerRect.width
    ));
    const lineHeight = Math.max(40, cursorRect.height);
    anchorY += horizontalProgress * lineHeight;
  }

  const centeredTarget = anchorY - containerRect.height / 2;
  return Math.max(0, Math.min(maxScrollTop, centeredTarget));
}

function startContinuousScroll() {
  if (state._scrollRafId) return; // already running
  state._scrollCurrent = els.scoreContainer.scrollTop;

  function tick() {
    const diff = state._scrollTarget - state._scrollCurrent;
    if (Math.abs(diff) < 0.5) {
      els.scoreContainer.scrollTop = state._scrollTarget;
      state._scrollCurrent = state._scrollTarget;
      state._scrollRafId = null;
      return;
    }
    // Ease toward target: move 8% of the remaining distance each frame
    state._scrollCurrent += diff * 0.08;
    els.scoreContainer.scrollTop = state._scrollCurrent;
    state._scrollRafId = requestAnimationFrame(tick);
  }

  state._scrollRafId = requestAnimationFrame(tick);
}

function updateMidiHighlight() {
  if (state.scoreManager.scoreType !== 'midi') return;
  els.midiNoteList.querySelectorAll('.midi-measure').forEach((el) => {
    el.classList.toggle('active-measure', parseInt(el.dataset.measure) === state.currentMeasure);
  });
  // Highlight the specific note
  const activeNoteEl = els.midiNoteList.querySelector(`.midi-note-item[data-idx="${state.currentNoteIndex}"]`);
  els.midiNoteList.querySelectorAll('.midi-note-item').forEach((el) => el.classList.remove('active-note'));
  if (activeNoteEl) {
    activeNoteEl.classList.add('active-note');
    activeNoteEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Score click handling for OSMD
function handleScoreClick(event) {
  if (!state.scoreManager.osmd || !state.scoreManager.osmd.graphic) return;

  const container = els.scoreContainer;
  const rect = container.getBoundingClientRect();
  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;

  // Convert pixel position to OSMD units
  const pixelX = event.clientX - rect.left + scrollLeft;
  const pixelY = event.clientY - rect.top + scrollTop;

  // OSMD uses 10px per unit by default
  const unitX = pixelX / 10;
  const unitY = pixelY / 10;

  const measure = state.scoreManager.getMeasureAtPosition(unitX, unitY);
  if (measure) {
    jumpToMeasure(measure);
  }
}

// Score playback
async function togglePlayback() {
  if (state.isPlaying) {
    stopPlayback();
  } else {
    await startPlayback();
  }
}

async function startPlayback() {
  if (state.view !== 'scales' && (!state.scoreLoaded || !state.activeNotes.length)) return;
  if (state.view === 'scales' && !state.activeNotes.length) return;

  // Mutually exclusive with mic listening
  if (state.isListening) stopListening();

  const ctx = ensureAudioContext();
  // Must await resume — context can be suspended on Safari/iOS or after inactivity
  await ctx.resume();

  setPlayBtnState(true, false);

  try {
    if (!state.referenceTone) {
      state.referenceTone = new ReferenceToneEngine(ctx);
    }
    await state.referenceTone.init(); // ensure soundfont is loaded

    if (!state.scorePlayer) {
      state.scorePlayer = new ScorePlayer(ctx);
    }
    state.scorePlayer.player = state.referenceTone.player;

    if (!state.scorePlayer.player) {
      throw new Error('Soundfont player failed to load');
    }

    const bpm = getBpm();
    state.isPlaying = true;
    setPlayBtnState(false, true);

    if (state.view === 'scales') {
      // Scale mode: simple note highlighting with looping
      state.scorePlayer.shouldLoop = true;
      state.scorePlayer.loopDelayMs = 3000; // 3 seconds
      state.scorePlayer.onNoteIndex = (idx) => {
        const changed = idx !== state.currentNoteIndex;
        if (changed) {
          state.currentNoteIndex = idx;
          updateTargetDisplay();
          updateScaleHighlight();
        }
        // Always sync cursor and show overlay during playback (covers initial note too)
        if (state.scoreManager.osmd) {
          const cursorEl = state.scoreManager.syncCursor(idx);
          shiftCursorForCurrentSystem(cursorEl);
          showNoteNameOverlay(state.activeNotes[idx], cursorEl);
        }
      };
      state.scorePlayer.onProgress = null;
      state.scorePlayer.onEnded = () => {
        state.isPlaying = false;
        setPlayBtnState(false, false);
        showScaleComplete();
      };
    } else {
      // Score mode: full scroll logic
      const backwardRepeatJumpIndex = state.activeNotes.findIndex((note, index, notes) =>
        index > 0 && note.measure < notes[index - 1].measure
      );
      const hasBackwardRepeatJump = backwardRepeatJumpIndex >= 0;
      const repeatScrollStartMeasure = hasBackwardRepeatJump
        ? state.activeNotes[backwardRepeatJumpIndex].measure
        : null;
      state._scrollMinTarget = els.scoreContainer.scrollTop;
      state._lastPlaybackMeasure = state.activeNotes[state.currentNoteIndex]?.measure ?? null;
      state._repeatScrollStartMeasure = repeatScrollStartMeasure;
      state._playbackScrollEnabled = state.currentNoteIndex > 0 || !hasBackwardRepeatJump;

      state.scorePlayer.onNoteIndex = (idx) => {
        if (idx !== state.currentNoteIndex) {
          const nextMeasure = state.activeNotes[idx]?.measure ?? null;
          if (
            state.scrollMode === 'continuous' &&
            state._playbackScrollEnabled &&
            state._repeatScrollStartMeasure !== null &&
            state._lastPlaybackMeasure !== null &&
            state._lastPlaybackMeasure < state._repeatScrollStartMeasure &&
            nextMeasure !== null &&
            nextMeasure >= state._repeatScrollStartMeasure
          ) {
            state._playbackScrollEnabled = false;
            state._scrollMinTarget = els.scoreContainer.scrollTop;
            state._scrollTarget = els.scoreContainer.scrollTop;
          }

          if (
            state.scrollMode === 'continuous' &&
            nextMeasure !== null &&
            state._lastPlaybackMeasure !== null &&
            nextMeasure < state._lastPlaybackMeasure
          ) {
            state._playbackScrollEnabled = true;
            state._scrollMinTarget = els.scoreContainer.scrollTop;
          }

          state.currentNoteIndex = idx;
          state.currentMeasure = nextMeasure;
          state._lastPlaybackMeasure = nextMeasure;
          updateTargetDisplay();
          updateMidiHighlight();
        }
      };
      state.scorePlayer.onProgress = (currentBeat) => {
        if (state.scrollMode !== 'continuous' || state.scoreManager.scoreType !== 'musicxml' || !state._playbackScrollEnabled) return;
        const note = state.activeNotes[state.currentNoteIndex];
        if (!note) return;
        const container = els.scoreContainer;
        const containerRect = container.getBoundingClientRect();
        const measureTop = state.scoreManager.getMeasureTopPx(note.measure);
        if (measureTop === null || Number.isNaN(measureTop)) return;
        const baseTarget = Math.max(0, measureTop - containerRect.height / 3);
        setContinuousScrollTarget(getContinuousScrollTarget(note, containerRect, baseTarget, null, currentBeat));
        startContinuousScroll();
      };
      state.scorePlayer.onEnded = () => {
        state.isPlaying = false;
        setPlayBtnState(false, false);
      };
    }

    state.scorePlayer.play(state.activeNotes, bpm, state.currentNoteIndex);
  } catch (err) {
    console.error('Playback failed:', err);
    alert('Playback failed: ' + err.message);
    setPlayBtnState(false, false);
    state.isPlaying = false;
  }
}

function stopPlayback() {
  if (state.scorePlayer) {
    state.scorePlayer.shouldLoop = false;
    state.scorePlayer.stop();
    state.scorePlayer.onProgress = null;
  }
  state.isPlaying = false;
  state._playbackScrollEnabled = true;
  state._lastPlaybackMeasure = null;
  state._repeatScrollStartMeasure = null;
  setPlayBtnState(false, false);
}

// Mic toggle
async function toggleListening() {
  if (state.isListening) {
    stopListening();
  } else {
    await startListening();
  }
}

async function startListening() {
  // Mutually exclusive with playback
  if (state.isPlaying) stopPlayback();

  const ctx = ensureAudioContext();

  if (!state.pitchDetector) {
    state.pitchDetector = new PitchDetector(ctx);
  }
  if (!state.referenceTone) {
    state.referenceTone = new ReferenceToneEngine(ctx);
    state.referenceTone.setMode(state.mode);
    // init() loads samples — don't block on it, they'll be ready by the time user plays
    state.referenceTone.init();
  }

  try {
    await state.pitchDetector.start();
    state.isListening = true;
    setStartBtnState(true);

    // Start reference tone if in the right mode
    const note = state.activeNotes[state.currentNoteIndex];
    if (note) {
      state.referenceTone.setTargetNote(note.frequency);
      if (state.mode === 'drone') {
        state.referenceTone.startDrone(note.frequency);
      }
    }

    requestAnimationFrame(mainLoop);
  } catch (err) {
    alert('Could not access microphone: ' + err.message);
  }
}

function stopListening() {
  state.isListening = false;
  if (state.pitchDetector) state.pitchDetector.stop();
  if (state.referenceTone) state.referenceTone.stopAll();
  setStartBtnState(false);
  els.detectedNote.textContent = '-';
  els.detectedFreq.textContent = '';
  els.centsValue.textContent = '';
  els.centsIndicator.style.left = '50%';
  els.centsMeter.className = 'cents-meter';
  els.confidenceBar.style.width = '0%';
}

// Main loop
function mainLoop() {
  if (!state.isListening) return;

  const result = state.pitchDetector.detect();

  if (result && result.confidence > 0.66) {
    const { frequency, confidence } = result;
    const nearestMidi = nearestNoteNumber(frequency);
    const noteName = noteNumberToName(nearestMidi);
    const nearestFreq = noteNumberToFrequency(nearestMidi);
    const cents = centsDifference(frequency, nearestFreq);

    // Update detected display
    els.detectedNote.textContent = noteName;
    els.detectedFreq.textContent = `${frequency.toFixed(1)} Hz`;
    els.centsValue.textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(1)}¢`;
    els.confidenceBar.style.width = `${(confidence * 100).toFixed(0)}%`;

    // Cents meter: map -50..+50 to 0%..100%
    const pct = Math.max(0, Math.min(100, (cents + 50) * (100 / 100)));
    els.centsIndicator.style.left = `${pct}%`;

    // Color coding
    const absCents = Math.abs(cents);
    if (absCents < 5) {
      els.centsMeter.className = 'cents-meter in-tune';
    } else if (absCents < 15) {
      els.centsMeter.className = 'cents-meter close';
    } else {
      els.centsMeter.className = 'cents-meter out-of-tune';
    }

    // Reference tone logic
    const targetNote = state.activeNotes[state.currentNoteIndex];
    if (targetNote && state.referenceTone) {
      const targetCents = centsDifference(frequency, targetNote.frequency);

      if (state.mode === 'simultaneous') {
        if (!state.referenceTone.activeOscs.length) {
          state.referenceTone.setTargetNote(targetNote.frequency);
          state.referenceTone.startSimultaneous();
        }
      } else if (state.mode === 'ping') {
        if (Math.abs(targetCents) < 50) {
          state.referenceTone.triggerPing(targetNote.frequency);
        }
      }
      // drone mode runs independently

      // Auto-advance: if within 15 cents for 800ms, move to next note
      if (Math.abs(targetCents) < 15) {
        if (state.inTuneSince === 0) {
          state.inTuneSince = performance.now();
        } else if (performance.now() - state.inTuneSince > 800) {
          state.inTuneSince = 0;
          advanceNote(1);
        }
      } else {
        state.inTuneSince = 0;
      }
    } else if (!targetNote && state.referenceTone) {
      // Free play mode — no score loaded
      if (state.mode === 'simultaneous') {
        state.referenceTone.setTargetNote(nearestFreq);
        if (!state.referenceTone.activeOscs.length) {
          state.referenceTone.startSimultaneous();
        }
      } else if (state.mode === 'ping') {
        state.referenceTone.triggerPing(nearestFreq);
      } else if (state.mode === 'drone') {
        // In free play drone, drone the nearest note
        if (!state.referenceTone.activeOsc ||
            Math.abs(centsDifference(frequency, state.referenceTone.targetFreq)) > 50) {
          state.referenceTone.startDrone(nearestFreq);
        }
      }
    }
  } else {
    // No pitch detected
    els.confidenceBar.style.width = '0%';
    // No pitch detected — simultaneous tone keeps playing until silence

  }

  requestAnimationFrame(mainLoop);
}

// ── Scale Mode ──

function switchView(view) {
  if (state.isPlaying) stopPlayback();
  if (state.isListening) stopListening();
  state.view = view;

  els.viewTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  document.body.classList.toggle('scale-view', view === 'scales');

  if (view === 'scales') {
    els.scaleContainer.style.display = '';
    updateScaleNotes();
    updateScaleSubModeUI();
  } else {
    els.scaleContainer.style.display = 'none';
    enablePlayBtns(state.scoreLoaded);
    if (!state.scoreLoaded) loadSampleScore();
  }
}

function populateScaleKeyButtons() {
  els.scaleKeyButtons.innerHTML = '';

  // Keys header
  const keysHeader = document.createElement('span');
  keysHeader.className = 'scale-type-header';
  keysHeader.textContent = 'Keys:';
  els.scaleKeyButtons.appendChild(keysHeader);

  NOTE_NAMES.forEach((name, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = name;
    btn.dataset.key = i;
    btn.classList.toggle('active', state.scaleKey === i);
    btn.addEventListener('click', () => {
      state.scaleKey = i;
      if (state.isPlaying) stopPlayback();
      updateScaleNotes();
      updateScaleKeyButtonStates();
    });
    els.scaleKeyButtons.appendChild(btn);
  });
}

function updateScaleKeyButtonStates() {
  els.scaleKeyButtons.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.key) === state.scaleKey);
  });
}

function populateScaleTypeButtons() {
  els.scaleTypeButtons.innerHTML = '';

  // Scales header
  const scalesHeader = document.createElement('span');
  scalesHeader.className = 'scale-type-header';
  scalesHeader.textContent = 'Scales:';
  els.scaleTypeButtons.appendChild(scalesHeader);

  const scaleItems = [
    { label: 'Major', type: 'Major', isArp: false },
    { label: 'Natural Minor', type: 'Natural Minor', isArp: false },
    { label: 'Melodic Minor', type: 'Melodic Minor', isArp: false },
    { label: 'Harmonic Minor', type: 'Harmonic Minor', isArp: false },
  ];

  scaleItems.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.dataset.type = item.type;
    btn.dataset.isArp = item.isArp;
    btn.classList.toggle('active', state.scaleType === item.type && !state.scaleIsArpeggio);
    btn.addEventListener('click', () => {
      state.scaleType = item.type;
      state.scaleIsArpeggio = item.isArp;
      if (state.isPlaying) stopPlayback();
      updateScaleNotes();
      updateScaleTypeButtonStates();
    });
    els.scaleTypeButtons.appendChild(btn);
  });

  // Arpeggios header
  const arpHeader = document.createElement('span');
  arpHeader.className = 'scale-type-header';
  arpHeader.textContent = 'Arpeggios:';
  els.scaleTypeButtons.appendChild(arpHeader);

  const arpItems = [
    { label: 'Major', type: 'Major', isArp: true },
    { label: 'Minor', type: 'Minor', isArp: true },
    { label: 'Dom 7th', type: 'Dominant 7th', isArp: true },
    { label: 'Dim 7th', type: 'Diminished 7th', isArp: true },
    { label: 'Aug', type: 'Augmented', isArp: true },
    { label: 'bVI6', type: '♭VI6', isArp: true },
    { label: 'vi6', type: 'vi6', isArp: true },
    { label: 'IV6/4', type: 'IV6/4', isArp: true },
    { label: 'iv6/4', type: 'iv6/4', isArp: true },
    { label: '4-3 Sus', type: '4-3 Suspension', isArp: true },
  ];

  arpItems.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.dataset.type = item.type;
    btn.dataset.isArp = item.isArp;
    btn.classList.toggle('active', state.scaleType === item.type && state.scaleIsArpeggio);
    btn.addEventListener('click', () => {
      state.scaleType = item.type;
      state.scaleIsArpeggio = item.isArp;
      if (state.isPlaying) stopPlayback();
      updateScaleNotes();
      updateScaleTypeButtonStates();
    });
    els.scaleTypeButtons.appendChild(btn);
  });
}

function updateScaleTypeButtonStates() {
  els.scaleTypeButtons.querySelectorAll('button').forEach(btn => {
    const isActive = state.scaleType === btn.dataset.type &&
                     state.scaleIsArpeggio === (btn.dataset.isArp === 'true');
    btn.classList.toggle('active', isActive);
  });
}

function getScaleTitle() {
  const keyName = NOTE_NAMES[state.scaleKey];
  const typeLabel = state.scaleType;
  const kindLabel = state.scaleIsArpeggio ? 'Arpeggio' : 'Scale';
  return `${keyName} ${typeLabel} ${kindLabel} - 3 Octaves`;
}

function generateScaleMusicXML(notes) {
  const title = getScaleTitle();
  // Clef ranges (within the 5 staff lines, no ledger lines)
  const CLEFS = {
    bass:   { sign: 'F', line: 4, low: 43, high: 57 },  // G2 to A3
    tenor:  { sign: 'C', line: 4, low: 50, high: 64 },  // D3 to E4
    treble: { sign: 'G', line: 2, low: 64, high: 77 },  // E4 to F5
  };

  function pickBestClefForMeasure(measureNotes) {
    let bestClef = null;
    let bestScore = -Infinity;
    for (const clef of Object.values(CLEFS)) {
      // Score: count notes within range, tiebreak by minimizing total distance from range center
      const center = (clef.low + clef.high) / 2;
      let inRange = 0;
      let totalDistance = 0;
      for (const note of measureNotes) {
        if (note.midi >= clef.low && note.midi <= clef.high) inRange++;
        totalDistance += Math.abs(note.midi - center);
      }
      // Use inRange as primary score, totalDistance as tiebreak (negated, smaller is better)
      const score = inRange * 1000 - totalDistance;
      if (score > bestScore) {
        bestScore = score;
        bestClef = clef;
      }
    }
    return bestClef;
  }

  function generateNoteXml(note) {
    const octaveOffset = Math.floor(note.midi / 12) - 1;
    const noteInOctave = note.midi % 12;
    const noteLetters = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
    const alterations = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
    const noteLetter = noteLetters[noteInOctave];
    const alteration = alterations[noteInOctave];

    let alterXml = '';
    if (alteration === 1) alterXml = '<alter>1</alter>';
    else if (alteration === -1) alterXml = '<alter>-1</alter>';

    return `<note>
      <pitch>
        <step>${noteLetter}</step>
        ${alterXml}
        <octave>${octaveOffset}</octave>
      </pitch>
      <duration>4</duration>
      <type>quarter</type>
    </note>`;
  }

  // Chunk notes into measures of 6, then pick best clef for each
  const NOTES_PER_MEASURE = 6;
  const measures = []; // [{ clef, notes }]
  for (let i = 0; i < notes.length; i += NOTES_PER_MEASURE) {
    const chunk = notes.slice(i, i + NOTES_PER_MEASURE);
    measures.push({
      clef: pickBestClefForMeasure(chunk),
      notes: chunk,
    });
  }

  // Build measures
  let measuresXml = '';
  let prevClefSign = null;

  measures.forEach((measure, idx) => {
    const measureNum = idx + 1;
    const beats = measure.notes.length;
    const noteXmls = measure.notes.map(generateNoteXml).join('\n      ');
    const clefChanged = prevClefSign !== measure.clef.sign;
    const isFirst = idx === 0;

    let attributesXml = '';
    if (isFirst) {
      attributesXml = `<attributes>
        <divisions>4</divisions>
        <time print-object="no">
          <beats>${beats}</beats>
          <beat-type>4</beat-type>
        </time>
        <clef>
          <sign>${measure.clef.sign}</sign>
          <line>${measure.clef.line}</line>
        </clef>
      </attributes>`;
    } else {
      const parts = [];
      parts.push(`<time print-object="no">
          <beats>${beats}</beats>
          <beat-type>4</beat-type>
        </time>`);
      if (clefChanged) {
        parts.push(`<clef>
          <sign>${measure.clef.sign}</sign>
          <line>${measure.clef.line}</line>
        </clef>`);
      }
      attributesXml = `<attributes>
        ${parts.join('\n        ')}
      </attributes>`;
    }

    measuresXml += `<measure number="${measureNum}">
      ${attributesXml}
      ${noteXmls}
    </measure>\n    `;

    prevClefSign = measure.clef.sign;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work>
    <work-title>${title}</work-title>
  </work>
  <part-list>
    <score-part id="P1">
      <part-name>Cello</part-name>
      <score-instrument id="P1-I1">
        <instr-name>Cello</instr-name>
      </score-instrument>
      <midi-instrument id="P1-I1">
        <midi-program>42</midi-program>
      </midi-instrument>
    </score-part>
  </part-list>
  <part id="P1">
    ${measuresXml}
  </part>
</score-partwise>`;

  return xml;
}

function updateScaleNotes() {
  const notes = generateScaleNotes(state.scaleKey, state.scaleType, state.scaleIsArpeggio);
  state.activeNotes = notes;
  state.currentNoteIndex = 0;
  state.currentMeasure = 1;
  state.inTuneSince = 0;
  renderScaleMusicXML(notes);
  updateTargetDisplay();
}

// Track post-processing state so we can re-apply after OSMD re-renders (e.g. on resize)
let _postProcessingPending = null;
let _scaleSvgObserver = null;
let _postProcessApplied = false;
// Map of original staff Y range → shift applied. Used to shift the cursor too.
let _systemShiftMap = null;

function shiftCursorForCurrentSystem(cursorEl) {
  // After OSMD positions the cursor (using original/unshifted coordinates),
  // apply the same shift to the cursor that we applied to the staff it's on.
  if (!cursorEl || !_systemShiftMap || !_systemShiftMap.length) return;

  // OSMD's cursor is typically an HTML <img> overlay positioned with style.top/left.
  // To find which system the cursor belongs to, we need to know the cursor's Y in
  // the same coordinate system as the staff Y values from the SVG.

  const isHTMLCursor = !(cursorEl instanceof SVGElement);

  let cy;
  if (isHTMLCursor) {
    // The HTML cursor's "top" is in pixels relative to the score container.
    // Convert it to SVG coordinates by aligning with the SVG's viewport.
    const svg = els.scoreContainer.querySelector('svg');
    if (!svg) return;
    const svgRect = svg.getBoundingClientRect();
    const cursorRect = cursorEl.getBoundingClientRect();
    const screenY = cursorRect.top + cursorRect.height / 2;
    // Map screen Y → SVG Y using viewBox if defined, else assume 1:1
    const viewBox = svg.viewBox?.baseVal;
    if (viewBox && viewBox.height && svgRect.height) {
      cy = (screenY - svgRect.top) * (viewBox.height / svgRect.height);
    } else {
      cy = screenY - svgRect.top;
    }
  } else {
    let bbox;
    try { bbox = cursorEl.getBBox(); } catch (_) { return; }
    cy = bbox.y + bbox.height / 2;
  }

  // Find the nearest staff in the (original) shift map
  let nearest = _systemShiftMap[0];
  let minDist = Math.abs(cy - nearest.center);
  for (let i = 1; i < _systemShiftMap.length; i++) {
    const d = Math.abs(cy - _systemShiftMap[i].center);
    if (d < minDist) {
      minDist = d;
      nearest = _systemShiftMap[i];
    }
  }

  if (isHTMLCursor) {
    // Apply shift via CSS transform
    if (nearest.shift !== 0) {
      // Convert SVG-units shift to screen-pixel shift via the same ratio used above
      const svg = els.scoreContainer.querySelector('svg');
      const svgRect = svg?.getBoundingClientRect();
      const viewBox = svg?.viewBox?.baseVal;
      let pxShift = nearest.shift;
      if (viewBox && viewBox.height && svgRect && svgRect.height) {
        pxShift = nearest.shift * (svgRect.height / viewBox.height);
      }
      cursorEl.style.transform = `translateY(${pxShift}px)`;
    } else {
      cursorEl.style.transform = '';
    }
  } else {
    if (nearest.shift !== 0) {
      cursorEl.setAttribute('transform', `translate(0, ${nearest.shift})`);
    } else {
      cursorEl.removeAttribute('transform');
    }
  }
}

function applyScalePostProcessing() {
  if (_postProcessingPending) clearTimeout(_postProcessingPending);
  _postProcessingPending = setTimeout(() => {
    _postProcessingPending = null;
    hideCourtesyClefsAtLineEnds();
    equalizeSystemSpacing();
    _postProcessApplied = true;
  }, 80);
}

function setupScalePostProcessingObserver() {
  // Observe the score container and re-apply our post-processing whenever
  // OSMD re-renders the SVG (e.g. on window resize).
  if (_scaleSvgObserver) _scaleSvgObserver.disconnect();
  if (!els.scoreContainer) return;
  _scaleSvgObserver = new MutationObserver(() => {
    if (state.view !== 'scales') return;
    // Detect a fresh render (SVG was replaced or changed significantly)
    _postProcessApplied = false;
    applyScalePostProcessing();
  });
  _scaleSvgObserver.observe(els.scoreContainer, {
    childList: true,
    subtree: false,
  });
}

function hideCourtesyClefsAtLineEnds() {
  // Find clef-like SVG elements at the right edge of each system and hide them.
  try {
    const svg = els.scoreContainer.querySelector('svg');
    if (!svg) return;

    // Detect staff lines by geometry: wide and very thin
    const allDrawn = svg.querySelectorAll('line, path, rect');
    const horizontalLines = [];
    allDrawn.forEach(el => {
      let bbox;
      try { bbox = el.getBBox(); } catch (_) { return; }
      if (bbox.width > 50 && bbox.height < 3) {
        horizontalLines.push(el);
      }
    });
    if (!horizontalLines.length) return;

    const lineData = horizontalLines.map(el => {
      const bbox = el.getBBox();
      return {
        el,
        y: bbox.y + bbox.height / 2,
        x1: bbox.x,
        x2: bbox.x + bbox.width,
      };
    }).sort((a, b) => a.y - b.y);

    // Cluster by Y to find staves
    const clusters = [];
    let current = null;
    for (const item of lineData) {
      if (!current || item.y - current.items[current.items.length - 1].y > 25) {
        current = { items: [item], minY: item.y, maxY: item.y };
        clusters.push(current);
      } else {
        current.items.push(item);
        current.maxY = item.y;
      }
    }

    const staves = clusters.filter(c => c.items.length >= 5);
    if (!staves.length) return;

    // For each staff, find the X range and Y range
    const staffInfo = staves.map(staff => {
      const xMin = Math.min(...staff.items.map(it => it.x1));
      const xMax = Math.max(...staff.items.map(it => it.x2));
      return { minY: staff.minY, maxY: staff.maxY, xMin, xMax };
    });

    // Find and hide clef glyphs at the right edge of each staff
    const allCandidates = svg.querySelectorAll('path, g[id*="clef"], g[class*="clef"]');
    allCandidates.forEach(p => {
      let bbox;
      try { bbox = p.getBBox(); } catch (_) { return; }
      if (bbox.width === 0 && bbox.height === 0) return;
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;

      for (const info of staffInfo) {
        const staffHeight = info.maxY - info.minY;
        const yMargin = staffHeight * 2;
        if (cy < info.minY - yMargin || cy > info.maxY + yMargin) continue;
        if (cx < info.xMax - 60 || cx > info.xMax + 25) continue;
        if (bbox.height < staffHeight * 0.4) continue;
        // Clefs are WIDE glyphs; stems are very narrow vertical lines
        if (bbox.width < 8) continue;
        p.style.display = 'none';
        break;
      }
    });
  } catch (e) {
    console.warn('hideCourtesyClefsAtLineEnds failed:', e);
  }
}

function equalizeSystemSpacing() {
  try {
    const svg = els.scoreContainer.querySelector('svg');
    if (!svg) return;

    // Strategy: find the deepest <g> elements that each contain a single staff
    // (5 horizontal lines clustered tightly in Y). Their nearest common parent
    // levels up should be the page group. We treat each staff-containing group
    // as a system, then shift them to equalize gaps.

    // Find staff lines by geometry: wide and very thin
    const allDrawn = svg.querySelectorAll('line, path, rect');
    const horizontalLines = [];
    allDrawn.forEach(el => {
      let bbox;
      try { bbox = el.getBBox(); } catch (_) { return; }
      if (bbox.width > 50 && bbox.height < 3) {
        horizontalLines.push(el);
      }
    });
    if (!horizontalLines.length) return;

    // Cluster horizontal lines by Y proximity into staves
    const lineData = horizontalLines.map(el => {
      const bbox = el.getBBox();
      return { el, y: bbox.y + bbox.height / 2 };
    }).sort((a, b) => a.y - b.y);

    const clusters = [];
    let current = null;
    for (const item of lineData) {
      if (!current || item.y - current.items[current.items.length - 1].y > 25) {
        current = { items: [item], minY: item.y, maxY: item.y };
        clusters.push(current);
      } else {
        current.items.push(item);
        current.maxY = item.y;
      }
    }

    const staves = clusters.filter(c => c.items.length >= 5);
    if (staves.length < 3) return;

    // For each system, store its staff center Y for "nearest staff" matching
    const staffCenters = staves.map(s => (s.minY + s.maxY) / 2);

    // Calculate current gaps between staves and target gap
    const gaps = [];
    for (let i = 0; i < staves.length - 1; i++) {
      gaps.push(staves[i + 1].minY - staves[i].maxY);
    }
    const targetGap = Math.min(...gaps);

    // Calculate cumulative shifts for each system
    const systemShifts = [0];
    for (let i = 1; i < staves.length; i++) {
      const desiredMinY = staves[i - 1].maxY + targetGap;
      const currentMinY = staves[i].minY;
      systemShifts.push(systemShifts[i - 1] + (desiredMinY - currentMinY));
    }

    // Apply shifts to every SVG element. Assign each element to its NEAREST
    // staff (by distance from center) so tall elements like stems stay with
    // their noteheads.
    const allElements = svg.querySelectorAll('line, path, rect, text, ellipse, circle, polygon, polyline, image, use');
    allElements.forEach(el => {
      let svgBbox;
      try { svgBbox = el.getBBox(); } catch (_) { return; }
      const cy = svgBbox.y + svgBbox.height / 2;
      let nearestIdx = 0;
      let nearestDist = Math.abs(cy - staffCenters[0]);
      for (let i = 1; i < staffCenters.length; i++) {
        const d = Math.abs(cy - staffCenters[i]);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      if (systemShifts[nearestIdx] !== 0) {
        const existing = el.getAttribute('transform') || '';
        el.setAttribute('transform', `${existing} translate(0, ${systemShifts[nearestIdx]})`.trim());
      }
    });

    // Save the shift map so we can shift the cursor too.
    _systemShiftMap = staves.map((s, i) => ({
      center: staffCenters[i],
      shift: systemShifts[i],
    }));
  } catch (e) {
    console.warn('equalizeSystemSpacing failed:', e);
  }
}

async function renderScaleMusicXML(notes) {
  if (!notes.length) return;
  const xmlString = generateScaleMusicXML(notes);
  const container = els.scoreContainer;

  try {
    const osmdOptions = {
      autoResize: true,
      drawTitle: true,
      drawSubtitle: false,
      drawComposer: false,
      drawLyricist: false,
      drawCredits: false,
      drawPartNames: false,
      drawMeasureNumbers: true,
    };
    if (!state.scoreManager.osmd) {
      state.scoreManager.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, osmdOptions);
    } else if (state.scoreManager.osmd.setOptions) {
      state.scoreManager.osmd.setOptions(osmdOptions);
    }

    await state.scoreManager.osmd.load(xmlString);

    // Show measure number on every measure + consistent system spacing
    try {
      const rules = state.scoreManager.osmd.EngravingRules || state.scoreManager.osmd.rules;
      if (rules) {
        rules.UseXMLMeasureNumbers = false;
        rules.RenderMeasureNumbersOnlyAtSystemStart = false;
        const setIfDefined = (key, val) => {
          if (typeof rules[key] !== 'undefined') rules[key] = val;
        };
        setIfDefined('MeasureNumberLabelOffset', 0);
        // Tight system spacing
        setIfDefined('MinSkyBottomDistBetweenSystems', 2);
        setIfDefined('MinimumDistanceBetweenSystems', 4);
        setIfDefined('SystemDistance', 4);
        setIfDefined('BetweenStaffDistance', 2);
        setIfDefined('StaffDistance', 5);
        setIfDefined('MinSkyBottomDistBetweenStaves', 1);
        // Reduce title-to-staff distance
        setIfDefined('TitleTopDistance', 2);
        setIfDefined('TitleBottomDistance', 1);
        setIfDefined('SheetTitleHeight', 4);
        setIfDefined('PageTopMargin', 2);
        setIfDefined('SheetMinimumDistanceBetweenTitleAndStaffline', 2);
        // Hide courtesy clef shown at the end of each line before a clef change
        setIfDefined('RenderClefsAtBeginningOfStaffline', true);
        setIfDefined('ShowClefBeforeChange', false);
        setIfDefined('RenderEndOfMeasureClefBeforeChange', false);
        setIfDefined('DrawCourtesyAccidentals', false);
      }
    } catch (e) {
      console.warn('Could not configure engraving rules:', e);
    }

    state.scoreManager.osmd.render();
    state.scoreManager.scoreType = 'musicxml';
    state.scoreManager._cursorBeat = -1;
    state.scoreManager._setupCursor();
    applyScalePostProcessing();
    setupScalePostProcessingObserver();

    // Force OSMD to fully position the cursor at the first note.
    // We need to: advance forward then reset, which triggers OSMD's full
    // position calculation. Then wait for layout/paint to settle.
    setTimeout(() => {
      try {
        const cursor = state.scoreManager.osmd.cursor;
        cursor.next();
        cursor.reset();
        state.scoreManager._cursorBeat = 0;
      } catch (e) {}
      // Use double rAF to ensure layout has fully settled before measuring
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const note = state.activeNotes[state.currentNoteIndex];
          if (note && state.scoreManager.osmd) {
            const cursorEl = state.scoreManager.osmd.cursor.cursorElement;
            showNoteNameOverlay(note, cursorEl);
          }
        });
      });
    }, 50);
  } catch (err) {
    console.error('Failed to render scale MusicXML:', err);
  }
}

function updateScaleHighlight() {
  if (state.view !== 'scales') return;
  // Always show note name overlay for the highlighted note
  const note = state.activeNotes[state.currentNoteIndex];
  if (note && state.scoreManager.osmd) {
    const cursorEl = state.scoreManager.syncCursor(state.currentNoteIndex);
    shiftCursorForCurrentSystem(cursorEl);
    showNoteNameOverlay(note, cursorEl);
  }
}

function updateScaleSubModeUI() {
  const isPlayAlong = state.scaleSubMode === 'playAlong';
  els.submodePlayAlong.classList.toggle('active', isPlayAlong);
  els.submodeDetect.classList.toggle('active', !isPlayAlong);
  // In scale view: always enable play for playAlong, always enable start for detect
  enablePlayBtns(isPlayAlong);
}

function showScaleComplete() {
  setTimeout(() => {
    state.currentNoteIndex = 0;
    state.inTuneSince = 0;
    updateScaleHighlight();
    updateTargetDisplay();
  }, 2000);
}

// Event listeners
function init() {
  initDOM();

  els.loadBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', handleFileLoad);

  els.partSelect.addEventListener('change', (e) => {
    selectPart(parseInt(e.target.value));
    if (state.scoreManager.scoreType === 'midi') renderMidiNoteList();
  });

  els.scrollModeSelect.addEventListener('change', (e) => {
    state.scrollMode = e.target.value;
    state._scrollMinTarget = els.scoreContainer.scrollTop;
    // Cancel any in-progress continuous scroll animation
    if (state._scrollRafId) {
      cancelAnimationFrame(state._scrollRafId);
      state._scrollRafId = null;
    }
  });

  els.modeSelect.addEventListener('change', (e) => {
    state.mode = e.target.value;
    if (state.referenceTone) {
      state.referenceTone.setMode(state.mode);
      // Restart appropriate mode
      const note = state.activeNotes[state.currentNoteIndex];
      if (note && state.isListening) {
        state.referenceTone.setTargetNote(note.frequency);
        if (state.mode === 'drone') {
          state.referenceTone.startDrone(note.frequency);
        }
      }
    }
  });

  els.playBtn.addEventListener('click', togglePlayback);
  els.startBtn.addEventListener('click', toggleListening);
  els.focusPlayBtn.addEventListener('click', togglePlayback);
  els.focusStartBtn.addEventListener('click', toggleListening);
  els.collapseBtn.addEventListener('click', toggleFocus);
  els.expandBtn.addEventListener('click', toggleFocus);

  // Keep BPM inputs in sync with each other
  els.bpmInput.addEventListener('input', () => { els.focusBpmInput.value = els.bpmInput.value; });
  els.focusBpmInput.addEventListener('input', () => { els.bpmInput.value = els.focusBpmInput.value; });

  els.prevNote.addEventListener('click', () => { stopPlayback(); advanceNote(-1); });
  els.nextNote.addEventListener('click', () => { stopPlayback(); advanceNote(1); });
  els.prevMeasure.addEventListener('click', () => {
    stopPlayback();
    const m = Math.max(1, state.currentMeasure - 1);
    jumpToMeasure(m);
  });
  els.nextMeasure.addEventListener('click', () => {
    stopPlayback();
    const m = Math.min(state.scoreManager.getMeasureCount(), state.currentMeasure + 1);
    jumpToMeasure(m);
  });

  els.scoreContainer.addEventListener('click', handleScoreClick);

  // Scale mode event listeners
  populateScaleKeyButtons();
  populateScaleTypeButtons();
  els.viewTabs.forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
  els.submodePlayAlong.addEventListener('click', () => {
    if (state.isPlaying) stopPlayback();
    if (state.isListening) stopListening();
    state.scaleSubMode = 'playAlong';
    updateScaleSubModeUI();
  });
  els.submodeDetect.addEventListener('click', () => {
    if (state.isPlaying) stopPlayback();
    if (state.isListening) stopListening();
    state.scaleSubMode = 'detect';
    updateScaleSubModeUI();
  });

  updateTargetDisplay();

  // Start in focus (full-screen) mode
  document.body.classList.add('focused');

  // Start on Scales tab
  switchView('scales');

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const isTypingTarget = target instanceof HTMLElement && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    );
    if (isTypingTarget) return;

    if (e.key === 'ArrowRight') { stopPlayback(); advanceNote(1); }
    else if (e.key === 'ArrowLeft') { stopPlayback(); advanceNote(-1); }
    else if ((e.key === ' ' || e.code === 'Space') && !e.repeat) {
      e.preventDefault();
      togglePlayback();
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      togglePlayback();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFocus();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
