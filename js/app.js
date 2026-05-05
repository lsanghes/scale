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
  els.scaleKeySelect = document.getElementById('scale-key-select');
  els.scaleTypeSelect = document.getElementById('scale-type-select');
  els.scaleNoteDisplay = document.getElementById('scale-note-display');
  els.submodePlayAlong = document.getElementById('submode-play-along');
  els.submodeDetect = document.getElementById('submode-detect');
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
      // Scale mode: simple note highlighting
      state.scorePlayer.onNoteIndex = (idx) => {
        if (idx !== state.currentNoteIndex) {
          state.currentNoteIndex = idx;
          updateTargetDisplay();
          updateScaleHighlight();
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
  if (state.scorePlayer) state.scorePlayer.stop();
  if (state.scorePlayer) state.scorePlayer.onProgress = null;
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
  }
}

function populateScaleKeySelect() {
  els.scaleKeySelect.innerHTML = '';
  NOTE_NAMES.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = name;
    els.scaleKeySelect.appendChild(opt);
  });
}

function updateScaleNotes() {
  const notes = generateScaleNotes(state.scaleKey, state.scaleType, state.scaleIsArpeggio);
  state.activeNotes = notes;
  state.currentNoteIndex = 0;
  state.currentMeasure = 1;
  state.inTuneSince = 0;
  renderScaleNoteDisplay();
  updateTargetDisplay();
}

function renderScaleNoteDisplay() {
  const container = els.scaleNoteDisplay;
  container.innerHTML = '';

  const notes = state.activeNotes;
  if (!notes.length) return;

  let currentRow = notes[0].row;
  let rowDiv = document.createElement('div');
  rowDiv.className = 'scale-row';
  container.appendChild(rowDiv);

  for (let i = 0; i < notes.length; i++) {
    if (notes[i].row !== currentRow) {
      currentRow = notes[i].row;
      rowDiv = document.createElement('div');
      rowDiv.className = 'scale-row';
      container.appendChild(rowDiv);
    }

    const pill = document.createElement('span');
    pill.className = 'scale-note-pill';
    pill.innerHTML = `<span class="pill-solfege">${notes[i].solfege}</span><span class="pill-note">(${notes[i].name})</span>`;
    pill.dataset.idx = i;
    if (i === state.currentNoteIndex) pill.classList.add('active-note');
    rowDiv.appendChild(pill);
  }
}

function updateScaleHighlight() {
  if (state.view !== 'scales') return;
  const pills = els.scaleNoteDisplay.querySelectorAll('.scale-note-pill');
  pills.forEach(pill => {
    const idx = parseInt(pill.dataset.idx);
    pill.classList.toggle('active-note', idx === state.currentNoteIndex);
    pill.classList.toggle('played', idx < state.currentNoteIndex);
  });
  // Auto-scroll current pill into view
  const activePill = els.scaleNoteDisplay.querySelector('.scale-note-pill.active-note');
  if (activePill) {
    activePill.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  const pills = els.scaleNoteDisplay.querySelectorAll('.scale-note-pill');
  pills.forEach(pill => {
    pill.classList.remove('active-note');
    pill.classList.add('complete');
  });
  // Reset after 2 seconds
  setTimeout(() => {
    pills.forEach(pill => pill.classList.remove('complete'));
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
  populateScaleKeySelect();
  els.viewTabs.forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
  els.scaleKeySelect.addEventListener('change', (e) => {
    state.scaleKey = parseInt(e.target.value);
    if (state.isPlaying) stopPlayback();
    updateScaleNotes();
  });
  els.scaleTypeSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val.startsWith('arp-')) {
      state.scaleIsArpeggio = true;
      state.scaleType = val.slice(4);
    } else {
      state.scaleIsArpeggio = false;
      state.scaleType = val.slice(6); // strip "scale-"
    }
    if (state.isPlaying) stopPlayback();
    updateScaleNotes();
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

  // Auto-load sample score (in background for when user switches to Score tab)
  loadSampleScore();

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
