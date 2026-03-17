/**
 * highlight-rects.ts — Pixel-perfect highlight rectangle computation.
 *
 * Ported from react-pdf-highlighter (MIT license, agentcooper).
 * Uses the DOM Range API to get sub-span-precision bounding boxes,
 * then merges adjacent/overlapping rects on the same line.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Given a Range and a page element, return highlight rectangles
 * in page-relative (textLayer-relative) coordinates.
 */
export function getRectsFromRange(
  range: Range,
  textLayer: HTMLElement,
): Rect[] {
  const clientRects = Array.from(range.getClientRects());
  const tlRect = textLayer.getBoundingClientRect();

  // Compensate for CSS scale transforms on the textLayer
  const scaleX = tlRect.width > 0 ? textLayer.offsetWidth / tlRect.width : 1;
  const scaleY = tlRect.height > 0 ? textLayer.offsetHeight / tlRect.height : 1;

  const rects: Rect[] = [];
  for (const cr of clientRects) {
    if (cr.width <= 0 || cr.height <= 0) continue;
    // Skip rects outside the textLayer bounds
    if (
      cr.bottom < tlRect.top ||
      cr.top > tlRect.bottom ||
      cr.right < tlRect.left ||
      cr.left > tlRect.right
    ) continue;
    rects.push({
      left: (cr.left - tlRect.left) * scaleX,
      top: (cr.top - tlRect.top) * scaleY,
      width: cr.width * scaleX,
      height: cr.height * scaleY,
    });
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Rect optimization — group by line, merge into continuous rectangles.
// pdf.js text layer uses absolutely-positioned spans, so getClientRects()
// returns per-span rects with gaps. We group by Y-overlap and produce one
// continuous rectangle per line.
// ---------------------------------------------------------------------------

export function optimizeRects(clientRects: Rect[]): Rect[] {
  if (clientRects.length === 0) return [];

  // Filter degenerate rects
  const rects = clientRects.filter(r => r.width > 0.5 && r.height > 0.5);
  if (rects.length === 0) return [];

  // Remove rects fully inside another (duplicates from layered DOM)
  const deduped = rects.filter((rect) =>
    rects.every(
      (other) =>
        rect === other ||
        !(
          rect.top >= other.top &&
          rect.left >= other.left &&
          rect.top + rect.height <= other.top + other.height &&
          rect.left + rect.width <= other.left + other.width
        ),
    ),
  );

  // Group into lines by Y overlap
  type Line = { left: number; right: number; top: number; bottom: number };
  const lines: Line[] = [];

  // Sort by top then left for stable grouping
  const sorted = deduped.slice().sort((a, b) => a.top - b.top || a.left - b.left);

  for (const r of sorted) {
    const rBottom = r.top + r.height;
    let merged = false;
    for (const line of lines) {
      const overlapY = Math.min(rBottom, line.bottom) - Math.max(r.top, line.top);
      const minH = Math.min(r.height, line.bottom - line.top);
      if (minH > 0 && overlapY / minH > 0.5) {
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.left + r.width);
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, rBottom);
        merged = true;
        break;
      }
    }
    if (!merged) {
      lines.push({ left: r.left, right: r.left + r.width, top: r.top, bottom: rBottom });
    }
  }

  return lines.map((l) => ({
    left: l.left,
    top: l.top,
    width: l.right - l.left,
    height: l.bottom - l.top,
  }));
}
