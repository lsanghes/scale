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
    this.onLoopRestart = null; // callback() when loop count-in begins
    this.countInEnabled = true; // whether to play 4 clicks before each repeat
    this.shouldLoop = false; // whether to loop after completion
    this.loopDelayMs = 0;    // delay before looping
    this._loopTimeout = null; // timeout for loop restart (separate from note timeouts)
    this._countingIn = false; // true while 4-click count-in is in progress
  }

  _playClick() {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(900, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(450, ctx.currentTime + 0.06);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.06);
  }

  // Play 4 count-in clicks at `bpm`, then start note playback.
  // `onCountBeat(n)` is called with n=4,3,2,1 as each click fires.
  countIn(notes, bpm, fromIndex = 0, onCountBeat = null) {
    this.stop();
    this.isPlaying = true;
    this._countingIn = true;
    this._msPerBeat = 60000 / bpm;
    this._onCountBeat = onCountBeat;
    const BEATS = 4;

    for (let i = 0; i < BEATS; i++) {
      const delay = i * this._msPerBeat;
      const t = setTimeout(() => {
        if (!this.isPlaying) return;
        this._playClick();
        if (onCountBeat) onCountBeat(BEATS - i);
      }, delay);
      this._timeouts.push(t);
    }

    const startDelay = BEATS * this._msPerBeat;
    const t = setTimeout(() => {
      if (!this.isPlaying) return;
      this._timeouts = [];
      this.play(notes, bpm, fromIndex);
    }, startDelay);
    this._timeouts.push(t);
  }

  play(notes, bpm, fromIndex = 0) {
    this.stop();
    this._countingIn = false;
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

  changeBpm(bpm) {
    if (!this.isPlaying || !this._notes.length) return;
    if (this._countingIn) {
      this.countIn(this._notes, bpm, this._fromIndex, this._onCountBeat);
      return;
    }
    // Snapshot current beat, then cancel all pending note timeouts and reschedule
    const elapsedMs = performance.now() - this._startMs;
    const currentBeat = this._startBeat + elapsedMs / this._msPerBeat;

    for (const t of this._timeouts) clearTimeout(t);
    this._timeouts = [];

    this._msPerBeat = 60000 / bpm;
    this._startBeat = currentBeat;
    this._startMs = performance.now();

    // Find the next note at or after currentBeat and reschedule from there
    const notes = this._notes;
    let nextIdx = notes.length - 1;
    for (let i = 0; i < notes.length; i++) {
      if (notes[i].startBeat >= currentBeat) { nextIdx = i; break; }
    }

    for (let i = nextIdx; i < notes.length; i++) {
      const note = notes[i];
      const delayMs = (note.startBeat - currentBeat) * this._msPerBeat;
      const durSecs = Math.max(0.05, note.duration * this._msPerBeat / 1000);
      const timeout = setTimeout(() => {
        if (!this.isPlaying) return;
        this.player.play(note.midi, this.ctx.currentTime, { duration: durSecs, gain: 0.7 });
      }, delayMs);
      this._timeouts.push(timeout);
    }
  }

  stop() {
    this.isPlaying = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    for (const t of this._timeouts) clearTimeout(t);
    this._timeouts = [];
    if (this._loopTimeout) { clearTimeout(this._loopTimeout); this._loopTimeout = null; }
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
    if (last && currentBeat >= last.startBeat + last.duration) {
      if (this.shouldLoop) {
        // Schedule loop restart after delay (separate timeout, not cleared by stop)
        this.isPlaying = false;
        this._loopTimeout = setTimeout(() => {
          if (this.shouldLoop) {
            if (this.onLoopRestart) this.onLoopRestart();
            this.play(this._notes, (60000 / this._msPerBeat), 0);
          }
        }, this.loopDelayMs);
      } else {
        this.stop();
        if (this.onEnded) this.onEnded();
      }
      return;
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }
}
