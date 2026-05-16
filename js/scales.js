// Scale and arpeggio generation for Scale Mode

import { noteNumberToFrequency, noteNumberToName } from './notemath.js';

// Display names for key buttons — dual names for accidentals
const NOTE_NAMES = ['C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B'];

// Single-name spellings for scale titles
export const SHARP_KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_KEY_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Scale/arpeggio types that conventionally use sharp key spelling
export const SHARP_PREF_TYPES = new Set(['Natural Minor', 'Harmonic Minor', 'Melodic Minor', 'Minor', 'Diminished 7th', 'Melodic Minor Broken Third']);

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

// Scale-degree offsets (0-based letter indices) for each arpeggio,
// so the spelling map assigns the correct letter to each interval.
export const ARPEGGIO_DEGREES = {
  'Major':          [0, 2, 4],
  'Minor':          [0, 2, 4],
  'Dominant 7th':   [0, 2, 4, 6],
  'Diminished 7th':      [0, 2, 4, 6],
  'Dominant 7th of ♭II': [0, 2, 4, 5],
  'Augmented':      [0, 2, 4],
  '♭VI6':      [0, 2, 5],
  'vi6':            [0, 2, 5],
  'IV6/4':          [0, 3, 5],
  'iv6/4':          [0, 3, 5],
  '4-3 Suspension': [0, 3, 4],
};

export const ARPEGGIO_TYPES = {
  'Major':          [0, 4, 7],
  'Minor':          [0, 3, 7],
  'Dominant 7th':   [0, 4, 7, 10],
  'Diminished 7th': [0, 3, 6, 9],
  'Dominant 7th of ♭II': [0, 3, 6, 8],
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
    step: null,  // explicit enharmonic override for chromatic notes
    alter: null,
  };
}

/**
 * Generate a scale or arpeggio for the given number of octaves (1–3).
 * Scales use 1-3-2 intro, ascending by octave, descending by octave, 1-3-2-1 ending.
 * Arpeggios go straight up and down.
 */
export function generateScaleNotes(keyIndex, typeName, isArpeggio, octaves = 3) {
  const root = rootMidi(keyIndex);

  if (!isArpeggio) {
    if (typeName === 'Chromatic') return generateChromatic(root, octaves);
    if (typeName === 'Major Broken Third')
      return generateBrokenThirds(root, SCALE_TYPES['Major'], SCALE_TYPES['Major'], octaves);
    if (typeName === 'Melodic Minor Broken Third') {
      const mel = SCALE_TYPES['Melodic Minor'];
      return generateBrokenThirds(root, mel.up, mel.down, octaves);
    }
  }

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
  if (octaves === 1) {
    const entries = [];
    // Ascending: 1-2-3-4-5-6-7-1
    for (const interval of upIntervals) {
      entries.push({ midi: root + interval, row: 0 });
    }
    entries.push({ midi: root + 12, row: 0 }); // top Do
    // Descending: 7-6-5-4-3-2 (stop before root)
    for (let i = downIntervals.length - 1; i >= 1; i--) {
      entries.push({ midi: root + downIntervals[i], row: 1 });
    }
    return entries.map((e, i) => makeNote(e.midi, root, i, e.row));
  }

  const entries = []; // { midi, row }
  let row = 0;

  // 1-3-2 intro (skipped for 1 and 4 octaves)
  if (octaves !== 1 && octaves !== 4) {
    entries.push({ midi: root + upIntervals[0], row });
    entries.push({ midi: root + upIntervals[2], row });
    entries.push({ midi: root + upIntervals[1], row });
  }

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
    const isLast = oct === 0;
    // For 2/4 octaves: drop the final root note from the last descending octave
    const stopAt = (isLast && (octaves === 2 || octaves === 4)) ? 1 : 0;
    for (let i = downIntervals.length - 1; i >= stopAt; i--) {
      entries.push({ midi: root + oct * 12 + downIntervals[i], row });
    }
  }

  // Ending: skip for 2/4 octaves; for 3 octaves end on 3-2 (drop final 1)
  if (octaves !== 2 && octaves !== 4) {
    row++;
    entries.push({ midi: root + downIntervals[2], row });
    entries.push({ midi: root + downIntervals[1], row });
    if (octaves !== 3) {
      entries.push({ midi: root + downIntervals[0], row });
    }
  }

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

  // Descending: one row per octave, drop final root to avoid double-play on loop
  for (let oct = octaves - 1; oct >= 0; oct--) {
    const octNotes = downIntervals.map(i => root + oct * 12 + i);
    octNotes.sort((a, b) => b - a);
    for (const midi of octNotes) {
      entries.push({ midi, row });
    }
    row++;
  }
  entries.pop(); // remove final root

  return entries.map((e, i) => makeNote(e.midi, root, i, e.row));
}

// Broken-thirds generator: ascending pairs (d, d+2), descending pairs (d, d+1)
function generateBrokenThirds(root, upIntervals, downIntervals, octaves) {
  const N = upIntervals.length; // 7

  function upMidi(absDeg) {
    return root + Math.floor(absDeg / N) * 12 + upIntervals[absDeg % N];
  }
  function downMidi(absDeg) {
    return root + Math.floor(absDeg / N) * 12 + downIntervals[absDeg % N];
  }

  const entries = [];

  // Ascending: N*octaves pairs (d, d+2), then top note
  for (let d = 0; d < octaves * N; d++) {
    const row = Math.floor(d / N) + 1;
    entries.push({ midi: upMidi(d), row });
    entries.push({ midi: upMidi(d + 2), row });
  }
  entries.push({ midi: root + octaves * 12, row: octaves });

  // Descending: pairs (d, d+1) from octaves*N-2 down to 1
  for (let d = octaves * N - 2; d >= 1; d--) {
    const row = octaves + (octaves - Math.floor(d / N));
    entries.push({ midi: downMidi(d), row });
    entries.push({ midi: downMidi(d + 1), row });
  }

  return entries.map((e, i) => makeNote(e.midi, root, i, e.row));
}

// Sharp spellings for ascending chromatic, flat for descending
const CHROMATIC_SHARP_STEPS  = ['C','C','D','D','E','F','F','G','G','A','A','B'];
const CHROMATIC_SHARP_ALTERS = [ 0,  1,  0,  1,  0,  0,  1,  0,  1,  0,  1,  0];
const CHROMATIC_FLAT_STEPS   = ['C','D','D','E','E','F','G','G','A','A','B','B'];
const CHROMATIC_FLAT_ALTERS  = [ 0, -1,  0, -1,  0,  0, -1,  0, -1,  0, -1,  0];

function generateChromatic(root, octaves) {
  const entries = [];

  // Ascending root → root+octaves*12 (inclusive), sharps
  for (let s = 0; s <= octaves * 12; s++) {
    const pc = s % 12;
    const row = Math.min(Math.floor(s / 12) + 1, octaves);
    const note = makeNote(root + s, root, entries.length, row);
    note.step  = CHROMATIC_SHARP_STEPS[pc];
    note.alter = CHROMATIC_SHARP_ALTERS[pc];
    entries.push(note);
  }

  // Descending root+octaves*12-1 → root+1 (exclusive top, ends on flat 2nd), flats
  for (let s = octaves * 12 - 1; s >= 1; s--) {
    const pc = s % 12;
    const row = octaves + (octaves - Math.floor(s / 12));
    const note = makeNote(root + s, root, entries.length, row);
    note.step  = CHROMATIC_FLAT_STEPS[pc];
    note.alter = CHROMATIC_FLAT_ALTERS[pc];
    entries.push(note);
  }

  return entries;
}

export { NOTE_NAMES };
