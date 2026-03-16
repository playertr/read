<script lang="ts">
  import './app.css';
  import * as pdfjsLib from 'pdfjs-dist';
  import type { PDFDocumentProxy } from 'pdfjs-dist';
  import PdfViewer from './lib/components/PdfViewer.svelte';
  import Controls from './lib/components/Controls.svelte';
  import Highlight from './lib/components/Highlight.svelte';
  import { extractSentences, type Sentence } from './lib/pdf-text';
  import { AudioPipeline } from './lib/audio-pipeline';
  import type { WorkerOutgoing } from './lib/tts-worker';

  // Set pdf.js worker
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).href;

  // --- State ---
  let pdf: PDFDocumentProxy | null = $state(null);
  let sentences: Sentence[] = $state([]);
  let currentSentenceIndex = $state(0);
  let isPlaying = $state(false);
  let isPaused = $state(false);
  let speed = $state(1.0);
  let voice = $state('af_heart');
  let voices: string[] = $state(['af_heart']);
  let isLoading = $state(true);
  let loadingMessage = $state('Detecting device…');
  let ttsDevice = $state('');
  let activeSentenceSpans: HTMLElement[] = $state([]);
  let pdfViewer: PdfViewer | undefined = $state();

  // --- Audio ---
  const audioPipeline = new AudioPipeline();

  // --- TTS Worker ---
  const ttsWorker = new Worker(
    new URL('./lib/tts-worker.ts', import.meta.url),
    { type: 'module' }
  );

  let ttsReady = false;
  let generateId = 0;
  const pendingAudio = new Map<number, { resolve: (v: { audio: Float32Array; sampleRate: number }) => void; reject: (e: Error) => void }>();

  ttsWorker.onmessage = (e: MessageEvent<WorkerOutgoing>) => {
    const msg = e.data;
    switch (msg.type) {
      case 'device':
        ttsDevice = msg.device;
        loadingMessage = `Detected ${msg.device}. Downloading model…`;
        break;
      case 'ready':
        ttsReady = true;
        isLoading = false;
        voices = msg.voices;
        if (voices.length > 0 && !voices.includes(voice)) {
          voice = voices[0];
        }
        break;
      case 'progress':
        loadingMessage = `Downloading model… ${Math.round(msg.progress)}%`;
        break;
      case 'voices':
        voices = msg.voices;
        if (voices.length > 0 && !voices.includes(voice)) {
          voice = voices[0];
        }
        break;
      case 'audio': {
        const pending = pendingAudio.get(msg.id);
        if (pending) {
          pendingAudio.delete(msg.id);
          pending.resolve({ audio: msg.audio, sampleRate: msg.sampleRate });
        }
        break;
      }
      case 'error': {
        if (msg.id !== undefined) {
          const pending = pendingAudio.get(msg.id);
          if (pending) {
            pendingAudio.delete(msg.id);
            pending.reject(new Error(msg.error));
          }
        } else {
          console.error('TTS Worker error:', msg.error);
          isLoading = false;
          loadingMessage = `Error: ${msg.error}`;
        }
        break;
      }
    }
  };

  // Initialize TTS
  ttsWorker.postMessage({ type: 'init' });

  // --- TTS generation helper ---
  function generateSpeech(text: string): Promise<{ audio: Float32Array; sampleRate: number }> {
    return new Promise((resolve, reject) => {
      const id = ++generateId;
      pendingAudio.set(id, { resolve, reject });
      ttsWorker.postMessage({ type: 'generate', id, text, voice, speed: 1.0 });
    });
  }

  // --- Lookahead buffer ---
  // Fire TTS generation ahead of playback so audio is ready when needed.
  // The first sentence plays as soon as its audio arrives (no pre-buffering).
  const LOOKAHEAD = 3;

  interface BufferedAudio {
    sentenceIndex: number;
    promise: Promise<{ audio: Float32Array; sampleRate: number }>;
  }

  let audioBuffer: BufferedAudio[] = [];

  /** Request TTS for a sentence (deduplicates). Returns a promise for the audio. */
  function ensurePrefetched(sentenceIndex: number): Promise<{ audio: Float32Array; sampleRate: number }> {
    if (sentenceIndex >= sentences.length) {
      return Promise.reject(new Error("past end"));
    }

    const existing = audioBuffer.find((b) => b.sentenceIndex === sentenceIndex);
    if (existing) return existing.promise;

    const promise = generateSpeech(sentences[sentenceIndex].text);
    audioBuffer.push({ sentenceIndex, promise });

    // Keep buffer bounded
    if (audioBuffer.length > LOOKAHEAD + 2) {
      audioBuffer = audioBuffer.slice(-LOOKAHEAD - 2);
    }

    return promise;
  }

  // --- Playback loop ---
  let playbackAbort: AbortController | null = null;

  async function startPlaybackFrom(index: number) {
    if (playbackAbort) {
      playbackAbort.abort();
    }
    playbackAbort = new AbortController();
    const signal = playbackAbort.signal;

    await audioPipeline.init();
    audioPipeline.setSpeed(speed);
    isPlaying = true;
    isPaused = false;
    currentSentenceIndex = index;

    // Clear old buffer
    audioBuffer = [];

    // Immediately fire TTS for the first sentence + lookahead
    for (let k = 0; k <= LOOKAHEAD && index + k < sentences.length; k++) {
      ensurePrefetched(index + k);
    }

    for (let i = index; i < sentences.length; i++) {
      if (signal.aborted) break;

      currentSentenceIndex = i;

      // Fire lookahead for upcoming sentences
      for (let k = 1; k <= LOOKAHEAD; k++) {
        ensurePrefetched(i + k);
      }

      // Get audio (already prefetched or wait for it)
      let audioData: { audio: Float32Array; sampleRate: number };
      try {
        audioData = await ensurePrefetched(i);
      } catch (err) {
        console.error(`TTS failed for sentence ${i}:`, err);
        continue;
      }

      if (signal.aborted) break;

      // Set highlight RIGHT BEFORE play so it syncs with audio start
      updateHighlight(i);

      try {
        await audioPipeline.play(audioData.audio, audioData.sampleRate);
      } catch (playErr) {
        console.error(`[Playback] Play error for sentence ${i}:`, playErr);
        break;
      }

      if (signal.aborted) break;
    }

    if (!signal.aborted) {
      isPlaying = false;
      activeSentenceSpans = [];
    }
  }

  function updateHighlight(sentenceIndex: number) {
    const sentence = sentences[sentenceIndex];
    if (!sentence) {
      activeSentenceSpans = [];
      return;
    }

    // pdf.js viewer uses data-page-number (1-indexed) and .textLayer
    const pageContainer = document.querySelector(
      `.page[data-page-number="${sentence.pageIndex + 1}"]`
    );
    if (!pageContainer) {
      activeSentenceSpans = [];
      return;
    }

    const textLayer = pageContainer.querySelector('.textLayer');
    if (!textLayer) {
      activeSentenceSpans = [];
      return;
    }

    const allSpans = Array.from(textLayer.querySelectorAll('span:not(.markedContent)'));
    // Highlight the full range of spans (min to max index) so space
    // spans between words are also highlighted — no striped gaps.
    const minIdx = Math.min(...sentence.itemIndices);
    const maxIdx = Math.max(...sentence.itemIndices);
    const spans: HTMLElement[] = [];
    for (let idx = minIdx; idx <= maxIdx; idx++) {
      if (idx < allSpans.length) {
        spans.push(allSpans[idx] as HTMLElement);
      }
    }

    activeSentenceSpans = spans;
  }

  // --- Controls handlers ---
  function handlePlayClick() {
    if (isPlaying && !isPaused) {
      // Pause
      isPaused = true;
      audioPipeline.pause();
    } else if (isPaused) {
      // Resume
      isPaused = false;
      audioPipeline.resume();
    } else {
      // Start
      startPlaybackFrom(currentSentenceIndex);
    }
  }

  function handleSpeedChange(newSpeed: number) {
    speed = newSpeed;
    audioPipeline.setSpeed(speed);
  }

  function handleVoiceChange(newVoice: string) {
    voice = newVoice;
    // Clear prefetch buffer so upcoming sentences regenerate with the new voice.
    // The currently-playing sentence finishes with old voice; next one uses new.
    audioBuffer = [];
  }

  function handleSentenceClick(event: { text: string; pageIndex: number }) {
    // Find the sentence closest to the selected text
    const selectedText = event.text.trim();
    if (!selectedText) return;
    const selectedLower = selectedText.toLowerCase();

    let bestIndex = -1;
    let bestScore = -1;

    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s.pageIndex !== event.pageIndex) continue;
      const sentLower = s.text.toLowerCase();

      // Check overlap: selection start found in sentence, or sentence start in selection
      let score = 0;
      const probe = selectedLower.substring(0, Math.min(20, selectedLower.length));
      if (sentLower.includes(probe)) {
        score = selectedText.length;
      } else if (selectedLower.includes(sentLower.substring(0, Math.min(20, sentLower.length)))) {
        score = sentLower.length;
      } else if (sentLower.includes(selectedLower) || selectedLower.includes(sentLower)) {
        score = Math.min(selectedText.length, sentLower.length);
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      currentSentenceIndex = bestIndex;
      updateHighlight(bestIndex);
      // If already playing, jump to the selected sentence
      if (isPlaying && !isPaused) {
        startPlaybackFrom(bestIndex);
      }
      // Otherwise just set position — user presses Play to start
    }
  }

  // --- PDF loading ---
  let isDragOver = $state(false);

  async function loadPdfFile(file: File) {
    const buffer = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
    pdf = doc;
    sentences = await extractSentences(doc);
    currentSentenceIndex = 0;
  }

  async function loadPdfFromUrl(url: string) {
    const doc = await pdfjsLib.getDocument(url).promise;
    pdf = doc;
    sentences = await extractSentences(doc);
    currentSentenceIndex = 0;
  }

  // Auto-load PDF from ?file= URL parameter
  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    const fileParam = params.get('file');
    if (fileParam) {
      loadPdfFromUrl(fileParam);
    }
  });

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;
    const file = e.dataTransfer?.files[0];
    if (file && file.type === 'application/pdf') {
      loadPdfFile(file);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    isDragOver = true;
  }

  function handleDragLeave() {
    isDragOver = false;
  }

  function handleFileInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      loadPdfFile(file);
    }
  }

  // --- Keyboard shortcuts ---
  function handleKeydown(e: KeyboardEvent) {
    // Don't capture when typing in inputs
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

    // Zoom shortcuts (Ctrl/Cmd + plus/minus/zero)
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        pdfViewer?.zoomIn();
        return;
      }
      if (e.key === '-') {
        e.preventDefault();
        pdfViewer?.zoomOut();
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        pdfViewer?.zoomFitWidth();
        return;
      }
    }

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        handlePlayClick();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (currentSentenceIndex > 0) {
          currentSentenceIndex--;
          if (isPlaying) startPlaybackFrom(currentSentenceIndex);
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (currentSentenceIndex < sentences.length - 1) {
          currentSentenceIndex++;
          if (isPlaying) startPlaybackFrom(currentSentenceIndex);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        handleSpeedChange(Math.min(3.0, speed + 0.25));
        break;
      case 'ArrowDown':
        e.preventDefault();
        handleSpeedChange(Math.max(0.5, speed - 0.25));
        break;
      case 'Escape':
        e.preventDefault();
        if (playbackAbort) playbackAbort.abort();
        audioPipeline.stop();
        isPlaying = false;
        isPaused = false;
        activeSentenceSpans = [];
        break;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if !pdf}
  <!-- Drop zone / file picker -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="drop-zone"
    class:drag-over={isDragOver}
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
  >
    <div class="drop-content">
      <svg viewBox="0 0 48 48" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M24 32V16m-8 8l8-8 8 8" />
        <rect x="4" y="4" width="40" height="40" rx="4" />
      </svg>
      <h2>Drop a PDF here</h2>
      <p>or</p>
      <label class="file-picker">
        Choose file
        <input type="file" accept=".pdf,application/pdf" onchange={handleFileInput} />
      </label>
      <p class="hint">Space = play/pause · ←→ = skip sentence · ↑↓ = speed · Esc = stop</p>
    </div>
  </div>
{:else}
  <PdfViewer {pdf} onsentenceclick={handleSentenceClick} bind:this={pdfViewer} />
  <Highlight {activeSentenceSpans} />
  <Controls
    isPlaying={isPlaying && !isPaused}
    {speed}
    {voice}
    {voices}
    currentSentence={currentSentenceIndex + 1}
    totalSentences={sentences.length}
    {isLoading}
    onplayclick={handlePlayClick}
    onspeedchange={handleSpeedChange}
    onvoicechange={handleVoiceChange}
  />
{/if}

<style>
  .drop-zone {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1a1a2e;
    color: #8888aa;
    transition: background 0.2s;
  }

  .drop-zone.drag-over {
    background: #1a2a3e;
    color: #aabbdd;
  }

  .drop-content {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .drop-content h2 {
    font-weight: 400;
    font-size: 1.5rem;
  }

  .drop-content p {
    font-size: 0.9rem;
    opacity: 0.6;
  }

  .file-picker {
    display: inline-block;
    padding: 10px 24px;
    background: #4a9eff;
    color: white;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1rem;
    transition: background 0.15s;
  }

  .file-picker:hover {
    background: #3a8eef;
  }

  .file-picker input {
    display: none;
  }

  .hint {
    margin-top: 24px;
    font-size: 0.75rem;
    opacity: 0.4;
  }
</style>
