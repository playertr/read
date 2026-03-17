<script lang="ts">
  import type { PluginRegistry } from '@embedpdf/svelte-pdf-viewer';

  interface HighlightRect {
    /** Absolute X within the document container (CSS pixels). */
    x: number;
    /** Absolute Y within the document container (CSS pixels). */
    y: number;
    width: number;
    height: number;
  }

  interface Props {
    /** Highlight rectangles in absolute document-container coords (CSS px). */
    rects: HighlightRect[];
    /** The EmbedPDF registry (used to locate the shadow DOM). */
    registry: PluginRegistry | null;
  }

  let { rects, registry }: Props = $props();

  let overlays: HTMLElement[] = [];
  let highlightLayer: HTMLElement | null = null;

  /** Find (or create) the highlight layer inside the EmbedPDF shadow DOM's
   *  document container — the div with position:relative that spans all pages. */
  function getHighlightLayer(): HTMLElement | null {
    if (highlightLayer?.isConnected) return highlightLayer;
    highlightLayer = null;

    const container = document.querySelector('embedpdf-container');
    const sr = container?.shadowRoot;
    if (!sr) return null;

    // The scroll container is .bg-bg-app
    const scrollEl = sr.querySelector('.bg-bg-app');
    if (!scrollEl) return null;

    // Navigate: scrollEl → inline-block wrapper → document container (position: relative)
    const wrapper = scrollEl.firstElementChild as HTMLElement | null;
    const docContainer = wrapper?.firstElementChild as HTMLElement | null;
    if (!docContainer || !docContainer.style.position?.includes('relative')) return null;

    // Look for existing highlight layer
    let layer = docContainer.querySelector('.tts-highlight-layer') as HTMLElement | null;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'tts-highlight-layer';
      layer.style.cssText = `
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 20;
      `;
      docContainer.appendChild(layer);
    }
    highlightLayer = layer;
    return layer;
  }

  $effect(() => {
    // Remove previous overlays
    for (const o of overlays) o.remove();
    overlays = [];

    if (rects.length === 0 || !registry) return;

    const layer = getHighlightLayer();
    if (!layer) return;

    for (const rect of rects) {
      const div = document.createElement('div');
      div.className = 'reading-highlight-overlay';
      div.style.cssText = `
        position: absolute;
        left: ${rect.x}px;
        top: ${rect.y}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        background: rgba(66, 133, 244, 0.35);
        border-radius: 2px;
        pointer-events: none;
      `;
      layer.appendChild(div);
      overlays.push(div);
    }

    // Scroll the first highlight into view within the shadow DOM scroll container
    if (overlays.length > 0) {
      overlays[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    return () => {
      for (const o of overlays) o.remove();
      overlays = [];
    };
  });
</script>
