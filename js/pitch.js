// YIN pitch detection algorithm for string instruments

export class PitchDetector {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 4096;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.stream = null;
    this.source = null;
    this._history = [];     // frequency history for median smoothing
    this._midiHistory = []; // MIDI note history for octave correction
    this._prevFreq = null;  // last accepted frequency
    this._missCount = 0;    // consecutive missed frames
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    this._history = [];
    this._midiHistory = [];
    this._prevFreq = null;
    this._missCount = 0;
  }

  stop() {
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this._history = [];
    this._midiHistory = [];
    this._prevFreq = null;
    this._missCount = 0;
  }

  detect() {
    this.analyser.getFloatTimeDomainData(this.buffer);

    let rms = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      rms += this.buffer[i] * this.buffer[i];
    }
    rms = Math.sqrt(rms / this.buffer.length);
    if (rms < 0.002) {
      this._missCount++;
      if (this._missCount > 5) {
        this._history = [];
        this._midiHistory = [];
        this._prevFreq = null;
      }
      return null;
    }

    const result = this._yin(this.buffer, this.audioContext.sampleRate);
    if (!result) {
      this._missCount++;
      if (this._missCount > 5) {
        this._history = [];
        this._midiHistory = [];
        this._prevFreq = null;
      }
      return null;
    }

    this._missCount = 0;

    // Octave correction before smoothing
    let freq = this._octaveCorrected(result.frequency);

    // Median of last 3 detections suppresses single-frame harmonic jumps
    this._history.push(freq);
    if (this._history.length > 6) this._history.shift();
    const sorted = [...this._history].sort((a, b) => a - b);
    const smoothedFreq = sorted[Math.floor(sorted.length / 2)];

    // Update MIDI history for future octave corrections
    const midi = Math.round(12 * Math.log2(smoothedFreq / 440) + 69);
    this._midiHistory.push(midi);
    if (this._midiHistory.length > 7) this._midiHistory.shift();

    this._prevFreq = smoothedFreq;

    return { frequency: smoothedFreq, confidence: result.confidence };
  }

  _octaveCorrected(freq) {
    if (!this._prevFreq || this._midiHistory.length < 3) return freq;

    const midiDet = 12 * Math.log2(freq / 440) + 69;
    const midiPrev = 12 * Math.log2(this._prevFreq / 440) + 69;

    // If within one octave of the previous, accept as-is
    if (Math.abs(midiDet - midiPrev) < 11) return freq;

    // Try octave shifts — pick the one closest to recent history median
    const histSorted = [...this._midiHistory].sort((a, b) => a - b);
    const histMedian = histSorted[Math.floor(histSorted.length / 2)];

    let best = freq;
    let bestDist = Math.abs(midiDet - histMedian);

    for (const shift of [-1, 1, -2, 2]) {
      const candidate = freq * Math.pow(2, shift);
      if (candidate < 60 || candidate > 1100) continue;
      const midiCand = 12 * Math.log2(candidate / 440) + 69;
      const dist = Math.abs(midiCand - histMedian);
      if (dist < bestDist && Math.abs(midiCand - midiPrev) < 11) {
        best = candidate;
        bestDist = dist;
      }
    }
    return best;
  }

  _yin(buffer, sampleRate) {
    const halfLen = Math.floor(buffer.length / 2);
    const threshold = 0.27;

    // Step 1: Difference function
    const diff = new Float32Array(halfLen);
    for (let tau = 0; tau < halfLen; tau++) {
      let sum = 0;
      for (let i = 0; i < halfLen; i++) {
        const delta = buffer[i] - buffer[i + tau];
        sum += delta * delta;
      }
      diff[tau] = sum;
    }

    // Step 2: Cumulative mean normalized difference
    const cmndf = new Float32Array(halfLen);
    cmndf[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < halfLen; tau++) {
      runningSum += diff[tau];
      cmndf[tau] = diff[tau] / (runningSum / tau);
    }

    // Step 3: Absolute threshold — first tau below threshold
    let tauEstimate = -1;
    for (let tau = 2; tau < halfLen; tau++) {
      if (cmndf[tau] < threshold) {
        while (tau + 1 < halfLen && cmndf[tau + 1] < cmndf[tau]) {
          tau++;
        }
        tauEstimate = tau;
        break;
      }
    }

    if (tauEstimate === -1) return null;

    // Step 4: Parabolic interpolation for sub-sample accuracy
    let betterTau = tauEstimate;
    if (tauEstimate > 0 && tauEstimate < halfLen - 1) {
      const s0 = cmndf[tauEstimate - 1];
      const s1 = cmndf[tauEstimate];
      const s2 = cmndf[tauEstimate + 1];
      const shift = (s2 - s0) / (2 * (2 * s1 - s2 - s0));
      if (isFinite(shift) && Math.abs(shift) < 1) {
        betterTau = tauEstimate + shift;
      }
    }

    const frequency = sampleRate / betterTau;
    const confidence = 1 - cmndf[tauEstimate];

    // String instruments: C2 (65Hz) to ~C6 (1047Hz)
    if (frequency < 60 || frequency > 1100) return null;

    return { frequency, confidence };
  }
}
