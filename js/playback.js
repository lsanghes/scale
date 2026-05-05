// Score playback — setTimeout scheduler with Web Audio for actual note triggering

export class ScorePlayer {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.player = null; // soundfont-player instance
    this.isPlaying = false;
    this._timeouts = [];
    this._rafId = null;
    this._startMs = 0;
    this._startBeat = 0;
    this._fromIndex = 0;
    this._msPerBeat = 500;
    this._notes = [];
    this.onNoteIndex = null; // callback(noteIndex) each animation frame
    this.onProgress = null;  // callback(currentBeat) each animation frame
    this.onEnded = null;     // callback() when playback finishes
  }

  play(notes, bpm, fromIndex = 0) {
    this.stop();
    if (!this.player || !notes.length) return;

    console.log('[ScorePlayer] play()', { noteCount: notes.length, bpm, fromIndex, firstNote: notes[fromIndex] });

    this._notes = notes;
    this._msPerBeat = 60000 / bpm;
    this._fromIndex = fromIndex;
    const fromBeat = notes[fromIndex]?.startBeat ?? 0;
    this._startBeat = fromBeat;
    this._startMs = performance.now();
    this.isPlaying = true;

    // Schedule each note with setTimeout, play immediately when triggered
    for (let i = fromIndex; i < notes.length; i++) {
      const note = notes[i];
      const delayMs = (note.startBeat - fromBeat) * this._msPerBeat;
      const durSecs = Math.max(0.05, note.duration * this._msPerBeat / 1000);
      const timeout = setTimeout(() => {
        if (!this.isPlaying) return;
        console.log('[ScorePlayer] playing note', note.midi, 'at beat', note.startBeat, 'dur', durSecs.toFixed(2));
        this.player.play(note.midi, this.ctx.currentTime, { duration: durSecs, gain: 0.7 });
      }, delayMs);
      this._timeouts.push(timeout);
    }

    this._tick();
  }

  stop() {
    this.isPlaying = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    for (const t of this._timeouts) clearTimeout(t);
    this._timeouts = [];
  }

  _tick() {
    if (!this.isPlaying) return;

    const elapsedMs = performance.now() - this._startMs;
    const currentBeat = this._startBeat + elapsedMs / this._msPerBeat;
    if (this.onProgress) this.onProgress(currentBeat);

    // Find note currently playing
    const notes = this._notes;
    let activeIdx = this._fromIndex;
    for (let i = this._fromIndex; i < notes.length - 1; i++) {
      if (notes[i + 1].startBeat <= currentBeat) activeIdx = i + 1;
      else break;
    }
    if (this.onNoteIndex) this.onNoteIndex(activeIdx);

    // Done when past the last note's end
    const last = notes[notes.length - 1];
    if (last && currentBeat >= last.startBeat + last.duration + 0.5) {
      this.stop();
      if (this.onEnded) this.onEnded();
      return;
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }
}
