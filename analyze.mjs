// Node.js pitch analysis script — reads raw float32 PCM, runs YIN, prints results
import { readFileSync } from 'fs';

const SAMPLE_RATE = 44100;
const CHUNK_SIZE = 4096;
const HOP_MS = 50;
const HOP_SAMPLES = Math.round(HOP_MS / 1000 * SAMPLE_RATE);

// --- YIN (same as pitch.js) ---
function yin(buffer, sampleRate, threshold = 0.15) {
  const halfLen = Math.floor(buffer.length / 2);
  const diff = new Float32Array(halfLen);
  for (let tau = 0; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }
  const cmndf = new Float32Array(halfLen);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfLen; tau++) {
    runningSum += diff[tau];
    cmndf[tau] = diff[tau] / (runningSum / tau);
  }
  let tauEstimate = -1;
  for (let tau = 2; tau < halfLen; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 < halfLen && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate === -1) return null;
  let betterTau = tauEstimate;
  if (tauEstimate > 0 && tauEstimate < halfLen - 1) {
    const s0 = cmndf[tauEstimate - 1];
    const s1 = cmndf[tauEstimate];
    const s2 = cmndf[tauEstimate + 1];
    const shift = (s2 - s0) / (2 * (2 * s1 - s2 - s0));
    if (isFinite(shift) && Math.abs(shift) < 1) betterTau = tauEstimate + shift;
  }
  const frequency = sampleRate / betterTau;
  const confidence = 1 - cmndf[tauEstimate];
  if (frequency < 60 || frequency > 1100) return null;
  return { frequency, confidence };
}

// Median smoothing over last 3 frames
const freqHistory = [];
function smooth(freq) {
  freqHistory.push(freq);
  if (freqHistory.length > 3) freqHistory.shift();
  const sorted = [...freqHistory].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function rms(buf) {
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

// Note name utilities
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function freqToMidi(f) { return Math.round(12 * Math.log2(f / 440) + 69); }
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function midiToName(m) { return NOTE_NAMES[m % 12] + Math.floor(m / 12 - 1); }
function centsDiff(f, ref) { return 1200 * Math.log2(f / ref); }

// Read raw PCM
const inputFile = process.argv[2] || 'haydn-slow50.raw';
const raw = readFileSync(inputFile);
const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

console.log(`Audio: ${(data.length / SAMPLE_RATE).toFixed(1)}s  chunks:${CHUNK_SIZE}  hop:${HOP_MS}ms\n`);
console.log('TIME    NOTE  FREQ      CONF  CENTS   RMS      FLAGS');
console.log('─'.repeat(65));

let prevMidi = null;
let flipCount = 0;
let detected = 0;
let missed = 0;

for (let offset = 0; offset + CHUNK_SIZE <= data.length; offset += HOP_SAMPLES) {
  const chunk = data.slice(offset, offset + CHUNK_SIZE);
  const level = rms(chunk);
  const timeSec = (offset / SAMPLE_RATE).toFixed(2);

  if (level < 0.005) {
    console.log(`${timeSec.padStart(6)}  (silence)  rms:${level.toFixed(4)}`);
    prevMidi = null;
    continue;
  }

  const raw = yin(chunk, SAMPLE_RATE);
  if (!raw) {
    missed++;
    freqHistory.length = 0;
    console.log(`${timeSec.padStart(6)}  ???   (no pitch)  rms:${level.toFixed(4)}`);
    continue;
  }

  const frequency = smooth(raw.frequency);
  const confidence = raw.confidence;
  const midi = freqToMidi(frequency);
  const name = midiToName(midi);
  const ref = midiToFreq(midi);
  const cents = centsDiff(frequency, ref);
  const centsStr = (cents >= 0 ? '+' : '') + cents.toFixed(1) + '¢';

  let flags = '';
  if (prevMidi !== null) {
    const interval = Math.abs(midi - prevMidi);
    if (interval === 12 || interval === 11 || interval === 13) {
      flags += ' ← OCTAVE FLIP';
      flipCount++;
    } else if (interval > 3) {
      flags += ` ← JUMP ${interval}st`;
    }
  }
  prevMidi = midi;
  detected++;

  console.log(
    `${timeSec.padStart(6)}  ${name.padEnd(3)}  ${frequency.toFixed(1).padStart(7)}Hz  ${confidence.toFixed(2)}  ${centsStr.padStart(7)}  rms:${level.toFixed(3)}${flags}`
  );
}

console.log('\n' + '─'.repeat(65));
console.log(`Detected: ${detected}  Missed: ${missed}  Octave flips: ${flipCount}  Flip rate: ${detected ? (100*flipCount/detected).toFixed(1) : 0}%`);
