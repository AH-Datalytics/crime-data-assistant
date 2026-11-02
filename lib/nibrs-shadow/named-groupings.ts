/**
 * The breakdowns a question names, from its words (coordinator 2026-11-02: a requested breakdown is never silently
 * dropped). "Robbery offenders in Memphis by age and year from 2022 to 2024" names age and year; every one must be a
 * grouping of the answer, or the question is declined. Used by the engine's guard (answer.ts) and by the scorer
 * (lib/answer-eval/shadow.ts), so both read the same request.
 *
 * Only the phrases that ask for a breakdown are read: "by ...", "per ...", "each ...", up to the next part of the
 * question ("in", "from", "since", ...). A word there that names no breakdown ("by men and women", "per 100,000") is
 * left to the reader.
 */
export type NamedGrouping = { word: string; matches: (dimension: string) => boolean };

const DIMENSIONS: { re: RegExp; word: string; matches: (d: string) => boolean }[] = [
  { re: /\b(?:years?|yearly|annual(?:ly)?)\b/, word: "year", matches: (d) => d === "time.year" },
  { re: /\b(?:months?|monthly)\b/, word: "month", matches: (d) => d === "time.month" },
  { re: /\b(?:quarters?|quarterly)\b/, word: "quarter", matches: (d) => d === "time.quarter" },
  { re: /\bages?(?:\s+groups?)?\b/, word: "age", matches: (d) => /(?:^|\.|_)age$/.test(d) },
  { re: /\brace\b/, word: "race", matches: (d) => /(?:^|\.|_)race$/.test(d) },
  { re: /\b(?:sex|gender)\b/, word: "sex", matches: (d) => /(?:^|\.|_)sex$/.test(d) },
  { re: /\bethnicity\b/, word: "ethnicity", matches: (d) => /(?:^|\.|_)ethnicity$/.test(d) },
  { re: /\bweapons?\b/, word: "weapon", matches: (d) => /weapon/.test(d) },
  { re: /\blocations?(?:\s+types?)?\b/, word: "location", matches: (d) => /location/.test(d) },
  { re: /\brelationships?\b/, word: "relationship", matches: (d) => /relationship/.test(d) },
  { re: /\bclearance\s+(?:status|type|method)\b/, word: "clearance", matches: (d) => /clearance/.test(d) },
];
const PHRASE = /\b(?:by|per|each)\s+([a-z][a-z\s,&/-]*?)(?=\s+(?:in|from|since|for|during|between|over|with|where|that|who|which|across|at|compared|vs\.?|versus|only|according|combined|together)\b|\s*,\s*(?=\d|(?:in|from|since|for|during|between|over)\b)|\s*\(|\s*[?.!;]|\s*$)/gi;
/**
 * Which agencies are counted ("only agencies that reported each month"), not a breakdown (Codex guard review 01.1);
 * "did Detroit report each year" still asks for years (confirmation 01.3).
 */
const REPORTING = /\bagencies\s+(?:that\s+|which\s+|who\s+)?report(?:ed|ing|s)?\s+(?:in\s+)?(?:each|every)\s+(?:month|year|quarter)\b/gi;

/** The breakdowns the question's "by/per/each" phrases name, each once. */
export function namedGroupings(question: string): NamedGrouping[] {
  const out: NamedGrouping[] = [];
  for (const m of question.toLowerCase().replace(REPORTING, " ").matchAll(PHRASE))
    for (const d of DIMENSIONS) if (d.re.test(m[1]) && !out.some((x) => x.word === d.word)) out.push({ word: d.word, matches: d.matches });
  return out;
}

/** The named breakdowns an answer's groupings leave out; empty when every one is there. */
export function missingGroupings(question: string, dimensions: readonly string[]): string[] {
  return namedGroupings(question).filter((g) => !dimensions.some((d) => g.matches(d))).map((g) => g.word);
}
