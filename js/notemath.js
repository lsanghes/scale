// Note math utilities for frequency/note conversion

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const A4_FREQ = 440;
const A4_MIDI = 69;

export function frequencyToNoteNumber(freq) {
  return 12 * Math.log2(freq / A4_FREQ) + A4_MIDI;
}

export function noteNumberToFrequency(noteNum) {
  return A4_FREQ * Math.pow(2, (noteNum - A4_MIDI) / 12);
}

export function noteNumberToName(noteNum) {
  const n = Math.round(noteNum);
  const octave = Math.floor(n / 12) - 1;
  const noteIndex = ((n % 12) + 12) % 12;
  return NOTE_NAMES[noteIndex] + octave;
}

export function centsDifference(detectedFreq, targetFreq) {
  return 1200 * Math.log2(detectedFreq / targetFreq);
}

export function nearestNoteNumber(freq) {
  return Math.round(frequencyToNoteNumber(freq));
}

export function nearestNoteFrequency(freq) {
  return noteNumberToFrequency(nearestNoteNumber(freq));
}

export function midiToNoteName(midi) {
  return noteNumberToName(midi);
}
