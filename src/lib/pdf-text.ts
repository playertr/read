/**
 * pdf-text.ts -- Reading-order text extraction and sentence splitting for PDFs.
 *
 * Given a PDFDocumentProxy (from pdfjs-dist), this module:
 *
 *  1. Extracts TextItems from each page.
 *  2. Filters out headers, footers, and page numbers.
 *  3. Detects two-column layouts via a histogram of line-start X positions.
 *  4. Validates whether the PDF content stream already provides correct
 *     reading order (left column then right column). If so, uses stream
 *     order directly. If the stream interleaves columns, falls back to
 *     heuristic Y-then-X sorting per column.
 *  5. Groups items into paragraphs using font-size changes and Y-gaps.
 *  6. Splits paragraph text into sentences (with abbreviation awareness)
 *     and maps each sentence back to its source TextItem indices for
 *     highlight positioning in the rendered PDF.
 *
 * The main entry point is extractSentences().
 */

import type { PDFDocumentProxy } from "pdfjs-dist";

/** Mirrors pdfjs-dist's TextItem (not re-exported from the main entry). */
export interface TextItem {
  str: string;
  dir: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

export interface Sentence {
  text: string;
  pageIndex: number;
  /** Indices into the page's TextItem array, for highlight positioning. */
  itemIndices: number[];
}

// ---------------------------------------------------------------------------
// Column-detection helpers (exported for unit testing)
// ---------------------------------------------------------------------------

export interface ItemEntry {
  item: TextItem;
  index: number;
}

/**
 * Detect whether a page has a two-column layout by looking for a vertical gap
 * in the X-distribution of text items in the body region.
 *
 * Returns `null` for single-column or { leftMax, rightMin } for two-column.
 */
export function detectColumns(
  items: ItemEntry[],
  pageWidth: number,
  _pageHeight: number,
): { leftMax: number; rightMin: number } | null {
  const fontSizes = items.map((e) => Math.abs(e.item.transform[3]));
  const sortedSizes = [...fontSizes].sort((a, b) => a - b);
  const medianFontSize = sortedSizes[Math.floor(sortedSizes.length / 2)];
  const maxBodySize = medianFontSize * 1.3;

  const bodyItems = items.filter((e) => {
    const fs = Math.abs(e.item.transform[3]);
    const w = e.item.width ?? 0;
    return fs <= maxBodySize && (w / pageWidth) < 0.6;
  });

  if (bodyItems.length < 10) return null;

  // Group items into text lines by Y-coordinate proximity, then use each
  // line's leftmost X (start position) for histogram.  Individual words
  // scatter midpoints across the column, masking the gutter gap.  Line
  // starts cluster tightly at each column margin.
  const yTolerance = medianFontSize * 0.5;
  const textLines: { y: number; minX: number }[] = [];
  for (const e of bodyItems) {
    const y = e.item.transform[5];
    const x = e.item.transform[4];
    let merged = false;
    for (const line of textLines) {
      if (Math.abs(line.y - y) < yTolerance) {
        line.minX = Math.min(line.minX, x);
        merged = true;
        break;
      }
    }
    if (!merged) {
      textLines.push({ y, minX: x });
    }
  }

  if (textLines.length < 6) return null;

  // Sort line-start positions and find the largest jump between consecutive
  // starts where both sides have enough lines.  This is more robust than
  // histogram binning: a single indented heading can't break the gap because
  // it only shifts one value, and the jump between the two column clusters
  // will always dominate.
  const starts = textLines.map((l) => l.minX).sort((a, b) => a - b);
  const minGroupSize = 5;

  let bestJump = 0;
  let bestJumpIdx = -1;
  for (let i = minGroupSize; i <= starts.length - minGroupSize; i++) {
    const jump = starts[i] - starts[i - 1];
    if (jump > bestJump) {
      bestJump = jump;
      bestJumpIdx = i;
    }
  }

  if (bestJumpIdx === -1) return null;

  // The gap must span at least 15% of page width to be a real column gutter.
  if (bestJump < pageWidth * 0.15) return null;

  const gapLeft = starts[bestJumpIdx - 1];
  const gapRight = starts[bestJumpIdx];
  const gapCenter = (gapLeft + gapRight) / 2;

  // Reject if the gap is not roughly centered (within 30–70% of page).
  if (gapCenter < pageWidth * 0.3 || gapCenter > pageWidth * 0.7) return null;

  // Classify body items by which side of the gap they fall on.
  const boundary = (gapLeft + gapRight) / 2;
  const leftItems = bodyItems.filter(
    (e) => e.item.transform[4] < boundary,
  );
  const rightItems = bodyItems.filter(
    (e) => e.item.transform[4] >= boundary,
  );

  if (leftItems.length < 5 || rightItems.length < 5) return null;

  const leftMax = Math.max(
    ...leftItems.map((e) => e.item.transform[4] + (e.item.width ?? 0)),
  );
  const rightMin = Math.min(...rightItems.map((e) => e.item.transform[4]));

  return { leftMax, rightMin };
}

/**
 * Classify an item as "full-width" (spanning across the column boundary)
 * or belonging to a specific column.
 *
 *  - Returns -1 for full-width / spanning items
 *  - Returns 0 for left column
 *  - Returns 1 for right column
 */
export function classifyItem(
  entry: ItemEntry,
  columns: { leftMax: number; rightMin: number },
  pageWidth: number,
): -1 | 0 | 1 {
  const x = entry.item.transform[4];
  const w = entry.item.width ?? 0;
  const rightEdge = x + w;
  const midX = (columns.leftMax + columns.rightMin) / 2;

  if (x < midX && rightEdge > midX) return -1;
  if (w > pageWidth * 0.5) return -1;

  return x + w / 2 < midX ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Stream-order validation
// ---------------------------------------------------------------------------

/**
 * Validate that the content stream order is already correct for a two-column
 * page. In correct stream order, all items in one column section appear
 * consecutively (not interleaved with the other column).
 *
 * Returns true if stream order is valid (items flow through columns in blocks,
 * not zigzagging between left and right).
 */
export function isStreamOrderValid(
  items: ItemEntry[],
  columns: { leftMax: number; rightMin: number },
  pageWidth: number,
): boolean {
  // Classify each item into columns
  const cols = items.map((e) => classifyItem(e, columns, pageWidth));

  // Count column transitions (ignoring full-width items).
  // Valid stream order: full-width*, left*, right* (or any contiguous blocks)
  // Invalid: L R L R (interleaved)
  let transitions = 0;
  let lastCol: 0 | 1 | null = null;

  for (const col of cols) {
    if (col === -1) continue; // skip full-width
    if (lastCol !== null && col !== lastCol) {
      transitions++;
    }
    lastCol = col;
  }

  // A valid two-column layout has at most a few transitions
  // (e.g., full-width header breaks columns into bands, each band = 1 transition)
  // An interleaved mess would have many transitions
  return transitions <= 4;
}

// ---------------------------------------------------------------------------
// Page number / header / footer filtering
// ---------------------------------------------------------------------------

/**
 * Filter out page numbers, headers, and footers.
 * Uses multiple heuristics:
 * - Items in top/bottom margins with small or non-body font sizes
 * - Standalone small numbers in corners (page numbers)
 */
export function filterNonBodyItems(
  items: ItemEntry[],
  pageWidth: number,
  pageHeight: number,
): ItemEntry[] {
  if (items.length === 0) return [];

  const fontSizes = items.map((e) => Math.abs(e.item.transform[3]));
  const sortedSizes = [...fontSizes].sort((a, b) => a - b);
  const medianFontSize = sortedSizes[Math.floor(sortedSizes.length / 2)];

  const marginY = pageHeight * 0.06;

  return items.filter((e) => {
    const y = e.item.transform[5];
    const x = e.item.transform[4];
    const fontSize = Math.abs(e.item.transform[3]);
    const str = e.item.str.trim();

    // Standalone page numbers: small text, pure number, in top/bottom margin
    // Page numbers can be in corners OR centered (e.g., centered at bottom)
    if (/^\d{1,4}$/.test(str) && fontSize < medianFontSize * 1.1) {
      const inTopRegion = y > pageHeight - marginY * 2;
      const inBottomRegion = y < marginY * 2;
      if (inTopRegion || inBottomRegion) return false;
    }

    // Headers/footers: small text in margins (use wider margin for bottom
    // to catch footnotes/affiliations that sit above the strict margin)
    const inTopMargin = y > pageHeight - marginY;
    const inBottomMargin = y < marginY * 2;
    if ((inTopMargin || inBottomMargin) && fontSize <= medianFontSize * 0.9) {
      return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Reading order: stream-first with column-validation fallback
// ---------------------------------------------------------------------------

/**
 * Determine reading order for items on a page.
 *
 * Strategy:
 * 1. Check if page is two-column.
 * 2. If so, validate that the PDF content stream order is already correct
 *    (most well-formed PDFs emit left column then right column).
 * 3. If stream order is valid, use it directly — this is the most reliable
 *    approach and avoids format-specific heuristics.
 * 4. If stream order is invalid (interleaved columns), fall back to
 *    heuristic sorting: full-width items first, then left col, then right col
 *    per Y-band.
 * 5. For single-column pages, use Y-descending (top to bottom) order.
 */
export function sortReadingOrder(
  items: ItemEntry[],
  pageWidth: number,
  pageHeight: number,
): ItemEntry[] {
  if (items.length === 0) return [];

  const columns = detectColumns(items, pageWidth, pageHeight);

  if (!columns) {
    // Single-column: Y descending, then X ascending
    return [...items].sort((a, b) => {
      const yA = a.item.transform[5];
      const yB = b.item.transform[5];
      if (Math.abs(yA - yB) > 2) return yB - yA;
      return a.item.transform[4] - b.item.transform[4];
    });
  }

  // Two-column detected — check if stream order is already correct
  if (isStreamOrderValid(items, columns, pageWidth)) {
    // Stream order is good — use it as-is (it already reads left then right)
    return items;
  }

  // Stream order is interleaved — fall back to heuristic sort
  return sortReadingOrderHeuristic(items, columns, pageWidth);
}

/**
 * Heuristic column sort: group by column classification, emit
 * full-width → left col → right col per Y-band.
 */
function sortReadingOrderHeuristic(
  items: ItemEntry[],
  columns: { leftMax: number; rightMin: number },
  pageWidth: number,
): ItemEntry[] {
  const classified = items.map((entry) => ({
    entry,
    col: classifyItem(entry, columns, pageWidth),
  }));

  const fullWidth = classified
    .filter((c) => c.col === -1)
    .map((c) => c.entry);
  const leftCol = classified.filter((c) => c.col === 0).map((c) => c.entry);
  const rightCol = classified.filter((c) => c.col === 1).map((c) => c.entry);

  const sortByY = (arr: ItemEntry[]) =>
    [...arr].sort((a, b) => {
      const yA = a.item.transform[5];
      const yB = b.item.transform[5];
      if (Math.abs(yA - yB) > 2) return yB - yA;
      return a.item.transform[4] - b.item.transform[4];
    });

  fullWidth.sort((a, b) => b.item.transform[5] - a.item.transform[5]);
  const leftSorted = sortByY(leftCol);
  const rightSorted = sortByY(rightCol);

  const allColumnItems = [...leftSorted, ...rightSorted];
  if (allColumnItems.length === 0) return sortByY(fullWidth);

  const columnTopY = Math.max(...allColumnItems.map((e) => e.item.transform[5]));
  const columnBottomY = Math.min(...allColumnItems.map((e) => e.item.transform[5]));

  const aboveColumns = fullWidth.filter(
    (e) => e.item.transform[5] > columnTopY + 2,
  );
  const belowColumns = fullWidth.filter(
    (e) => e.item.transform[5] < columnBottomY - 2,
  );
  const betweenColumns = fullWidth.filter(
    (e) =>
      e.item.transform[5] <= columnTopY + 2 &&
      e.item.transform[5] >= columnBottomY - 2,
  );

  betweenColumns.sort((a, b) => b.item.transform[5] - a.item.transform[5]);

  const result: ItemEntry[] = [];
  result.push(...aboveColumns);

  if (betweenColumns.length === 0) {
    result.push(...leftSorted, ...rightSorted);
  } else {
    const breakYs = betweenColumns.map((e) => e.item.transform[5]);
    const allBreakYs = [columnTopY + 10, ...breakYs, columnBottomY - 10];
    const bands: { topY: number; bottomY: number }[] = [];
    for (let i = 0; i < allBreakYs.length - 1; i++) {
      bands.push({ topY: allBreakYs[i], bottomY: allBreakYs[i + 1] });
    }

    for (let b = 0; b < bands.length; b++) {
      const band = bands[b];
      const inBandLeft = leftSorted.filter(
        (e) =>
          e.item.transform[5] < band.topY &&
          e.item.transform[5] >= band.bottomY,
      );
      const inBandRight = rightSorted.filter(
        (e) =>
          e.item.transform[5] < band.topY &&
          e.item.transform[5] >= band.bottomY,
      );
      result.push(...inBandLeft, ...inBandRight);

      if (b < betweenColumns.length) {
        result.push(betweenColumns[b]);
      }
    }
  }

  result.push(...belowColumns);
  return result;
}

// ---------------------------------------------------------------------------
// Sentence splitting with abbreviation handling
// ---------------------------------------------------------------------------

/** Common abbreviations that should NOT trigger a sentence break. */
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

/**
 * Split text into sentences with awareness of abbreviations and minimum
 * length. Short fragments are merged with their neighbors.
 */
export function splitSentences(
  fullText: string,
  charToItemIndices: number[][],
  pageIndex: number,
): Sentence[] {
  const raw: { text: string; start: number; end: number }[] = [];

  // Walk through the text finding sentence boundaries
  let sentStart = 0;
  for (let i = 0; i < fullText.length; i++) {
    const ch = fullText[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    // Check for multiple consecutive terminators (e.g., "..." or "?!")
    let endPunct = i;
    while (
      endPunct + 1 < fullText.length &&
      ".!?".includes(fullText[endPunct + 1])
    ) {
      endPunct++;
    }

    // Must be followed by whitespace or end-of-string to be a break
    const afterPunct = endPunct + 1;
    if (afterPunct < fullText.length && !/\s/.test(fullText[afterPunct])) {
      i = endPunct;
      continue;
    }

    // Check for abbreviation: word before the period
    if (ch === ".") {
      const beforePeriod = fullText.slice(sentStart, i);
      const lastWordMatch = beforePeriod.match(/(\w+)$/);
      if (lastWordMatch) {
        const lastWord = lastWordMatch[1].toLowerCase();
        if (ABBREVIATIONS.has(lastWord)) {
          i = endPunct;
          continue;
        }
        // Single uppercase letter (initials like "A." "B.")
        if (/^[A-Z]$/.test(lastWordMatch[1])) {
          i = endPunct;
          continue;
        }
      }
      // Number before period (e.g., "3." in numbered lists) — only break
      // if followed by a capital letter or long enough text
      if (/\d$/.test(fullText.slice(sentStart, i))) {
        const afterStr = fullText.slice(afterPunct).trimStart();
        if (afterStr.length > 0 && !/^[A-Z]/.test(afterStr)) {
          i = endPunct;
          continue;
        }
      }
    }

    // This is a sentence boundary
    const sentEnd = afterPunct;
    const text = fullText.slice(sentStart, sentEnd).trim();
    if (text.length > 0) {
      raw.push({ text, start: sentStart, end: sentEnd });
    }
    sentStart = sentEnd;
    i = endPunct;
  }

  // Capture trailing text
  if (sentStart < fullText.length) {
    const text = fullText.slice(sentStart).trim();
    if (text.length > 0) {
      raw.push({ text, start: sentStart, end: fullText.length });
    }
  }

  // Merge short sentences (< 40 chars) with neighbors for better TTS intonation
  const MIN_SENTENCE_LENGTH = 40;
  const merged: { text: string; start: number; end: number }[] = [];

  for (const s of raw) {
    if (
      merged.length > 0 &&
      (merged[merged.length - 1].text.length < MIN_SENTENCE_LENGTH ||
        s.text.length < MIN_SENTENCE_LENGTH)
    ) {
      // Merge with previous
      const prev = merged[merged.length - 1];
      prev.text = prev.text + " " + s.text;
      prev.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }

  // Convert to Sentence objects with item index mapping
  return merged.map((s) => {
    const indexSet = new Set<number>();
    for (let ci = s.start; ci < s.end && ci < charToItemIndices.length; ci++) {
      for (const idx of charToItemIndices[ci]) {
        indexSet.add(idx);
      }
    }
    return {
      text: s.text,
      pageIndex,
      itemIndices: [...indexSet].sort((a, b) => a - b),
    };
  });
}

// ---------------------------------------------------------------------------
// Sentence extraction
// ---------------------------------------------------------------------------

/**
 * Extract reading-order sentences from every page of a PDF document.
 *
 * Strategy: prefer the PDF content stream order (which is semantically correct
 * in most well-formed PDFs), validate with column detection, and fall back to
 * heuristic sorting only when stream order is clearly wrong.
 */
/**
 * Detect paragraph breaks between consecutive sorted items.
 * Uses font-size-relative Y-jump thresholds and font-size/font-name changes.
 *
 * A paragraph break is detected when:
 * - Y decreases (downward) by more than 2.5× the previous item's font size
 *   (accounts for larger line spacing in headings vs body text)
 * - OR font size changes by more than 25% relative (title → body, etc.)
 * - OR font name changes at a line break (bold title → regular body)
 *
 * Column breaks (large Y increase, going back up) are NOT paragraph breaks.
 */
export function isParagraphBreak(
  prevEntry: ItemEntry,
  entry: ItemEntry,
): boolean {
  const prevY = prevEntry.item.transform[5];
  const currY = entry.item.transform[5];
  const yDelta = prevY - currY; // positive = downward (normal reading)

  // Column breaks go upward (negative yDelta) — never a paragraph break
  if (yDelta < 0) return false;

  const prevFs = Math.abs(prevEntry.item.transform[3]);
  const currFs = Math.abs(entry.item.transform[3]);

  // Font-relative font size change: >25% change signals a structural break
  // (e.g., 20pt title → 10pt body = 50%, 10pt → 8pt = 20% → not a break)
  const avgFs = (prevFs + currFs) / 2;
  if (avgFs > 0 && Math.abs(prevFs - currFs) / avgFs > 0.25) return true;

  // Font name change at a line break: title (bold) → body (regular), etc.
  // Only trigger if there's a Y-position change (new line) to avoid
  // false positives from inline bold/italic formatting.
  if (yDelta > 0 && prevEntry.item.fontName !== entry.item.fontName) return true;

  // Y-jump relative to font size: typical line spacing ≈ 1.4× font size,
  // so paragraph breaks are > 1.8× that = 2.52× font size
  const threshold = prevFs * 2.52;
  if (yDelta > threshold) return true;

  return false;
}

export async function extractSentences(
  pdf: PDFDocumentProxy,
): Promise<Sentence[]> {
  const sentences: Sentence[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });

    // Filter to real TextItems (skip TextMarkedContent) with non-empty str
    const items: ItemEntry[] = [];
    for (let i = 0; i < content.items.length; i++) {
      const raw = content.items[i];
      if ("str" in raw && (raw as TextItem).str.trim().length > 0) {
        items.push({ item: raw as TextItem, index: i });
      }
    }

    if (items.length === 0) continue;

    const pageIndex = pageNum - 1;
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    // --- Filter page numbers, headers, footers ---
    const filtered = filterNonBodyItems(items, pageWidth, pageHeight);
    if (filtered.length === 0) continue;

    // --- Determine reading order ---
    const sorted = sortReadingOrder(filtered, pageWidth, pageHeight);

    // --- Build spans with proper spacing and paragraph grouping ---
    interface Span {
      text: string;
      itemIndices: number[];
    }

    const paragraphs: Span[][] = [[]];

    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      const prevEntry = i > 0 ? sorted[i - 1] : null;
      const nextEntry = i < sorted.length - 1 ? sorted[i + 1] : null;

      // --- Detect paragraph break ---
      if (prevEntry && isParagraphBreak(prevEntry, entry)) {
        const currentParagraph = paragraphs[paragraphs.length - 1];
        if (currentParagraph.length > 0) {
          paragraphs.push([]);
        }
      }

      // --- Build span ---
      const str = entry.item.str;
      const isLastOnLine = entry.item.hasEOL || i === sorted.length - 1;
      const endsWithHyphen = str.endsWith("-");
      const currFontSize = Math.abs(entry.item.transform[3]) || 10;
      const isLineBreak =
        isLastOnLine ||
        (nextEntry &&
          Math.abs(nextEntry.item.transform[5] - entry.item.transform[5]) > currFontSize * 0.3);

      let span: Span;
      if (endsWithHyphen && isLineBreak && nextEntry) {
        span = { text: str.slice(0, -1), itemIndices: [entry.index] };
      } else if (isLineBreak) {
        span = { text: str + " ", itemIndices: [entry.index] };
      } else {
        // Same-line items: detect horizontal gaps (missing spaces from
        // filtered-out space-only TextItems)
        let needsSpace = false;
        if (nextEntry) {
          const rightEdge =
            entry.item.transform[4] + (entry.item.width || 0);
          const nextLeft = nextEntry.item.transform[4];
          // Gap > 15% of font size indicates a missing space
          needsSpace = nextLeft - rightEdge > currFontSize * 0.15;
        }
        span = {
          text: str + (needsSpace ? " " : ""),
          itemIndices: [entry.index],
        };
      }

      paragraphs[paragraphs.length - 1].push(span);
    }

    // --- Process each paragraph independently through sentence splitting ---
    for (const paraSpans of paragraphs) {
      let fullText = "";
      const charToItemIndices: number[][] = [];

      for (const span of paraSpans) {
        for (const ch of span.text) {
          fullText += ch;
          charToItemIndices.push(span.itemIndices);
        }
      }

      if (fullText.trim().length === 0) continue;

      const pageSentences = splitSentences(
        fullText,
        charToItemIndices,
        pageIndex,
      );
      sentences.push(...pageSentences);
    }
  }

  return sentences;
}
