// Mix original cello input + drone with 150ms simulated lag
import { readFileSync, writeFileSync } from 'fs';

const SAMPLE_RATE = 44100;
const LAG_MS = 50;
const LAG_SAMPLES = Math.round(LAG_MS / 1000 * SAMPLE_RATE);

// Read original cello (raw float32)
const rawInput = readFileSync('/Users/lsang/projects/playable/scale_cut.raw');
const inputF32 = new Float32Array(rawInput.buffer, rawInput.byteOffset, rawInput.byteLength / 4);

// Read drone WAV (skip 44-byte header, int16)
const droneWav = readFileSync('/Users/lsang/projects/playable/drone_output.wav');
const droneInt16 = new Int16Array(droneWav.buffer, droneWav.byteOffset + 44, (droneWav.byteLength - 44) / 2);
const droneF32 = new Float32Array(droneInt16.length);
for (let i = 0; i < droneInt16.length; i++) droneF32[i] = droneInt16[i] / 32767;

const totalSamples = Math.max(inputF32.length, LAG_SAMPLES + droneF32.length);
const out = new Float32Array(totalSamples);

// Original at 0.6 gain, drone (delayed) at 0.5 gain
for (let i = 0; i < inputF32.length; i++) out[i] += inputF32[i] * 0.6;
for (let i = 0; i < droneF32.length; i++) out[i + LAG_SAMPLES] += droneF32[i] * 0.5;

// Write stereo WAV: left = original, right = drone (makes it easier to hear both)
function writeWavStereo(left, right, sr, path) {
  const n = Math.max(left.length, right.length);
  const buf = Buffer.alloc(44 + n * 4); // 2 channels x 2 bytes
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(2, 22);       // stereo
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);  // byte rate
  buf.writeUInt16LE(4, 32);       // block align
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-32768, Math.min(32767, Math.round((left[i] || 0) * 32767)));
    const r = Math.max(-32768, Math.min(32767, Math.round((right[i] || 0) * 32767)));
    buf.writeInt16LE(l, 44 + i * 4);
    buf.writeInt16LE(r, 44 + i * 4 + 2);
  }
  writeFileSync(path, buf);
}

// Pad drone to same length as input (with lag offset)
const droneAligned = new Float32Array(totalSamples);
for (let i = 0; i < droneF32.length; i++) droneAligned[i + LAG_SAMPLES] = droneF32[i] * 0.5;
const inputAligned = new Float32Array(totalSamples);
for (let i = 0; i < inputF32.length; i++) inputAligned[i] = inputF32[i] * 0.6;

const outPath = '/Users/lsang/projects/playable/lag_demo.wav';
writeWavStereo(inputAligned, droneAligned, SAMPLE_RATE, outPath);
console.log(`Wrote ${outPath}`);
console.log(`Left channel: original cello`);
console.log(`Right channel: drone at ${LAG_MS}ms lag`);
