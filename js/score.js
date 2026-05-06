// Score loading — MusicXML (via OSMD) and MIDI (via @tonejs/midi)

import { noteNumberToFrequency, midiToNoteName } from './notemath.js';

export class ScoreManager {
  constructor() {
    this.osmd = null;
    this.parts = []; // [{ name, notes: [{ midi, frequency, name, measure, startBeat, duration }] }]
    this.measureCount = 0;
    this.scoreType = null; // 'musicxml' | 'midi'
    this.bpm = 120;
    this._cursorBeat = -1;
    this._systemLayouts = [];
    this._playbackMeasureOrder = null;
  }

  async loadFile(file) {
    const ext = file.name.toLowerCase().split('.').pop();
    if (['mid', 'midi'].includes(ext)) {
      const buf = await file.arrayBuffer();
      this._loadMIDI(buf);
    } else {
      // musicxml, xml, mxl
      if (ext === 'mxl') {
        await this._loadMXL(file);
      } else {
        const text = await file.text();
        await this._loadMusicXML(text);
      }
    }
  }

  async _loadMusicXML(xmlString) {
    this.scoreType = 'musicxml';
    this._playbackMeasureOrder = this._parsePlaybackMeasureOrder(xmlString);
    const container = document.getElementById('score-container');
    this.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
      autoResize: true,
      drawTitle: true,
      drawPartNames: true,
    });
    this.osmd.EngravingRules.MinimumDistanceBetweenSystems = 8;
    await this.osmd.load(xmlString);
    window._osmd = this.osmd;
    this.osmd.render();
    this._extractFromOSMD();
    this._setupCursor();
  }

  async _loadMXL(file) {
    this.scoreType = 'musicxml';
    this._playbackMeasureOrder = null;
    const container = document.getElementById('score-container');
    this.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
      autoResize: true,
      drawTitle: true,
      drawPartNames: true,
    });
    this.osmd.EngravingRules.MinimumDistanceBetweenSystems = 8;
    const buf = await file.arrayBuffer();
    await this.osmd.load(buf);
    window._osmd = this.osmd;
    this.osmd.render();
    this._extractFromOSMD();
    this._setupCursor();
  }

  _extractFromOSMD() {
    this.parts = [];
    const sheet = this.osmd.sheet;
    this.measureCount = sheet.SourceMeasures.length;
    this._buildSystemLayouts();
    const measureTimings = this._getMeasureTimings(sheet);

    for (let pIdx = 0; pIdx < sheet.Parts.length; pIdx++) {
      const part = sheet.Parts[pIdx];
      const partName = part.Name || `Part ${pIdx + 1}`;
      const notes = [];

      for (let mIdx = 0; mIdx < sheet.SourceMeasures.length; mIdx++) {
        const measure = sheet.SourceMeasures[mIdx];
        const staffEntries = measure.VerticalSourceStaffEntryContainers;

        for (const container of staffEntries) {
          const entry = container.StaffEntries[pIdx];
          if (!entry) continue;

          for (const voiceEntry of entry.VoiceEntries) {
            for (const note of voiceEntry.Notes) {
              if (note.isRest()) continue;
              const midi = note.halfTone + 12; // OSMD uses halfTone relative to C-1
              const frequency = noteNumberToFrequency(midi);
              const name = midiToNoteName(midi);
              const startBeat = note.getAbsoluteTimestamp().RealValue * 4; // convert to quarter beats
              const duration = note.Length.RealValue * 4;

              notes.push({
                midi,
                frequency,
                name,
                measure: mIdx + 1,
                startBeat,
                scoreStartBeat: startBeat,
                duration,
              });
            }
          }
        }
      }

      notes.sort((a, b) => a.startBeat - b.startBeat);
      this.parts.push({
        name: partName,
        notes: this._expandNotesForPlayback(notes, measureTimings),
      });
    }
  }

  _getMeasureTimings(sheet) {
    const timings = [];
    for (let mIdx = 0; mIdx < sheet.SourceMeasures.length; mIdx++) {
      const measure = sheet.SourceMeasures[mIdx];
      const startBeat = measure?.AbsoluteTimestamp?.RealValue != null
        ? measure.AbsoluteTimestamp.RealValue * 4
        : (timings[mIdx - 1]?.startBeat ?? 0) + (timings[mIdx - 1]?.duration ?? 4);
      const nextMeasure = sheet.SourceMeasures[mIdx + 1];
      let duration = measure?.Duration?.RealValue != null ? measure.Duration.RealValue * 4 : null;
      if ((duration == null || duration <= 0) && nextMeasure?.AbsoluteTimestamp?.RealValue != null) {
        duration = nextMeasure.AbsoluteTimestamp.RealValue * 4 - startBeat;
      }
      timings.push({
        startBeat,
        duration: duration && duration > 0 ? duration : 4,
      });
    }
    return timings;
  }

  _expandNotesForPlayback(notes, measureTimings) {
    const playbackOrder = this._playbackMeasureOrder;
    if (!playbackOrder || !playbackOrder.length) return notes;

    const notesByMeasure = new Map();
    for (const note of notes) {
      const timing = measureTimings[note.measure - 1];
      const measureStartBeat = timing?.startBeat ?? 0;
      const offsetBeat = note.startBeat - measureStartBeat;
      const arr = notesByMeasure.get(note.measure) || [];
      arr.push({ ...note, offsetBeat });
      notesByMeasure.set(note.measure, arr);
    }

    const expanded = [];
    let playbackBeat = 0;
    for (const measureNumber of playbackOrder) {
      const timing = measureTimings[measureNumber - 1];
      const measureDuration = timing?.duration ?? 4;
      const measureNotes = notesByMeasure.get(measureNumber) || [];
      for (const note of measureNotes) {
        expanded.push({
          ...note,
          startBeat: playbackBeat + note.offsetBeat,
        });
      }
      playbackBeat += measureDuration;
    }

    expanded.sort((a, b) => a.startBeat - b.startBeat);
    return expanded;
  }

  _parsePlaybackMeasureOrder(xmlString) {
    try {
      const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
      const part = doc.querySelector('score-partwise > part');
      if (!part) return null;

      const measureEls = Array.from(part.children).filter((el) => el.tagName === 'measure');
      const measures = measureEls.map((measureEl, index) => {
        const forwardRepeat = !!measureEl.querySelector('barline repeat[direction="forward"]');
        const backwardRepeat = !!measureEl.querySelector('barline repeat[direction="backward"]');
        const endingNumbers = new Set();
        measureEl.querySelectorAll('barline ending[number]').forEach((endingEl) => {
          const raw = endingEl.getAttribute('number') || '';
          raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => {
            const parsed = parseInt(n, 10);
            if (!Number.isNaN(parsed)) endingNumbers.add(parsed);
          });
        });
        return {
          sequenceNumber: index + 1,
          forwardRepeat,
          backwardRepeat,
          endingNumbers,
        };
      });

      const order = [];
      const repeatStack = [];
      let measureIdx = 0;
      let guard = 0;

      while (measureIdx < measures.length && guard < measures.length * 8) {
        guard += 1;
        const measure = measures[measureIdx];

        if (measure.forwardRepeat) {
          const top = repeatStack[repeatStack.length - 1];
          if (!top || top.startIndex !== measureIdx) {
            repeatStack.push({ startIndex: measureIdx, pass: 1 });
          }
        }

        const activeRepeat = repeatStack[repeatStack.length - 1] || null;
        const allowedByEnding = !activeRepeat ||
          measure.endingNumbers.size === 0 ||
          measure.endingNumbers.has(activeRepeat.pass);

        if (allowedByEnding) {
          order.push(measure.sequenceNumber);
        }

        if (measure.backwardRepeat && activeRepeat && allowedByEnding && activeRepeat.pass < 2) {
          activeRepeat.pass += 1;
          measureIdx = activeRepeat.startIndex;
          continue;
        }

        if (measure.backwardRepeat && activeRepeat) {
          repeatStack.pop();
        }

        measureIdx += 1;
      }

      return order.length ? order : null;
    } catch (_) {
      return null;
    }
  }

  _loadMIDI(arrayBuffer) {
    this.scoreType = 'midi';
    const midi = new Midi(arrayBuffer);
    this.parts = [];

    // Estimate measures from time signatures
    const tempos = midi.header.tempos;
    const bpm = tempos.length > 0 ? tempos[0].bpm : 120;
    const timeSigs = midi.header.timeSignatures;
    const beatsPerMeasure = timeSigs.length > 0
      ? timeSigs[0].timeSignature[0]
      : 4;

    let maxTime = 0;

    for (const track of midi.tracks) {
      if (track.notes.length === 0) continue;
      const partName = track.name || `Track ${this.parts.length + 1}`;
      const notes = [];

      for (const n of track.notes) {
        const startBeat = n.ticks / midi.header.ppq;
        const duration = n.durationTicks / midi.header.ppq;
        const measure = Math.floor(startBeat / beatsPerMeasure) + 1;
        const frequency = noteNumberToFrequency(n.midi);
        const name = midiToNoteName(n.midi);

        notes.push({
          midi: n.midi,
          frequency,
          name,
          measure,
          startBeat,
          scoreStartBeat: startBeat,
          duration,
        });

        maxTime = Math.max(maxTime, startBeat + duration);
      }

      notes.sort((a, b) => a.startBeat - b.startBeat);
      this.parts.push({ name: partName, notes });
    }

    this.measureCount = Math.ceil(maxTime / beatsPerMeasure);
    this.bpm = bpm;
  }

  getParts() {
    return this.parts.map((p) => p.name);
  }

  getNotesForPart(partIndex) {
    return this.parts[partIndex]?.notes || [];
  }

  getMeasureCount() {
    return this.measureCount;
  }

  getBPM() {
    return this.bpm;
  }

  getNotesInMeasure(partIndex, measureNumber) {
    const notes = this.getNotesForPart(partIndex);
    return notes.filter((n) => n.measure === measureNumber);
  }

  // Get the measure number at a click position on the rendered score
  getMeasureAtPosition(x, y) {
    if (!this.osmd || !this.osmd.graphic) return null;
    const measureList = this.osmd.graphic.MeasureList;
    if (!measureList) return null;

    for (let mIdx = 0; mIdx < measureList.length; mIdx++) {
      const measures = measureList[mIdx];
      for (const gMeasure of measures) {
        if (!gMeasure) continue;
        const pos = gMeasure.PositionAndShape;
        if (!pos) continue;
        const abs = pos.AbsolutePosition;
        const size = pos.Size;
        // OSMD uses units, we need to convert. The container's bounding rect gives us the scale
        if (
          x >= abs.x &&
          x <= abs.x + size.width &&
          y >= abs.y &&
          y <= abs.y + size.height
        ) {
          return mIdx + 1; // 1-indexed
        }
      }
    }
    return null;
  }

  // Approximate top position of a measure in CSS pixels for scrolling fallback.
  getMeasureTopPx(measureNumber) {
    if (!this.osmd || !this.osmd.graphic) return null;
    const measureList = this.osmd.graphic.MeasureList;
    if (!measureList) return null;
    const idx = measureNumber - 1;
    const measures = measureList[idx];
    if (!measures) return null;

    for (const gMeasure of measures) {
      if (!gMeasure || !gMeasure.PositionAndShape) continue;
      const abs = gMeasure.PositionAndShape.AbsolutePosition;
      if (!abs) continue;
      // OSMD uses ~10px per unit by default; we match the click conversion.
      return abs.y * 10;
    }
    return null;
  }

  getSystemLayoutForMeasure(measureNumber) {
    if (!this._systemLayouts.length) return null;
    return this._systemLayouts.find((system) =>
      measureNumber >= system.startMeasure && measureNumber <= system.endMeasure
    ) || null;
  }

  _buildSystemLayouts() {
    this._systemLayouts = [];
    if (!this.osmd || !this.osmd.graphic) return;

    const measureList = this.osmd.graphic.MeasureList;
    if (!measureList) return;

    const systems = [];
    for (let idx = 0; idx < measureList.length; idx++) {
      const measureNumber = idx + 1;
      const measures = measureList[idx];
      let topPx = null;
      let heightPx = 0;

      for (const gMeasure of measures) {
        if (!gMeasure || !gMeasure.PositionAndShape) continue;
        const pos = gMeasure.PositionAndShape;
        const abs = pos.AbsolutePosition;
        if (!abs) continue;
        topPx = abs.y * 10;
        heightPx = Math.max(heightPx, (pos.Size?.height || 0) * 10);
      }

      if (topPx === null) continue;

      const lastSystem = systems[systems.length - 1];
      if (lastSystem && Math.abs(lastSystem.topPx - topPx) < 1) {
        lastSystem.endMeasure = measureNumber;
        lastSystem.heightPx = Math.max(lastSystem.heightPx, heightPx);
      } else {
        systems.push({
          topPx,
          heightPx,
          startMeasure: measureNumber,
          endMeasure: measureNumber,
        });
      }
    }

    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];
      const next = systems[i + 1] || null;
      system.nextTopPx = next ? next.topPx : system.topPx;
      system.deltaToNextPx = next ? Math.max(0, next.topPx - system.topPx) : 0;
      if (!system.heightPx) {
        system.heightPx = next ? Math.max(60, next.topPx - system.topPx) : 120;
      }
    }

    this._systemLayouts = systems;
  }

  _setupCursor() {
    if (!this.osmd) return;
    try {
      this.osmd.cursor.show();
      this._cursorBeat = -1;
    } catch (e) {
      console.warn('OSMD cursor unavailable:', e);
    }
  }

  // Move OSMD cursor to the note at startBeat. Returns the cursor DOM element for scrolling.
  syncCursor(startBeat) {
    if (!this.osmd || this.scoreType !== 'musicxml') return null;
    try {
      const cursor = this.osmd.cursor;
      const targetTime = startBeat / 4; // beats → OSMD RealValue (whole notes)

      if (targetTime < this._cursorBeat || this._cursorBeat < 0) {
        cursor.reset();
        this._cursorBeat = cursor.iterator.CurrentSourceTimestamp.RealValue;
      }

      while (!cursor.iterator.EndReached) {
        const t = cursor.iterator.CurrentSourceTimestamp.RealValue;
        if (t >= targetTime) {
          this._cursorBeat = t;
          break;
        }
        cursor.next();
      }

      return cursor.cursorElement || null;
    } catch (e) {
      return null;
    }
  }
}
