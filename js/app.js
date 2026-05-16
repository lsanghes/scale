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
import { generateScaleNotes, SCALE_TYPES, ARPEGGIO_TYPES, ARPEGGIO_DEGREES, NOTE_NAMES, SHARP_KEY_NAMES, FLAT_KEY_NAMES, SHARP_PREF_TYPES } from './scales.js';

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
  bpm: 120,
  loopEnabled: true,
  showNoteNames: true,
  scoreLoaded: false,
  activeNotes: [], // notes for the selected part
  inTuneSince: 0,  // timestamp when player was first in-tune on current note
  view: 'score',           // 'score' | 'scales'
  scaleKey: 0,
  scaleType: 'Major',
  scaleIsArpeggio: false,
  scaleOctaves: 3,
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
  els.detectedNote = document.getElementById('detected-note');
  els.detectedFreq = document.getElementById('detected-freq');
  els.targetNote = document.getElementById('target-note');
  els.centsValue = document.getElementById('cents-value');
  els.centsIndicator = document.getElementById('cents-indicator');
  els.centsMeter = document.getElementById('cents-meter');
  els.scoreContainer = document.getElementById('score-container');
  els.scoreWrapper = document.getElementById('score-wrapper');
  els.scoreTitle = document.getElementById('score-title');
  els.playBtn = document.getElementById('play-btn');
  els.loopBtn = document.getElementById('loop-btn');
  els.noteNameBtn = document.getElementById('note-name-btn');
  els.bpmGroup = document.getElementById('bpm-group');
  els.bpmScrub = document.getElementById('bpm-scrub');
  els.bpmScrubVal = document.getElementById('bpm-scrub-val');
  els.bpmDec = document.getElementById('bpm-dec');
  els.bpmInc = document.getElementById('bpm-inc');
  // Scale mode elements
  els.topPanel = document.getElementById('top-panel');
  els.scaleKeyButtons = document.getElementById('scale-key-buttons');
  els.scaleTypeButtons = document.getElementById('scale-type-buttons');
  els.noteNameOverlay = document.getElementById('note-name-overlay');
}

function getNoteheadScreenPos(noteIdx) {
  if (!state.scoreManager.osmd?.graphic?.MeasureList) return null;
  const nPerMeasure = getNotesPerMeasure();
  const measureIdx = Math.floor(noteIdx / nPerMeasure);
  const entryIdx = noteIdx % nPerMeasure;
  const gMeasure = state.scoreManager.osmd.graphic.MeasureList[measureIdx]?.[0];
  const staffEntry = gMeasure?.staffEntries?.[entryIdx];
  const gNote = staffEntry?.graphicalVoiceEntries?.[0]?.notes?.[0];
  const pos = gNote?.PositionAndShape?.AbsolutePosition;
  if (!pos) return null;

  const svg = els.scoreContainer.querySelector('svg');
  if (!svg) return null;
  const vb = svg.viewBox?.baseVal;
  const svgRect = svg.getBoundingClientRect();
  const scaleX = vb?.width  ? svgRect.width  / vb.width  : 1;
  const scaleY = vb?.height ? svgRect.height / vb.height : 1;

  const svgPxX = pos.x * OSMD_SCALE;
  const svgPxY = pos.y * OSMD_SCALE + getShiftForSvgY(pos.y * OSMD_SCALE);

  return {
    x: svgRect.left + svgPxX * scaleX,
    y: svgRect.top  + svgPxY * scaleY,
  };
}

