<script lang="ts">
  interface Props {
    activeSentenceSpans: HTMLElement[];
  }

  let { activeSentenceSpans }: Props = $props();

  let overlays: HTMLElement[] = [];

  /**
   * Build continuous highlight rectangles by grouping spans into lines
   * and creating a single overlay per line. This avoids the gaps between
   * pdf.js's absolutely-positioned text spans.
   */
  function buildOverlays(spans: HTMLElement[]): HTMLElement[] {
    if (spans.length === 0) return [];

    const textLayer = spans[0].closest('.textLayer') as HTMLElement | null;
    if (!textLayer) return [];

    const tlRect = textLayer.getBoundingClientRect();

    // Group spans into lines by Y position
    type Line = { left: number; right: number; top: number; bottom: number };
    const lines: Line[] = [];

    for (const span of spans) {
      const r = span.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;

      const relLeft = r.left - tlRect.left;
      const relTop = r.top - tlRect.top;
      const relRight = relLeft + r.width;
      const relBottom = relTop + r.height;

      // Find existing line within vertical tolerance
      let merged = false;
      for (const line of lines) {
        const overlapY = Math.min(relBottom, line.bottom) - Math.max(relTop, line.top);
        const minH = Math.min(r.height, line.bottom - line.top);
        if (minH > 0 && overlapY / minH > 0.5) {
          line.left = Math.min(line.left, relLeft);
          line.right = Math.max(line.right, relRight);
          line.top = Math.min(line.top, relTop);
          line.bottom = Math.max(line.bottom, relBottom);
          merged = true;
          break;
        }
      }
      if (!merged) {
        lines.push({ left: relLeft, right: relRight, top: relTop, bottom: relBottom });
      }
    }

    // Convert from viewport-relative to textLayer-local coordinates.
    // If textLayer has a CSS scale transform we need to compensate.
    const scaleX = tlRect.width > 0 ? textLayer.offsetWidth / tlRect.width : 1;
    const scaleY = tlRect.height > 0 ? textLayer.offsetHeight / tlRect.height : 1;

    const result: HTMLElement[] = [];
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = 'reading-highlight-overlay';
      div.style.cssText = `
        position: absolute;
        left: ${line.left * scaleX}px;
        top: ${line.top * scaleY}px;
        width: ${(line.right - line.left) * scaleX}px;
        height: ${(line.bottom - line.top) * scaleY}px;
        pointer-events: none;
        z-index: 0;
      `;
      textLayer.appendChild(div);
      result.push(div);
    }
    return result;
  }

  $effect(() => {
    // Remove previous overlays
    for (const o of overlays) o.remove();
    overlays = [];

    if (activeSentenceSpans.length === 0) return;

    overlays = buildOverlays(activeSentenceSpans);

    // Smooth-scroll the first active span into view
    activeSentenceSpans[0].scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

    return () => {
      for (const o of overlays) o.remove();
      overlays = [];
    };
  });
</script>
