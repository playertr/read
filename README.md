# read

A browser-based PDF read-along reader. Load any PDF, click a sentence, and
listen as neural text-to-speech reads the document aloud with word-level
highlighting, pitch-preserving speed control, and two-column reading order
detection.

Everything runs client-side. There is no backend.

**Live demo:** <https://playertr.github.io/read>

## Features

- Renders PDFs with Mozilla's pdf.js viewer (zoom, scroll, text selection)
- Neural TTS via Kokoro 82M (ONNX, runs in a Web Worker)
- Sentence-level highlight overlay that tracks the spoken word
- Click any sentence to start reading from that point
- Speed control from 0.5x to 3x using PICOLA time-stretching (constant pitch)
- Two-column academic paper layout detection and correct reading order
- Voice selection across Kokoro's available voices
- Model files (~92 MB) cached in the browser after first download

## Getting started

```sh
npm install
npm run dev
```

Open `http://localhost:5173` and load a PDF. The first load downloads the TTS
model, which takes a minute or two depending on your connection. Subsequent
loads use the browser cache.

## Architecture

```
src/
  App.svelte              Main application shell, playback loop
  lib/
    tts-worker.ts         Web Worker hosting Kokoro TTS inference
    audio-pipeline.ts     Web Audio playback with PICOLA speed control
    picola.ts             PICOLA time-scale modification (pitch-preserving)
    pdf-text.ts           Reading-order extraction from pdf.js text items
    components/
      PdfViewer.svelte    pdf.js viewer wrapper (zoom, text layer)
      Controls.svelte     Play/pause, speed slider, voice picker
      Highlight.svelte    Sentence highlight overlay
```

**TTS runs in a Web Worker** so inference never blocks the UI. A two-sentence
lookahead buffer hides generation latency: while one sentence plays, the next
is already being synthesized.

**PICOLA** (Pointer Interval Controlled OverLap and Add) handles speed changes.
It detects pitch periods using AMDF, then removes or inserts periods with
sin/cos crossfade overlap-add to change duration without shifting pitch. The
implementation follows the [sonic](https://github.com/waywardgeek/sonic)
library's approach.

**Reading order** is extracted from pdf.js text items. For two-column layouts,
column detection uses a histogram of line-start X positions to find the gutter.
Sentences are then sorted top-to-bottom within each column, left column first.

## Commands

```sh
npm run dev       # Vite dev server
npm run build     # Production build -> dist/
npm run preview   # Preview production build
npm test          # Run all tests
```

## Tests

```sh
npx vitest run                              # All tests
npx vitest run tests/unit/pdf-text.test.ts  # Single file
npx vitest run --reporter=verbose           # Verbose output
```

The test suite covers:
- PDF reading order: column detection, paragraph breaks, sentence splitting,
  and real-page ordering constraints from academic papers
- PICOLA: duration accuracy, pitch preservation, energy conservation, edge cases
- Audio pipeline: Web Audio API integration, speed changes, pause/resume

## License

[MIT](LICENSE)

### Third-party licenses

| Dependency | License |
|---|---|
| [pdfjs-dist](https://github.com/nicolo-ribaudo/pdfjs-dist) | Apache-2.0 |
| [kokoro-js](https://github.com/nicolo-ribaudo/kokoro-js) | Apache-2.0 |
| [onnxruntime-web](https://github.com/nicolo-ribaudo/onnxruntime-web) | MIT |
| [Svelte](https://svelte.dev) | MIT |
| [Vite](https://vite.dev) | MIT |
