/**
 * pdf-text.ts -- Reading-order text extraction and sentence splitting for PDFs.
 *
 * Given a PDFDocumentProxy (from pdfjs-dist), this module:
 *
 *  1. Extracts TextItems from each page.
 *  2. Filters out headers, footers, and page numbers.
 *  3. Uses the PDF content stream order directly for reading order.
 *     Well-formed PDFs (the vast majority) already emit text items in
 *     correct reading order: left column top-to-bottom, then right column.
 *  4. Groups items into paragraphs using font-size changes and Y-gaps.
 *  5. Splits paragraph text into sentences (with abbreviation awareness)
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
// Types
// ---------------------------------------------------------------------------

export interface ItemEntry {
  item: TextItem;
  index: number;
}

// ---------------------------------------------------------------------------
// Page number / header / footer filtering
// ---------------------------------------------------------------------------

/**
 * Filter out page numbers, headers, and footers.
 * - Standalone small numbers in top/bottom margins (page numbers)
 * - Small text in margins (footnotes, affiliations)
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
    const fontSize = Math.abs(e.item.transform[3]);
    const str = e.item.str.trim();

    // Standalone page numbers: small text, pure number, in top/bottom margin
    if (/^\d{1,4}$/.test(str) && fontSize < medianFontSize * 1.1) {
      const inTopRegion = y > pageHeight - marginY * 2;
      const inBottomRegion = y < marginY * 2;
      if (inTopRegion || inBottomRegion) return false;
    }

    // Headers/footers: small text in margins
    const inTopMargin = y > pageHeight - marginY;
    const inBottomMargin = y < marginY * 2;
    if ((inTopMargin || inBottomMargin) && fontSize <= medianFontSize * 0.9) {
      return false;
    }

    return true;
  });
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
 * Uses the PDF content stream order directly (correct in well-formed PDFs),
 * filters non-body items, groups into paragraphs, then splits into sentences.
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

    // --- Use PDF content stream order (already correct for reading) ---
    // Filter page numbers, headers, footers, then keep stream order.
    const filtered = filterNonBodyItems(items, pageWidth, pageHeight);

    if (filtered.length === 0) continue;

    // --- Build spans with proper spacing and paragraph grouping ---
    interface Span {
      text: string;
      itemIndices: number[];
    }

    const paragraphs: Span[][] = [[]];

    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const prevEntry = i > 0 ? filtered[i - 1] : null;
      const nextEntry = i < filtered.length - 1 ? filtered[i + 1] : null;

      // --- Detect paragraph break ---
      if (prevEntry && isParagraphBreak(prevEntry, entry)) {
        const currentParagraph = paragraphs[paragraphs.length - 1];
        if (currentParagraph.length > 0) {
          paragraphs.push([]);
        }
      }

      // --- Build span ---
      const str = entry.item.str;
      const isLastOnLine = entry.item.hasEOL || i === filtered.length - 1;
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
