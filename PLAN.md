# Playable — Project Plan

## Vision
Score-aware intonation practice app for string players (violin, viola, cello, bass). Players load their sheet music and practice with real-time pitch feedback tied to each note in the score.

## Target Differentiator
Compared to existing apps like Intunator (drone/reference tone only):
- **Score loading** — import MusicXML or MIDI files of actual repertoire
- **Measure navigation** — jump to specific passages for focused practice
- **Sheet music display** — see the score while practicing, with visual pitch feedback per note
- **No install required** — runs entirely in the browser

## Current State (v1)
- Real-time pitch detection via YIN algorithm (Web Audio API)
- Three reference tone modes: drone, interval, scale
- MusicXML loading and rendering via OpenSheetMusicDisplay
- MIDI file loading via @tonejs/midi as fallback
- Note math utilities for frequency/pitch conversion
- Vanilla HTML/JS/CSS, no build step, no framework

## Next Steps
- **Testing** — cross-browser, mobile, various microphone setups
- **Score-click debugging** — clicking a note in the rendered score should set the practice target
- **Feedback loop mitigation** — prevent speaker output from being picked up by the microphone
- **Polish** — UI improvements, onboarding flow, error handling
- **Score navigation** — measure-by-measure and section-based navigation controls

## Market Context
- Intunator (closest competitor): ~$12k/yr estimated revenue, 4-star ratings, subscription model
- Niche but underserved market — string players who want score-integrated practice
- Browser-based approach removes friction (no app store, no install)
