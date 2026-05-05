# Playable — Agent Context

## What
Browser-based intonation practice app for string players. Detects pitch from the microphone and provides real-time feedback against reference tones or notes from loaded sheet music.

## Tech Stack
- Vanilla HTML/JS/CSS — no framework, no bundler, no build step
- Web Audio API for microphone input and tone generation
- ES modules (`type="module"` script tags)

## CDN Dependencies
- **OpenSheetMusicDisplay (OSMD)** — renders MusicXML as sheet music in the browser
- **@tonejs/midi** — parses MIDI files into note data

## File Structure
```
index.html          — main app entry point
css/style.css       — all styles
js/app.js           — app initialization and UI logic
js/pitch.js         — YIN pitch detection algorithm
js/audio.js         — Web Audio API setup, tone generation, microphone handling
js/score.js         — score loading (MusicXML/MIDI), OSMD integration
js/notemath.js      — frequency/pitch/note name conversion utilities
```

## Key Algorithms
- **YIN pitch detection** (`js/pitch.js`) — autocorrelation-based fundamental frequency estimation from raw audio samples

## How to Run
```bash
cd /home/outlet/projects/playable
python3 -m http.server
# Open http://localhost:8000 in a browser
```
Requires a browser with Web Audio API and getUserMedia support (Chrome recommended).

## Score Formats
- **MusicXML** (primary) — rendered as sheet music via OSMD
- **MIDI** (fallback) — parsed for note data only, no visual rendering

## Conventions
- ES modules, no bundler
- No framework — vanilla DOM manipulation
- Minimal dependencies (CDN-loaded only)
- Single-page app, all state in JS
