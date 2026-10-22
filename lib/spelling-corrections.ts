/**
 * Option 3 batch 1 (audit/presentation-2026-10-20/OVER-REFUSAL-PLAN-r3.md; Codex r3 ACCEPT): a CLOSED list of observed
 * misspellings of non-geographic words, corrected before the question is read, with the reading stated in the answer.
 *
 * - Closed: each entry is a misspelling seen in the 10-20 baseline (cases named), never a general edit-distance correction.
 * - Never a place, number, code or identifier: places stay with the existing resolver and its guards
 *   (lib/geo-place-resolver.ts); "since 20210" is not corrected (it is clarified). No target word is a place name.
 * - Traceable: the request context keeps the original question and each correction; every delivered text states the
 *   reading ("Read "cirme" as "crime"."), and the log row keeps the user's original words plus the tag
 *   `spelling-corrected`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** `span`: the misspelled word in the ORIGINAL question; `normalizedSpan`: its correction in the corrected question. */
export type SpellingCorrection = { from: string; to: string; span: [number, number]; normalizedSpan: [number, number] };
type SpellingContext = { original: string | null; corrections: SpellingCorrection[] };
const store = new AsyncLocalStorage<SpellingContext>();

export const SPELLING_TAG = "spelling-corrected";

/** The closed list. `to` keeps a plural of the matched word where the misspelling had one. */
const RULES: { cases: string; pattern: RegExp; to: (m: RegExpExecArray) => string }[] = [
  { cases: "P019", pattern: /\bcirme(s?)\b/gi, to: (m) => `crime${m[1]}` },
  { cases: "P019", pattern: /\ban\s+drates\b/gi, to: () => "and rates" },
  { cases: "P159", pattern: /\bshootiny\b/gi, to: () => "shooting" },
  { cases: "P139", pattern: /\bcatagor(y|ies)\b/gi, to: (m) => `categor${m[1]}` },
  { cases: "P213, P135", pattern: /\bcomparis(?:son|oon)(s?)\b/gi, to: (m) => `comparison${m[1]}` },
  { cases: "P367", pattern: /\bposession\b/gi, to: () => "possession" },
  // "wit" only where it can only mean "with": before "the" (P217 "the states wit the highest share")
  { cases: "P217", pattern: /\bwit(?=\s+the\b)/gi, to: () => "with" },
  // "ow many" only at the start of the question (P170 "ow many people were killed …")
  { cases: "P170", pattern: /^(\s*)ow(?=\s+many\b)/gi, to: (m) => `${m[1]}how` },
];

/**
 * The corrected question and the corrections made (pure; for tests and the route). Every match is found against the
 * ORIGINAL question (codex build ruling item 5), so each correction keeps its original-coordinate span and its span in
 * the corrected text; overlapping matches keep the earlier-listed rule.
 */
export function correctSpelling(question: string): { text: string; corrections: SpellingCorrection[] } {
  type Hit = { start: number; end: number; to: string };
  const hits: Hit[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(question))) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      const to = rule.to(m);
      if (to.toLowerCase() === m[0].toLowerCase()) continue;
      const hit = { start: m.index, end: m.index + m[0].length, to };
      if (!hits.some((h) => h.start < hit.end && hit.start < h.end)) hits.push(hit);
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const corrections: SpellingCorrection[] = [];
  let text = "";
  let cursor = 0;
  for (const h of hits) {
    text += question.slice(cursor, h.start);
    const lead = h.to.length - h.to.trimStart().length; // a kept leading space ("ow" rule) is not part of the word
    const from = question.slice(h.start, h.end);
    const fromLead = from.length - from.trimStart().length;
    const nStart = text.length + lead;
    text += h.to;
    corrections.push({
      from: from.trim(), to: h.to.trim(),
      span: [h.start + fromLead, h.start + fromLead + from.trim().length],
      normalizedSpan: [nStart, nStart + h.to.trim().length],
    });
    cursor = h.end;
  }
  text += question.slice(cursor);
  return { text, corrections };
}

