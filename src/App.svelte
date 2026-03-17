<script lang="ts">
  import './app.css';
  import type { PluginRegistry } from '@embedpdf/svelte-pdf-viewer';
  import type { PdfDocumentObject, PdfEngine, PdfPageObject, PdfTextRun, PdfAnnotationSubtype } from '@embedpdf/models';
  import PdfViewer from './lib/components/PdfViewer.svelte';
  import Controls from './lib/components/Controls.svelte';
  import { AudioPipeline } from './lib/audio-pipeline';
  import type { WorkerOutgoing } from './lib/tts-worker';

  // --- Types for our text model ---
  interface Word {
    text: string;
    pageIndex: number;
    /** Bounding rect in PDF page coordinates (points). Uses EmbedPDF Rect format. */
    pdfRect: { origin: { x: number; y: number }; size: { width: number; height: number } };
  }

  interface Sentence {
    text: string;
    pageIndex: number;
    words: Word[];
    /** Start char index within the page (EmbedPDF charIndex). */
    charStartInPage: number;
    /** End char index (exclusive) within the page. */
    charEndInPage: number;
  }

  // --- State ---
  let pdfSrc: string | null = $state(null);
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

  // EmbedPDF references
  let registry: PluginRegistry | null = $state(null);
  let engine: PdfEngine | null = $state(null);
  let pdfDoc: PdfDocumentObject | null = $state(null);

  // Highlight state: native annotation ID + page index for cleanup
  let currentHighlightId: string | null = $state(null);
  let currentHighlightPage: number = $state(-1);

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

  // --- TTS generation with dedup cache ---
  const ttsCache = new Map<string, Promise<{ audio: Float32Array; sampleRate: number }>>();

  function generateSpeech(text: string): Promise<{ audio: Float32Array; sampleRate: number }> {
    const cached = ttsCache.get(text);
    if (cached) return cached;

    const promise = new Promise<{ audio: Float32Array; sampleRate: number }>((resolve, reject) => {
      const id = ++generateId;
      pendingAudio.set(id, { resolve, reject });
      ttsWorker.postMessage({ type: 'generate', id, text, voice, speed: 1.0 });
    });
    ttsCache.set(text, promise);

    if (ttsCache.size > 200) {
      const first = ttsCache.keys().next().value;
      if (first !== undefined) ttsCache.delete(first);
    }
    return promise;
  }

  // --- Text extraction from PDFium ---
  async function extractTextFromDoc(eng: PdfEngine, doc: PdfDocumentObject) {
    const allSentences: Sentence[] = [];

    for (const page of doc.pages) {
      try {
        const [textRuns, geometry] = await Promise.all([
          eng.getPageTextRuns(doc, page).toPromise(),
          eng.getPageGeometry(doc, page).toPromise(),
        ]);
        // Build a flat array of glyph boxes indexed by char position
        const glyphs = buildGlyphIndex(geometry.runs);
        const pageSentences = textRunsToSentences(textRuns.runs, page, glyphs);
        allSentences.push(...pageSentences);
      } catch (err) {
        console.warn(`Text extraction failed for page ${page.index}:`, err);
      }
    }

    sentences = allSentences;
    currentSentenceIndex = 0;
    console.log(`Extracted ${sentences.length} sentences from ${doc.pageCount} pages`);
  }

  interface GlyphBox { x: number; y: number; width: number; height: number }

  /** Build a char-index → glyph-box map from geometry runs. */
  function buildGlyphIndex(runs: Array<{ charStart: number; glyphs: GlyphBox[] }>): Map<number, GlyphBox> {
    const map = new Map<number, GlyphBox>();
    for (const run of runs) {
      for (let i = 0; i < run.glyphs.length; i++) {
        map.set(run.charStart + i, run.glyphs[i]);
      }
    }
    return map;
  }

  /**
   * Convert PDFium PdfTextRun[] into Sentence/Word arrays.
   * Groups runs into paragraphs, then splits into sentences.
   */
  function textRunsToSentences(runs: PdfTextRun[], page: PdfPageObject, glyphs: Map<number, GlyphBox>): Sentence[] {
    if (runs.length === 0) return [];

    // Group runs into paragraphs by detecting large Y gaps or font size changes
    const paragraphs: PdfTextRun[][] = [[]];
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (i > 0) {
        const prev = runs[i - 1];
        if (isParagraphBreakRun(prev, run, page.size.height)) {
          if (paragraphs[paragraphs.length - 1].length > 0) {
            paragraphs.push([]);
          }
        }
      }
      paragraphs[paragraphs.length - 1].push(run);
    }

    // For each paragraph, concatenate text, split into sentences
    const result: Sentence[] = [];
    for (const paraRuns of paragraphs) {
      if (paraRuns.length === 0) continue;
      const fullText = paraRuns.map(r => r.text).join('');
      if (fullText.trim().length === 0) continue;

      const rawSentences = splitIntoSentences(fullText);
      let charOffset = 0;

      // Build mapping: paragraph char offset → page-level charIndex
      const paraCharToPage: number[] = [];
      for (const run of paraRuns) {
        for (let c = 0; c < run.text.length; c++) {
          paraCharToPage.push(run.charIndex + c);
        }
      }

      for (const sentText of rawSentences) {
        const sentStart = fullText.indexOf(sentText, charOffset);
        if (sentStart < 0) continue;
        const sentEnd = sentStart + sentText.length;
        charOffset = sentEnd;

        // Map sentence chars back to runs to get word-level rects
        const words = extractWordsFromRuns(sentText, sentStart, paraRuns, page.index, glyphs);

        // Map to page-level char indices
        const charStartInPage = sentStart < paraCharToPage.length ? paraCharToPage[sentStart] : 0;
        const charEndInPage = sentEnd <= paraCharToPage.length ? paraCharToPage[sentEnd - 1] + 1 : charStartInPage + sentText.length;

        result.push({
          text: sentText,
          pageIndex: page.index,
          words,
          charStartInPage,
          charEndInPage,
        });
      }
    }

    return result;
  }

  /** Detect paragraph breaks between consecutive text runs. */
  function isParagraphBreakRun(
    prev: PdfTextRun,
    curr: PdfTextRun,
    pageHeight: number,
  ): boolean {
    // EmbedPDF coords: Y increases downward. Runs going down = increasing Y.
    const prevY = prev.rect.origin.y;
    const currY = curr.rect.origin.y;
    const yDelta = currY - prevY; // positive = moved down

    // Column break (going back up) — not a paragraph break
    if (yDelta < 0) return false;

    // Font size change > 25%
    const avgFs = (prev.fontSize + curr.fontSize) / 2;
    if (avgFs > 0 && Math.abs(prev.fontSize - curr.fontSize) / avgFs > 0.25) return true;

    // Font change at line break
    if (yDelta > 0 && prev.font.name !== curr.font.name) return true;

    // Large Y gap (> 2.5× font size)
    if (yDelta > prev.fontSize * 2.52) return true;

    return false;
  }

  /** Split text into sentences (reusing abbreviation-aware logic). */
  function splitIntoSentences(text: string): string[] {
    const ABBREVIATIONS = new Set([
      "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st",
      "fig", "figs", "eq", "eqs", "ref", "refs", "sec", "secs",
      "vol", "vols", "no", "nos", "p", "pp", "ed", "eds",
      "al", "et", "vs", "viz", "approx", "dept", "est", "govt",
      "inc", "corp", "ltd", "assn", "natl", "intl",
      "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
      "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
      "e", "g", "ie", "eg",
    ]);

    const raw: string[] = [];
    let sentStart = 0;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;

      let endPunct = i;
      while (endPunct + 1 < text.length && '.!?'.includes(text[endPunct + 1])) endPunct++;

      const afterPunct = endPunct + 1;
      if (afterPunct < text.length && !/\s/.test(text[afterPunct])) {
        i = endPunct;
        continue;
      }

      if (ch === '.') {
        const before = text.slice(sentStart, i);
        const match = before.match(/(\w+)$/);
        if (match) {
          if (ABBREVIATIONS.has(match[1].toLowerCase())) { i = endPunct; continue; }
          if (/^[A-Z]$/.test(match[1])) { i = endPunct; continue; }
        }
        if (/\d$/.test(text.slice(sentStart, i))) {
          const after = text.slice(afterPunct).trimStart();
          if (after.length > 0 && !/^[A-Z]/.test(after)) { i = endPunct; continue; }
        }
      }

      const sentEnd = afterPunct;
      const s = text.slice(sentStart, sentEnd).trim();
      if (s.length > 0) raw.push(s);
      sentStart = sentEnd;
      i = endPunct;
    }

    if (sentStart < text.length) {
      const s = text.slice(sentStart).trim();
      if (s.length > 0) raw.push(s);
    }

    // Merge short sentences
    const MIN_LEN = 40;
    const merged: string[] = [];
    for (const s of raw) {
      if (merged.length > 0 && (merged[merged.length - 1].length < MIN_LEN || s.length < MIN_LEN)) {
        merged[merged.length - 1] += ' ' + s;
      } else {
        merged.push(s);
      }
    }

    return merged;
  }

  /**
   * Extract words from sentence text, mapping each word to its PDF bounding rect.
   * Uses char indices to find which run(s) each word falls in.
   */
  function extractWordsFromRuns(
    sentText: string,
    sentStartInPara: number,
    paraRuns: PdfTextRun[],
    pageIndex: number,
    glyphs: Map<number, GlyphBox>,
  ): Word[] {
    const words: Word[] = [];
    const wordMatches = [...sentText.matchAll(/\S+/g)];

    // Build a mapping from paragraph char offset → global charIndex
    const charIndexMap: number[] = [];
    for (const run of paraRuns) {
      for (let c = 0; c < run.text.length; c++) {
        charIndexMap.push(run.charIndex + c);
      }
    }

    for (const m of wordMatches) {
      const wordStart = sentStartInPara + m.index!;
      const wordEnd = wordStart + m[0].length;

      // Compute bounding rect from individual glyph boxes
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let found = false;

      for (let ci = wordStart; ci < wordEnd && ci < charIndexMap.length; ci++) {
        const globalIdx = charIndexMap[ci];
        const glyph = glyphs.get(globalIdx);
        if (!glyph) continue;

        if (!found) {
          minX = glyph.x;
          minY = glyph.y;
          maxX = glyph.x + glyph.width;
          maxY = glyph.y + glyph.height;
          found = true;
        } else {
          minX = Math.min(minX, glyph.x);
          minY = Math.min(minY, glyph.y);
          maxX = Math.max(maxX, glyph.x + glyph.width);
          maxY = Math.max(maxY, glyph.y + glyph.height);
        }
      }

      if (found) {
        words.push({
          text: m[0],
          pageIndex,
          pdfRect: {
            origin: { x: minX, y: minY },
            size: { width: maxX - minX, height: maxY - minY },
          },
        });
      }
    }

    return words;
  }

  // --- Playback loop ---
  let playbackAbort: AbortController | null = null;

  async function startPlaybackFrom(index: number) {
    if (playbackAbort) {
      playbackAbort.abort();
    }
    audioPipeline.stop();
    playbackAbort = new AbortController();
    const signal = playbackAbort.signal;

    await audioPipeline.init();
    if (signal.aborted) return;
    audioPipeline.setSpeed(speed);
    isPlaying = true;
    isPaused = false;
    currentSentenceIndex = index;

    // Pre-generate the first sentence + lookahead
    if (index < sentences.length) generateSpeech(sentences[index].text);
    if (index + 1 < sentences.length) generateSpeech(sentences[index + 1].text);

    for (let i = index; i < sentences.length; i++) {
      if (signal.aborted) break;

      currentSentenceIndex = i;
      const sentence = sentences[i];

      // Start generating next sentence while current plays
      if (i + 2 < sentences.length) generateSpeech(sentences[i + 2].text);

      let audioData: { audio: Float32Array; sampleRate: number };
      try {
        audioData = await generateSpeech(sentence.text);
      } catch (err) {
        console.error(`TTS failed for sentence:`, err);
        continue;
      }

      if (signal.aborted) break;

      // Highlight the entire sentence
      updateHighlightForSentence(sentence);

      try {
        await audioPipeline.play(audioData.audio, audioData.sampleRate);
      } catch (playErr) {
        console.error(`[Playback] Play error:`, playErr);
        break;
      }

      if (signal.aborted) break;
    }

    if (!signal.aborted) {
      isPlaying = false;
      clearHighlight();
    }
  }


  function clearHighlight() {
    if (currentHighlightId && currentHighlightPage >= 0 && registry) {
      try {
        const annoPlugin = registry.getPlugin('annotation') as any;
        annoPlugin?.deleteAnnotation(currentHighlightPage, currentHighlightId);
      } catch {}
    }
    currentHighlightId = null;
    currentHighlightPage = -1;
  }

  /** Highlight all words of a sentence using a native PDF highlight annotation. */
  function updateHighlightForSentence(sentence: Sentence) {
    clearHighlight();
    if (!registry || !pdfDoc || sentence.words.length === 0) return;

    const annoPlugin = registry.getPlugin('annotation') as any;
    if (!annoPlugin) return;

    // Group word rects by line (same Y within tolerance) for cleaner highlights
    const lineRects: Array<{ origin: { x: number; y: number }; size: { width: number; height: number } }> = [];
    let lineY = -1;
    let current: typeof lineRects[0] | null = null;

    for (const word of sentence.words) {
      const r = word.pdfRect;
      if (r.size.width === 0 && r.size.height === 0) continue;

      if (current === null || Math.abs(r.origin.y - lineY) > 3) {
        if (current) lineRects.push(current);
        lineY = r.origin.y;
        current = { origin: { x: r.origin.x, y: r.origin.y }, size: { width: r.size.width, height: r.size.height } };
      } else {
        const endX = r.origin.x + r.size.width;
        current.size.width = endX - current.origin.x;
        current.size.height = Math.max(current.size.height, r.size.height);
      }
    }
    if (current) lineRects.push(current);
    if (lineRects.length === 0) return;

    // Bounding rect
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of lineRects) {
      minX = Math.min(minX, r.origin.x);
      minY = Math.min(minY, r.origin.y);
      maxX = Math.max(maxX, r.origin.x + r.size.width);
      maxY = Math.max(maxY, r.origin.y + r.size.height);
    }

    const annoId = `tts-hl-${Date.now()}`;
    const pageIndex = sentence.pageIndex;

    try {
      annoPlugin.createAnnotation(pageIndex, {
        id: annoId,
        type: 9, // PdfAnnotationSubtype.HIGHLIGHT
        pageIndex,
        rect: { origin: { x: minX, y: minY }, size: { width: maxX - minX, height: maxY - minY } },
        segmentRects: lineRects,
        strokeColor: '#4285F4',
        opacity: 0.35,
      });
      currentHighlightId = annoId;
      currentHighlightPage = pageIndex;
    } catch {}

    // Scroll highlight into view via the scroll plugin
    scrollHighlightIntoView(pageIndex, minY);
  }

  /** Scroll to make the current highlight visible. */
  function scrollHighlightIntoView(pageIndex: number, pdfY: number) {
    if (!registry) return;
    try {
      const scrollPlugin = registry.getPlugin('scroll') as any;
      const store = registry.getStore();
      const state = store.getState();
      const docId = state.core.activeDocumentId;
      if (!docId || !scrollPlugin) return;

      // Use getRectPositionForPage to convert PDF coords to scroll position
      const pos = scrollPlugin.getRectPositionForPage?.(docId, pageIndex, { origin: { x: 0, y: pdfY }, size: { width: 1, height: 20 } });
      if (pos !== undefined && pos !== null) {
        const scrollEl = document.querySelector('embedpdf-container')?.shadowRoot?.querySelector('.bg-bg-app');
        if (scrollEl) {
          const currentScroll = scrollEl.scrollTop;
          const viewHeight = scrollEl.clientHeight;
          // Only scroll if highlight is outside the visible area
          if (pos < currentScroll || pos > currentScroll + viewHeight - 100) {
            scrollEl.scrollTo({ top: Math.max(0, pos - viewHeight / 3), behavior: 'smooth' });
          }
        }
      }
    } catch {}
  }

  // --- Controls handlers ---
  let pausedAtSentence = -1;

  function handlePlayClick() {
    if (isPlaying && !isPaused) {
      isPaused = true;
      pausedAtSentence = currentSentenceIndex;
      audioPipeline.pause();
    } else if (isPaused) {
      isPaused = false;
      if (currentSentenceIndex !== pausedAtSentence) {
        startPlaybackFrom(currentSentenceIndex);
      } else {
        audioPipeline.resume();
      }
    } else {
      startPlaybackFrom(currentSentenceIndex);
    }
  }

  function handleSpeedChange(newSpeed: number) {
    speed = newSpeed;
    audioPipeline.setSpeed(speed);
  }

  function handleVoiceChange(newVoice: string) {
    voice = newVoice;
    ttsCache.clear();
  }

  /**
   * Given a page index and a char index within that page (from the selection plugin),
   * find the sentence that contains this position and update currentSentenceIndex.
   */
  function selectSentenceAtCharIndex(pageIndex: number, charIndex: number) {
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s.pageIndex !== pageIndex) continue;
      if (charIndex >= s.charStartInPage && charIndex < s.charEndInPage) {
        currentSentenceIndex = i;
        updateHighlightForSentence(s);
        if (isPlaying && !isPaused) {
          startPlaybackFrom(i);
        }
        return;
      }
    }
  }

  /**
   * Wire up selection detection by polling the EmbedPDF selection plugin
   * on mouseup events within the shadow DOM.
   */
  function wireSelectionDetection(reg: PluginRegistry) {
    const selPlugin = reg.getPlugin('selection') as any;
    if (!selPlugin) return;

    const container = document.querySelector('embedpdf-container');
    const sr = container?.shadowRoot;
    if (!sr) return;

    const scrollEl = sr.querySelector('.bg-bg-app');
    if (!scrollEl) return;

    scrollEl.addEventListener('mouseup', () => {
      // Delay to let the selection plugin finalize its state
      setTimeout(() => {
        const store = reg.getStore();
        const state = store.getState();
        const docId = state.core.activeDocumentId;
        if (!docId) return;

        const docState = selPlugin.getDocumentState(docId);
        if (!docState?.selection?.start) return;

        const { page, index } = docState.selection.start;
        selectSentenceAtCharIndex(page, index);
      }, 150);
    });
  }

  // --- Registry ready handler ---
  function handleRegistryReady(reg: PluginRegistry) {
    registry = reg;
    engine = reg.getEngine();

    // Expose registry globally for debugging
    (window as any).__registry = reg;

    // Listen for document loads
    const store = reg.getStore();
    store.onAction('SET_DOCUMENT_LOADED', (action: any, state: any) => {
      // The action payload contains the document directly
      const docId = action.payload?.documentId ?? action.documentId;
      const doc = action.payload?.document;
      
      if (doc && engine) {
        pdfDoc = doc;
        extractTextFromDoc(engine, doc);
      } else {
        // Fallback: get document from state
        const activeId = state.core.activeDocumentId;
        if (activeId && engine) {
          const docState = state.core.documents[activeId];
          if (docState?.document) {
            pdfDoc = docState.document;
            extractTextFromDoc(engine, docState.document);
          }
        }
      }

      // Wire selection detection after shadow DOM renders the pages
      setTimeout(() => wireSelectionDetection(reg), 500);
    });
  }

  // --- PDF loading ---
  let isDragOver = $state(false);

  function loadPdfFile(file: File) {
    // Revoke previous blob URL if any
    if (pdfSrc && pdfSrc.startsWith('blob:')) {
      URL.revokeObjectURL(pdfSrc);
    }
    pdfSrc = URL.createObjectURL(file);
  }

  function loadPdfFromUrl(url: string) {
    pdfSrc = url;
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

  // --- Keyboard shortcuts (capture phase to intercept before EmbedPDF's shadow DOM) ---
  function handleKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        e.stopPropagation();
        handlePlayClick();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        if (currentSentenceIndex > 0) {
          currentSentenceIndex--;
          if (isPlaying) startPlaybackFrom(currentSentenceIndex);
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        if (currentSentenceIndex < sentences.length - 1) {
          currentSentenceIndex++;
          if (isPlaying) startPlaybackFrom(currentSentenceIndex);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        handleSpeedChange(Math.min(3.0, speed + 0.25));
        break;
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        handleSpeedChange(Math.max(0.5, speed - 0.25));
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (playbackAbort) playbackAbort.abort();
        audioPipeline.stop();
        isPlaying = false;
        isPaused = false;
        clearHighlight();
        break;
    }
  }

  $effect(() => {
    window.addEventListener('keydown', handleKeydown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeydown, { capture: true });
  });
</script>



{#if !pdfSrc}
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
  <PdfViewer src={pdfSrc} onregistryready={handleRegistryReady} />
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
