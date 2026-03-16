<script lang="ts">
  import { onMount } from 'svelte';
  import type { PDFDocumentProxy } from 'pdfjs-dist';
  import {
    PDFViewer as PdfJsViewer,
    EventBus,
    PDFLinkService,
  } from 'pdfjs-dist/web/pdf_viewer.mjs';
  import 'pdfjs-dist/web/pdf_viewer.css';

  interface Props {
    pdf: PDFDocumentProxy | null;
    onsentenceclick?: (event: { text: string; pageIndex: number }) => void;
  }

  let { pdf, onsentenceclick }: Props = $props();

  let containerEl: HTMLDivElement;
  let viewerEl: HTMLDivElement;
  let pdfViewer: PdfJsViewer | null = null;
  let eventBus: EventBus | null = null;
  let currentZoom = $state(100);
  let pagesReady = $state(false);

  onMount(() => {
    eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });

    pdfViewer = new PdfJsViewer({
      container: containerEl,
      viewer: viewerEl,
      eventBus,
      linkService,
      removePageBorders: false,
      textLayerMode: 1, // ENABLE
      annotationMode: 0, // DISABLE — hides misaligned link boxes
    });
    linkService.setViewer(pdfViewer);

    eventBus.on('scalechanging', (evt: { scale: number }) => {
      currentZoom = Math.round(evt.scale * 100);
    });

    return () => {
      pdfViewer?.cleanup();
    };
  });

  // Load document into viewer when pdf prop changes
  $effect(() => {
    if (!pdfViewer || !pdf || !eventBus) return;

    pagesReady = false;

    const onPagesInit = () => {
      pdfViewer!.currentScaleValue = 'page-width';
      pagesReady = true;
    };
    eventBus.on('pagesinit', onPagesInit);

    pdfViewer.setDocument(pdf);
    (pdfViewer as any).linkService?.setDocument(pdf);

    return () => {
      eventBus!.off('pagesinit', onPagesInit);
    };
  });

  // --- Zoom ---
  function zoomIn() {
    if (pdfViewer) pdfViewer.currentScale = Math.min(pdfViewer.currentScale * 1.15, 5.0);
  }
  function zoomOut() {
    if (pdfViewer) pdfViewer.currentScale = Math.max(pdfViewer.currentScale / 1.15, 0.25);
  }
  function zoomFitWidth() {
    if (pdfViewer) pdfViewer.currentScaleValue = 'page-width';
  }

  // Ctrl/Cmd+scroll and trackpad pinch = zoom (continuous)
  function handleWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (!pdfViewer) return;
      // trackpad pinch produces fractional deltaY; scroll wheel gives larger steps
      const factor = Math.pow(1.01, -e.deltaY);
      pdfViewer.currentScale = Math.min(Math.max(pdfViewer.currentScale * factor, 0.25), 5.0);
    }
  }

  // Text selection for "read from here"
  function handleMouseUp() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString().trim();
    if (!text) return;

    const anchorNode = selection.anchorNode;
    if (!anchorNode) return;
    const pageEl = (anchorNode instanceof HTMLElement ? anchorNode : anchorNode.parentElement)
      ?.closest('.page');
    if (!pageEl) return;

    const pageNumber = Number(pageEl.getAttribute('data-page-number'));
    if (!isNaN(pageNumber)) {
      onsentenceclick?.({ text, pageIndex: pageNumber - 1 });
    }
  }

  export function scrollToPage(pageIndex: number) {
    if (pdfViewer) pdfViewer.currentPageNumber = pageIndex + 1;
  }

  // Expose zoom methods for keyboard shortcuts from parent
  export { zoomIn, zoomOut, zoomFitWidth };
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="viewer-wrapper" onwheel={handleWheel} onmouseup={handleMouseUp}>
  <div class="viewer-container" bind:this={containerEl}>
    <div class="pdfViewer" bind:this={viewerEl}></div>
  </div>

  {#if pdf}
    <div class="zoom-toolbar">
      <button onclick={zoomOut} title="Zoom out (Ctrl −)">−</button>
      <span class="zoom-pct">{currentZoom}%</span>
      <button onclick={zoomIn} title="Zoom in (Ctrl +)">+</button>
      <button class="fit-btn" onclick={zoomFitWidth} title="Fit to width">↔</button>
    </div>
  {/if}
</div>

<style>
  .viewer-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
  }

  .viewer-container {
    position: absolute;
    inset: 0;
    overflow: auto;
    background: #525659;
  }

  /* Zoom toolbar — top-right floating */
  .zoom-toolbar {
    position: absolute;
    top: 12px;
    right: 24px;
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(24, 24, 28, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 8px;
    padding: 4px 8px;
    z-index: 100;
    user-select: none;
  }

  .zoom-toolbar button {
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #e0e0e0;
    font-size: 1.1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .zoom-toolbar button:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .zoom-pct {
    color: #ccc;
    font-size: 0.8rem;
    min-width: 42px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .fit-btn {
    font-size: 0.95rem !important;
  }

  /* Override pdf.js viewer page styles for our dark theme */
  .viewer-container :global(.pdfViewer .page) {
    margin: 8px auto;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  /* Ensure text layer spans for reading are selectable */
  .viewer-container :global(.textLayer span)::selection {
    background: rgba(0, 100, 200, 0.4);
  }
</style>
