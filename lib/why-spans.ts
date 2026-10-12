/**
 * Stage 3b (plan r1.1 F1): explanation spans, found on the raw question BEFORE any tab decides whether the turn asks
 * for data.
 *
 * An explanation span opens at an introducer ("why", "how come", "what explains", "reasons for", "causes of",
 * "what caused", "explain", "evidence for") and ends at the first sentence terminator (? . ! ;) or at a coordinator
 * that opens a data request (", and show ...", ", then list ..."). A conjunction right before the introducer
 * (", and why ...") belongs to the span. Everything outside every span is the turn's data request.
 *
 * The data path sees the question with each span replaced by spaces of equal length, so offsets are unchanged and every
 * tab's existing recognition, binding, K2 and dispatch see only the data request (plan r1.3).
 */

export type ExplanationSpan = {
  /** [start, end) in the raw question, including a leading conjunction and the closing terminator. */
  span: [number, number];
  /** The introducer as written ("why", "how come", ...). */
  introducer: string;
  /** The span's text after the introducer, trimmed and without the terminator: what is to be explained. */
  clause: string;
};

const INTRODUCER = /\bwhy\b|\bhow\s+come\b|\bwhat\s+explains?\b|\breasons?\s+(?:for|why|behind)\b|\bcauses?\s+(?:of|for|behind)\b|\bwhat\s+(?:causes?|caused)\b|\bexplain(?:s|ed)?\b|\bevidence\s+for(?:\s+why)?\b/gi;
const DATA_OPENER = /,\s*(?:and\s+|also\s+|then\s+)?(?:show|give|list|what\s+(?:is|are)|how\s+many|compare|rank|chart|break\s+down|do\s+it|just\s+do\s+it)\b/i;
const LEADING_CONJUNCTION = /(?:,\s*|\s+)(?:and|but|also|so)\s*$|,\s*$/i;

/** The explanation spans of a question, in written order; overlapping introducers share one span. */
export function findExplanationSpans(question: string): ExplanationSpan[] {
  const spans: ExplanationSpan[] = [];
  INTRODUCER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTRODUCER.exec(question))) {
    if (spans.length && m.index < spans[spans.length - 1].span[1]) continue;
    const after = m.index + m[0].length;
    const rest = question.slice(after);
    const term = rest.search(/[?.!;]/);
    const opener = rest.search(DATA_OPENER);
    const cut = [term >= 0 ? term + 1 : -1, opener >= 0 ? opener : -1].filter((x) => x >= 0);
    const end = after + (cut.length ? Math.min(...cut) : rest.length);
    const before = question.slice(0, m.index);
    const lead = before.match(LEADING_CONJUNCTION);
    const start = lead ? m.index - lead[0].length : m.index;
    const clause = question.slice(after, end).replace(/[?.!;]\s*$/, "").trim();
    spans.push({ span: [start, end], introducer: m[0], clause });
    INTRODUCER.lastIndex = end;
  }
  return spans;
}

/** The question with every span replaced by spaces of equal length. */
export function maskSpans(question: string, spans: ExplanationSpan[]): string {
  let out = question;
  for (const s of spans) out = out.slice(0, s.span[0]) + " ".repeat(s.span[1] - s.span[0]) + out.slice(s.span[1]);
  return out;
}

const FILLER = /\b(?:ok(?:ay)?|so|and|also|then|please|just|but|now|well|hey|hmm|is\s+there|are\s+there|can\s+you|could\s+you|tell\s+me|i\s+wonder)\b/gi;

/** True when the masked question still asks for data: something other than filler and punctuation is left. */
export function hasDataRequest(masked: string): boolean {
  return /[\p{L}\p{N}]/u.test(masked.replace(FILLER, " "));
}
