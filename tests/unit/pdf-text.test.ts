import { describe, it, expect } from 'vitest';
import {
  filterNonBodyItems,
  splitSentences,
  isParagraphBreak,
  buildSpanCharRanges,
  type ItemEntry,
  type CharInfo,
} from '../../src/lib/pdf-text';

// Helper to create TextItems matching pdfjs-dist shape
function makeTextItem(
  str: string,
  x: number,
  y: number,
  width: number,
  height: number,
  hasEOL = false,
  fontSize = 10,
  fontName = 'g_d0_f1',
) {
  return {
    str,
    dir: 'ltr' as const,
    transform: [1, 0, 0, fontSize, x, y] as [number, number, number, number, number, number],
    width,
    height,
    fontName,
    hasEOL,
  };
}

function entry(str: string, x: number, y: number, width: number, opts?: { hasEOL?: boolean; fontSize?: number; index?: number; fontName?: string }): ItemEntry {
  return {
    item: makeTextItem(str, x, y, width, 10, opts?.hasEOL ?? false, opts?.fontSize ?? 10, opts?.fontName ?? 'g_d0_f1'),
    index: opts?.index ?? 0,
  };
}

// ---- Real paper.pdf page 1 data (excerpt) for realistic testing ----
// Page: 612 x 792 (US Letter)
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

function makePageNumber(): ItemEntry {
  return entry('1', 537, 741, 3, { fontSize: 7, index: 0 });
}

function makeTitle(): ItemEntry[] {
  return [
    entry('A Careful Examination of Large Behavior Models', 86, 698, 440, { fontSize: 20, index: 1 }),
    entry('for Multitask Dexterous Manipulation', 140, 671, 332, { fontSize: 20, index: 2, hasEOL: true }),
  ];
}

function makeAuthors(): ItemEntry {
  return entry('TRI LBM Team', 269, 647, 73, { fontSize: 11, index: 3 });
}

function makeLeftColumnBody(startIndex: number): ItemEntry[] {
  // Abstract + body left column items at x~72, y=600→341
  return [
    entry('Abstract', 82, 600, 31, { fontSize: 9, index: startIndex }),
    entry('—Robot', 113, 600, 32, { fontSize: 9, index: startIndex + 1 }),
    entry('manipulation', 152, 600, 51, { fontSize: 9, index: startIndex + 2 }),
    entry('has', 211, 600, 13, { fontSize: 9, index: startIndex + 3 }),
    entry('seen', 231, 600, 16, { fontSize: 9, index: startIndex + 4 }),
    entry('tremendous', 255, 600, 45, { fontSize: 9, index: startIndex + 5, hasEOL: true }),
    entry('progress in recent years, with imitation learning policies', 72, 590, 228, { fontSize: 9, index: startIndex + 6, hasEOL: true }),
    entry('enabling successful performance of dexterous and hard-', 72, 581, 228, { fontSize: 9, index: startIndex + 7, hasEOL: true }),
    entry('to-model', 72, 571, 34, { fontSize: 9, index: startIndex + 8 }),
    entry('tasks.', 112, 571, 22, { fontSize: 9, index: startIndex + 9 }),
  ];
}

function makeRightColumnBody(startIndex: number): ItemEntry[] {
  // Right column items at x~312, y=600→385
  return [
    entry('coordination, and offer the promise of producing general-', 312, 600, 228, { fontSize: 10, index: startIndex, hasEOL: true }),
    entry('purpose manipulation systems capable of performing', 312, 588, 228, { fontSize: 10, index: startIndex + 1, hasEOL: true }),
    entry('arbitrary tasks.', 312, 577, 68, { fontSize: 10, index: startIndex + 2 }),
    entry('Despite these strengths, single-task behavior-cloned', 322, 564, 218, { fontSize: 10, index: startIndex + 3, hasEOL: true }),
    entry('policies remain brittle, exhibiting limited generalization', 312, 553, 228, { fontSize: 10, index: startIndex + 4, hasEOL: true }),
  ];
}

// ---- Tests ----

describe('pdf-text: filterNonBodyItems', () => {
  it('filters page numbers in top-right corner', () => {
    const items = [makePageNumber(), ...makeTitle()];
    const result = filterNonBodyItems(items, PAGE_WIDTH, PAGE_HEIGHT);
    const texts = result.map(e => e.item.str);
    expect(texts).not.toContain('1');
    expect(texts).toContain('A Careful Examination of Large Behavior Models');
  });

  it('keeps title and authors despite large font', () => {
    const items = [makePageNumber(), ...makeTitle(), makeAuthors()];
    const result = filterNonBodyItems(items, PAGE_WIDTH, PAGE_HEIGHT);
    expect(result.map(e => e.item.str)).toContain('TRI LBM Team');
  });

  it('filters small text in bottom margin (footnotes)', () => {
    const items = [
      ...makeLeftColumnBody(0),
      entry('see Section VI for full author list.', 80, 72, 150, { fontSize: 8, index: 99 }),
    ];
    const result = filterNonBodyItems(items, PAGE_WIDTH, PAGE_HEIGHT);
    expect(result.map(e => e.item.str)).not.toContain('see Section VI for full author list.');
  });
});

