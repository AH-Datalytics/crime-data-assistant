/**
 * Chart label text, measured rather than estimated (docs/superpowers/specs/2026-10-28-answer-columns-and-chart-labels.md
 * section 5; owner item 3.1, labels "cut at narrow widths").
 *
 * Widths come from the browser's own text measurement in the chart's tick font, so a long agency name, a wide glyph
 * or a large number is sized as drawn. Outside a browser (server render, Node tests) a per-character estimate stands
 * in; the browser re-measures on mount, after fonts load and on resize. Labels are wrapped, never cut: no ellipsis.
 */

export const TICK_FONT_SIZE = 13;
export const TICK_FONT_FAMILY = "'DM Sans', 'Segoe UI', Arial, sans-serif";
export const TICK_FONT = `${TICK_FONT_SIZE}px ${TICK_FONT_FAMILY}`;
/** Line advance for wrapped tick text, px. */
export const TICK_LINE_HEIGHT = 15;

/** The estimate used where nothing can measure: about 7.2 px per character at 13 px DM Sans. */
export const ESTIMATED_CHAR_WIDTH = 7.2;

export type Measure = (text: string) => number;

export const estimateWidth: Measure = (text) => text.length * ESTIMATED_CHAR_WIDTH;

let canvasMeasure: Measure | null = null;
const cache = new Map<string, number>();

/** The browser's measurement in the tick font, or the estimate where there is no canvas. Cached per string. */
export const measureTickText: Measure = (text) => {
  if (canvasMeasure === null) {
    const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    if (!ctx) return estimateWidth(text);
    canvasMeasure = (t) => { ctx.font = TICK_FONT; return ctx.measureText(t).width; };
  }
  let w = cache.get(text);
  if (w === undefined) { w = canvasMeasure(text); cache.set(text, w); }
  return w;
};

/** Called once the page's fonts have loaded: earlier measurements may have used a fallback font. */
export function resetTickTextCache(): void {
  cache.clear();
}

/**
 * The label wrapped onto as many lines as it needs, each no wider than `maxWidth`. A single word wider than the line
 * is broken between characters rather than cut. Never adds an ellipsis.
 */
export function wrapLabel(label: string, maxWidth: number, measure: Measure = measureTickText): string[] {
  const width = Math.max(1, maxWidth);
  const lines: string[] = [];
  let cur = "";
  const pushWord = (word: string) => {
    if (measure(word) <= width) { cur = word; return; }
    let piece = "";
    for (const ch of word) {
      if (piece && measure(piece + ch) > width) { lines.push(piece); piece = ch; } else piece += ch;
    }
    cur = piece;
  };
  for (const word of String(label).split(/\s+/).filter(Boolean)) {
    if (!cur) pushWord(word);
    else if (measure(`${cur} ${word}`) <= width) cur = `${cur} ${word}`;
    else { lines.push(cur); pushWord(word); }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** The widest of the labels as measured. */
export function widestLabel(labels: readonly string[], measure: Measure = measureTickText): number {
  return labels.reduce((m, l) => Math.max(m, measure(l)), 0);
}

/** Height of an x axis whose labels are wrapped flat under bars `perBar` px wide. */
export function wrappedAxisHeight(labels: readonly string[], perBar: number, measure: Measure = measureTickText): number {
  const lines = labels.reduce((m, l) => Math.max(m, wrapLabel(l, perBar - 6, measure).length), 1);
  return 14 + TICK_LINE_HEIGHT * (lines - 1) + 10;
}

/** Slanted labels taller than this (about 35 characters) make category bars draw sideways instead. */
export const MAX_SLANTED_AXIS = 200;

/** Height of an x axis whose labels are slanted at 45 degrees. */
export function slantedAxisHeight(labels: readonly string[], measure: Measure = measureTickText): number {
  return Math.max(60, Math.ceil(widestLabel(labels, measure) * Math.SQRT1_2 + TICK_FONT_SIZE + 16));
}

/** Width of the label column of sideways bars: the widest label, at most half the box. */
export function sideLabelWidth(labels: readonly string[], boxWidth: number, measure: Measure = measureTickText): number {
  const cap = Math.max(60, Math.round(boxWidth * 0.5));
  return Math.min(cap, Math.max(60, Math.ceil(widestLabel(labels, measure)) + 14));
}

/** Width of a value axis: the widest formatted tick plus the gap to the plot. */
export function valueAxisWidth(ticks: readonly string[], measure: Measure = measureTickText): number {
  return Math.max(40, Math.ceil(widestLabel(ticks, measure)) + 12);
}

/**
 * Left margin so the first slanted label (rotated -45 degrees, anchored at its end under the first tick) is not cut
 * at the chart's left edge. The label reaches width x cos 45 left of its tick; the tick sits at margin + value axis +
 * half a band, and the band itself narrows as the margin grows: band = (box - margin - axis - right) / bars. Solved
 * for the margin.
 */
export function slantedLeftMargin(firstLabel: string, valueAxisWidth: number, boxWidth: number, bars: number,
  rightMargin = 24, measure: Measure = measureTickText): number {
  if (boxWidth <= 0) return 8;
  const reach = measure(firstLabel) * Math.SQRT1_2 + 6;
  const n = Math.max(1, bars);
  const need = (reach - valueAxisWidth - (boxWidth - valueAxisWidth - rightMargin) / (2 * n)) / (1 - 1 / (2 * n));
  return Math.max(8, Math.ceil(need));
}
