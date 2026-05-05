#!/usr/bin/env python3
"""
Synthesizes a drone audio file from full_analysis.txt.
Mirrors the harmonic partials and lowpass filter in js/audio.js startDrone().
"""

import re
import math
import struct
import wave
import numpy as np

# ── Partials from audio.js ────────────────────────────────────────────────────
PARTIALS = [
    (1, 0.50),
    (2, 0.28),
    (3, 0.14),
    (4, 0.08),
    (5, 0.04),
    (6, 0.02),
]

SAMPLE_RATE = 44100
MASTER_GAIN = 0.18  # matches audio.js startDrone masterGain
CROSSFADE_SEC = 0.08  # fade duration on note change

# ── Parse analysis output ─────────────────────────────────────────────────────

def parse_analysis(path):
    """Return list of (time_sec, freq_hz) for every detected frame."""
    entries = []
    pattern = re.compile(r'^\s*(\d+\.\d+)s\s+([\d.]+)Hz')
    with open(path) as f:
        for line in f:
            m = pattern.match(line)
            if m:
                t = float(m.group(1))
                freq = float(m.group(2))
                entries.append((t, freq))
    return entries

# ── Simple 1-pole IIR lowpass (approximates biquad lowpass at 3200 Hz) ────────

def lowpass_filter(signal, cutoff_hz, sr):
    rc = 1.0 / (2 * math.pi * cutoff_hz)
    dt = 1.0 / sr
    alpha = dt / (rc + dt)
    out = np.zeros_like(signal)
    prev = 0.0
    for i in range(len(signal)):
        prev = prev + alpha * (signal[i] - prev)
        out[i] = prev
    return out

# ── Synthesize ────────────────────────────────────────────────────────────────

def synthesize(entries, total_sec, sr=SAMPLE_RATE):
    n_samples = int(total_sec * sr)
    output = np.zeros(n_samples, dtype=np.float64)

    # Build per-frame frequency array (fill gaps with silence = 0)
    freq_timeline = np.zeros(n_samples)
    for i, (t, freq) in enumerate(entries):
        start = int(t * sr)
        end = int(entries[i + 1][0] * sr) if i + 1 < len(entries) else n_samples
        freq_timeline[start:end] = freq

    # Synthesize sample-by-sample using accumulated phase per partial
    phases = [0.0] * len(PARTIALS)
    crossfade_len = int(CROSSFADE_SEC * sr)
    prev_freq = 0.0
    gain_env = np.zeros(n_samples)

    # Build gain envelope: fade in when pitch appears, fade out when it disappears
    in_note = False
    fade_pos = 0
    for i in range(n_samples):
        freq = freq_timeline[i]
        if freq > 0 and not in_note:
            in_note = True
            fade_pos = i
        elif freq == 0 and in_note:
            in_note = False
            fade_pos = i

        if freq > 0:
            fade_in = min(1.0, (i - fade_pos) / crossfade_len) if in_note else 0.0
            gain_env[i] = MASTER_GAIN * fade_in
        else:
            fade_out = max(0.0, 1.0 - (i - fade_pos) / crossfade_len) if not in_note else 0.0
            gain_env[i] = MASTER_GAIN * fade_out

    # Vectorized synthesis: accumulate phase chunk by chunk
    chunk = 4096
    for start in range(0, n_samples, chunk):
        end = min(start + chunk, n_samples)
        freqs = freq_timeline[start:end]
        sig = np.zeros(end - start)
        for ratio, gain in PARTIALS:
            # instantaneous phase increments
            dphi = 2 * math.pi * ratio * freqs / sr
            for j, dp in enumerate(dphi):
                phases_idx = PARTIALS.index((ratio, gain))
                phases[phases_idx] = (phases[phases_idx] + dp) % (2 * math.pi)
                sig[j] += gain * math.sin(phases[phases_idx])
        output[start:end] = sig * gain_env[start:end]

    return output

def synthesize_fast(entries, total_sec, sr=SAMPLE_RATE):
    """Vectorized synthesis — much faster than sample-by-sample."""
    n = int(total_sec * sr)
    freq_timeline = np.zeros(n)

    for i, (t, freq) in enumerate(entries):
        s = int(t * sr)
        e = int(entries[i + 1][0] * sr) if i + 1 < len(entries) else n
        freq_timeline[s:min(e, n)] = freq

    # Gain envelope
    crossfade = int(CROSSFADE_SEC * sr)
    active = (freq_timeline > 0).astype(np.float64)
    # Smooth transitions with a short ramp
    kernel = np.ones(crossfade) / crossfade
    gain_env = np.convolve(active, kernel, mode='same')
    gain_env = np.clip(gain_env, 0, 1) * MASTER_GAIN

    # Accumulate phase per partial
    output = np.zeros(n)
    for ratio, partial_gain in PARTIALS:
        dphi = 2 * np.pi * ratio * freq_timeline / sr
        phase = np.cumsum(dphi)
        output += partial_gain * np.sin(phase)

    output *= gain_env

    # Lowpass filter (approximate biquad at 3200 Hz with 1-pole IIR)
    rc = 1.0 / (2 * math.pi * 3200)
    dt = 1.0 / sr
    alpha = dt / (rc + dt)
    filtered = np.zeros_like(output)
    prev = 0.0
    # Vectorized IIR via loop (unavoidable for causal filter)
    for i in range(len(output)):
        prev += alpha * (output[i] - prev)
        filtered[i] = prev

    return filtered

# ── Write WAV ─────────────────────────────────────────────────────────────────

def write_wav(path, samples, sr=SAMPLE_RATE):
    peak = np.max(np.abs(samples))
    if peak > 0:
        samples = samples / peak * 0.9  # normalize to -0.9 peak
    int_samples = (samples * 32767).astype(np.int16)
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(int_samples.tobytes())
    print(f"Written: {path}  ({len(samples)/sr:.1f}s, {len(samples)} samples)")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    import sys
    analysis_file = sys.argv[1] if len(sys.argv) > 1 else "full_analysis.txt"
    output_file = sys.argv[2] if len(sys.argv) > 2 else "drone_output.wav"

    print(f"Parsing {analysis_file}...")
    entries = parse_analysis(analysis_file)
    if not entries:
        print("No entries found.")
        return

    total_sec = entries[-1][0] + 0.5  # a bit of tail
    print(f"  {len(entries)} frames, {total_sec:.1f}s total")

    print("Synthesizing drone audio...")
    samples = synthesize_fast(entries, total_sec)

    print(f"Saving {output_file}...")
    write_wav(output_file, samples)
    print("Done.")

if __name__ == "__main__":
    main()