/**
 * Maps a span of the corrected text back to the original question: a span inside unchanged text shifts by the length
 * differences of the corrections before it; a span touching a correction widens to that correction's original words.
 */
export function originalSpan(span: [number, number], corrections: SpellingCorrection[]): [number, number] {
  const map = (pos: number, edge: "start" | "end"): number => {
    let delta = 0;
    for (const c of corrections) {
      const [ns, ne] = c.normalizedSpan;
      if (pos < ns || (edge === "end" && pos === ns)) break;
      if (pos <= ne && !(edge === "start" && pos === ne)) return edge === "start" ? c.span[0] : c.span[1];
      delta += (c.span[1] - c.span[0]) - (ne - ns);
    }
    return pos + delta;
  };
  return [map(span[0], "start"), map(span[1], "end")];
}

/**
 * Codex build ruling r2 item 5: the association between this turn's corrections and the EFFECTIVE question a follow-up
 * resolver rebuilt (which mixes this turn's corrected words with words inherited from earlier turns). Each correction is
 * associated only where its corrected word occurs exactly once, word-bounded, in the effective text; a missing or repeated
 * occurrence is left unassociated rather than guessed. Inherited words never carry a correction.
 */
export function associateCorrections(effective: string, corrections: SpellingCorrection[]): { correction: SpellingCorrection; effectiveSpan: [number, number] }[] {
  const out: { correction: SpellingCorrection; effectiveSpan: [number, number] }[] = [];
  for (const c of corrections) {
    const re = new RegExp(`\\b${c.to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const hits = [...effective.matchAll(re)];
    if (hits.length === 1) out.push({ correction: c, effectiveSpan: [hits[0].index!, hits[0].index! + hits[0][0].length] });
  }
  return out;
}

/** The user's own word behind an effective-question span: the misspelling it corrected, or null (unchanged or inherited). */
export function originalWordFor(span: [number, number], associations: { correction: SpellingCorrection; effectiveSpan: [number, number] }[]): string | null {
  const hit = associations.find((a) => a.effectiveSpan[0] < span[1] && span[0] < a.effectiveSpan[1]);
  return hit ? hit.correction.from : null;
}

/** Runs one route request inside its own context. */
export function runWithSpellingContext<T>(fn: () => T): T {
  return store.run({ original: null, corrections: [] }, fn);
}

/** Corrects the question, recording the original and the corrections in this request's context. */
export function applySpellingCorrections(question: string): string {
  const { text, corrections } = correctSpelling(question);
  const s = store.getStore();
  if (s && corrections.length) { s.original = question; s.corrections = corrections; }
  return corrections.length ? text : question;
}

export function spellingCorrections(): SpellingCorrection[] {
  return store.getStore()?.corrections ?? [];
}

/** The reading, stated once: `Read "cirme" as "crime"; "an drates" as "and rates".` (the words come from the closed list). */
export function spellingNote(): string | null {
  const c = spellingCorrections();
  if (!c.length) return null;
  return `Read ${c.map((x) => `"${x.from}" as "${x.to}"`).join("; ")}.`;
}

/** Prefixes the reading to a delivered text, exactly once. */
export function withSpellingNote(text: string | null | undefined): string | null | undefined {
  const note = spellingNote();
  if (!note) return text;
  const base = String(text ?? "");
  if (base.startsWith(note)) return base;
  return base.trim() ? `${note} ${base.trim()}` : note;
}

/** The question as the user typed it, for the log row; unchanged when nothing was corrected. */
export function originalQuestion(question: string): string {
  const s = store.getStore();
  return s?.original && s.corrections.length ? s.original : question;
}

/** Adds the tag once to a guardrail list when this request's spelling was corrected. */
export function withSpellingTag(tags: string[] | null | undefined): string[] | null | undefined {
  if (!spellingCorrections().length) return tags;
  const list = Array.isArray(tags) ? tags : [];
  return list.includes(SPELLING_TAG) ? list : [...list, SPELLING_TAG];
}
