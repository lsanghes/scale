// Reference tone engine — cello sample playback via soundfont-player

import { nearestNoteNumber } from './notemath.js';

export class ReferenceToneEngine {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.mode = 'simultaneous';
    this.targetFreq = null;
    this.activeNode = null;
    this.activeOscs = []; // app.js checks .length to know if playing
    this.lastPingNote = null;
    this.lastPingTime = 0;
    this.player = null;
    this._loading = null;
  }

  /** Load the cello instrument samples from CDN. Call once before playing. */
  async init(destination) {
    if (this._loading) return this._loading;
    this._loading = Soundfont.instrument(this.ctx, 'cello', {
      soundfont: 'MusyngKite',
      destination: destination || this.ctx.destination,
    }).then(player => {
      this.player = player;
    });
    return this._loading;
  }

  setMode(mode) {
    this.stopAll();
    this.mode = mode;
  }

  setTargetNote(frequency) {
    const prevFreq = this.targetFreq;
    this.targetFreq = frequency;
    if (this.mode === 'simultaneous' && this.activeOscs.length) {
      // Only restart if the MIDI note actually changed
      const prevMidi = prevFreq ? nearestNoteNumber(prevFreq) : null;
      const newMidi = nearestNoteNumber(frequency);
      if (prevMidi !== newMidi) {
        this.stopAll();
        this._playNote(frequency, 0.5, true);
      }
    }
  }

  startSimultaneous() {
    if (!this.targetFreq || !this.player) return;
    this.stopAll();
    this._playNote(this.targetFreq, 0.5, true);
  }

  stopSimultaneous() {
    this.stopAll();
  }

  triggerPing(frequency) {
    const freq = frequency || this.targetFreq;
    if (!freq || !this.player) return;

    // Debounce: don't re-ping the same note within 500ms
    const noteRound = Math.round(12 * Math.log2(freq / 440));
    const now = performance.now();
    if (noteRound === this.lastPingNote && now - this.lastPingTime < 500) return;
    this.lastPingNote = noteRound;
    this.lastPingTime = now;

    const midi = nearestNoteNumber(freq);
    this.player.play(midi, this.ctx.currentTime, { duration: 0.4, gain: 0.6 });
  }

  startDrone(frequency) {
    const freq = frequency || this.targetFreq;
    if (!freq || !this.player) return;
    this.stopAll();
    this._playNote(freq, 0.5, true);
    this.targetFreq = freq;
  }

  _playNote(frequency, gain, loop) {
    if (!this.player) return;
    const midi = nearestNoteNumber(frequency);
    const node = this.player.play(midi, this.ctx.currentTime, {
      loop: loop,
      gain: gain,
    });
    this.activeNode = node;
    this.activeOscs = [1]; // sentinel so .length > 0
  }

  stopAll() {
    if (this.activeNode) {
      try { this.activeNode.stop(); } catch (e) { /* already stopped */ }
      this.activeNode = null;
    }
    if (this.player) {
      this.player.stop();
    }
    this.activeOscs = [];
  }
}
