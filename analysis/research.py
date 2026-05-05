#!/usr/bin/env python3
"""
Parameter research for YIN pitch detection.

Sweeps parameters, scores each combo on proxy quality metrics
(no ground truth needed), then fits a linear model to find the
optimal operating point.

Usage:
    python3 research.py                          # run full sweep
    python3 research.py --quick                  # fast sweep (fewer combos)
    python3 research.py --refine                 # refine around current best
"""

import wave
import math
import argparse
import itertools
import json
import os
import sys
import time
from dataclasses import dataclass, field, asdict

import numpy as np

# ── note math ────────────────────────────────────────────────────────────────

A4 = 440.0

def freq_to_midi(f):
    return 69 + 12 * math.log2(f / A4)

def midi_to_freq(m):
    return A4 * 2 ** ((m - 69) / 12)

def nearest_midi(f):
    return round(freq_to_midi(f))

# ── YIN (FFT-accelerated) ────────────────────────────────────────────────────

def yin(buf, sr, threshold):
    """YIN pitch detection using FFT cross-correlation — O(n log n)."""
    n = len(buf)
    half = n // 2

    # FFT size: next power of 2 >= n, doubled for zero-pad (linear correlation)
    fft_size = 1
    while fft_size < n:
        fft_size <<= 1
    fft_size <<= 1

    # Cross-correlate buf[0:half] with buf[0:n] to get:
    #   r(tau) = sum_{i=0}^{half-1} buf[i] * buf[i+tau]
    a = np.zeros(fft_size)
    a[:half] = buf[:half]
    b = np.zeros(fft_size)
    b[:n] = buf[:n]
    fft_a = np.fft.rfft(a)
    fft_b = np.fft.rfft(b)
    r = np.fft.irfft(np.conj(fft_a) * fft_b, fft_size)[:half]

    # Energy terms for the difference function:
    #   d(tau) = E_0 + E_tau - 2*r(tau)
    buf_sq = buf * buf
    cum = np.cumsum(buf_sq)
    e0 = cum[half - 1]  # sum of buf[0..half-1]^2
    # E_tau = sum of buf[tau..tau+half-1]^2 for tau=1..half-1
    e_shifted = cum[half:2 * half - 1] - cum[:half - 1]

    diff = np.empty(half)
    diff[0] = 0.0
    diff[1:] = e0 + e_shifted - 2 * r[1:half]
    # Clamp negatives from floating-point error
    np.maximum(diff, 0.0, out=diff)

    # Cumulative mean normalized difference
    cmndf = np.empty(half)
    cmndf[0] = 1.0
    cs = np.cumsum(diff[1:])
    taus = np.arange(1, half, dtype=np.float64)
    cmndf[1:] = np.where(cs > 0, diff[1:] / (cs / taus), 1.0)

    # Absolute threshold — first local minimum below threshold
    tau_est = -1
    for tau in range(2, half):
        if cmndf[tau] < threshold:
            while tau + 1 < half and cmndf[tau + 1] < cmndf[tau]:
                tau += 1
            tau_est = tau
            break

    if tau_est == -1:
        return None

    better_tau = float(tau_est)
    if 0 < tau_est < half - 1:
        s0, s1, s2 = cmndf[tau_est - 1], cmndf[tau_est], cmndf[tau_est + 1]
        denom = 2 * (2 * s1 - s2 - s0)
        if denom != 0:
            shift = (s2 - s0) / denom
            if math.isfinite(shift) and abs(shift) < 1:
                better_tau = tau_est + shift

    freq = sr / better_tau
    conf = 1 - cmndf[tau_est]
    if freq < 60 or freq > 1100:
        return None
    return freq, conf

# ── WAV loader ───────────────────────────────────────────────────────────────

def load_wav(path, duration=None):
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = int(duration * sr) if duration else wf.getnframes()
        raw = wf.readframes(n)
        sw = wf.getsampwidth()
        nc = wf.getnchannels()
    if sw == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported sample width: {sw}")
    if nc > 1:
        samples = samples.reshape(-1, nc).mean(axis=1)
    return samples, sr

# ── Run one parameter set ────────────────────────────────────────────────────

