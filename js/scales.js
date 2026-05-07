// Scale and arpeggio generation for Scale Mode

import { noteNumberToFrequency, noteNumberToName } from './notemath.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Semitone-to-solfege mapping
const SOLFEGE = {
  0: 'Do', 1: 'Di', 2: 'Re', 3: 'Me', 4: 'Mi', 5: 'Fa',
  6: 'Fi', 7: 'Sol', 8: 'Le', 9: 'La', 10: 'Te', 11: 'Ti',
};

// Semitone intervals from root
export const SCALE_TYPES = {
  'Major':          [0, 2, 4, 5, 7, 9, 11],
  'Natural Minor':  [0, 2, 3, 5, 7, 8, 10],
  'Melodic Minor':  { up: [0, 2, 3, 5, 7, 9, 11], down: [0, 2, 3, 5, 7, 8, 10] },
  'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
};

export const ARPEGGIO_TYPES = {
  'Major':          [0, 4, 7],
  'Minor':          [0, 3, 7],
  'Dominant 7th':   [0, 4, 7, 10],
  'Diminished 7th': [0, 3, 6, 9],
  'Augmented':      [0, 4, 8],
  '\u266dVI6':      [0, 3, 8],
  'vi6':            [0, 4, 9],
  'IV6/4':          [0, 5, 9],
  'iv6/4':          [0, 5, 8],
  '4-3 Suspension': [0, 5, 7],
};

// Lowest MIDI note for each key in playable range (C2=36 .. B2=47)
function rootMidi(keyIndex) {
  return 36 + keyIndex;
}

function solfegeForInterval(semitones) {
  return SOLFEGE[((semitones % 12) + 12) % 12] || '?';
}

function makeNote(midi, rootMidiNote, beatIndex, row) {
  const interval = ((midi - rootMidiNote) % 12 + 12) % 12;
  return {
    midi,
    frequency: noteNumberToFrequency(midi),
    name: noteNumberToName(midi),
    solfege: solfegeForInterval(interval),
    row,
    measure: 1,
    startBeat: beatIndex,
    duration: 1,
  };
}

/**
 * Generate a scale or arpeggio for the given number of octaves (1–3).
 * Scales use 1-3-2 intro, ascending by octave, descending by octave, 1-3-2-1 ending.
 * Arpeggios go straight up and down.
 */
export function generateScaleNotes(keyIndex, typeName, isArpeggio, octaves = 3) {
  const root = rootMidi(keyIndex);
  const types = isArpeggio ? ARPEGGIO_TYPES : SCALE_TYPES;
  const pattern = types[typeName];
  if (!pattern) return [];

  const hasDirectional = pattern.up && pattern.down;
  const upIntervals = hasDirectional ? pattern.up : pattern;
  const downIntervals = hasDirectional ? pattern.down : pattern;

  if (isArpeggio) {
    return generateArpeggio(root, upIntervals, downIntervals, octaves);
  }
  return generateScale(root, upIntervals, downIntervals, octaves);
}

function generateScale(root, upIntervals, downIntervals, octaves) {
  const entries = []; // { midi, row }
  let row = 0;

  // Row 0: 1-3-2 intro
  entries.push({ midi: root + upIntervals[0], row });
  entries.push({ midi: root + upIntervals[2], row });
  entries.push({ midi: root + upIntervals[1], row });

  // Ascending octaves (all but last)
  for (let oct = 0; oct < octaves - 1; oct++) {
    row++;
    for (const interval of upIntervals) {
      entries.push({ midi: root + oct * 12 + interval, row });
    }
  }

  // Last ascending octave + top note
  row++;
  for (const interval of upIntervals) {
    entries.push({ midi: root + (octaves - 1) * 12 + interval, row });
  }
  entries.push({ midi: root + octaves * 12, row }); // top Do

  // Descending octaves
  for (let oct = octaves - 1; oct >= 0; oct--) {
    row++;
    for (let i = downIntervals.length - 1; i >= 0; i--) {
      entries.push({ midi: root + oct * 12 + downIntervals[i], row });
    }
  }

  // 3-2-1 ending
  row++;
  entries.push({ midi: root + downIntervals[2], row });
  entries.push({ midi: root + downIntervals[1], row });
  entries.push({ midi: root + downIntervals[0], row });

  return entries.map((e, i) => makeNote(e.midi, root, i, e.row));
}

function generateArpeggio(root, upIntervals, downIntervals, octaves) {
  const entries = [];
  let row = 0;

  // Ascending: one row per octave, top note on last ascending row
  for (let oct = 0; oct < octaves; oct++) {
    for (const interval of upIntervals) {
      entries.push({ midi: root + oct * 12 + interval, row });
    }
    if (oct === octaves - 1) {
      entries.push({ midi: root + octaves * 12, row }); // top note
    }
    row++;
  }

  // Descending: one row per octave
  for (let oct = octaves - 1; oct >= 0; oct--) {
    const octNotes = downIntervals.map(i => root + oct * 12 + i);
    octNotes.sort((a, b) => b - a);
    for (const midi of octNotes) {
      entries.push({ midi, row });
    }
    row++;
  }

  return entries.map((e, i) => makeNote(e.midi, root, i, e.row));
}

export { NOTE_NAMES };