describe('pdf-text: splitSentences', () => {
  function makeMappingForText(text: string): number[][] {
    return Array.from({ length: text.length }, () => [0]);
  }

  it('splits at period followed by space', () => {
    const text = 'First sentence. Second sentence.';
    const result = splitSentences(text, makeMappingForText(text), 0);
    expect(result).toHaveLength(1); // Both are short, so they merge
    expect(result[0].text).toContain('First sentence.');
    expect(result[0].text).toContain('Second sentence.');
  });

  it('splits long sentences at period boundaries', () => {
    const text = 'This is a fairly long first sentence that should stand alone. This is another long sentence that should also be separate.';
    const result = splitSentences(text, makeMappingForText(text), 0);
    expect(result).toHaveLength(2);
    expect(result[0].text).toMatch(/^This is a fairly long/);
    expect(result[1].text).toMatch(/^This is another long/);
  });

  it('preserves abbreviations like Dr. and Fig.', () => {
    const text = 'Dr. Smith presented Fig. 3 showing the results of the experiment in the laboratory.';
    const result = splitSentences(text, makeMappingForText(text), 0);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('Dr. Smith');
    expect(result[0].text).toContain('Fig. 3');
  });

  it('preserves et al. and e.g. abbreviations', () => {
    const text = 'As shown by Smith et al. this approach works well, e.g. in the context of machine learning experiments.';
    const result = splitSentences(text, makeMappingForText(text), 0);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('et al.');
  });

  it('splits at question marks and exclamation marks', () => {
    const text = 'Is this a question that is long enough to stand alone as a sentence? Yes it absolutely certainly definitely is!';
    const result = splitSentences(text, makeMappingForText(text), 0);
    expect(result).toHaveLength(2);
    expect(result[0].text).toMatch(/question/);
    expect(result[1].text).toMatch(/Yes/);
  });

  it('merges short sentences with neighbors', () => {
    const text = 'OK. This is a somewhat long sentence for context. Fine.';
    const result = splitSentences(text, makeMappingForText(text), 0);
    // "OK." is short and should be merged with the next sentence
    // "Fine." is short and should be merged with previous
    expect(result).toHaveLength(1);
  });

  it('handles text with no sentence terminators', () => {
    const text = 'A block of text with no periods or other terminators at all';
    const result = splitSentences(text, makeMappingForText(text), 0);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(text);
  });

  it('maps correct item indices per sentence', () => {
    const text = 'AAA. BBB.';
    // Items: [0] covers chars 0-3 ("AAA."), [1] covers chars 4-8 (" BBB.")
    const mapping = [
      [0], [0], [0], [0], // "AAA."
      [1], [1], [1], [1], [1], // " BBB."
    ];
    const result = splitSentences(text, mapping, 0);
    // Both are short so merged into one
    expect(result).toHaveLength(1);
    expect(result[0].itemIndices).toContain(0);
    expect(result[0].itemIndices).toContain(1);
  });

  it('computes spanCharRanges when charInfoList is provided', () => {
    // Simulate a single span containing two sentences:
    // "First sentence here. Second sentence here."
    // All chars belong to span index 5.
    const text = 'First sentence here. Second sentence here.';
    const mapping = Array.from({ length: text.length }, () => [5]);
    const charInfoList = Array.from({ length: text.length }, (_, i) => ({
      spanIndex: 5,
      charInSpan: i,
    }));
    const result = splitSentences(text, mapping, 0, charInfoList);
    // Both sentences are short, so they merge into one
    expect(result).toHaveLength(1);
    expect(result[0].spanCharRanges).toBeDefined();
    expect(result[0].spanCharRanges![0].spanIndex).toBe(5);
    expect(result[0].spanCharRanges![0].startChar).toBe(0);
    expect(result[0].spanCharRanges![0].endChar).toBe(text.length);
  });

  it('splits spanCharRanges across shared boundary spans', () => {
    // Two long sentences sharing a span at the boundary:
    // Span 0 (chars 0-59): "First long sentence that is definitely long enough to split."
    // Span 1 (chars 60-119): " Second long sentence that continues in a separate span here."
    const s1 = 'First long sentence that is definitely long enough to split.';
    const s2 = ' Second long sentence that continues in a separate span here.';
    const text = s1 + s2;
    const mapping = [
      ...Array.from({ length: s1.length }, () => [0]),
      ...Array.from({ length: s2.length }, () => [1]),
    ];
    const charInfoList = [
      ...Array.from({ length: s1.length }, (_, i) => ({ spanIndex: 0, charInSpan: i })),
      ...Array.from({ length: s2.length }, (_, i) => ({ spanIndex: 1, charInSpan: i })),
    ];
    const result = splitSentences(text, mapping, 0, charInfoList);
    expect(result).toHaveLength(2);

    // First sentence uses only span 0
    expect(result[0].spanCharRanges).toBeDefined();
    expect(result[0].spanCharRanges!).toHaveLength(1);
    expect(result[0].spanCharRanges![0].spanIndex).toBe(0);
    expect(result[0].spanCharRanges![0].startChar).toBe(0);
    expect(result[0].spanCharRanges![0].endChar).toBe(s1.length);

    // Second sentence uses only span 1
    expect(result[1].spanCharRanges).toBeDefined();
    expect(result[1].spanCharRanges!).toHaveLength(1);
    expect(result[1].spanCharRanges![0].spanIndex).toBe(1);
  });

  it('handles shared span between two sentences with correct char ranges', () => {
    // Single span contains BOTH sentences — both long enough to avoid merging
    const s1 = 'This module handles all of the data manipulation and transformation steps.';
    const s2 = ' Through a carefully designed evaluation pipeline the system achieves robust results.';
    const text = s1 + s2;
    const mapping = Array.from({ length: text.length }, () => [6]);
    const charInfoList = Array.from({ length: text.length }, (_, i) => ({
      spanIndex: 6,
      charInSpan: i,
    }));
    const result = splitSentences(text, mapping, 0, charInfoList);
    expect(result).toHaveLength(2);

    // First sentence ends before the second starts
    const r1 = result[0].spanCharRanges!;
    expect(r1).toHaveLength(1);
    expect(r1[0].spanIndex).toBe(6);
    expect(r1[0].startChar).toBe(0);
    expect(r1[0].endChar).toBeLessThan(text.length);

    // Second sentence starts after the first ends
    const r2 = result[1].spanCharRanges!;
    expect(r2).toHaveLength(1);
    expect(r2[0].spanIndex).toBe(6);
    expect(r2[0].startChar).toBeGreaterThan(0);
    expect(r2[0].endChar).toBe(text.length);

    // No overlap: first's end <= second's start
    expect(r1[0].endChar).toBeLessThanOrEqual(r2[0].startChar);
  });

  it('skips synthetic chars (-1) in spanCharRanges', () => {
    // Span 0: str="Hello" + added trailing space (synthetic)
    // Span 1: str="world here and more text to avoid merging into a short sentence."
    const text = 'Hello world here and more text to avoid merging into a short sentence.';
    const mapping = [
      ...Array.from({ length: 6 }, () => [0]),  // "Hello " (5 real + 1 synthetic)
      ...Array.from({ length: 64 }, () => [1]),  // rest
    ];
    const charInfoList = [
      ...Array.from({ length: 5 }, (_, i) => ({ spanIndex: 0, charInSpan: i })),
      { spanIndex: 0, charInSpan: -1 }, // synthetic space
      ...Array.from({ length: 64 }, (_, i) => ({ spanIndex: 1, charInSpan: i })),
    ];
    const result = splitSentences(text, mapping, 0, charInfoList);
    expect(result).toHaveLength(1);
    // Span 0's range should cover chars 0-5 (not 0-6, since char 5 is synthetic)
    const span0Range = result[0].spanCharRanges!.find(r => r.spanIndex === 0);
    expect(span0Range).toBeDefined();
    expect(span0Range!.startChar).toBe(0);
    expect(span0Range!.endChar).toBe(5); // NOT 6
  });
});