function showNoteNameOverlay(note, cursorEl, noteIdx = null) {
  if (!els.noteNameOverlay || !note || !state.showNoteNames) return;

  els.noteNameOverlay.textContent = note.name;

  // In scale view, position relative to the actual notehead Y (pitch-accurate)
  if (noteIdx !== null) {
    const pos = getNoteheadScreenPos(noteIdx);
    if (pos) {
      els.noteNameOverlay.style.left = `${pos.x}px`;
      els.noteNameOverlay.style.top  = `${pos.y + 14}px`; // 14px below notehead center
      els.noteNameOverlay.style.display = 'block';
      return;
    }
  }

  // Fallback: position below the OSMD cursor element
  if (!cursorEl) {
    const osmdCursor = state.scoreManager.osmd?.cursor;
    cursorEl = osmdCursor?.cursorElement || osmdCursor?.GetCurrentSymbol?.()?.cursorElement;
  }
  let cursorRect = null;
  if (cursorEl && cursorEl.getBoundingClientRect) {
    cursorRect = cursorEl.getBoundingClientRect();
    if (!cursorRect.height && !cursorRect.width) cursorRect = null;
  }
  if (cursorRect) {
    els.noteNameOverlay.style.left = `${cursorRect.left + cursorRect.width / 2}px`;
    els.noteNameOverlay.style.top  = `${cursorRect.bottom + 35}px`;
    els.noteNameOverlay.style.display = 'block';
  } else {
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
}

function enablePlayBtns(enabled) {
  els.playBtn.disabled = !enabled;
}

function getBpm() {
  return state.bpm;
}

function setBpm(val) {
  const bpm = Math.max(1, Math.min(400, Math.round(parseInt(val) || 120)));
  state.bpm = bpm;
  els.bpmScrubVal.textContent = bpm;
  if (state.scorePlayer?.isPlaying) state.scorePlayer.changeBpm(bpm);
}

function ensureAudioContext() {
  if (!state.audioContext) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Master gain → compressor → destination for consistent loudness
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 3;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.1;
    compressor.connect(ctx.destination);
    const masterGain = ctx.createGain();
    masterGain.gain.value = 3.0;
    masterGain.connect(compressor);
    state.audioContext = ctx;
    state.masterGain = masterGain;
  }
  if (state.audioContext.state === 'suspended') {
    state.audioContext.resume();
  }
  return state.audioContext;
}