@dataclass
class Params:
    yin_threshold: float = 0.20
    rms_gate: float = 0.005
    conf_threshold: float = 0.78
    median_window: int = 3
    octave_history: int = 7
    miss_tolerance: int = 5
    window_size: int = 4096
    hop_sec: float = 0.02

@dataclass
class Metrics:
    detection_rate: float = 0.0      # fraction of pitched frames detected
    octave_flip_rate: float = 0.0    # fraction of detections that are octave errors
    note_change_rate: float = 0.0    # note changes per second of detected audio
    jitter_cents: float = 0.0        # median frame-to-frame pitch jitter in cents
    gap_count: int = 0               # number of gaps > 100ms
    mean_gap_sec: float = 0.0        # average gap length
    avg_deviation: float = 0.0       # average cents deviation from nearest ET note
    total_detected: int = 0
    total_missed: int = 0
    total_flips: int = 0


def run_analysis(samples, sr, p: Params) -> Metrics:
    hop = int(p.hop_sec * sr)
    n_frames = (len(samples) - p.window_size) // hop

    prev_freq = None
    prev_midi = None
    midi_history = []
    freq_history = []
    miss_count = 0

    detected = 0
    missed = 0
    octave_flips = 0
    note_changes = 0
    jitters = []
    deviations = []
    gaps = []
    gap_start = None
    last_detect_time = None

    for i in range(n_frames):
        offset = i * hop
        buf = samples[offset:offset + p.window_size]
        t = offset / sr

        rms = math.sqrt(float(np.dot(buf, buf)) / len(buf))
        if rms < p.rms_gate:
            miss_count += 1
            if miss_count > p.miss_tolerance:
                freq_history.clear()
                midi_history.clear()
                prev_freq = None
            if gap_start is None and last_detect_time is not None:
                gap_start = t
            continue

        det = yin(buf, sr, p.yin_threshold)
        if det is None:
            missed += 1
            miss_count += 1
            if miss_count > p.miss_tolerance:
                freq_history.clear()
                midi_history.clear()
                prev_freq = None
            if gap_start is None and last_detect_time is not None:
                gap_start = t
            continue

        freq, conf = det
        if conf < p.conf_threshold:
            missed += 1
            continue

        miss_count = 0

        # Close any open gap
        if gap_start is not None:
            gaps.append(t - gap_start)
            gap_start = None

        # Octave correction
        if prev_freq and len(midi_history) >= 3:
            midi_det = freq_to_midi(freq)
            midi_prev = freq_to_midi(prev_freq)
            if abs(midi_det - midi_prev) >= 11:
                hist_sorted = sorted(midi_history)
                hist_median = hist_sorted[len(hist_sorted) // 2]
                best = freq
                best_dist = abs(midi_det - hist_median)
                for shift in [-1, 1, -2, 2]:
                    candidate = freq * (2 ** shift)
                    if candidate < 60 or candidate > 1100:
                        continue
                    midi_cand = freq_to_midi(candidate)
                    dist = abs(midi_cand - hist_median)
                    if dist < best_dist and abs(midi_cand - midi_prev) < 11:
                        best = candidate
                        best_dist = dist
                freq = best

        # Median smoothing
        freq_history.append(freq)
        if len(freq_history) > p.median_window:
            freq_history.pop(0)
        smoothed = sorted(freq_history)[len(freq_history) // 2]

        midi = nearest_midi(smoothed)
        midi_history.append(midi)
        if len(midi_history) > p.octave_history:
            midi_history.pop(0)

        # Metrics
        detected += 1
        ref = midi_to_freq(midi)
        dev = abs(1200 * math.log2(smoothed / ref))
        deviations.append(dev)

        if prev_freq:
            jitter = abs(1200 * math.log2(smoothed / prev_freq))
            jitters.append(jitter)

        if prev_midi is not None:
            interval = abs(midi - prev_midi)
            if 11 <= interval <= 13:
                octave_flips += 1
            if midi != prev_midi:
                note_changes += 1

        prev_midi = midi
        prev_freq = smoothed
        last_detect_time = t

    total_frames = detected + missed
    duration_sec = n_frames * p.hop_sec
    long_gaps = [g for g in gaps if g > 0.1]

    m = Metrics()
    m.total_detected = detected
    m.total_missed = missed
    m.total_flips = octave_flips
    m.detection_rate = detected / max(1, total_frames)
    m.octave_flip_rate = octave_flips / max(1, detected)
    m.note_change_rate = note_changes / max(0.01, duration_sec)
    m.jitter_cents = float(np.median(jitters)) if jitters else 0.0
    m.gap_count = len(long_gaps)
    m.mean_gap_sec = float(np.mean(long_gaps)) if long_gaps else 0.0
    m.avg_deviation = float(np.mean(deviations)) if deviations else 0.0
    return m


def score(m: Metrics) -> float:
    """
    Composite quality score (higher = better).

    Weights tuned for intonation practice:
    - Detection rate matters most (you can't practice what you can't detect)
    - Octave flips are very disruptive
    - Jitter and gaps hurt usability
    - Note change rate penalizes instability (spurious note changes)
    """
    s = 0.0
    s += 40.0 * m.detection_rate                         # 0-40: detection rate
    s -= 20.0 * m.octave_flip_rate                       # penalty for flips
    s -= 0.5 * min(m.gap_count, 60)                      # penalty per gap (capped)
    s -= 0.3 * min(m.jitter_cents, 50)                   # penalty for jitter
    s -= 0.05 * max(0, m.note_change_rate - 2.0)         # penalty for excessive changes
    s -= 0.1 * min(m.avg_deviation, 30)                  # penalty for poor tuning accuracy
    return s

# ── Parameter grid ───────────────────────────────────────────────────────────

def make_grid(mode='full'):
    if mode == 'quick':
        return {
            'yin_threshold': [0.12, 0.15, 0.18, 0.20, 0.25],
            'rms_gate':      [0.003, 0.005, 0.008, 0.012],
            'conf_threshold': [0.72, 0.78, 0.82, 0.88],
            'median_window':  [3, 5],
        }
    elif mode == 'full':
        return {
            'yin_threshold': [0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.25, 0.28],
            'rms_gate':      [0.002, 0.003, 0.005, 0.008, 0.010, 0.015],
            'conf_threshold': [0.70, 0.74, 0.78, 0.82, 0.85, 0.90],
            'median_window':  [3, 5, 7],
        }
    else:
        return {}  # filled by refine()

def make_refine_grid(best_params):
    """Generate a fine grid around the current best."""
    bp = best_params
    def neighbourhood(val, step, lo, hi, n=5):
        return sorted(set(
            round(max(lo, min(hi, val + step * i)), 6)
            for i in range(-n//2, n//2 + 1)
        ))
    return {
        'yin_threshold':  neighbourhood(bp['yin_threshold'], 0.01, 0.08, 0.35),
        'rms_gate':       neighbourhood(bp['rms_gate'], 0.001, 0.001, 0.02),
        'conf_threshold': neighbourhood(bp['conf_threshold'], 0.02, 0.60, 0.95),
        'median_window':  [max(1, bp['median_window'] - 1),
                           bp['median_window'],
                           bp['median_window'] + 1],
    }

# ── Linear model ─────────────────────────────────────────────────────────────

def fit_linear_model(records):
    """
    Fit score ~ b0 + b1*yin_threshold + b2*rms_gate + b3*conf_threshold
                   + b4*median_window + interactions + quadratics.
    Returns (coefficients, feature_names, predicted_optimum).
    """
    if len(records) < 10:
        return None, None, None

    # Build feature matrix with quadratic and interaction terms
    param_keys = ['yin_threshold', 'rms_gate', 'conf_threshold', 'median_window']
    features = []
    feature_names = ['intercept'] + param_keys[:]

    # Add quadratic terms
    for k in param_keys:
        feature_names.append(f'{k}^2')

    # Add key interactions
    interactions = [
        ('yin_threshold', 'conf_threshold'),
        ('yin_threshold', 'rms_gate'),
        ('rms_gate', 'conf_threshold'),
    ]
    for a, b in interactions:
        feature_names.append(f'{a}*{b}')

    X = []
    y = []
    for r in records:
        row = [1.0]  # intercept
        vals = {k: r['params'][k] for k in param_keys}
        # Linear
        for k in param_keys:
            row.append(vals[k])
        # Quadratic
        for k in param_keys:
            row.append(vals[k] ** 2)
        # Interactions
        for a, b in interactions:
            row.append(vals[a] * vals[b])
        X.append(row)
        y.append(r['score'])

    X = np.array(X)
    y = np.array(y)

    # Ridge regression (small regularization for stability)
    lam = 0.01
    XtX = X.T @ X + lam * np.eye(X.shape[1])
    Xty = X.T @ y
    try:
        coeffs = np.linalg.solve(XtX, Xty)
    except np.linalg.LinAlgError:
        return None, None, None

    # Predicted optimum: evaluate on a fine grid around the observed range
    best_score = -1e9
    best_params = None
    ranges = {}
    for k in param_keys:
        vals = [r['params'][k] for r in records]
        lo, hi = min(vals), max(vals)
        margin = (hi - lo) * 0.1
        ranges[k] = np.linspace(lo - margin, hi + margin, 20)

    for yt in ranges['yin_threshold']:
        for rg in ranges['rms_gate']:
            for ct in ranges['conf_threshold']:
                for mw in ranges['median_window']:
                    vals = {'yin_threshold': yt, 'rms_gate': rg,
                            'conf_threshold': ct, 'median_window': mw}
                    row = [1.0]
                    for k in param_keys:
                        row.append(vals[k])
                    for k in param_keys:
                        row.append(vals[k] ** 2)
                    for a, b in interactions:
                        row.append(vals[a] * vals[b])
                    pred = np.dot(coeffs, row)
                    if pred > best_score:
                        best_score = pred
                        best_params = dict(vals)

    if best_params:
        # Snap median_window to int
        best_params['median_window'] = max(1, round(best_params['median_window']))
        # Clamp to sensible ranges
        best_params['yin_threshold'] = round(max(0.08, min(0.35, best_params['yin_threshold'])), 3)
        best_params['rms_gate'] = round(max(0.001, min(0.02, best_params['rms_gate'])), 4)
        best_params['conf_threshold'] = round(max(0.60, min(0.95, best_params['conf_threshold'])), 3)

    return coeffs, feature_names, best_params


def print_model(coeffs, names):
    """Print the linear model coefficients ranked by absolute importance."""
    if coeffs is None:
        print("  (model could not be fit)")
        return
    pairs = list(zip(names, coeffs))
    pairs.sort(key=lambda x: abs(x[1]), reverse=True)
    print(f"  {'Feature':<30} {'Coefficient':>12}")
    print(f"  {'─'*30} {'─'*12}")
    for name, c in pairs:
        bar = '#' * min(40, int(abs(c) * 2))
        print(f"  {name:<30} {c:>+12.4f}  {bar}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="YIN parameter research")
    parser.add_argument("--quick", action="store_true", help="Quick sweep (fewer combos)")
    parser.add_argument("--refine", action="store_true", help="Refine around current best")
    parser.add_argument("--duration", type=float, default=60, help="Seconds of audio to analyze")
    parser.add_argument("--inputs", nargs="+", default=None, help="WAV files to analyze")
    args = parser.parse_args()

    # Find input files
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if args.inputs:
        wav_files = args.inputs
    else:
        wav_files = sorted(
            os.path.join(script_dir, f)
            for f in os.listdir(script_dir)
            if f.endswith('.wav') and f.startswith('input')
        )

    if not wav_files:
        print("No input WAV files found. Convert MP3s first:")
        print("  ffmpeg -i input1.mp3 -ar 44100 -ac 1 input1.wav")
        sys.exit(1)

    print(f"Input files: {[os.path.basename(f) for f in wav_files]}")
    print(f"Duration: {args.duration}s per file\n")

    # Load audio
    audio_data = []
    for f in wav_files:
        print(f"Loading {os.path.basename(f)}...", end=" ", flush=True)
        samples, sr = load_wav(f, args.duration)
        audio_data.append((os.path.basename(f), samples, sr))
        print(f"{len(samples)/sr:.1f}s at {sr}Hz")
    print()

    # Results file for persistence
    results_file = os.path.join(script_dir, 'research_results.json')
    prev_results = []
    if os.path.exists(results_file):
        with open(results_file) as fp:
            prev_results = json.load(fp)
        print(f"Loaded {len(prev_results)} previous results from {os.path.basename(results_file)}")

    # Build parameter grid
    if args.refine:
        if prev_results:
            best_prev = max(prev_results, key=lambda r: r['score'])
            grid = make_refine_grid(best_prev['params'])
            print(f"Refining around previous best (score={best_prev['score']:.3f}):")
            print(f"  {best_prev['params']}")
        else:
            print("No previous results to refine. Running full sweep.")
            grid = make_grid('full')
    elif args.quick:
        grid = make_grid('quick')
    else:
        grid = make_grid('full')

    # Generate all combinations
    keys = list(grid.keys())
    values = [grid[k] for k in keys]
    combos = list(itertools.product(*values))
    print(f"\nSweeping {len(combos)} parameter combinations x {len(audio_data)} files "
          f"= {len(combos) * len(audio_data)} runs\n")

    # Run sweep
    records = list(prev_results)
    seen = {json.dumps(r['params'], sort_keys=True) for r in records}
    new_count = 0
    t0 = time.time()

    for ci, combo in enumerate(combos):
        param_dict = dict(zip(keys, combo))
        param_key = json.dumps(param_dict, sort_keys=True)
        if param_key in seen:
            continue

        p = Params(**param_dict)
        file_metrics = []

        for fname, samples, sr in audio_data:
            m = run_analysis(samples, sr, p)
            file_metrics.append(m)

        # Average metrics across files
        avg = Metrics()
        n = len(file_metrics)
        avg.detection_rate = sum(m.detection_rate for m in file_metrics) / n
        avg.octave_flip_rate = sum(m.octave_flip_rate for m in file_metrics) / n
        avg.note_change_rate = sum(m.note_change_rate for m in file_metrics) / n
        avg.jitter_cents = sum(m.jitter_cents for m in file_metrics) / n
        avg.gap_count = sum(m.gap_count for m in file_metrics) // n
        avg.mean_gap_sec = sum(m.mean_gap_sec for m in file_metrics) / n
        avg.avg_deviation = sum(m.avg_deviation for m in file_metrics) / n
        avg.total_detected = sum(m.total_detected for m in file_metrics)
        avg.total_missed = sum(m.total_missed for m in file_metrics)
        avg.total_flips = sum(m.total_flips for m in file_metrics)

        s = score(avg)
        rec = {
            'params': param_dict,
            'metrics': asdict(avg),
            'score': round(s, 4),
        }
        records.append(rec)
        seen.add(param_key)
        new_count += 1

        # Progress
        if new_count % 20 == 0 or ci == len(combos) - 1:
            elapsed = time.time() - t0
            rate = new_count / max(0.01, elapsed)
            remaining = (len(combos) - ci - 1) / max(0.01, rate)
            best_so_far = max(records, key=lambda r: r['score'])
            print(f"  [{new_count}/{len(combos) - len(prev_results)} new] "
                  f"{elapsed:.0f}s elapsed, ~{remaining:.0f}s remaining  "
                  f"best={best_so_far['score']:.3f}", flush=True)

    elapsed = time.time() - t0
    print(f"\nCompleted {new_count} new evaluations in {elapsed:.1f}s")
    print(f"Total records: {len(records)}\n")

    # Save results
    with open(results_file, 'w') as fp:
        json.dump(records, fp, indent=2)
    print(f"Saved to {os.path.basename(results_file)}\n")

    # ── Top results ──────────────────────────────────────────────────────────

    records.sort(key=lambda r: r['score'], reverse=True)
    top = records[:15]

    print("=" * 90)
    print("TOP 15 PARAMETER SETS")
    print("=" * 90)
    print(f"{'#':>3}  {'Score':>6}  {'YIN':>5}  {'RMS':>6}  {'Conf':>5}  {'Med':>3}  "
          f"{'Det%':>5}  {'Flip%':>5}  {'Gaps':>4}  {'Jitter':>6}  {'Dev¢':>5}")
    print("-" * 90)

    for i, r in enumerate(top):
        p = r['params']
        m = r['metrics']
        print(f"{i+1:>3}  {r['score']:>6.2f}  "
              f"{p['yin_threshold']:>5.2f}  {p['rms_gate']:>6.4f}  "
              f"{p['conf_threshold']:>5.2f}  {p.get('median_window', 3):>3}  "
              f"{100*m['detection_rate']:>5.1f}  {100*m['octave_flip_rate']:>5.2f}  "
              f"{m['gap_count']:>4}  {m['jitter_cents']:>6.1f}  "
              f"{m['avg_deviation']:>5.1f}")

    # ── Linear model ─────────────────────────────────────────────────────────

    print(f"\n{'=' * 90}")
    print("LINEAR MODEL (score ~ params + params² + interactions)")
    print("=" * 90)

    coeffs, names, model_optimum = fit_linear_model(records)
    print_model(coeffs, names)

    if model_optimum:
        print(f"\nModel-predicted optimum:")
        for k, v in model_optimum.items():
            print(f"  {k}: {v}")

        # Validate model prediction by actually running it
        print("\nValidating model prediction...")
        p = Params(**model_optimum)
        file_metrics = []
        for fname, samples, sr in audio_data:
            m = run_analysis(samples, sr, p)
            file_metrics.append(m)
        n = len(file_metrics)
        avg = Metrics()
        avg.detection_rate = sum(m.detection_rate for m in file_metrics) / n
        avg.octave_flip_rate = sum(m.octave_flip_rate for m in file_metrics) / n
        avg.note_change_rate = sum(m.note_change_rate for m in file_metrics) / n
        avg.jitter_cents = sum(m.jitter_cents for m in file_metrics) / n
        avg.gap_count = sum(m.gap_count for m in file_metrics) // n
        avg.mean_gap_sec = sum(m.mean_gap_sec for m in file_metrics) / n
        avg.avg_deviation = sum(m.avg_deviation for m in file_metrics) / n
        avg.total_detected = sum(m.total_detected for m in file_metrics)
        avg.total_missed = sum(m.total_missed for m in file_metrics)
        avg.total_flips = sum(m.total_flips for m in file_metrics)
        s = score(avg)
        print(f"  Actual score: {s:.3f}")
        print(f"  Detection: {100*avg.detection_rate:.1f}%  "
              f"Flips: {100*avg.octave_flip_rate:.2f}%  "
              f"Gaps: {avg.gap_count}  Jitter: {avg.jitter_cents:.1f}¢  "
              f"Dev: {avg.avg_deviation:.1f}¢")

    # ── Comparison with current settings ─────────────────────────────────────

    best = records[0]
    current = {'yin_threshold': 0.20, 'rms_gate': 0.005,
               'conf_threshold': 0.78, 'median_window': 3}

    print(f"\n{'=' * 90}")
    print("RECOMMENDATION")
    print("=" * 90)
    print(f"\nCurrent params:  {current}")
    print(f"Best found:      {best['params']}")
    print(f"Current score:   ", end="")
    # Find current in records
    current_key = json.dumps(current, sort_keys=True)
    current_rec = next((r for r in records
                        if json.dumps(r['params'], sort_keys=True) == current_key), None)
    if current_rec:
        print(f"{current_rec['score']:.3f}")
    else:
        print("(not in sweep — run with current params included)")
    print(f"Best score:      {best['score']:.3f}")

    bp = best['params']
    bm = best['metrics']
    print(f"\nBest params for js/pitch.js:")
    print(f"  YIN threshold:      {bp['yin_threshold']}")
    print(f"  RMS gate:           {bp['rms_gate']}")
    print(f"  Confidence cutoff:  {bp['conf_threshold']}  (in app.js)")
    print(f"  Median window:      {bp.get('median_window', 3)}")
    print(f"\nExpected metrics:")
    print(f"  Detection rate:     {100*bm['detection_rate']:.1f}%")
    print(f"  Octave flip rate:   {100*bm['octave_flip_rate']:.2f}%")
    print(f"  Gaps >100ms:        {bm['gap_count']}")
    print(f"  Frame jitter:       {bm['jitter_cents']:.1f}¢")
    print(f"  Avg deviation:      {bm['avg_deviation']:.1f}¢")


if __name__ == "__main__":
    main()