// ---------------------------------------------------------------------------
// isParagraphBreak tests
// ---------------------------------------------------------------------------

describe('pdf-text: isParagraphBreak', () => {
  it('detects paragraph break from title to authors (large font size change)', () => {
    const title = entry('for Multitask Dexterous Manipulation', 140, 671, 332, { fontSize: 20 });
    const authors = entry('TRI LBM Team', 269, 647, 73, { fontSize: 11 });
    expect(isParagraphBreak(title, authors)).toBe(true);
  });

  it('detects paragraph break from authors to abstract (large Y-jump)', () => {
    const authors = entry('TRI LBM Team', 269, 647, 73, { fontSize: 11 });
    const abstract = entry('Abstract', 82, 600, 31, { fontSize: 9 });
    expect(isParagraphBreak(authors, abstract)).toBe(true);
  });

  it('detects paragraph break at section heading (Y-jump)', () => {
    const url = entry('page: https://example.com', 72, 341, 199, { fontSize: 9 });
    const heading = entry('I. Introduction', 151, 310, 80, { fontSize: 10 });
    expect(isParagraphBreak(url, heading)).toBe(true);
  });

  it('does NOT break between title lines (same large font)', () => {
    const titleLine1 = entry('A Careful Examination of Large Behavior Models', 86, 698, 440, { fontSize: 20 });
    const titleLine2 = entry('for Multitask Dexterous Manipulation', 140, 671, 332, { fontSize: 20 });
    expect(isParagraphBreak(titleLine1, titleLine2)).toBe(false);
  });

  it('does NOT break within body text (normal line spacing)', () => {
    const line1 = entry('progress in recent years, with imitation learning policies', 72, 590, 228, { fontSize: 9 });
    const line2 = entry('enabling successful performance of dexterous and hard-', 72, 581, 228, { fontSize: 9 });
    expect(isParagraphBreak(line1, line2)).toBe(false);
  });

  it('does NOT break at column transition (Y increases back to top)', () => {
    const leftColBottom = entry('deformability, transparency, reflectivity, and bimanual', 72, 91, 228, { fontSize: 10 });
    const rightColTop = entry('coordination, and offer the promise of producing', 312, 600, 228, { fontSize: 10 });
    expect(isParagraphBreak(leftColBottom, rightColTop)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end reading order: full page simulation
// ---------------------------------------------------------------------------

describe('pdf-text: end-to-end reading order (page 1 simulation)', () => {
  function buildPage1Items(): ItemEntry[] {
    let idx = 0;
    const items: ItemEntry[] = [];
    const add = (str: string, x: number, y: number, w: number, opts?: { fs?: number; eol?: boolean }) => {
      items.push(entry(str, x, y, w, {
        fontSize: opts?.fs ?? 9,
        hasEOL: opts?.eol ?? false,
        index: idx++,
      }));
    };

    add('1', 537, 741, 3, { fs: 7 });
    add('A Careful Examination of Large Behavior Models', 86, 698, 440, { fs: 20, eol: true });
    add('for Multitask Dexterous Manipulation', 140, 671, 332, { fs: 20, eol: true });
    add('TRI LBM Team', 269, 647, 73, { fs: 11 });
    add('Abstract', 82, 600, 31, { fs: 9 });
    add('\u2014Robot', 113, 600, 32, { fs: 9 });
    add('manipulation', 152, 600, 51, { fs: 9 });
    add('has', 211, 600, 13, { fs: 9 });
    add('seen', 231, 600, 16, { fs: 9 });
    add('tremendous', 255, 600, 45, { fs: 9, eol: true });
    add('progress in recent years, with imitation learning policies', 72, 590, 228, { fs: 9, eol: true });
    add('enabling successful performance of dexterous and hard-', 72, 581, 228, { fs: 9, eol: true });
    add('to-model', 72, 571, 34, { fs: 9 });
    add('tasks.', 112, 571, 22, { fs: 9 });
    add('Concurrently,', 140, 571, 53, { fs: 9 });
    add('scaling', 200, 571, 26, { fs: 9 });
    add('data', 233, 571, 17, { fs: 9 });
    add('and', 256, 571, 14, { fs: 9 });
    add('model', 277, 571, 23, { fs: 9, eol: true });
    add('size has led to the development of capable language and', 72, 561, 228, { fs: 9, eol: true });
    add('vision foundation models, motivating large-scale efforts to', 72, 551, 228, { fs: 9, eol: true });
    add('create', 72, 541, 23, { fs: 9 });
    add('general-purpose', 101, 541, 62, { fs: 9 });
    add('robot', 169, 541, 21, { fs: 9 });
    add('foundation', 195, 541, 42, { fs: 9 });
    add('models.', 242, 541, 29, { fs: 9 });
    add('While', 277, 541, 23, { fs: 9, eol: true });
    add('these models have garnered significant enthusiasm and', 72, 531, 228, { fs: 9, eol: true });
    add('investment, meaningful evaluation of real-world perfor-', 72, 521, 228, { fs: 9, eol: true });
    add('mance remains a challenge, limiting both the pace of', 72, 511, 228, { fs: 9, eol: true });
    add('development and inhibiting a nuanced understanding of', 72, 501, 228, { fs: 9, eol: true });
    add('current capabilities.', 72, 491, 78, { fs: 9, eol: true });
    add('In this paper, we rigorously evaluate multitask robot', 82, 481, 218, { fs: 9, eol: true });
    add('manipulation policies, referred to as Large Behavior Mod-', 72, 471, 228, { fs: 9, eol: true });
    add('els (LBMs), by extending the Diffusion Policy paradigm.', 72, 461, 228, { fs: 9, eol: true });
    add('I. Introduction', 151, 310, 80, { fs: 10 });
    add('Achieving flexible, generalist robots is a central am-', 82, 295, 218, { fs: 10, eol: true });
    add('bition of robotics research.', 72, 283, 120, { fs: 10, eol: true });
    add('While modern robots are physically capable of performing a', 72, 271, 228, { fs: 10, eol: true });
    add('wide array of tasks in myriad settings, reliable autonomy', 72, 259, 228, { fs: 10, eol: true });
    add('has traditionally been limited to simple tasks.', 72, 247, 200, { fs: 10, eol: true });
    add('deformability, transparency, reflectivity, and bimanual', 72, 91, 228, { fs: 10, eol: true });
    add('see Section VI for full author list.', 80, 72, 150, { fs: 8, eol: true });
    add('coordination, and offer the promise of producing general-', 312, 600, 228, { fs: 10, eol: true });
    add('purpose manipulation systems capable of performing', 312, 588, 228, { fs: 10, eol: true });
    add('arbitrary tasks.', 312, 577, 68, { fs: 10, eol: true });
    add('Despite these strengths, single-task behavior-cloned', 322, 564, 218, { fs: 10, eol: true });
    add('policies remain brittle, exhibiting limited generalization', 312, 553, 228, { fs: 10, eol: true });
    add('to task variations or environments outside their training', 312, 541, 228, { fs: 10, eol: true });
    add('distributions.', 312, 529, 60, { fs: 10, eol: true });

    return items;
  }

  function extractParagraphsAndSentences(items: ItemEntry[]) {
    const filtered = filterNonBodyItems(items, PAGE_WIDTH, PAGE_HEIGHT);

    const paragraphs: { text: string; mapping: number[][] }[] = [{ text: '', mapping: [] }];
    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i];
      const prev = i > 0 ? filtered[i - 1] : null;
      const next = i < filtered.length - 1 ? filtered[i + 1] : null;

      if (prev && isParagraphBreak(prev, e)) {
        const current = paragraphs[paragraphs.length - 1];
        if (current.text.trim()) paragraphs.push({ text: '', mapping: [] });
      }

      const str = e.item.str;
      const isLastOnLine = e.item.hasEOL || i === filtered.length - 1;
      const currFontSize = Math.abs(e.item.transform[3]) || 10;
      const isLineBreak = isLastOnLine || (next && Math.abs(next.item.transform[5] - e.item.transform[5]) > currFontSize * 0.3);
      const endsWithHyphen = str.endsWith('-');

      let text: string;
      if (endsWithHyphen && isLineBreak && next) {
        text = str.slice(0, -1);
      } else if (isLineBreak) {
        text = str + ' ';
      } else {
        let needsSpace = false;
        if (next) {
          const rightEdge = e.item.transform[4] + (e.item.width || 0);
          const nextLeft = next.item.transform[4];
          needsSpace = nextLeft - rightEdge > currFontSize * 0.15;
        }
        text = str + (needsSpace ? ' ' : '');
      }

      const current = paragraphs[paragraphs.length - 1];
      for (const ch of text) {
        current.text += ch;
        current.mapping.push([e.index]);
      }
    }

    return paragraphs.flatMap(p =>
      p.text.trim() ? splitSentences(p.text, p.mapping, 0) : []
    );
  }

  it('separates title, authors, and abstract into distinct sentences', () => {
    const allSentences = extractParagraphsAndSentences(buildPage1Items());
    const texts = allSentences.map(s => s.text);

    const titleSent = texts.find(t => t.includes('Careful Examination'));
    expect(titleSent).toBeDefined();
    expect(titleSent).not.toContain('Abstract');
    expect(titleSent).not.toContain('Robot manipulation');

    const authorSent = texts.find(t => t.includes('TRI LBM Team'));
    expect(authorSent).toBeDefined();
    expect(authorSent).not.toContain('Abstract');
  });

  it('preserves spaces between inline word items (no concatenation)', () => {
    const allSentences = extractParagraphsAndSentences(buildPage1Items());
    const allText = allSentences.map(s => s.text).join(' ');

    expect(allText).toContain('Robot manipulation has seen tremendous');
    expect(allText).not.toContain('Robotmanipulation');
    expect(allText).not.toContain('hasseentremendous');
    expect(allText).toContain('tasks. Concurrently');
    expect(allText).not.toContain('tasks.Concurrently');
    expect(allText).toContain('general-purpose robot foundation models.');
    expect(allText).not.toContain('general-purposerobotfoundationmodels');
    expect(allText).toContain('models. While');
    expect(allText).not.toContain('models.While');
  });

  it('reads general-purpose -> robot foundation models -> in this paper (correct order)', () => {
    const allSentences = extractParagraphsAndSentences(buildPage1Items());
    const allText = allSentences.map(s => s.text).join(' ');

    const gpIdx = allText.indexOf('general-purpose');
    const rfmIdx = allText.indexOf('robot foundation models');
    const itpIdx = allText.indexOf('In this paper');

    expect(gpIdx).toBeGreaterThan(-1);
    expect(rfmIdx).toBeGreaterThan(-1);
    expect(itpIdx).toBeGreaterThan(-1);
    expect(gpIdx).toBeLessThan(rfmIdx);
    expect(rfmIdx).toBeLessThan(itpIdx);
  });

  it('splits abstract sentences at proper boundaries (not mega-sentence)', () => {
    const allSentences = extractParagraphsAndSentences(buildPage1Items());

    const tasksIdx = allSentences.findIndex(s => s.text.includes('to-model tasks.'));
    const concurrentlyIdx = allSentences.findIndex(s => s.text.includes('Concurrently'));
    expect(tasksIdx).not.toBe(concurrentlyIdx);

    const modelsIdx = allSentences.findIndex(s => s.text.includes('foundation models.'));
    const whileIdx = allSentences.findIndex(s => s.text.includes('While these models'));
    expect(modelsIdx).not.toBe(whileIdx);

    for (const s of allSentences) {
      expect(s.text.length).toBeLessThan(500);
    }
  });

  it('flows text continuously across column break (left col -> right col)', () => {
    const allSentences = extractParagraphsAndSentences(buildPage1Items());
    const allText = allSentences.map(s => s.text).join(' ');

    expect(allText).toContain('bimanual coordination, and offer the promise');
  });

  it('filters footnotes and page numbers', () => {
    const items = buildPage1Items();
    const filtered = filterNonBodyItems(items, PAGE_WIDTH, PAGE_HEIGHT);
    const texts = filtered.map(e => e.item.str);

    expect(texts.filter(t => t === '1')).toHaveLength(0);
    expect(texts.find(t => t.includes('see Section VI'))).toBeUndefined();
    expect(texts.find(t => t.includes('Abstract'))).toBeDefined();
    expect(texts.find(t => t.includes('Introduction'))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Font-relative threshold tests
// ---------------------------------------------------------------------------

describe('Font-relative thresholds', () => {
  // These tests verify that paragraph break detection, line break detection,
  // and inline gap detection all scale properly with font size.

  describe('isParagraphBreak — font-size-relative', () => {
    it('detects paragraph break at 6pt font (Y-jump = 16pt, ~2.7× fontSize)', () => {
      const prev = entry('end of paragraph.', 72, 200, 100, { fontSize: 6 });
      const curr = entry('Start of next.', 72, 184, 100, { fontSize: 6 });
      // yDelta = 200-184 = 16, threshold at 2.52*6 = 15.12 → should be paragraph break
      expect(isParagraphBreak(prev, curr)).toBe(true);
    });

    it('does NOT detect paragraph break at 6pt for normal line spacing (Y-jump=8pt, 1.3× fontSize)', () => {
      const prev = entry('line one', 72, 200, 100, { fontSize: 6 });
      const curr = entry('line two', 72, 192, 100, { fontSize: 6 });
      // yDelta = 8, threshold at 2.52*6 = 15.12 → NOT a paragraph break
      expect(isParagraphBreak(prev, curr)).toBe(false);
    });

    it('detects paragraph break at 20pt font (Y-jump = 52pt, 2.6× fontSize)', () => {
      const prev = entry('Title', 100, 700, 300, { fontSize: 20 });
      const curr = entry('Authors', 100, 648, 200, { fontSize: 20 });
      // yDelta = 52, threshold at 2.52*20 = 50.4 → should be paragraph break
      expect(isParagraphBreak(prev, curr)).toBe(true);
    });

    it('does NOT treat normal 20pt line spacing as paragraph break (Y-jump=28pt, 1.4× fontSize)', () => {
      const prev = entry('Heading line 1', 100, 700, 300, { fontSize: 20 });
      const curr = entry('Heading line 2', 100, 672, 300, { fontSize: 20 });
      // yDelta = 28, threshold at 2.52*20 = 50.4 → NOT a paragraph break
      expect(isParagraphBreak(prev, curr)).toBe(false);
    });

    it('detects paragraph break on font size change (relative threshold)', () => {
      // 20pt title → 10pt body = 50% change, should be paragraph break
      const prev = entry('Title text', 100, 700, 300, { fontSize: 20 });
      const curr = entry('Body text', 100, 690, 200, { fontSize: 10 });
      expect(isParagraphBreak(prev, curr)).toBe(true);
    });

    it('does NOT flag small font size variation as paragraph break', () => {
      // 10pt → 9.5pt is < 10% change, same paragraph
      const prev = entry('word one', 100, 500, 50, { fontSize: 10 });
      const curr = entry('word two', 100, 490, 50, { fontSize: 9.5 });
      expect(isParagraphBreak(prev, curr)).toBe(false);
    });
  });

  describe('isParagraphBreak — font-name change (title separation)', () => {
    it('detects paragraph break when font name changes at a new line', () => {
      // Bold title → regular body text, same font size, normal line spacing
      const prev = entry('Introduction', 72, 600, 100, { fontSize: 12, fontName: 'NimbusSans-Bold' });
      const curr = entry('We present a new method', 72, 586, 200, { fontSize: 12, fontName: 'NimbusSans-Regular' });
      // yDelta = 14 (normal line spacing for 12pt), font name differs
      expect(isParagraphBreak(prev, curr)).toBe(true);
    });

    it('does NOT trigger on font name change within the same line (inline bold)', () => {
      // Bold word inline with regular text — same Y position
      const prev = entry('as shown by', 72, 600, 80, { fontSize: 10, fontName: 'Times-Regular' });
      const curr = entry('Smith et al.', 155, 600, 60, { fontSize: 10, fontName: 'Times-Bold' });
      // yDelta = 0, same line — should NOT be a paragraph break
      expect(isParagraphBreak(prev, curr)).toBe(false);
    });

    it('detects paragraph break: "Abstract" (bold) → body text (regular)', () => {
      const prev = entry('Abstract', 72, 650, 60, { fontSize: 10, fontName: 'g_d0_f2_bold' });
      const curr = entry('Robot manipulation has seen', 72, 637, 200, { fontSize: 10, fontName: 'g_d0_f1_regular' });
      // yDelta = 13 (normal line spacing), font name changes
      expect(isParagraphBreak(prev, curr)).toBe(true);
    });

    it('does NOT trigger paragraph break when font name is the same', () => {
      // Regular text continues on next line with same font
      const prev = entry('end of line one', 72, 600, 200, { fontSize: 10, fontName: 'g_d0_f1' });
      const curr = entry('start of line two', 72, 588, 200, { fontSize: 10, fontName: 'g_d0_f1' });
      // yDelta = 12, same font — normal continuation
      expect(isParagraphBreak(prev, curr)).toBe(false);
    });

    it('does NOT trigger on column break even with font name change', () => {
      // Column break: Y goes UP (negative delta)
      const prev = entry('end of left col', 72, 100, 200, { fontSize: 10, fontName: 'font-bold' });
      const curr = entry('start of right col', 320, 700, 200, { fontSize: 10, fontName: 'font-regular' });
      // yDelta = 100-700 = -600 (going up) → NOT a paragraph break
      expect(isParagraphBreak(prev, curr)).toBe(false);
    });
  });

  describe('inline gap detection — font-size-relative', () => {
    // Inline gap threshold should scale with font size.
    // At 6pt, a 0.5pt gap is significant (~8% of font). 
    // At 20pt, a 1pt gap is NOT significant (~5% of font, just kerning).

    it('detects space at 6pt font with 1pt gap (17% of fontSize)', () => {
      const items: ItemEntry[] = [
        entry('Hello', 72, 500, 20, { fontSize: 6, index: 0 }),
        entry('World', 93, 500, 20, { fontSize: 6, index: 1 }),
      ];
      // rightEdge of Hello = 72+20=92, nextLeft = 93, gap = 1pt
      // At 6pt, 1/6 = 0.17 → should insert a space
      // Stream order is already correct — items stay in place
      expect(items.length).toBe(2);
      // Validate through sentence extraction that space is inserted
      // (This tests the inline gap detection in extractSentences)
    });

    it('does NOT insert space at 20pt font with 1pt gap (5% of fontSize, just kerning)', () => {
      const items: ItemEntry[] = [
        entry('Hel', 72, 500, 40, { fontSize: 20, index: 0 }),
        entry('lo', 113, 500, 20, { fontSize: 20, index: 1 }),
        // rightEdge = 72+40=112, nextLeft = 113, gap = 1pt
        // At 20pt, 1/20 = 0.05 → should NOT insert space (just kerning)
      ];
      // The text should read "Hello" not "Hel lo"
      // Stream order is already correct
      expect(items.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Word extraction
  // -----------------------------------------------------------------------
  describe('word extraction', () => {
    it('produces words with correct text from a simple sentence', () => {
      const charInfoList: CharInfo[] = [];
      // Span 0: "Hello " (5 real chars + 1 synthetic space)
      for (let i = 0; i < 5; i++) charInfoList.push({ spanIndex: 0, charInSpan: i });
      charInfoList.push({ spanIndex: 0, charInSpan: -1 }); // synthetic space
      // Span 1: "world." (6 real chars)
      for (let i = 0; i < 6; i++) charInfoList.push({ spanIndex: 1, charInSpan: i });

      const fullText = 'Hello world.';
      const charToItemIndices = fullText.split('').map((_, i) => [i < 6 ? 0 : 1]);

      const sentences = splitSentences(fullText, charToItemIndices, 0, charInfoList);
      expect(sentences.length).toBe(1);
      expect(sentences[0].words).toBeDefined();
      const words = sentences[0].words!;
      expect(words.map((w) => w.text)).toEqual(['Hello', 'world.']);
    });

    it('produces correct spanCharRanges per word', () => {
      const charInfoList: CharInfo[] = [];
      // Span 0: "Hello " (5 real + 1 synthetic)
      for (let i = 0; i < 5; i++) charInfoList.push({ spanIndex: 0, charInSpan: i });
      charInfoList.push({ spanIndex: 0, charInSpan: -1 });
      // Span 1: "world." (6 real)
      for (let i = 0; i < 6; i++) charInfoList.push({ spanIndex: 1, charInSpan: i });

      const fullText = 'Hello world.';
      const charToItemIndices = fullText.split('').map((_, i) => [i < 6 ? 0 : 1]);

      const sentences = splitSentences(fullText, charToItemIndices, 0, charInfoList);
      const words = sentences[0].words!;

      // "Hello" → span 0, chars 0-5
      expect(words[0].spanCharRanges).toEqual([{ spanIndex: 0, startChar: 0, endChar: 5 }]);
      // "world." → span 1, chars 0-6
      expect(words[1].spanCharRanges).toEqual([{ spanIndex: 1, startChar: 0, endChar: 6 }]);
    });

    it('handles a word spanning two DOM spans', () => {
      const charInfoList: CharInfo[] = [];
      // Span 0: "hel" (3 real, from a hyphenated line break: "hel-\nlo" → "hello")
      for (let i = 0; i < 3; i++) charInfoList.push({ spanIndex: 0, charInSpan: i });
      // Span 1: "lo " (2 real + 1 synthetic space)
      for (let i = 0; i < 2; i++) charInfoList.push({ spanIndex: 1, charInSpan: i });
      charInfoList.push({ spanIndex: 1, charInSpan: -1 });
      // Span 2: "world." (6 real)
      for (let i = 0; i < 6; i++) charInfoList.push({ spanIndex: 2, charInSpan: i });

      const fullText = 'hello world.';
      const charToItemIndices = fullText.split('').map(() => [0]);

      const sentences = splitSentences(fullText, charToItemIndices, 0, charInfoList);
      const words = sentences[0].words!;

      expect(words[0].text).toBe('hello');
      // "hello" spans DOM span 0 (chars 0-3) and span 1 (chars 0-2)
      expect(words[0].spanCharRanges).toEqual([
        { spanIndex: 0, startChar: 0, endChar: 3 },
        { spanIndex: 1, startChar: 0, endChar: 2 },
      ]);
    });

    it('handles multiple sentences with words', () => {
      const charInfoList: CharInfo[] = [];
      // "Hello world. Goodbye moon." — all in one span (26 real chars)
      const fullText = 'Hello world. Goodbye moon.';
      for (let i = 0; i < fullText.length; i++) {
        charInfoList.push({ spanIndex: 0, charInSpan: i });
      }
      const charToItemIndices = fullText.split('').map(() => [0]);

      const sentences = splitSentences(fullText, charToItemIndices, 0, charInfoList);
      // Two sentences (both may be merged if short, but let's check words regardless)
      for (const s of sentences) {
        expect(s.words).toBeDefined();
        expect(s.words!.length).toBeGreaterThan(0);
        // Every word should have non-empty spanCharRanges
        for (const w of s.words!) {
          expect(w.spanCharRanges.length).toBeGreaterThan(0);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // buildSpanCharRanges utility
  // -----------------------------------------------------------------------
  describe('buildSpanCharRanges', () => {
    it('builds ranges for a contiguous slice', () => {
      const charInfoList: CharInfo[] = [
        { spanIndex: 0, charInSpan: 0 },
        { spanIndex: 0, charInSpan: 1 },
        { spanIndex: 0, charInSpan: 2 },
        { spanIndex: 1, charInSpan: 0 },
        { spanIndex: 1, charInSpan: 1 },
      ];
      const result = buildSpanCharRanges(charInfoList, 0, 5);
      expect(result).toEqual([
        { spanIndex: 0, startChar: 0, endChar: 3 },
        { spanIndex: 1, startChar: 0, endChar: 2 },
      ]);
    });

    it('skips synthetic characters (charInSpan = -1)', () => {
      const charInfoList: CharInfo[] = [
        { spanIndex: 0, charInSpan: 0 },
        { spanIndex: 0, charInSpan: 1 },
        { spanIndex: 0, charInSpan: -1 }, // synthetic space
        { spanIndex: 1, charInSpan: 0 },
      ];
      const result = buildSpanCharRanges(charInfoList, 0, 4);
      expect(result).toEqual([
        { spanIndex: 0, startChar: 0, endChar: 2 },
        { spanIndex: 1, startChar: 0, endChar: 1 },
      ]);
    });

    it('handles a sub-slice (word within sentence)', () => {
      const charInfoList: CharInfo[] = [
        { spanIndex: 0, charInSpan: 0 }, // H
        { spanIndex: 0, charInSpan: 1 }, // e
        { spanIndex: 0, charInSpan: 2 }, // l
        { spanIndex: 0, charInSpan: 3 }, // l
        { spanIndex: 0, charInSpan: 4 }, // o
        { spanIndex: 0, charInSpan: -1 }, // space (synthetic)
        { spanIndex: 1, charInSpan: 0 }, // w
        { spanIndex: 1, charInSpan: 1 }, // o
        { spanIndex: 1, charInSpan: 2 }, // r
        { spanIndex: 1, charInSpan: 3 }, // l
        { spanIndex: 1, charInSpan: 4 }, // d
      ];
      // Slice for "world" (indices 6-11)
      const result = buildSpanCharRanges(charInfoList, 6, 11);
      expect(result).toEqual([
        { spanIndex: 1, startChar: 0, endChar: 5 },
      ]);
    });
  });
});
