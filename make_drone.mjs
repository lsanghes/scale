// Reads scale_cut.raw, detects notes, synthesizes a drone WAV
import { readFileSync, writeFileSync } from 'fs';

const SAMPLE_RATE = 44100;
const CHUNK_SIZE  = 4096;
const HOP_SAMPLES = Math.round(0.05 * SAMPLE_RATE); // 50ms hop

// --- YIN (same as pitch.js) ---
function yin(buffer, threshold = 0.15) {
  const halfLen = Math.floor(buffer.length / 2);
  const diff = new Float32Array(halfLen);
  for (let tau = 0; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const d = buffer[i] - buffer[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }
  const cmndf = new Float32Array(halfLen);
  cmndf[0] = 1;
  let rs = 0;
  for (let tau = 1; tau < halfLen; tau++) {
    rs += diff[tau];
    cmndf[tau] = diff[tau] / (rs / tau);
  }
  let tau0 = -1;
  for (let tau = 2; tau < halfLen; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 < halfLen && cmndf[tau + 1] < cmndf[tau]) tau++;
      tau0 = tau;
      break;
    }
  }
  if (tau0 === -1) return null;
  let bt = tau0;
  if (tau0 > 0 && tau0 < halfLen - 1) {
    const s0 = cmndf[tau0 - 1], s1 = cmndf[tau0], s2 = cmndf[tau0 + 1];
    const sh = (s2 - s0) / (2 * (2 * s1 - s2 - s0));
    if (isFinite(sh) && Math.abs(sh) < 1) bt = tau0 + sh;
  }
  const freq = SAMPLE_RATE / bt;
  if (freq < 60 || freq > 1100) return null;
  return { freq, conf: 1 - cmndf[tau0] };
}

function rms(buf) {
  let s = 0; for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

// --- Detect note segments ---
const raw = readFileSync('/Users/lsang/projects/playable/scale_cut.raw');
const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

// Median smoother
const hist = [];
function smooth(f) {
  hist.push(f); if (hist.length > 3) hist.shift();
  return [...hist].sort((a, b) => a - b)[Math.floor(hist.length / 2)];
}

// Quantise freq to nearest MIDI note
function freqToMidi(f) { return Math.round(12 * Math.log2(f / 440) + 69); }
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function midiToName(m) { return NAMES[m % 12] + (Math.floor(m / 12) - 1); }

// Collect per-hop detections
const hops = [];
for (let off = 0; off + CHUNK_SIZE <= data.length; off += HOP_SAMPLES) {
  const chunk = data.slice(off, off + CHUNK_SIZE);
  const level = rms(chunk);
  if (level < 0.005) { hist.length = 0; hops.push(null); continue; }
  const r = yin(chunk);
  if (!r || r.conf < 0.85) { hops.push(null); continue; }
  hops.push(smooth(r.freq));
}

// Group consecutive hops with same MIDI note into segments
const segments = []; // { midi, freq, startSample, endSample }
let segMidi = null, segStart = 0;
for (let i = 0; i <= hops.length; i++) {
  const midi = (hops[i] != null) ? freqToMidi(hops[i]) : null;
  if (midi !== segMidi) {
    if (segMidi !== null) {
      segments.push({
        midi: segMidi,
        freq: midiToFreq(segMidi),
        name: midiToName(segMidi),
        startSample: segStart * HOP_SAMPLES,
        endSample:   i * HOP_SAMPLES,
      });
    }
    segMidi = midi;
    segStart = i;
  }
}

// Filter out very short segments (< 150ms)
const MIN_SAMPLES = Math.round(0.15 * SAMPLE_RATE);
const noteSegs = segments.filter(s => (s.endSample - s.startSample) >= MIN_SAMPLES);

console.log('Detected note segments:');
for (const s of noteSegs) {
  const dur = ((s.endSample - s.startSample) / SAMPLE_RATE).toFixed(2);
  console.log(`  ${s.name.padEnd(4)} ${s.freq.toFixed(1).padStart(7)}Hz  ${dur}s`);
}

// --- Synthesize drone WAV ---
// Harmonics matching audio.js
const PARTIALS = [
  { ratio: 1, gain: 0.50 },
  { ratio: 2, gain: 0.28 },
  { ratio: 3, gain: 0.14 },
  { ratio: 4, gain: 0.08 },
  { ratio: 5, gain: 0.04 },
  { ratio: 6, gain: 0.02 },
];
const MASTER_GAIN = 0.6;
const FADE = Math.round(0.03 * SAMPLE_RATE); // 30ms fade

const totalSamples = noteSegs.length > 0
  ? noteSegs[noteSegs.length - 1].endSample
  : 0;

const out = new Float32Array(totalSamples);

for (const seg of noteSegs) {
  const len = seg.endSample - seg.startSample;
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;
    for (const { ratio, gain } of PARTIALS) {
      sample += gain * Math.sin(2 * Math.PI * seg.freq * ratio * t);
    }
    // Fade in / fade out
    let env = 1;
    if (i < FADE) env = i / FADE;
    else if (i > len - FADE) env = (len - i) / FADE;
    out[seg.startSample + i] += sample * env * MASTER_GAIN;
  }
}

// --- Write WAV ---
function writeWav(samples, sampleRate, path) {
  const numSamples = samples.length;
  const buf = Buffer.alloc(44 + numSamples * 2);
  const int16 = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  }
  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + numSamples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);       // chunk size
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(numSamples * 2, 40);
  for (let i = 0; i < numSamples; i++) {
    buf.writeInt16LE(int16[i], 44 + i * 2);
  }
  writeFileSync(path, buf);
}

const outPath = '/Users/lsang/projects/playable/drone_output.wav';
writeWav(out, SAMPLE_RATE, outPath);
console.log(`\nWrote ${outPath}  (${(totalSamples / SAMPLE_RATE).toFixed(1)}s)`);