// File loading (score mode removed — scales only)
async function loadScoreData(loader) {
  els.scoreContainer.innerHTML = '<p>Loading score...</p>';

  try {
    await loader();
    state.scoreLoaded = true;
    selectPart(0);
    setBpm(state.scoreManager.getBPM());
    enablePlayBtns(true);
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
    if (state.view !== 'scales') {
      // Sync OSMD cursor and scroll
      const cursorEl = state.scoreManager.syncCursor(note.scoreStartBeat ?? note.startBeat);
      scrollScoreToCursor(cursorEl, note);
    }
  } else {
    els.targetNote.textContent = '-';
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

// Score click handling for OSMD
const OSMD_SCALE = 10;

function getNotesPerMeasure() {
  if (state.scaleType === 'Chromatic') return 8;
  if (state.scaleType === 'Major Broken Third' || state.scaleType === 'Melodic Minor Broken Third') return 8;
  switch (state.scaleOctaves) {
    case 1: return state.activeNotes.length || 16; // all notes in one measure
    case 2: return 8;
    case 3: return 6;
    case 4: return 8;
    default: return 8;
  }
}

function getShiftForSvgY(midY) {
  if (!_systemShiftMap || !_systemShiftMap.length) return 0;
  let nearest = _systemShiftMap[0];
  let minDist = Math.abs(midY - nearest.center);
  for (let i = 1; i < _systemShiftMap.length; i++) {
    const d = Math.abs(midY - _systemShiftMap[i].center);
    if (d < minDist) { minDist = d; nearest = _systemShiftMap[i]; }
  }
  return nearest.shift;
}

function getNoteIndexAtSvgPx(svgX, svgY) {
  const measureList = state.scoreManager.osmd?.graphic?.MeasureList;
  if (!measureList) return null;

  for (let mIdx = 0; mIdx < measureList.length; mIdx++) {
    const measures = measureList[mIdx];
    for (const gm of measures) {
      if (!gm?.PositionAndShape) continue;
      const abs = gm.PositionAndShape.AbsolutePosition;
      const size = gm.PositionAndShape.Size;

      let x0 = abs.x * OSMD_SCALE;
      let x1 = (abs.x + size.width) * OSMD_SCALE;
      let y0 = abs.y * OSMD_SCALE;
      let y1 = (abs.y + size.height) * OSMD_SCALE;
      const shift = getShiftForSvgY((y0 + y1) / 2);
      y0 += shift;
      y1 += shift;
      // Expand Y to catch notes on ledger lines above/below the staff
      const Y_PAD = 60;
      if (svgX < x0 || svgX > x1 || svgY < y0 - Y_PAD || svgY > y1 + Y_PAD) continue;

      // Clicked inside this measure — find closest staff entry by X
      const baseIdx = mIdx * getNotesPerMeasure();
      const entries = gm.staffEntries;
      if (entries && entries.length) {
        let closestLocal = 0;
        let closestDist = Infinity;
        entries.forEach((entry, i) => {
          const rel = entry?.PositionAndShape?.RelativePosition;
          if (!rel) return;
          const entryX = (abs.x + rel.x) * OSMD_SCALE;
          const dist = Math.abs(svgX - entryX);
          if (dist < closestDist) { closestDist = dist; closestLocal = i; }
        });
        return Math.min(baseIdx + closestLocal, state.activeNotes.length - 1);
      }
      return Math.min(baseIdx, state.activeNotes.length - 1);
    }
  }
  return null;
}

function handleScoreClick(event) {
  if (!state.scoreManager.osmd || !state.scoreManager.osmd.graphic) return;

  const container = els.scoreContainer;
  const containerRect = container.getBoundingClientRect();

  // Click position in SVG pixel space (accounting for container scroll)
  const svgX = event.clientX - containerRect.left + container.scrollLeft;
  const svgY = event.clientY - containerRect.top + container.scrollTop;

  const noteIdx = getNoteIndexAtSvgPx(svgX, svgY);
  if (noteIdx !== null) {
    const wasPlaying = state.isPlaying;
    if (wasPlaying) stopPlayback();
    state.currentNoteIndex = noteIdx;
    state.currentMeasure = state.activeNotes[noteIdx]?.measure ?? state.currentMeasure;
    state.inTuneSince = 0;
    updateTargetDisplay();
    if (state.view === 'scales') updateScaleHighlight();
    if (wasPlaying) startPlayback();
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
    await state.referenceTone.init(state.masterGain); // ensure soundfont is loaded

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
      state.scorePlayer.shouldLoop = state.loopEnabled;
      state.scorePlayer.loopDelayMs = 0;
      state.scorePlayer.countInEnabled = true;
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
          showNoteNameOverlay(state.activeNotes[idx], cursorEl, idx);
        }
      };
      state.scorePlayer.onLoopRestart = () => {
        state.currentNoteIndex = 0;
        state.currentMeasure = state.activeNotes[0]?.measure ?? 1;
        updateTargetDisplay();
        updateScaleHighlight();
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

    state.scorePlayer.countIn(state.activeNotes, bpm, state.currentNoteIndex, (beat) => {
      setPlayBtnState(false, true);
      els.playBtn.textContent = beat;
      if (beat === 1) {
        setTimeout(() => {
          els.playBtn.textContent = '⏹ Stop';
        }, 60000 / bpm);
      }
    });
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
    state.referenceTone.init(state.masterGain);
  }

  try {
    await state.pitchDetector.start();
    state.isListening = true;

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
  els.detectedNote.textContent = '-';
  els.detectedFreq.textContent = '';
  els.centsValue.textContent = '';
  els.centsIndicator.style.left = '50%';
  els.centsMeter.className = 'cents-meter';
}

// Main loop
function mainLoop() {
  if (!state.isListening) return;

  const result = state.pitchDetector.detect();

  if (result && result.confidence > 0.66) {
    const { frequency } = result;
    const nearestMidi = nearestNoteNumber(frequency);
    const noteName = noteNumberToName(nearestMidi);
    const nearestFreq = noteNumberToFrequency(nearestMidi);
    const cents = centsDifference(frequency, nearestFreq);

    // Update detected display
    els.detectedNote.textContent = noteName;
    els.detectedFreq.textContent = `${frequency.toFixed(1)} Hz`;
    els.centsValue.textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(1)}¢`;
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
    // No pitch detected — simultaneous tone keeps playing until silence

  }

  requestAnimationFrame(mainLoop);
}

// ── Scale Mode ──

function switchView(view) {
  state.view = view;
  updateScaleNotes();
  updateScaleSubModeUI();
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
    { label: 'Melodic<br>Minor', type: 'Melodic Minor', isArp: false },
    { label: 'Harmonic<br>Minor', type: 'Harmonic Minor', isArp: false },
    { label: 'Natural<br>Minor', type: 'Natural Minor', isArp: false },
    { label: 'Major<br>Broken 3rd', type: 'Major Broken Third', isArp: false },
    { label: 'Melodic<br>Broken 3rd', type: 'Melodic Minor Broken Third', isArp: false },
    { label: 'Chromatic', type: 'Chromatic', isArp: false },
  ];

  scaleItems.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scale-btn';
    btn.innerHTML = item.label;
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
    { label: 'Minor',   type: 'Minor',                  isArp: true, tooltip: 'Minor (i)' },
    { label: '♭VI6',    type: '♭VI6',                   isArp: true, tooltip: 'Flat Submediant Six (♭VI6)' },
    { label: 'Aug',     type: 'Augmented',               isArp: true, tooltip: 'Augmented' },
    { label: 'vi6',     type: 'vi6',                     isArp: true, tooltip: 'Relative Minor Six (vi6)' },
    { label: 'V7',      type: 'Dominant 7th',            isArp: true, tooltip: 'Dominant Seventh (V7)' },
    { label: 'IV6/4',   type: 'IV6/4',                   isArp: true, tooltip: 'Subdominant Six-Four (IV⁶⁄₄)' },
    { label: 'iv6/4',   type: 'iv6/4',                   isArp: true, tooltip: 'Minor Subdominant Six-Four (iv⁶⁄₄)' },
    { label: '4-3 Sus', type: '4-3 Suspension',          isArp: true, tooltip: 'Four-Three Suspension' },
    { label: 'Major',   type: 'Major',                   isArp: true, tooltip: 'Major (I)' },
    { label: 'V7/♭II',  type: 'Dominant 7th of ♭II',    isArp: true, tooltip: 'Dominant Seventh of ♭II' },
  ];

  arpItems.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'arp-btn';
    btn.textContent = item.label;
    btn.dataset.tooltip = item.tooltip;
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

const ARPEGGIO_FULL_NAMES = {
  'Minor':           ['Minor',                      'i'],
  '♭VI6':            ['Flat Submediant Six',         '♭VI6'],
  'Augmented':       ['Augmented',                  'Aug'],
  'vi6':             ['Relative Minor Six',          'vi6'],
  'Dominant 7th':    ['Dominant Seventh',            'V7'],
  'IV6/4':           ['Subdominant Six-Four',        'IV⁶⁄₄'],
  'iv6/4':           ['Minor Subdominant Six-Four',  'iv⁶⁄₄'],
  '4-3 Suspension':  ['Four-Three Suspension',       '4-3 Sus', true],
  'Major':           ['Major',                       'I'],
  'Diminished 7th':      ['Diminished Seventh',          '°7'],
  'Dominant 7th of ♭II': null, // title built dynamically in getScaleTitle
};

function getScaleTitle() {
  const useSharp = !state.scaleIsArpeggio && SHARP_PREF_TYPES.has(state.scaleType);
  const keyName = (useSharp ? SHARP_KEY_NAMES : FLAT_KEY_NAMES)[state.scaleKey];
  const octLabel = `${state.scaleOctaves} Octave${state.scaleOctaves > 1 ? 's' : ''}`;
  if (state.scaleIsArpeggio) {
    if (state.scaleType === 'Dominant 7th of ♭II') {
      const flatII = FLAT_KEY_NAMES[(state.scaleKey + 1) % 12];
      return `${keyName} Dominant Seventh of ${flatII} Arpeggio - ${octLabel}`;
    }
    const [fullName, symbol, useWith] = ARPEGGIO_FULL_NAMES[state.scaleType] ?? [state.scaleType, ''];
    const connector = useWith ? 'with ' : '';
    return `${keyName} ${connector}${fullName} Arpeggio (${symbol}) - ${octLabel}`;
  }
  return `${keyName} ${state.scaleType} Scale - ${octLabel}`;
}

// Circle-of-fifths value for each root (semitone 0–11) and mode
// Minor keys use their relative major's key signature (e.g. A minor = C major = 0)
const MINOR_FIFTHS = [-3, 4, -1, -6, 1, -4, 3, -2, 5, 0, -5, 2];
const MAJOR_FIFTHS = [ 0, -5,  2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const KEY_FIFTHS = {
  'Major':          MAJOR_FIFTHS,
  'Natural Minor':  MINOR_FIFTHS,
  'Harmonic Minor': MINOR_FIFTHS,
  'Melodic Minor':  MINOR_FIFTHS,
  'Major Broken Third':          MAJOR_FIFTHS,
  'Melodic Minor Broken Third':  MINOR_FIFTHS,
  'Chromatic': [0,0,0,0,0,0,0,0,0,0,0,0],
  // Arpeggio types
  'Minor':          MINOR_FIFTHS,
  'Dominant 7th':        [ 0, -5,  2, -3, 4, -1, 6, 1, -4, 3, -2, 5],
  'Diminished 7th':      MINOR_FIFTHS,
  'Dominant 7th of ♭II': [-5,  2, -3,  4,-1,  6, 1,-4,  3, -2,  5, 0],
  'Augmented':      [ 0, -5,  2, -3, 4, -1, 6, 1, -4, 3, -2, 5],
  '♭VI6':           MINOR_FIFTHS,
  'vi6':            MAJOR_FIFTHS,
  'IV6/4':          MAJOR_FIFTHS,
  'iv6/4':          MINOR_FIFTHS,
  '4-3 Suspension': MAJOR_FIFTHS,
};

function getKeyFifths() {
  const table = KEY_FIFTHS[state.scaleType];
  if (!table) return 0;
  return table[state.scaleKey] ?? 0;
}

function generateScaleMusicXML(notes) {
  const title = getScaleTitle();
  const fifths = getKeyFifths();
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

  // Build a pitch-class → {step, alter} map from the scale's diatonic spelling
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const NATURAL_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
  // Root letter index per semitone for sharp vs flat keys
  const ROOT_LETTER_SHARP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
  const ROOT_LETTER_FLAT  = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];

  const useFlats = fifths < 0;
  const rootLetterIdx = (useFlats ? ROOT_LETTER_FLAT : ROOT_LETTER_SHARP)[state.scaleKey];
  const scaleIntervals = (() => {
    if (state.scaleIsArpeggio) return ARPEGGIO_TYPES[state.scaleType] ?? [0, 4, 7];
    const t = SCALE_TYPES[state.scaleType];
    return Array.isArray(t) ? t : (t?.up ?? [0, 2, 4, 5, 7, 9, 11]);
  })();

  const arpDegrees = state.scaleIsArpeggio
    ? (ARPEGGIO_DEGREES[state.scaleType] ?? scaleIntervals.map((_, i) => i * 2))
    : null;

  const spellingMap = new Map();
  for (let i = 0; i < scaleIntervals.length; i++) {
    const pc = (state.scaleKey + scaleIntervals[i]) % 12;
    const degreeOffset = state.scaleIsArpeggio ? arpDegrees[i] : i;
    const letterIdx = (rootLetterIdx + degreeOffset) % 7;
    const alter = (((pc - NATURAL_SEMITONES[letterIdx] + 6) % 12) + 12) % 12 - 6;
    spellingMap.set(pc, { step: LETTERS[letterIdx], alter });
  }
  // Fallback for any pitch class not in the scale (shouldn't happen for standard scales)
  const SHARP_FALLBACK = ['C','C','D','D','E','F','F','G','G','A','A','B'];
  const SHARP_ALTER_FB = [ 0,  1,  0,  1,  0,  0,  1,  0,  1,  0,  1,  0];
  const FLAT_FALLBACK  = ['C','D','D','E','E','F','G','G','A','A','B','B'];
  const FLAT_ALTER_FB  = [ 0, -1,  0, -1,  0,  0, -1,  0, -1,  0, -1,  0];

  function generateNoteXml(note) {
    const pc = note.midi % 12;
    let step, alter;
    if (note.step !== null && note.step !== undefined) {
      step  = note.step;
      alter = note.alter ?? 0;
    } else if (spellingMap.has(pc)) {
      ({ step, alter } = spellingMap.get(pc));
    } else {
      step  = useFlats ? FLAT_FALLBACK[pc]  : SHARP_FALLBACK[pc];
      alter = useFlats ? FLAT_ALTER_FB[pc]  : SHARP_ALTER_FB[pc];
    }
    // Octave based on natural (un-altered) pitch so E# and Cb land in the right octave
    const octave = Math.floor((note.midi - alter) / 12) - 1;

    let alterXml = '';
    if (alter === 1) alterXml = '<alter>1</alter>';
    else if (alter === -1) alterXml = '<alter>-1</alter>';
    else if (alter === 2) alterXml = '<alter>2</alter>';
    else if (alter === -2) alterXml = '<alter>-2</alter>';

    return `<note>
      <pitch>
        <step>${step}</step>
        ${alterXml}
        <octave>${octave}</octave>
      </pitch>
      <duration>4</duration>
      <type>quarter</type>
      <stem>none</stem>
    </note>`;
  }

  // Chunk notes into measures of 6, then pick best clef for each
  const NOTES_PER_MEASURE = getNotesPerMeasure();
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
        <key>
          <fifths>${fifths}</fifths>
        </key>
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

const SHARP_NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NOTE_NAMES  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

function updateScaleNotes() {
  const notes = generateScaleNotes(state.scaleKey, state.scaleType, state.scaleIsArpeggio, state.scaleOctaves);

  // Append final root note when not looping so the exercise resolves on Do;
  // omit it when looping so the root isn't played twice at the loop boundary.
  if (!state.loopEnabled && notes.length > 0) {
    const last = notes[notes.length - 1];
    notes.push({ ...notes[0], startBeat: last.startBeat + 1, row: last.row });
  }

  notes.forEach((note, i) => { note.measure = Math.floor(i / getNotesPerMeasure()) + 1; });

  // Re-spell note names to match the key signature (sharps vs flats)
  const useFlats = getKeyFifths() < 0;
  const nameTable = useFlats ? FLAT_NOTE_NAMES : SHARP_NOTE_NAMES;
  notes.forEach(note => {
    const pc = ((note.midi % 12) + 12) % 12;
    const octave = Math.floor(note.midi / 12) - 1;
    note.name = nameTable[pc] + octave;
  });

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
    const svg = els.scoreContainer.querySelector('svg');
    if (!svg) return;
    const svgRect = svg.getBoundingClientRect();
    // Remove our transform before measuring so getBoundingClientRect reflects
    // OSMD's original (unshifted) cursor position, not the previously-shifted one.
    const savedTransform = cursorEl.style.transform;
    cursorEl.style.transform = '';
    const cursorRect = cursorEl.getBoundingClientRect();
    cursorEl.style.transform = savedTransform;
    const screenY = cursorRect.top + cursorRect.height / 2;
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

function applyScalePostProcessing(keepHidden = false) {
  if (_postProcessingPending) clearTimeout(_postProcessingPending);
  if (keepHidden) els.scoreContainer.style.visibility = 'hidden';
  _postProcessingPending = setTimeout(() => {
    _postProcessingPending = null;
    hideCourtesyClefsAtLineEnds();
    equalizeSystemSpacing();
    cropSvgToContent();
    _postProcessApplied = true;
    els.scoreContainer.style.visibility = '';
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
  try {
    const svg = els.scoreContainer.querySelector('svg');
    if (!svg) return;

    // Clef glyphs (both initial and courtesy) are <g> elements with a direct
    // <path> child, width 17–28 px, height > 15 px. In each system row the
    // initial clef is the leftmost one; every other clef in that row is a
    // courtesy clef and should be hidden.
    const candidates = [];
    svg.querySelectorAll('g').forEach(g => {
      if (!g.querySelector(':scope > path')) return;
      let bbox;
      try { bbox = g.getBBox(); } catch (_) { return; }
      if (bbox.width < 17 || bbox.width > 28) return;
      if (bbox.height < 15) return;
      candidates.push({ el: g, bbox });
    });

    if (!candidates.length) return;

    // Group candidates into system rows by vertical centre proximity
    const rows = [];
    for (const c of candidates) {
      const cy = c.bbox.y + c.bbox.height / 2;
      let row = rows.find(r => Math.abs(r.cy - cy) < 80);
      if (!row) { row = { cy, items: [] }; rows.push(row); }
      row.items.push(c);
    }

    // Find the rightmost barline in each system row. Barlines are vertical
    // SVG lines/rects: taller than wide, height > 10. Courtesy clefs always
    // appear to the RIGHT of the final barline; noteheads never do.
    // Using the barline position as the threshold prevents noteheads at the
    // far right of the last measure from being mistaken for courtesy clefs.
    const allLines = svg.querySelectorAll('line, rect');
    const verticalLines = [];
    allLines.forEach(el => {
      let bbox;
      try { bbox = el.getBBox(); } catch (_) { return; }
      if (bbox.height > 10 && bbox.width < 5) {
        verticalLines.push({ cx: bbox.x + bbox.width / 2, cy: bbox.y + bbox.height / 2 });
      }
    });

    for (const row of rows) {
      // Find barlines whose vertical center is within the row's Y band
      const rowBarlines = verticalLines.filter(l => Math.abs(l.cy - row.cy) < 80);
      const rightmostBarlineX = rowBarlines.length
        ? Math.max(...rowBarlines.map(l => l.cx))
        : null;

      for (const item of row.items) {
        // Hide if item is to the right of the rightmost barline in this row,
        // and also past the first candidate (skip the initial clef at the left).
        const threshold = rightmostBarlineX ?? (Math.max(...row.items.map(i => i.bbox.x)) - 1);
        if (item.bbox.x > threshold) item.el.style.display = 'none';
      }
    }
  } catch (e) {
    console.warn('hideCourtesyClefsAtLineEnds failed:', e);
  }
}

function cropSvgToContent() {
  try {
    const svg = els.scoreContainer.querySelector('svg');
    if (!svg) return;
    const box = svg.getBBox();
    if (!box.width || !box.height) return;

    const svgRect = svg.getBoundingClientRect();
    const vb = svg.viewBox?.baseVal;
    if (!vb || !vb.width || !vb.height) return;

    const scaleY = svgRect.height / vb.height;
    const pad = 6;

    // Crop the empty space OSMD adds above the score (title/page margin).
    // box.y is the topmost rendered content — clefs, high notes, accidentals included.
    const topCropSvg = Math.max(0, box.y - vb.y - 2);
    const topCropPx = Math.floor(topCropSvg * scaleY);

    const contentBottomPx = (box.y - vb.y + box.height + pad) * scaleY + 120;

    // Shift the container (SVG + cursor both move together, keeping alignment).
    // The wrapper's overflow:hidden clips the shifted-up empty region.
    els.scoreContainer.style.height = `${contentBottomPx}px`;
    els.scoreContainer.style.marginTop = `-${topCropPx}px`;

  } catch (e) {
    console.warn('cropSvgToContent failed:', e);
  }
}

function equalizeSystemSpacing() {
  _systemShiftMap = null;
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

    // Apply shifts to every SVG element. Assign each element to its system
    // using midpoint boundaries between adjacent staves — this keeps ledger
    // lines for very high/low notes with the correct system even when they
    // fall geometrically closer to the next system's staff center.
    const staffBoundaries = [];
    for (let i = 0; i < staves.length - 1; i++) {
      staffBoundaries.push((staves[i].maxY + staves[i + 1].minY) / 2);
    }
    const allElements = svg.querySelectorAll('line, path, rect, text, ellipse, circle, polygon, polyline, image, use');
    allElements.forEach(el => {
      let svgBbox;
      try { svgBbox = el.getBBox(); } catch (_) { return; }
      const cy = svgBbox.y + svgBbox.height / 2;
      let nearestIdx = 0;
      for (let i = 0; i < staffBoundaries.length; i++) {
        if (cy > staffBoundaries[i]) nearestIdx = i + 1;
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
  const title = getScaleTitle();
  if (els.scoreTitle) {
    els.scoreTitle.textContent = title;
    els.scoreTitle.style.display = 'block';
  }
  const xmlString = generateScaleMusicXML(notes);
  const container = els.scoreContainer;

  try {
    const osmdOptions = {
      autoResize: true,
      drawTitle: false,
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
        // System spacing
        setIfDefined('MinSkyBottomDistBetweenSystems', 5);
        setIfDefined('MinimumDistanceBetweenSystems', 8);
        setIfDefined('SystemDistance', 8);
        setIfDefined('BetweenStaffDistance', 4);
        setIfDefined('StaffDistance', 8);
        setIfDefined('MinSkyBottomDistBetweenStaves', 3);
        setIfDefined('PageTopMargin', 0);
        setIfDefined('PageBottomMargin', 0);
        setIfDefined('SheetTitleHeight', 0);
        setIfDefined('TitleTopDistance', 0);
        setIfDefined('TitleBottomDistance', 0);
        setIfDefined('SheetMinimumDistanceBetweenTitleAndStaffline', 0);
        // Hide courtesy clef shown at the end of each line before a clef change
        setIfDefined('RenderClefsAtBeginningOfStaffline', true);
        setIfDefined('ShowClefBeforeChange', false);
        setIfDefined('RenderEndOfMeasureClefBeforeChange', false);
        setIfDefined('DrawCourtesyAccidentals', false);
        // Don't stretch the last system to fill the full width
        setIfDefined('StretchLastSystemLine', false);
      }
    } catch (e) {
      console.warn('Could not configure engraving rules:', e);
    }

    state.scoreManager.osmd.render();
    state.scoreManager.scoreType = 'musicxml';
    state.scoreManager._cursorBeat = -1;
    state.scoreManager._setupCursor();
    applyScalePostProcessing(true);
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
            showNoteNameOverlay(note, cursorEl, state.currentNoteIndex);
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
  const note = state.activeNotes[state.currentNoteIndex];
  if (note && state.scoreManager.osmd) {
    const cursorEl = state.scoreManager.syncCursor(state.currentNoteIndex);
    shiftCursorForCurrentSystem(cursorEl);
    showNoteNameOverlay(note, cursorEl, state.currentNoteIndex);
  }
}

function updateScaleSubModeUI() {
  enablePlayBtns(true);
  if (!state.isListening) startListening();
}

function showScaleComplete() {
  setTimeout(() => {
    state.currentNoteIndex = 0;
    state.inTuneSince = 0;
    updateScaleHighlight();
    updateTargetDisplay();
  }, 2000);
}

function addBpmStepButton(btn, delta) {
  if (!btn) return;
  let intervalId = null;
  let timeoutId = null;

  function step() { setBpm(state.bpm + delta); }

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    step();
    timeoutId = setTimeout(() => {
      intervalId = setInterval(step, 80);
    }, 400);
  });

  function stopRepeat() {
    clearTimeout(timeoutId);
    clearInterval(intervalId);
  }

  btn.addEventListener('pointerup', stopRepeat);
  btn.addEventListener('pointercancel', stopRepeat);
  btn.addEventListener('pointerleave', stopRepeat);
}

function initBpmScrub() {
  addBpmStepButton(els.bpmDec, -1);
  addBpmStepButton(els.bpmInc, +1);

  [
    { scrub: els.bpmScrub, val: els.bpmScrubVal },
  ].forEach(({ scrub, val }) => {
    if (!scrub) return;

    let dragging = false;
    let totalDx = 0;
    let lastX = 0;
    let accumDelta = 0;

    scrub.addEventListener('pointerdown', (e) => {
      dragging = true;
      totalDx = 0;
      accumDelta = 0;
      lastX = e.clientX;
      scrub.classList.add('dragging');
      scrub.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    scrub.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      // 1px = 1 BPM; use ± buttons for fine adjustment
      accumDelta += dx;
      totalDx += Math.abs(dx);

      const delta = Math.trunc(accumDelta);
      if (delta !== 0) {
        setBpm(state.bpm + delta);
        accumDelta -= delta;
      }

      lastX = e.clientX;
    });

    scrub.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      scrub.classList.remove('dragging');
      if (totalDx < 6) showBpmInput(scrub, val);
    });

    scrub.addEventListener('pointercancel', () => {
      dragging = false;
      scrub.classList.remove('dragging');
    });
  });
}

function showBpmInput(scrub, val) {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = state.bpm;
  input.min = 1;
  input.max = 400;
  val.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    setBpm(input.value);
    input.replaceWith(val);
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { input.replaceWith(val); }
  });
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// Event listeners
function init() {
  initDOM();
  setBpm(120);

  window.addEventListener('scroll', () => {
    const osmdCursor = state.scoreManager.osmd?.cursor;
    const cursorEl = osmdCursor?.cursorElement || osmdCursor?.GetCurrentSymbol?.()?.cursorElement;
    if (cursorEl && els.noteNameOverlay.style.display !== 'none') {
      const cursorRect = cursorEl.getBoundingClientRect();
      if (cursorRect.width || cursorRect.height) {
        els.noteNameOverlay.style.left = `${cursorRect.left + cursorRect.width / 2}px`;
        els.noteNameOverlay.style.top = `${cursorRect.bottom + 35}px`;
      }
    }
  });

  els.playBtn.addEventListener('click', togglePlayback);

  function toggleLoop() {
    state.loopEnabled = !state.loopEnabled;
    els.loopBtn.classList.toggle('active', state.loopEnabled);
    if (state.scorePlayer) state.scorePlayer.shouldLoop = state.loopEnabled;
    if (state.view === 'scales' && state.activeNotes.length) {
      if (state.isPlaying) stopPlayback();
      updateScaleNotes();
    }
  }
  els.loopBtn.addEventListener('click', toggleLoop);

  function toggleNoteNames() {
    state.showNoteNames = !state.showNoteNames;
    els.noteNameBtn.classList.toggle('active', state.showNoteNames);
    if (!state.showNoteNames) hideNoteNameOverlay();
    else updateScaleHighlight();
  }
  els.noteNameBtn.addEventListener('click', toggleNoteNames);

  initBpmScrub();

  els.scoreContainer.addEventListener('click', handleScoreClick);

  // Scale mode event listeners
  populateScaleKeyButtons();
  populateScaleTypeButtons();
  const octBtn = document.getElementById('oct-btn');

  function setOctaves(n) {
    state.scaleOctaves = n;
    octBtn.textContent = n === 1 ? '1 Octave' : `${n} Octaves`;
    if (state.isPlaying) stopPlayback();
    updateScaleNotes();
  }

  setOctaves(state.scaleOctaves);

  octBtn.addEventListener('click', () => {
    setOctaves((state.scaleOctaves % 4) + 1);
  });

  updateTargetDisplay();

  // Panel tab switching
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const panel = tab.dataset.panel;
      els.topPanel.dataset.state = panel;
      document.querySelectorAll('.panel-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.panel === panel)
      );
    });
  });

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
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
