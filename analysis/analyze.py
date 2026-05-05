#!/usr/bin/env python3
"""
Pitch analysis script — ports the YIN algorithm from js/pitch.js.
Usage: python3 analyze.py [input.wav] [--start 32] [--duration 60]
"""

import wave
import struct
import math
import sys
import argparse
import numpy as np

# ── note math (mirrors js/notemath.js) ────────────────────────────────────────

def frequency_to_note_number(freq):
    return 69 + 12 * math.log2(freq / 440.0)

def note_number_to_frequency(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)

def note_number_to_name(midi):
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    return names[midi % 12] + str(midi // 12 - 1)

def nearest_note_number(freq):
    return round(frequency_to_note_number(freq))

def cents_difference(freq, ref_freq):
    return 1200 * math.log2(freq / ref_freq)

# ── YIN pitch detection ───────────────────────────────────────────────────────

def yin_numpy(buf, sr, threshold=0.18):
    half = len(buf) // 2

    # Difference function (vectorized)
    diff = np.zeros(half)
    for tau in range(1, half):
        d = buf[:half] - buf[tau:tau + half]
        diff[tau] = np.dot(d, d)

    # Cumulative mean normalized difference
    cmndf = np.zeros(half)
    cmndf[0] = 1.0
    running = 0.0
    for tau in range(1, half):
        running += diff[tau]
        cmndf[tau] = diff[tau] / (running / tau)

    # Absolute threshold — first local minimum below threshold
    tau_estimate = -1
    for tau in range(2, half):
        if cmndf[tau] < threshold:
            while tau + 1 < half and cmndf[tau + 1] < cmndf[tau]:
                tau += 1
            tau_estimate = tau
            break

    if tau_estimate == -1:
        return None

    # Parabolic interpolation
    better_tau = float(tau_estimate)
    if 0 < tau_estimate < half - 1:
        s0, s1, s2 = cmndf[tau_estimate - 1], cmndf[tau_estimate], cmndf[tau_estimate + 1]
        denom = 2 * (2 * s1 - s2 - s0)
        if denom != 0:
            shift = (s2 - s0) / denom
            if math.isfinite(shift) and abs(shift) < 1:
                better_tau = tau_estimate + shift

    freq = sr / better_tau
    confidence = 1 - cmndf[tau_estimate]

    # String instruments: C2 (65 Hz) to ~C6 (1047 Hz)
    if freq < 60 or freq > 1100:
        return None

    return freq, confidence


def octave_corrected(freq, prev_freq, history_midi):
    """
    Suppress octave jumps: if the detected freq is exactly an octave away
    from the recent history, return the octave-corrected version instead.
    Uses a 7-frame majority vote on the MIDI pitch class + octave.
    """
    if prev_freq is None or not history_midi:
        return freq

    midi_det = frequency_to_note_number(freq)
    midi_prev = frequency_to_note_number(prev_freq)

    # If within one octave of the previous, accept as-is
    if abs(midi_det - midi_prev) < 13:
        return freq

    # If exactly ~1 or ~2 octaves away, try snapping to the more common octave
    for octave_shift in [-1, 1, -2, 2]:
        candidate = freq * (2 ** octave_shift)
        if 60 <= candidate <= 1100:
            midi_cand = frequency_to_note_number(candidate)
            if abs(midi_cand - midi_prev) < 13:
                # Prefer the candidate that agrees with the recent history median
                hist_median = sorted(history_midi)[len(history_midi) // 2]
                if abs(midi_cand - hist_median) < abs(midi_det - hist_median):
                    return candidate
    return freq


# ── WAV reader ────────────────────────────────────────────────────────────────

def read_wav_mono(path, start_sec=0, duration_sec=None):
    with wave.open(path, 'rb') as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        frame_rate = wf.getframerate()
        n_frames = wf.getnframes()

        start_frame = int(start_sec * frame_rate)
        n_read = int(duration_sec * frame_rate) if duration_sec else n_frames - start_frame

        wf.setpos(start_frame)
        raw = wf.readframes(n_read)

    if sampwidth == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported sample width: {sampwidth}")

    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)

    return samples, frame_rate


# ── Gap filling ───────────────────────────────────────────────────────────────

def fill_gaps(results, max_gap_sec=0.4):
    """
    Fill short gaps between detections with interpolated frequency.
    Gaps shorter than max_gap_sec and surrounded by the same note get filled.
    """
    if len(results) < 2:
        return results

    filled = [results[0]]
    hop = 0.02  # must match hop used in main

    for i in range(1, len(results)):
        t_prev, f_prev, *rest_prev = filled[-1]
        t_curr, f_curr, *rest_curr = results[i]
        gap = t_curr - t_prev

        if 0 < gap <= max_gap_sec:
            # Check if surrounding notes are close enough to interpolate
            midi_prev = nearest_note_number(f_prev)
            midi_curr = nearest_note_number(f_curr)
            if abs(midi_prev - midi_curr) <= 2:  # same or adjacent note
                n_fill = round(gap / hop) - 1
                for k in range(1, n_fill + 1):
                    alpha = k / (n_fill + 1)
                    f_interp = f_prev * (1 - alpha) + f_curr * alpha
                    t_interp = t_prev + k * hop
                    filled.append((t_interp, f_interp) + tuple(rest_prev))

        filled.append(results[i])

    return filled


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="YIN pitch analysis on a WAV file")
    parser.add_argument("wav", nargs="?", default="input.wav")
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--hop", type=float, default=0.02,   help="Hop size in seconds (default: 0.02)")
    parser.add_argument("--window", type=int, default=4096,  help="Window size in samples (default: 4096)")
    parser.add_argument("--confidence", type=float, default=0.66, help="Min confidence (default: 0.66)")
    parser.add_argument("--rms", type=float, default=0.002,  help="RMS gate (default: 0.002)")
    parser.add_argument("--yin-threshold", type=float, default=0.27, help="YIN CMNDF threshold (default: 0.27)")
    parser.add_argument("--no-gap-fill", action="store_true")
    args = parser.parse_args()

    print(f"Loading {args.wav} (start={args.start}s, duration={args.duration}s)...")
    samples, sr = read_wav_mono(args.wav, args.start, args.duration)
    total_sec = len(samples) / sr
    print(f"Loaded {total_sec:.1f}s at {sr} Hz\n")

    hop_samples = int(args.hop * sr)
    window = args.window
    history_freq = []   # last N raw frequencies (for median)
    history_midi = []   # last N midi values (for octave correction)
    prev_freq = None
    results = []

    n_frames = (len(samples) - window) // hop_samples
    for frame_idx in range(n_frames):
        offset = frame_idx * hop_samples
        buf = samples[offset:offset + window]

        rms = math.sqrt(float(np.dot(buf, buf)) / len(buf))
        if rms < args.rms:
            history_freq.clear()
            history_midi.clear()
            continue

        det = yin_numpy(buf, sr, threshold=args.yin_threshold)
        if det is None:
            history_freq.clear()
            history_midi.clear()
            continue

        freq, conf = det
        if conf < args.confidence:
            continue

        # Octave correction before history update
        freq = octave_corrected(freq, prev_freq, history_midi)

        # Median smoothing over last 5 detections
        history_freq.append(freq)
        if len(history_freq) > 5:
            history_freq.pop(0)
        smoothed = sorted(history_freq)[len(history_freq) // 2]

        midi = nearest_note_number(smoothed)
        history_midi.append(midi)
        if len(history_midi) > 7:
            history_midi.pop(0)

        name = note_number_to_name(midi)
        ref_freq = note_number_to_frequency(midi)
        cents = cents_difference(smoothed, ref_freq)
        t = args.start + offset / sr

        results.append((t, smoothed, name, cents, conf))
        prev_freq = smoothed

    print(f"Raw detections: {len(results)} frames")

    # Gap filling
    if not args.no_gap_fill:
        # Pack for filling (use 5-tuple, strip to 2 for fill then repack)
        raw2 = [(r[0], r[1], r[2], r[3], r[4]) for r in results]
        filled = fill_gaps(raw2, max_gap_sec=0.4)
        # Re-derive note/cents for filled frames
        refilled = []
        for entry in filled:
            t, freq = entry[0], entry[1]
            midi = nearest_note_number(freq)
            name = note_number_to_name(midi)
            ref_freq = note_number_to_frequency(midi)
            cents = cents_difference(freq, ref_freq)
            conf = entry[4] if len(entry) > 4 else 0.0
            refilled.append((t, freq, name, cents, conf))
        results = refilled
        print(f"After gap fill:  {len(results)} frames")

    if not results:
        print("No pitched notes detected.")
        return

    # Print results
    print(f"\n{'Time':>8}  {'Freq':>8}  {'Note':>5}  {'Cents':>7}  {'Conf':>5}")
    print("-" * 46)
    prev_note = None
    for t, freq, name, cents, conf in results:
        marker = " <-- changed" if name != prev_note else ""
        sign = "+" if cents >= 0 else ""
        conf_str = f"{conf:.0%}" if conf > 0 else "  (fill)"
        print(f"{t:>7.2f}s  {freq:>7.1f}Hz  {name:>5}  {sign}{cents:>6.1f}¢  {conf_str:>5}{marker}")
        prev_note = name

    # Summary
    print(f"\n{'='*46}")
    print(f"Total frames: {len(results)}")
    from collections import Counter
    note_counts = Counter(name for _, _, name, _, _ in results)
    print("Most common notes:")
    for note, count in note_counts.most_common(10):
        bar = "#" * (count * 30 // max(note_counts.values()))
        print(f"  {note:>5}: {bar} ({count})")
    avg_cents = sum(abs(c) for _, _, _, c, _ in results) / len(results)
    print(f"\nAverage deviation: {avg_cents:.1f}¢")


if __name__ == "__main__":
    main()
